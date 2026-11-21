import { afterAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parseAllDocuments } from 'yaml';

/**
 * GUARD TEST for .github/workflows/coldstart-phases-kind-native.yml, the native amd64 run of the
 * kind cold-start phase harness.
 *
 * Invariants a casual edit could silently destroy:
 * 1. MANUAL. A measurement tool, not a gate: the only triggers are workflow_dispatch and ONE push
 *    trigger restricted to exactly five branch names (bench/run-coldstart-native and its -ladder,
 *    -bun, -smoke, -buildtool siblings; the default-branch dispatch limitation); no wildcard, paths, tags,
 *    schedule or pull_request. The branch maps to the arm set through github.ref_name in env.
 * 2. Inputs set, n, arms, ready_window_s, validated in the shell (n >= 12 except the smoke set,
 *    which may use N=1; window 16..45) and reaching the shell through env only.
 * 3. The three arms resolve (node 1000m, node no-limit, bun 1000m) and unknown arms are refused.
 * 4. Every action is pinned by a 40-hex SHA with a `# vX.Y.Z` comment; permissions are read-only;
 *    concurrency group queues runs (cancel-in-progress: false; the job applies to a cluster).
 * 5. The harness is called as it is: `analyze.py` with --p95 and no edits to its flags here.
 * 6. The Ready window is wired end to end: workflow -> drive.py -> cold-cycle.mjs, default 1500 ms.
 * 7. The summary reports Ready recorded and image pulled per arm, and fails when an arm has no rows.
 *
 * Text-scan, not YAML-parse, like bun-sandbox-fetch-ab-workflow.test.ts: no new dependency.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..');
const WF = resolve(REPO_ROOT, '.github/workflows/coldstart-phases-kind-native.yml');
const DIR = resolve(REPO_ROOT, 'scripts/bench-cold-start-phases');
const ARMS_SH = resolve(DIR, 'kind/arms.sh');
const SUMMARY_PY = resolve(REPO_ROOT, 'scripts/bench-cold-start-phases/kind/summarize-native.py');
const text = readFileSync(WF, 'utf8');

/** The workflow text with whole-line comments removed, so a comment cannot satisfy a scan. */
const code = text
  .split('\n')
  .filter((l) => !/^\s*#/.test(l))
  .join('\n');

/** The `on:` block of a workflow text (comments already stripped by the caller). */
function onBlock(t: string) {
  const i = t.indexOf('\non:');
  const j = t.indexOf('\npermissions:');
  return i < 0 || j < 0 ? '' : t.slice(i, j);
}

const BRANCHES = [
  'bench/run-coldstart-native',
  'bench/run-coldstart-native-ladder',
  'bench/run-coldstart-native-bun',
  'bench/run-coldstart-native-smoke',
  'bench/run-coldstart-native-buildtool',
];
const BRANCH_LIST = BRANCHES.map((b) => `      - ${b}\n`).join('');
const PUSH_BODY = `    branches:\n${BRANCH_LIST}`.trimEnd();

/** Every way the trigger block departs from "dispatch + exactly the five bench-branch push". */
function onViolations(t: string): string[] {
  const on = onBlock(t);
  const v: string[] = [];
  const top = [...on.matchAll(/^ {2}([a-z_]+):/gm)].map((m) => m[1]);
  for (const k of top) if (k !== 'push' && k !== 'workflow_dispatch') v.push(`trigger ${k}`);
  if (top.filter((k) => k === 'push').length !== 1) v.push('push trigger count != 1');
  const push = on.match(/^ {2}push:\n((?: {4}.*\n?)*)/m);
  if (!push || push[1].trimEnd() !== PUSH_BODY)
    v.push('push body is not exactly the five branches');
  if (/\bcron:/.test(on)) v.push('cron');
  return v;
}

function arms(arg?: string) {
  return spawnSync('bash', [ARMS_SH, ...(arg === undefined ? [] : [arg])], { encoding: 'utf8' });
}

describe('coldstart-phases-kind-native workflow shape', () => {
  it('has exactly one push trigger (the five dedicated bench branches), dispatch, and nothing else', () => {
    expect(onViolations(code)).toEqual([]);
    expect(onBlock(code)).toMatch(/workflow_dispatch:/);
  });

  it('the trigger scan rejects a fifth branch, a wildcard, tags, paths, a schedule or a pull_request', () => {
    const base = `\non:\n  push:\n${PUSH_BODY.replace(/^ {4}/, '    ')}\n  workflow_dispatch:\n`;
    const wrap = (on: string) => `${on}\npermissions:\n  contents: read\n`;
    expect(onViolations(wrap(base))).toEqual([]);
    const last = '      - bench/run-coldstart-native-buildtool\n';
    const bad = [
      base.replace(last, `${last}      - main\n`),
      base.replace(last, `${last}      - bench/run-coldstart-native-x\n`),
      base.replace(last, '      - bench/run-coldstart-native-*\n'),
      base.replace(last, ''),
      base.replace(last, `${last}    tags: [v*]\n`),
      base.replace(last, `${last}    paths: [x]\n`),
      `${base}  schedule:\n    - cron: '0 0 * * *'\n`,
      `${base}  pull_request:\n`,
      `${base}  pull_request_target:\n`,
      base.replace(`  push:\n${PUSH_BODY}\n`, '  push:\n'),
      base.replace(`  push:\n${PUSH_BODY}\n`, ''),
    ];
    for (const b of bad) expect(onViolations(wrap(b)).length).toBeGreaterThan(0);
  });

  it('exactly five push branches, no wildcard, no paths, no schedule, no pull_request', () => {
    const on = onBlock(code);
    const listed = [...on.matchAll(/^ {6}- (\S+)$/gm)].map((m) => m[1]);
    expect(listed).toEqual(BRANCHES);
    expect(on).not.toMatch(/\*/);
    expect(on).not.toMatch(/\bpaths(-ignore)?:|schedule:|pull_request|tags:/);
  });

  it('maps each push branch to its set in env through github.ref_name, not a run: input', () => {
    const m = code.match(/\n {6}SET: (.*)\n/);
    expect(m).not.toBeNull();
    const expr = m?.[1] ?? '';
    expect(expr).toMatch(/^\$\{\{ inputs\.set \|\| /);
    for (const [branch, set] of [
      ['bench/run-coldstart-native-ladder', 'ladder'],
      ['bench/run-coldstart-native-bun', 'bun'],
      ['bench/run-coldstart-native-smoke', 'smoke'],
      ['bench/run-coldstart-native-buildtool', 'buildtool'],
    ])
      expect(expr).toContain(`github.ref_name == '${branch}' && '${set}'`);
    expect(expr).toMatch(/\|\| 'default' \}\}$/);
    // The bare default branch (and a dispatch with no set) falls through to the default set.
    expect(expr).not.toContain("== 'bench/run-coldstart-native' &&");
  });

  it('falls back to the documented defaults when the inputs are empty (push event)', () => {
    expect(code).toMatch(/\n {6}N_INPUT: \$\{\{ inputs\.n \|\| '' \}\}\n/);
    expect(code).toMatch(/\n {6}ARMS_INPUT: \$\{\{ inputs\.arms \|\| '' \}\}\n/);
    expect(code).toMatch(/\n {6}READY_WINDOW_S: \$\{\{ inputs\.ready_window_s \|\| '20' \}\}\n/);
    // The fallbacks equal the declared input defaults, and the validation step still reads them.
    expect(code).toMatch(/\n {6}- name: Validate inputs\n/);
    expect(code).toMatch(/\[ "\$N" -le 30 \]/);
    expect(code).toMatch(/run-budget\.sh" "\$N"/);
  });

  it('declares the four inputs with the agreed defaults', () => {
    expect(code).toMatch(/\n {6}set:\n(?: {8}.*\n)*? {8}default: 'default'/);
    expect(code).toMatch(/\n {6}n:\n(?: {8}.*\n)*? {8}default: ''/);
    expect(code).toMatch(/\n {6}arms:\n(?: {8}.*\n)*? {8}default: ''/);
    expect(code).toMatch(/\n {6}ready_window_s:\n(?: {8}.*\n)*? {8}default: '20'/);
  });

  it('validates the inputs in the shell and passes them through env only', () => {
    expect(code).toMatch(/\[ "\$N" -ge "\$MIN_N" \]/);
    expect(code).toMatch(/\[ "\$N" -le 30 \]/);
    expect(code).toMatch(/timeout-minutes: 150/);
    expect(code).toMatch(/"\$READY_WINDOW_S" -lt 16/);
    expect(code).toMatch(/"\$READY_WINDOW_S" -gt 45/);
    // No dispatch input is templated into a run: script.
    const runBodies = code.split(/\n\s+run: /).slice(1);
    for (const body of runBodies)
      expect(body).not.toMatch(/github\.event\.inputs|\$\{\{\s*inputs\./);
  });

  it('has read-only permissions and a queuing concurrency group', () => {
    expect(code).toMatch(/\npermissions:\n {2}contents: read\n/);
    expect(code).toMatch(/\nconcurrency:\n {2}group: \S+\n {2}cancel-in-progress: false\n/);
    expect(code).not.toMatch(/\n\s+(?:id-token|packages|pull-requests|actions|issues): write/);
  });

  it('pins every action by 40-hex SHA with a version comment', () => {
    const uses = [...text.matchAll(/^\s*(?:- )?uses:\s*(\S+)(.*)$/gm)].filter(
      (m) => !m[1].startsWith('./'),
    );
    expect(uses.length).toBeGreaterThanOrEqual(6);
    for (const m of uses) {
      expect(m[1]).toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/);
      expect(m[2]).toMatch(/#\s*v\d+\.\d+\.\d+/);
    }
  });

  it('verifies each arm runs its runtime through check-runtime.sh, on the command and the process', () => {
    // Both the rendered container command and the live process go through the one checker.
    expect(code.match(/"\$chk" "\$runtime"/g)?.length).toBe(1);
    expect(code.match(/"\$chk" "\$proc_rt"/g)?.length).toBe(1);
    expect(code).toMatch(/kind\/check-runtime\.sh/);
    expect(code).toMatch(/flag="--allow-empty"/);
    // A vinext arm renders no container command either (the image CMD runs it); a vinext+bun
    // process is the compiled executable, so it is judged as bun-exec, not as a bun argv[0].
    expect(code).toMatch(/\[ "\$build" = vinext \] && flag="--allow-empty"/);
    expect(code).toMatch(/proc_rt="bun-exec"/);
    // No bare substring globs on a command line.
    expect(code).not.toMatch(/\*bun\*|\*node\*/);
    // Distroless image: read the process from the kind node, never exec into the app container.
    expect(code).toMatch(/containerStatuses\[\?\(@\.name=="user-container"\)\]\.containerID/);
    expect(code).toMatch(/docker exec "\$knode" crictl inspect "\$cid"/);
    expect(code).toMatch(/jq -r '\.info\.pid'/);
    expect(code).toMatch(/docker exec "\$knode" cat "\/proc\/\$\{kpid\}\/cmdline"/);
    expect(code).not.toMatch(/kubectl[^\n]*\bexec\b/);
    expect(code).toMatch(/crictl inspect failed on/);
    // Newest Running pod that is not terminating.
    expect(code).toMatch(/\.metadata\.deletionTimestamp == null/);
    expect(code).toMatch(/sort_by\(\.metadata\.creationTimestamp\) \| last/);
  });

  it('runs the combined run-budget check', () => {
    expect(code).toMatch(/\/run-budget\.sh" "\$N" .* "\$READY_WINDOW_S"/);
    expect(code).toMatch(/\[ "\$N" -le 30 \]/);
  });

  it('runs on amd64 ubuntu-latest and checks the node architecture', () => {
    expect(code).toMatch(/runs-on: ubuntu-latest/);
    expect(code).toMatch(/uname -m/);
    expect(code).toMatch(/test "\$\(cat "\$\{RUNNER_TEMP\}\/node-arch\.txt"\)" = amd64/);
  });

  it('loads images into kind rather than pulling inside it', () => {
    expect(code).toMatch(/kind load docker-image "\$IMG" --name "\$CLUSTER"/);
  });

  it('loads the harness node image as a single-platform digest-pinned archive, never docker-image', () => {
    // A multi-platform index pulled for one platform makes `kind load docker-image` fail with
    // "content digest ... not found" (ctr import --all-platforms).
    const D = 'sha256:4eefa1bfce4197942661ef9148247d779ddf1bb0ee006d3294a467609de60724';
    expect(code).toContain(`docker pull --platform linux/amd64 node@${D}`);
    expect(code).toContain(`docker tag node@${D} node:24-alpine`);
    expect(code).toMatch(/docker save -o "\$\{RUNNER_TEMP\}\/node-24-alpine\.tar" node:24-alpine/);
    expect(code).toMatch(
      /kind load image-archive "\$\{RUNNER_TEMP\}\/node-24-alpine\.tar" --name "\$CLUSTER"/,
    );
    expect(code).not.toMatch(/kind load docker-image\s+["']?(?:docker\.io\/library\/)?node[:@]/);
    expect(code).not.toMatch(/docker pull node:/);
  });

  it('the kind harness manifest never pulls: every node:24-alpine container is IfNotPresent', () => {
    const docs = parseAllDocuments(
      readFileSync(resolve(DIR, 'kind/phase-harness-kind.yaml'), 'utf8'),
    ).map(
      (d) => d.toJS() as { spec?: { containers?: { image?: string; imagePullPolicy?: string }[] } },
    );
    const nodeContainers = docs
      .flatMap((d) => d?.spec?.containers ?? [])
      .filter((c) => /(^|\/)node[:@]/.test(c.image ?? ''));
    expect(nodeContainers.length).toBe(3);
    for (const c of nodeContainers) expect(c.imagePullPolicy).toBe('IfNotPresent');
  });

  it('drives the existing harness unchanged and calls analyze.py with --p95', () => {
    expect(code).toMatch(/scripts\/bench-cold-start-phases\/drive\.py "\$N" "\$ARMS"/);
    expect(code).toMatch(/kind\/phase-harness-kind\.yaml/);
    expect(code).toMatch(/analyze\.py "\$1" --namespace="\$APP_NS" --no-marker --p95/);
    expect(code).toMatch(/READY_WINDOW_MS=\$\(\(READY_WINDOW_S \* 1000\)\)/);
  });

  it('uploads the jsonl and the analysis and writes a step summary', () => {
    expect(code).toMatch(/upload-artifact@/);
    expect(code).toMatch(/runner\.temp \}\}\/out\//);
    expect(code).toMatch(/analysis-\$\{arm\}\.txt/);
    expect(code).toMatch(/phases-\$\{arm\}\.jsonl/);
    expect(code).toMatch(/summarize-native\.py/);
    expect(code).toMatch(/>> "\$GITHUB_STEP_SUMMARY"/);
  });
});

describe('kind/arms.sh', () => {
  it('resolves the default three arms with their runtime and cpu limit', () => {
    const r = arms();
    expect(r.status).toBe(0);
    expect(r.stdout.trim().split('\n')).toEqual([
      'node-1000m node 1000m',
      'node-nolimit node 64',
      'bun-1000m bun 1000m',
    ]);
  });

  it('keeps the order given and accepts a subset', () => {
    const r = arms('bun-1000m,node-1000m');
    expect(r.status).toBe(0);
    expect(r.stdout.trim().split('\n')).toEqual(['bun-1000m bun 1000m', 'node-1000m node 1000m']);
  });

  it('refuses an unknown arm and a duplicate, exiting 2', () => {
    const bad = arms('node-1000m,deno-1000m');
    expect(bad.status).toBe(2);
    expect(bad.stderr).toContain("unknown arm 'deno-1000m'");
    const dup = arms('node-1000m,node-1000m');
    expect(dup.status).toBe(2);
    expect(dup.stderr).toContain("duplicate arm 'node-1000m'");
  });
});

describe('kind/arms.sh sets', () => {
  const SETS: Record<string, string[]> = {
    ladder: [
      'node-1000m node 1000m',
      'node-2000m node 2000m',
      'node-4000m node 4000m',
      'node-nolimit node 64',
    ],
    bun: ['bun-1000m bun 1000m', 'bun-nolimit bun 64', 'node-1000m node 1000m'],
    smoke: ['node-1000m node 1000m'],
    buildtool: [
      'node-turbopack-1000m node 1000m turbopack scaffold',
      'bun-turbopack-1000m bun 1000m turbopack scaffold',
      'node-vinext-1000m node 1000m vinext scaffold',
      'bun-vinext-1000m bun 1000m vinext scaffold',
    ],
    default: ['node-1000m node 1000m', 'node-nolimit node 64', 'bun-1000m bun 1000m'],
  };
  for (const [name, lines] of Object.entries(SETS))
    it(`set ${name} resolves to its arms in order`, () => {
      const r = arms(name);
      expect(r.status).toBe(0);
      expect(r.stdout.trim().split('\n')).toEqual(lines);
    });

  it('the new single arms resolve, the nolimit arms at a 64 CPU limit', () => {
    expect(arms('node-2000m,node-4000m,bun-nolimit').stdout.trim().split('\n')).toEqual([
      'node-2000m node 2000m',
      'node-4000m node 4000m',
      'bun-nolimit bun 64',
    ]);
  });

  it('only the smoke set has a minimum N below 12', () => {
    const minN = (a: string) =>
      spawnSync('bash', [ARMS_SH, '--min-n', a], { encoding: 'utf8' }).stdout.trim();
    expect(minN('smoke')).toBe('1');
    for (const o of ['default', 'ladder', 'bun', 'buildtool']) expect(minN(o)).toBe('12');
  });

  it('--min-n and --default-n reject an unknown set or an arm list with exit 2', () => {
    for (const flag of ['--min-n', '--default-n'])
      for (const o of ['junk', 'node-1000m', 'smoke,node-1000m']) {
        const r = spawnSync('bash', [ARMS_SH, flag, o], { encoding: 'utf8' });
        expect(r.status).toBe(2);
        expect(r.stderr).toContain('unknown set');
      }
  });
});

/** Run the real "Validate inputs" step script with a shimmed `uname` and a scratch GITHUB_ENV. */
function validate(env: Record<string, string>) {
  const step = text.split('\n      - name: Validate inputs\n')[1].split('\n      - name: ')[0];
  const script = step.split('        run: |\n')[1].replace(/^ {10}/gm, '');
  const d = mkdtempSync(join(tmpdir(), 'val-'));
  try {
    writeFileSync(join(d, 'uname'), '#!/bin/sh\necho x86_64\n', { mode: 0o755 });
    writeFileSync(join(d, 'genv'), '');
    const r = spawnSync('bash', ['-c', script], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      env: {
        PATH: `${d}:${process.env.PATH}`,
        RUNNER_TEMP: d,
        GITHUB_ENV: join(d, 'genv'),
        READY_WINDOW_S: '20',
        N_INPUT: '',
        ARMS_INPUT: '',
        ...env,
      },
    });
    return {
      status: r.status,
      out: r.stdout + r.stderr,
      genv: readFileSync(join(d, 'genv'), 'utf8'),
    };
  } finally {
    rmSync(d, { recursive: true, force: true });
  }
}

describe('Validate inputs step (behaviour)', () => {
  it('accepts N=1 for the smoke set and defaults smoke to N=1', () => {
    const a = validate({ SET: 'smoke', N_INPUT: '1' });
    expect(a.status).toBe(0);
    expect(a.genv).toContain('N=1\n');
    expect(a.genv).toContain('ARMS=node-1000m\n');
    expect(validate({ SET: 'smoke' }).genv).toContain('N=1\n');
  });

  it('refuses N=1 (and anything under 12) for every other set and for an explicit arm list', () => {
    for (const set of ['default', 'ladder', 'bun']) {
      expect(validate({ SET: set, N_INPUT: '1' }).status).toBe(1);
      expect(validate({ SET: set, N_INPUT: '11' }).status).toBe(1);
    }
    expect(validate({ SET: 'default', ARMS_INPUT: 'node-1000m', N_INPUT: '1' }).status).toBe(1);
    expect(validate({ SET: 'default', N_INPUT: '12' }).status).toBe(0);
  });

  it('defaults the non-smoke sets to N=12 and exports the resolved arms', () => {
    const r = validate({ SET: 'ladder' });
    expect(r.status).toBe(0);
    expect(r.genv).toContain('N=12\n');
    expect(r.genv).toContain('ARMS=node-1000m,node-2000m,node-4000m,node-nolimit\n');
  });

  it('accepts ladder at N=20 and refuses an oversize run', () => {
    expect(validate({ SET: 'ladder', N_INPUT: '20' }).status).toBe(0);
    expect(validate({ SET: 'ladder', N_INPUT: '30' }).status).toBe(1);
  });

  it('refuses the arms=smoke N=1 bypass (the floor follows SET, not the arm spec)', () => {
    expect(validate({ SET: 'default', ARMS_INPUT: 'smoke', N_INPUT: '1' }).status).toBe(1);
    expect(validate({ SET: 'default', ARMS_INPUT: 'ladder', N_INPUT: '12' }).status).toBe(1);
    expect(validate({ SET: 'default', ARMS_INPUT: 'node-1000m', N_INPUT: '1' }).status).toBe(1);
  });

  it('refuses a non-integer, whitespace or newline-bearing n, even for the smoke set', () => {
    for (const n of ['x', ' ', '1\n2', '1\n', '1.5', '-1'])
      for (const set of ['smoke', 'default', 'ladder'])
        expect(validate({ SET: set, N_INPUT: n }).status).toBe(1);
  });

  it('refuses an unknown set', () => {
    expect(validate({ SET: 'junk' }).status).not.toBe(0);
    expect(validate({ SET: 'junk', N_INPUT: '12' }).status).not.toBe(0);
    expect(validate({ SET: '' }).status).not.toBe(0);
  });

  it('the default set exports exactly the 3 default arms and N=12', () => {
    const r = validate({ SET: 'default' });
    expect(r.status).toBe(0);
    expect(r.genv).toBe('N=12\nARMS=node-1000m,node-nolimit,bun-1000m\n');
  });

  it('accepts an explicit arm list with the default set and exports exactly it', () => {
    const r = validate({ SET: 'default', ARMS_INPUT: 'node-2000m,bun-nolimit' });
    expect(r.status).toBe(0);
    expect(r.genv).toBe('N=12\nARMS=node-2000m,bun-nolimit\n');
  });

  it('refuses arms together with a named set', () => {
    expect(validate({ SET: 'ladder', ARMS_INPUT: 'node-1000m' }).status).toBe(1);
  });
});

describe('Ready window wiring', () => {
  it('cold-cycle.mjs waits READY_WINDOW_MS, defaulting to the original 1500 ms', () => {
    const src = readFileSync(resolve(DIR, 'cold-cycle.mjs'), 'utf8');
    expect(src).toMatch(
      /const READY_WINDOW_MS = Number\(process\.env\.READY_WINDOW_MS \?\? 1500\);/,
    );
    expect(src).toMatch(/await sleep\(READY_WINDOW_MS\);/);
    expect(src).not.toMatch(/await sleep\(1500\)/);
  });

  it('drive.py forwards READY_WINDOW_MS to the in-cluster harness only when set', () => {
    const src = readFileSync(resolve(DIR, 'drive.py'), 'utf8');
    expect(src).toMatch(/^import os$/m);
    expect(src).toMatch(
      /if os\.environ\.get\("READY_WINDOW_MS"\):\n\s+env\["READY_WINDOW_MS"\] = os\.environ\["READY_WINDOW_MS"\]/,
    );
  });
});

describe('kind/summarize-native.py', () => {
  const row = (arm: string, ready: boolean, pulling: boolean, firstByte: number) =>
    JSON.stringify({
      arm,
      code: 200,
      watch: { first_byte: firstByte, ...(ready ? { cond_Ready: 900 } : {}) },
      events: pulling ? [{ reason: 'Pulling' }] : [{ reason: 'Pulled' }],
    });
  function run(lines: string[], armsArg?: string) {
    const d = mkdtempSync(join(tmpdir(), 'summ-'));
    try {
      const f = join(d, 'run.jsonl');
      writeFileSync(f, `${lines.join('\n')}\n`);
      return spawnSync('python3', [SUMMARY_PY, f, ...(armsArg ? [armsArg] : [])], {
        encoding: 'utf8',
      });
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }

  it('counts Ready recorded, image pulled and the first-byte median per arm', () => {
    const r = run([
      row('a', true, false, 3000),
      row('a', false, true, 3200),
      row('b', true, false, 2000),
    ]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('| a | 2 | 2 | 1 | 1 | 3100 | 3200 |');
    expect(r.stdout).toContain('| b | 1 | 1 | 1 | 0 | 2000 | 2000 |');
  });

  it('exits 1 when a requested arm has no rows', () => {
    const r = run([row('a', true, false, 3000)], 'a,b');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('no rows for arm(s): b');
  });
});

describe('kind/check-runtime.sh (behaviour)', () => {
  const CHECK = resolve(DIR, 'kind/check-runtime.sh');
  const run = (runtime: string, argv: string[], extra: string[] = []) =>
    spawnSync('bash', [CHECK, runtime, ...extra], {
      encoding: 'utf8',
      input: argv.map((a) => `${a}\0`).join(''),
    });

  it('judges argv[0] basename only: substrings in arguments or paths do not count', () => {
    expect(run('node', ['node', '/app/bundle.js']).status).toBe(0);
    expect(run('bun', ['bun', '/app/node_modules/x']).status).toBe(0);
    expect(run('bun', ['/usr/local/bin/bun', 'run', 'server.js']).status).toBe(0);
    expect(run('node', ['/usr/bin/bun', 'server.js']).status).toBe(1);
    expect(run('bun', ['node', '/opt/bun/server.js']).status).toBe(1);
    expect(run('node', ['/usr/local/bun/bin/node', 'x']).status).toBe(0);
    // A lookalike basename is not the runtime.
    expect(run('node', ['/usr/bin/nodejs-wrapper', 'x']).status).toBe(1);
    expect(run('bun', ['bunx', 'x']).status).toBe(1);
  });

  it('refuses an empty command line unless --allow-empty, and never for bun by default', () => {
    expect(run('bun', []).status).toBe(1);
    expect(run('node', []).status).toBe(1);
    expect(run('node', [], ['--allow-empty']).status).toBe(0);
  });

  it('rejects an unknown runtime with exit 2', () => {
    expect(run('deno', ['deno']).status).toBe(2);
  });
});

describe('kind/run-budget.sh (behaviour)', () => {
  const BUDGET = resolve(DIR, 'kind/run-budget.sh');
  const run = (...a: string[]) => spawnSync('bash', [BUDGET, ...a], { encoding: 'utf8' });

  it('accepts the defaults and the largest default-window run', () => {
    expect(run('12', '3', '20').status).toBe(0);
    expect(run('30', '3', '20').status).toBe(0);
  });

  it('refuses a run that does not fit, printing the arithmetic', () => {
    const r = run('30', '3', '45');
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('30 x 3 x (45 + 45) s');
    expect(r.stderr).toContain('does not fit');
  });

  it('keeps at least the post-step margin: a run that fits only without it is refused', () => {
    // 30 x 3 x 65 + 25 min = 7350 s fits 150 - 15 min (8100 s) but not 150 - 40 min (6600 s).
    expect(run('30', '3', '20', '150', '40').status).toBe(1);
    expect(run('30', '3', '20', '150', '15').status).toBe(0);
  });

  it('accepts the ladder set (4 arms) at N=20 and refuses an oversize run', () => {
    // 4 x 20 x (45 + 20) s + 25 min = 6700 s <= 8100 s.
    const ok = run('20', '4', '20');
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain('20 x 4 x (45 + 20) s');
    expect(run('30', '4', '20').status).toBe(1);
    expect(run('20', '4', '45').status).toBe(1);
  });

  it('rejects non-integers with exit 2', () => {
    expect(run('x', '3', '20').status).toBe(2);
  });
});
describe('build-tool axis (buildtool set)', () => {
  const BT = [
    'node-turbopack-1000m',
    'bun-turbopack-1000m',
    'node-vinext-1000m',
    'bun-vinext-1000m',
  ];

  it('every build-tool arm is a 1000m arm on the scaffold app, with its build tool in column 4', () => {
    const r = arms(BT.join(','));
    expect(r.status).toBe(0);
    for (const line of r.stdout.trim().split('\n')) {
      const [arm, runtime, cpu, build, app] = line.split(' ');
      expect(cpu).toBe('1000m');
      expect(app).toBe('scaffold');
      expect(arm).toBe(`${runtime}-${build}-1000m`);
      expect(['turbopack', 'vinext']).toContain(build);
    }
  });

  it('the legacy arms keep their three-column output (no build or app columns)', () => {
    for (const name of ['default', 'ladder', 'bun', 'smoke'])
      for (const line of arms(name).stdout.trim().split('\n'))
        expect(line.split(' ').length).toBe(3);
  });

  it('buildtool defaults to N=12 and exports exactly its four arms', () => {
    const r = validate({ SET: 'buildtool' });
    expect(r.status).toBe(0);
    expect(r.genv).toContain('N=12');
    expect(r.genv).toContain(`ARMS=${BT.join(',')}`);
  });

  it('buildtool refuses N below 12, and an arm list together with the set', () => {
    expect(validate({ SET: 'buildtool', N_INPUT: '1' }).status).not.toBe(0);
    expect(validate({ SET: 'buildtool', ARMS_INPUT: 'node-vinext-1000m' }).status).not.toBe(0);
  });

  it('the build-tool arms are accepted in an explicit arm list with set=default', () => {
    const r = validate({ SET: 'default', ARMS_INPUT: 'node-vinext-1000m,bun-vinext-1000m' });
    expect(r.status).toBe(0);
    expect(r.genv).toContain('ARMS=node-vinext-1000m,bun-vinext-1000m');
  });

  it('fits the budget at N=12: 12 x 4 x (45 + 20) s + 25 min is under 135 min', () => {
    const r = spawnSync('bash', [resolve(DIR, 'kind/run-budget.sh'), '12', '4', '20'], {
      encoding: 'utf8',
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('12 x 4 x (45 + 20) s');
  });

  it('the workflow keys the shared image on app, runtime AND build tool, not the runtime alone', () => {
    expect(code).toMatch(/key="\$\{app\}-\$\{runtime\}-\$\{build\}"/);
    expect(code).toMatch(/awk -v k="\$key" '\$1==k \{print \$2; exit\}'/);
    expect(code).toMatch(/echo "\$key \$img" >> "\$\{RUNNER_TEMP\}\/arm-images\.txt"/);
    // The old runtime-only key must be gone.
    expect(code).not.toMatch(/awk -v r="\$runtime"/);
  });

  it('writes build: into the arm config and builds the scaffold app for the scaffold arms', () => {
    expect(code).toMatch(/build: "\$\{build\}"/);
    expect(code).toMatch(/node "\$CLI" create "\$dir" .* --builder "\$\{build\}"/);
    expect(code).toMatch(/--runtime "\$runtime"/);
    // The spike-zone (legacy) path is still there for the existing sets.
    expect(code).toMatch(/spikes\/zone-functions-coldstart\/zone/);
  });

  it('records evidence per arm and quotes it in the summary', () => {
    expect(code).toMatch(/kind\/record-evidence\.sh/);
    expect(code).toMatch(/evidence-\$\{arm\}\.json/);
    expect(code).toMatch(/evidence-\*\.json/);
  });

  it('exports BYTECODE_BASELINE for the vinext+bun pragma differential', () => {
    expect(code).toMatch(/BYTECODE_BASELINE=/);
  });
});

describe('kind/check-runtime.sh bun-exec (vinext compiled executable)', () => {
  const CHECK = resolve(DIR, 'kind/check-runtime.sh');
  const run = (argv: string[]) =>
    spawnSync('bash', [CHECK, 'bun-exec'], {
      encoding: 'utf8',
      input: argv.map((a) => `${a}\0`).join(''),
    });

  it('accepts the compiled executable named server and nothing else', () => {
    expect(run(['/app/server']).status).toBe(0);
    expect(run(['server']).status).toBe(0);
    expect(run(['/usr/local/bin/node', '/app/server']).status).toBe(1);
    expect(run(['/app/bun']).status).toBe(1);
    expect(run(['/app/server-wrapper']).status).toBe(1);
    expect(run([]).status).toBe(1);
  });
});

describe('kind/verify-bytecode.mjs (behaviour)', () => {
  const VERIFY = resolve(REPO_ROOT, 'scripts/bench-cold-start-phases/kind/verify-bytecode.mjs');
  const MARKER = 'knext-standalone-exec:0123456789abcdef01234567';
  const PRAGMA = '// @bun @bytecode @bun-cjs';
  const NOPRAGMA = '// @bun @bun-cjs';
  const d = mkdtempSync(join(tmpdir(), 'vbc-'));
  afterAll(() => rmSync(d, { recursive: true, force: true }));
  const bin = (name: string, body: string, enc: BufferEncoding = 'latin1') => {
    const f = join(d, name);
    writeFileSync(f, Buffer.concat([Buffer.from('\x7fELFxx', 'latin1'), Buffer.from(body, enc)]));
    return f;
  };
  const verify = (...a: string[]) => spawnSync('node', [VERIFY, ...a], { encoding: 'utf8' });

  // A bun --compile module: pragma, banner marker, then a constant-pool copy of the marker.
  // The pool copy sits beyond the 4096-character pragma window, as it does in a real binary.
  const withBytecode = `${PRAGMA}\nglobalThis.m="${MARKER}";\n${'.'.repeat(5000)}\0\0${MARKER}\0`;
  const withoutBytecode = `${NOPRAGMA}\nglobalThis.m="${MARKER}";\n`;

  it('standalone: accepts a marker under an @bytecode pragma with a constant-pool copy', () => {
    const r = verify('standalone', bin('ok', withBytecode));
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('bytecode verified');
    expect(r.stdout).toContain(MARKER);
  });

  it('standalone: also accepts the UTF-16LE layout a real Next bundle uses', () => {
    expect(verify('standalone', bin('ok16', withBytecode, 'utf16le')).status).toBe(0);
  });

  it('standalone: refuses a build without bytecode, and a binary with no marker', () => {
    const no = verify('standalone', bin('nobc', withoutBytecode));
    expect(no.status).toBe(1);
    expect(no.stderr).toMatch(/bytecode|marker/);
    const none = verify('standalone', bin('nomarker', `${PRAGMA}\nhello`));
    expect(none.status).toBe(1);
    expect(none.stderr).toContain('no knext-standalone-exec marker');
  });

  it('pragma: needs more @bytecode module pragmas than the no-bytecode baseline probe', () => {
    const baseline = bin('base', `${PRAGMA}\n${NOPRAGMA}\n`); // the runtime carries one copy itself
    const app = bin('app', `${PRAGMA}\n${PRAGMA}\n${NOPRAGMA}\n`);
    const ok = verify('pragma', app, baseline);
    expect(ok.status).toBe(0);
    expect(ok.stdout).toContain('the build requested bytecode (pragma differential)');
    expect(ok.stdout).not.toMatch(/carries bytecode|proven/);
    expect(ok.stdout).toContain('app=2');
    expect(ok.stdout).toContain('baseline=1');
    // Same count as the baseline: compiled without bytecode.
    expect(verify('pragma', bin('same', `${PRAGMA}\n`), baseline).status).toBe(1);
    // A missing baseline is an error, never a pass.
    expect(verify('pragma', app).status).toBe(2);
  });

  it('pragma: counts the UTF-16LE spelling too', () => {
    const baseline = bin('base16', `${PRAGMA}\n`);
    const f = join(d, 'app16');
    writeFileSync(
      f,
      Buffer.concat([Buffer.from(`${PRAGMA}\n`, 'latin1'), Buffer.from(`${PRAGMA}\n`, 'utf16le')]),
    );
    expect(verify('pragma', f, baseline).status).toBe(0);
  });

  it('rejects an unknown mode or a missing file with exit 2', () => {
    expect(verify('nope', join(d, 'ok')).status).toBe(2);
    expect(verify('standalone', join(d, 'absent')).status).toBe(2);
  });
});

describe('kind/record-evidence.sh (behaviour, docker shimmed)', () => {
  const REC = resolve(DIR, 'kind/record-evidence.sh');
  const KPID = '4242';
  const NODE = 'kindnode';
  type Case = {
    runtime: string;
    build: string;
    files?: Record<string, string>;
    /** Lines of the image's own ENV, as `docker inspect` prints them. */
    env?: string;
    /** Files on the kind node, keyed by their /proc path. */
    proc?: Record<string, string>;
    args?: string[];
    /** Pids whose /proc/<pid>/stat is NOT created (the default fixtures give every pid a live one). */
    noStat?: string[];
  };

  /**
   * A fake `docker`. Every call is logged. `cp` materialises fixture files. `exec <node> cat|readlink
   * <path>` reads a fake /proc, and FAILS when <node> is not the node the script was told about, so a
   * wrong node name cannot pass.
   */
  function run(c: Case, baselineBin?: string) {
    const d = mkdtempSync(join(tmpdir(), 'rec-'));
    try {
      mkdirSync(join(d, 'fx'), { recursive: true });
      for (const [rel, body] of Object.entries(c.files ?? {})) {
        mkdirSync(join(d, 'fx', dirname(rel)), { recursive: true });
        writeFileSync(join(d, 'fx', rel), body);
      }
      for (const [rel, body] of Object.entries(c.proc ?? {})) {
        mkdirSync(join(d, 'proc', dirname(rel)), { recursive: true });
        writeFileSync(join(d, 'proc', rel), body);
      }
      // Every pid that has any fixture gets a live /proc/<pid>/stat unless the case says otherwise
      // (noStat) or supplies its own: the script requires a readable stat for every child.
      const pids = new Set(
        Object.keys(c.proc ?? {}).flatMap((k) => k.match(/^\/proc\/(\d+)\//)?.[1] ?? []),
      );
      for (const pid of pids) {
        const key = `/proc/${pid}/stat`;
        if ((c.noStat ?? []).includes(pid) || key in (c.proc ?? {})) continue;
        writeFileSync(join(d, 'proc', key), `${pid} (x) S 1 ${pid} ${pid} 0 -1\n`);
      }
      writeFileSync(
        join(d, 'docker'),
        [
          '#!/bin/sh',
          'echo "$1" >> "$FAKE_LOG"',
          'case "$1" in',
          '  pull) exit 0 ;;',
          '  create) echo fakecid ;;',
          '  rm) exit 0 ;;',
          '  inspect) printf "%s\\n" "PATH=/usr/bin" "${FAKE_ENV:-}" ;;',
          '  cp) src="${2#fakecid:}"; dst="$3"; cp -R "$FAKE_FX$src" "$dst" 2>/dev/null || exit 1 ;;',
          '  exec) [ "$2" = "$FAKE_NODE" ] || { echo "Error: No such container: $2" >&2; exit 1; }',
          '        case "$3" in cat | readlink) cat "$FAKE_PROC$4" || exit 1 ;; *) exit 1 ;; esac ;;',
          'esac',
          '',
        ].join('\n'),
        { mode: 0o755 },
      );
      writeFileSync(
        join(d, 'build.log'),
        'step\ncompile cache baked: 999999 bytes in 12 file(s)\n',
      );
      mkdirSync(join(d, 'out'));
      const r = spawnSync(
        'bash',
        [
          REC,
          'arm-x',
          c.runtime,
          c.build,
          'scaffold',
          'localhost:5001/x@sha256:abc',
          join(d, 'build.log'),
          join(d, 'out'),
          ...(c.args ?? [NODE, KPID]),
        ],
        {
          encoding: 'utf8',
          env: {
            PATH: `${d}:${process.env.PATH}`,
            FAKE_FX: join(d, 'fx'),
            FAKE_PROC: join(d, 'proc'),
            FAKE_ENV: c.env ?? '',
            FAKE_NODE: NODE,
            FAKE_LOG: join(d, 'calls.log'),
            ...(baselineBin ? { BYTECODE_BASELINE: baselineBin } : {}),
          },
        },
      );
      let ev: Record<string, unknown> | null = null;
      try {
        ev = JSON.parse(readFileSync(join(d, 'out', 'evidence-arm-x.json'), 'utf8'));
      } catch {
        ev = null;
      }
      let calls: string[] = [];
      try {
        calls = readFileSync(join(d, 'calls.log'), 'utf8').split('\n').filter(Boolean);
      } catch {
        calls = [];
      }
      return { status: r.status, err: r.stderr + r.stdout, ev, calls };
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  }

  const big = 'x'.repeat(300000);
  const TCACHE = '/app/.next/standalone/.next/compile-cache';
  const envOf = (cache: string) => `PATH=/usr/bin\0NODE_COMPILE_CACHE=${cache}\0`;
  const CHILDREN = `/proc/${KPID}/task/${KPID}/children`;

  // node + turbopack: a supervisor (KPID) and its Next child (4300).
  const nodeCase = (over: Partial<Case> = {}): Case => ({
    runtime: 'node',
    build: 'turbopack',
    files: { 'app/.next/standalone/.next/compile-cache/v24/a.bin': big },
    env: `NODE_COMPILE_CACHE=${TCACHE}`,
    proc: {
      [CHILDREN]: '4300 ',
      '/proc/4300/environ': envOf(TCACHE),
    },
    ...over,
  });

  it('turbopack+node: records the cache bytes, the image env and the CHILD live env', () => {
    const r = run(nodeCase());
    expect(r.status).toBe(0);
    expect(r.ev?.build_target).toBe('turbopack');
    expect(r.ev?.runtime).toBe('node');
    const bc = r.ev?.bytecode as Record<string, unknown>;
    expect(bc.kind).toBe('v8-compile-cache');
    expect(bc.bytes).toBe(300000);
    expect(bc.files).toBe(1);
    expect(bc.live_via).toBe('supervisor-child');
    expect(bc.live_pid).toBe(4300);
    expect(bc.live_env_NODE_COMPILE_CACHE).toBe(TCACHE);
    expect(String(bc.bake_line)).toContain('compile cache baked: 999999 bytes');
  });

  it('turbopack+node: the Next child must carry NODE_COMPILE_CACHE, not just the supervisor', () => {
    // The supervisor has it, its child does not: the cache is not effective where it matters.
    const r = run(
      nodeCase({
        proc: {
          [CHILDREN]: '4300 ',
          [`/proc/${KPID}/environ`]: envOf(TCACHE),
          '/proc/4300/environ': 'PATH=/usr/bin\0',
        },
      }),
    );
    expect(r.status).toBe(1);
    expect(r.err).toContain('no child of the supervisor');
    expect(r.err).not.toContain('scaled away');
    // A supervisor that is alive with no child: the server exited or is draining, i.e. scaled away.
    const none = run(nodeCase({ proc: { [CHILDREN]: '' } }));
    expect(none.status).toBe(1);
    expect(none.err).toContain('pod scaled away before the live check');
    expect(none.err).toContain('exited or is draining');
    expect(none.err).not.toContain('fell back');
  });

  it('vinext+node: reads the cache from /app/.compile-cache and the main process env', () => {
    const r = run(
      nodeCase({
        build: 'vinext',
        files: { 'app/.compile-cache/v24/a.bin': 'y'.repeat(70000) },
        env: 'NODE_COMPILE_CACHE=/app/.compile-cache',
        proc: { [`/proc/${KPID}/environ`]: envOf('/app/.compile-cache') },
      }),
    );
    expect(r.status).toBe(0);
    const bc = r.ev?.bytecode as Record<string, unknown>;
    expect(bc.bytes).toBe(70000);
    expect(bc.live_via).toBe('main-process');
    // A main process without the variable fails, naming it (not a bare exit).
    const bad = run(
      nodeCase({
        build: 'vinext',
        files: { 'app/.compile-cache/v24/a.bin': 'y'.repeat(70000) },
        env: 'NODE_COMPILE_CACHE=/app/.compile-cache',
        proc: { [`/proc/${KPID}/environ`]: 'PATH=/usr/bin\0' },
      }),
    );
    expect(bad.status).toBe(1);
    expect(bad.err).toContain('has NODE_COMPILE_CACHE=');
  });

  it('node: an empty or too-small cache, or a missing NODE_COMPILE_CACHE image env, fails', () => {
    const file = 'app/.next/standalone/.next/compile-cache/v24/a.bin';
    expect(run(nodeCase({ files: { [file]: 'tiny' } })).status).not.toBe(0);
    expect(run(nodeCase({ files: {} })).status).not.toBe(0);
    expect(run(nodeCase({ env: 'FOO=1' })).status).not.toBe(0);
  });

  it('a pod that scaled away says so, never "fell back", and nothing slow ran', () => {
    const gone: Case[] = [
      nodeCase({ proc: {} }),
      nodeCase({ proc: { [CHILDREN]: '4300 ' } }), // child environ unreadable
      nodeCase({
        build: 'vinext',
        env: 'NODE_COMPILE_CACHE=/app/.compile-cache',
        files: { 'app/.compile-cache/v24/a.bin': 'y'.repeat(70000) },
        proc: {},
      }),
      bunCase({ proc: {} }),
      bunCase({ proc: { [CHILDREN]: '4301 ' } }), // child unreadable
      bunCase({ proc: { [CHILDREN]: '' } }), // supervisor alive, child gone
      nodeCase({ proc: { [CHILDREN]: '' } }),
    ];
    for (const c of gone) {
      const r = run(c);
      expect(r.status).toBe(1);
      expect(r.err).toContain('pod scaled away before the live check');
      expect(r.err).not.toContain('fell back');
      // The live reads come first, so a gone pod is found before the image is even pulled.
      expect(r.calls).not.toContain('pull');
    }
  });

  it('does every live /proc read BEFORE the image pull, the copies and the bytecode scan', () => {
    const vinextNode = nodeCase({
      build: 'vinext',
      files: { 'app/.compile-cache/v24/a.bin': 'y'.repeat(70000) },
      env: 'NODE_COMPILE_CACHE=/app/.compile-cache',
      proc: { [`/proc/${KPID}/environ`]: envOf('/app/.compile-cache') },
    });
    for (const c of [nodeCase(), bunCase(), vinextNode]) {
      const r = run(c);
      expect(r.status).toBe(0);
      const lastExec = r.calls.lastIndexOf('exec');
      const slow = r.calls.findIndex((x) => ['pull', 'create', 'cp', 'inspect'].includes(x));
      expect(lastExec).toBeGreaterThanOrEqual(0);
      expect(slow).toBeGreaterThan(lastExec);
      // And no /proc read sneaks in after the first slow call.
      expect(r.calls.slice(slow)).not.toContain('exec');
    }
  });

  it('every /proc read names the kind node it was given: a wrong node fails', () => {
    const r = run(nodeCase({ args: ['some-other-node', KPID] }));
    expect(r.status).toBe(1);
    // The docker stderr of the failed read is quoted, so a wrong node name stays visible.
    expect(r.err).toContain('No such container: some-other-node');
    expect(run(nodeCase()).status).toBe(0);
  });

  it('refuses a missing kind node or pid, and a non-numeric pid, with exit 2', () => {
    expect(run(nodeCase({ args: [] })).status).toBe(2);
    expect(run(nodeCase({ args: [NODE] })).status).toBe(2);
    expect(run(nodeCase({ args: [NODE, 'abc'] })).status).toBe(2);
    expect(run(nodeCase({ args: [NODE, ''] })).status).toBe(2);
    expect(run(nodeCase({ args: [NODE, KPID, 'extra'] })).status).toBe(2);
  });

  const M = 'knext-standalone-exec:aaaaaaaaaaaaaaaaaaaaaaaa';
  const SEXEC = '/app/.next/standalone/knext-standalone-exec';
  const bunBody = `// @bun @bytecode @bun-cjs\nglobalThis.m="${M}";\n${'.'.repeat(5000)}\0${M}\0`;
  const bunCase = (over: Partial<Case> = {}): Case => ({
    runtime: 'bun',
    build: 'turbopack',
    files: { 'app/.next/standalone/knext-standalone-exec': bunBody },
    env: `STANDALONE_SERVER_EXEC=${SEXEC}`,
    proc: {
      [CHILDREN]: '4300 4301 ',
      '/proc/4300/cmdline': 'bun\0run\0/app/knext-entry.mjs\0',
      '/proc/4300/exe': '/usr/local/bin/bun\n',
      '/proc/4300/comm': 'bun\n',
      '/proc/4301/cmdline': `${SEXEC}\0`,
      '/proc/4301/exe': `${SEXEC}\n`,
      '/proc/4301/comm': 'knext-standalon\n',
    },
    ...over,
  });

  it('standalone bun: verifies the executable through the marker scan and the live child', () => {
    const r = run(bunCase());
    expect(r.status).toBe(0);
    const bc = r.ev?.bytecode as Record<string, unknown>;
    expect(bc.kind).toBe('bun-bytecode');
    expect(bc.method).toBe('marker');
    expect(String(bc.verdict)).toContain('bytecode verified');
    expect(bc.server_exec_env).toBe(SEXEC);
    expect(bc.live_child_pid).toBe(4301);
    expect(bc.live_child_argv0).toBe(SEXEC);
    expect(bc.live_child_matched_by).toBe('argv0');
    // Without bytecode the arm fails.
    const bad = run(
      bunCase({
        files: {
          'app/.next/standalone/knext-standalone-exec': `// @bun @bun-cjs\nglobalThis.m="${M}";\n`,
        },
      }),
    );
    expect(bad.status).not.toBe(0);
  });

  it('standalone bun: a rewritten process.title is still matched, by exe or comm, and says which', () => {
    const titled = (extra: Record<string, string>) =>
      bunCase({
        proc: {
          [CHILDREN]: '4301 ',
          '/proc/4301/cmdline': 'next-server (v16.4.5)\0',
          '/proc/4301/exe': '/dev/null\n',
          '/proc/4301/comm': 'next-server (v1\n',
          ...extra,
        },
      });
    const viaExe = run(titled({ '/proc/4301/exe': `${SEXEC}\n` }));
    expect(viaExe.status).toBe(0);
    expect((viaExe.ev?.bytecode as Record<string, unknown>).live_child_matched_by).toBe('exe');
    const viaComm = run(titled({ '/proc/4301/comm': 'knext-standalon\n' }));
    expect(viaComm.status).toBe(0);
    expect((viaComm.ev?.bytecode as Record<string, unknown>).live_child_matched_by).toBe('comm');
    // None of the three: it fell back, and the error lists what it saw.
    const none = run(titled({}));
    expect(none.status).toBe(1);
    expect(none.err).toContain('fell back');
    expect(none.err).toContain("comm='next-server (v1'");
  });

  it('standalone bun: refuses a silent fallback to an uncompiled server', () => {
    // The image does not name the executable: the supervisor would run `bun server.js`.
    const noEnv = run(bunCase({ env: 'FOO=1' }));
    expect(noEnv.status).toBe(1);
    expect(noEnv.err).toContain('STANDALONE_SERVER_EXEC');
    expect(run(bunCase({ env: 'STANDALONE_SERVER_EXEC=/app/server' })).status).toBe(1);
    // The image is right but the live supervisor has no compiled child (it spawned bun server.js).
    const fallback = run(
      bunCase({
        proc: {
          [CHILDREN]: '4300 ',
          '/proc/4300/cmdline': 'bun\0server.js\0',
          '/proc/4300/exe': '/usr/local/bin/bun\n',
          '/proc/4300/comm': 'bun\n',
        },
      }),
    );
    expect(fallback.status).toBe(1);
    expect(fallback.err).toContain('fell back');
    expect(fallback.err).not.toContain('scaled away');
    // A supervisor that is alive with no child: the executable exited or is draining.
    const none = run(bunCase({ proc: { [CHILDREN]: '' } }));
    expect(none.status).toBe(1);
    expect(none.err).toContain('pod scaled away before the live check');
    expect(none.err).toContain('exited or is draining');
  });

  it('standalone bun: a zombie child never matches, not even on its surviving comm', () => {
    const stat = (state: string) => `4301 (knext-standalon) ${state} 4242 4301 4301 0 -1 4194560\n`;
    const only = (state: string, extra: Record<string, string> = {}) =>
      bunCase({
        proc: {
          [CHILDREN]: '4301 ',
          '/proc/4301/cmdline': '',
          '/proc/4301/comm': 'knext-standalon\n',
          '/proc/4301/stat': stat(state),
          ...extra,
        },
      });
    // Alive (S): the comm match is accepted.
    const alive = run(only('S'));
    expect(alive.status).toBe(0);
    expect((alive.ev?.bytecode as Record<string, unknown>).live_child_matched_by).toBe('comm');
    // Zombie (Z): the child exited, so this is a scaled-away pod, and not a match.
    const zombie = run(only('Z'));
    expect(zombie.status).toBe(1);
    expect(zombie.err).toContain('pod scaled away before the live check');
    expect(zombie.err).toContain('state=Z');
    expect(zombie.err).not.toContain('fell back');
    // The state is read after the LAST ')' of stat: a comm holding ')' and spaces still parses.
    const odd = run(only('S', { '/proc/4301/stat': '4301 (knext) (x) Z 4242 4301 4301 0\n' }));
    expect(odd.status).toBe(1);
    expect(odd.err).toContain('state=Z');
    // A live compiled child next to a zombie one is still found.
    const both = run(
      bunCase({
        proc: {
          [CHILDREN]: '4300 4301 ',
          '/proc/4300/cmdline': '',
          '/proc/4300/comm': 'knext-standalon\n',
          '/proc/4300/stat': stat('Z'),
          '/proc/4301/cmdline': `${SEXEC}\0`,
          '/proc/4301/comm': 'knext-standalon\n',
          '/proc/4301/stat': stat('S'),
        },
      }),
    );
    expect(both.status).toBe(0);
    expect((both.ev?.bytecode as Record<string, unknown>).live_child_pid).toBe(4301);
  });

  it('standalone bun: one child readable but not the executable, another unreadable: scaled away', () => {
    const r = run(
      bunCase({
        proc: {
          [CHILDREN]: '4300 4301 ',
          '/proc/4300/cmdline': 'bun\0server.js\0',
          '/proc/4300/exe': '/usr/local/bin/bun\n',
          '/proc/4300/comm': 'bun\n',
          // 4301 has no /proc entries at all: it exited between the children read and its own read.
        },
      }),
    );
    expect(r.status).toBe(1);
    expect(r.err).toContain('pod scaled away before the live check');
    expect(r.err).not.toContain('fell back');
    // The same node shape: one child with the wrong env, another unreadable.
    const n = run(
      nodeCase({
        proc: {
          [CHILDREN]: '4300 4301 ',
          '/proc/4300/environ': 'PATH=/usr/bin\0',
        },
      }),
    );
    expect(n.status).toBe(1);
    expect(n.err).toContain('pod scaled away before the live check');
  });

  it('fails CLOSED when a child stat is unreadable, whatever the child matched on', () => {
    const base = (proc: Record<string, string>, noStat: string[] = ['4301']) =>
      bunCase({ proc: { [CHILDREN]: '4301 ', ...proc }, noStat });
    // comm-only match, stat unreadable: scaled away, never accepted.
    const comm = run(
      base({
        '/proc/4301/cmdline': '',
        '/proc/4301/comm': 'knext-standalon\n',
      }),
    );
    expect(comm.status).toBe(1);
    expect(comm.err).toContain('pod scaled away before the live check');
    expect(comm.err).toContain('state=unreadable');
    expect(comm.err).not.toContain('fell back');
    expect(comm.ev).toBeNull();
    // argv0 and exe matches are held to the same rule.
    const argv0 = run(base({ '/proc/4301/cmdline': `${SEXEC}\0` }));
    expect(argv0.status).toBe(1);
    expect(argv0.err).toContain('scaled away');
    const exe = run(
      base({ '/proc/4301/cmdline': '', '/proc/4301/exe': `${SEXEC}\n`, '/proc/4301/comm': 'x\n' }),
    );
    expect(exe.status).toBe(1);
    expect(exe.err).toContain('scaled away');
    // A stat with no state field is unreadable too.
    const junk = run(
      base(
        {
          '/proc/4301/cmdline': `${SEXEC}\0`,
          '/proc/4301/stat': 'garbage\n',
        },
        [],
      ),
    );
    expect(junk.status).toBe(1);
    expect(junk.err).toContain('scaled away');
  });

  it('proc_state is an allowlist: every live state is accepted, an empty or unknown one is unreadable', () => {
    const withState = (state: string, tail = ' 4242 4300 4300 0') =>
      nodeCase({
        proc: {
          [CHILDREN]: '4300 ',
          '/proc/4300/environ': envOf(TCACHE),
          '/proc/4300/stat': `4300 (next-server (v1) ${state}${tail}\n`,
        },
      });
    for (const live of ['R', 'S', 'D', 'T', 't', 'W', 'I', 'P'])
      expect(run(withState(live)).status, `state ${live}`).toBe(0);
    // Empty state: the stat ends right after ") ".
    const empty = run(
      nodeCase({
        proc: {
          [CHILDREN]: '4300 ',
          '/proc/4300/environ': envOf(TCACHE),
          '/proc/4300/stat': '4300 (next-server) \n',
        },
      }),
    );
    expect(empty.status).toBe(1);
    expect(empty.err).toContain('pod scaled away before the live check');
    expect(empty.ev).toBeNull();
    // A stat with no `) ` is unparseable even when it happens to start with a live letter.
    for (const junk of ['S garbage', 'Sxyz', 'R']) {
      const r = run(
        nodeCase({
          proc: {
            [CHILDREN]: '4300 ',
            '/proc/4300/environ': envOf(TCACHE),
            '/proc/4300/stat': `${junk}\n`,
          },
        }),
      );
      expect(r.status, `stat ${junk}`).toBe(1);
      expect(r.err).toContain('pod scaled away before the live check');
    }
    // Unknown letters (and a lowercase z, and a digit) are not live.
    for (const bad of ['Q', 'K', 'z', 'x', '9']) {
      const r = run(withState(bad));
      expect(r.status, `state ${bad}`).toBe(1);
      expect(r.err).toContain('pod scaled away before the live check');
    }
    // The same rule on the bun loop: an empty state and an unknown letter never accept a match.
    for (const stat of ['4301 (knext-standalon) \n', '4301 (knext-standalon) Q 4242 0 0\n']) {
      const r = run(
        bunCase({
          proc: {
            [CHILDREN]: '4301 ',
            '/proc/4301/cmdline': `${SEXEC}\0`,
            '/proc/4301/comm': 'knext-standalon\n',
            '/proc/4301/stat': stat,
          },
        }),
      );
      expect(r.status).toBe(1);
      expect(r.err).toContain('state=unreadable');
      expect(r.err).not.toContain('fell back');
    }
    // And the vinext+node main process.
    const vn = run(
      nodeCase({
        build: 'vinext',
        files: { 'app/.compile-cache/v24/a.bin': 'y'.repeat(70000) },
        env: 'NODE_COMPILE_CACHE=/app/.compile-cache',
        proc: {
          [`/proc/${KPID}/environ`]: envOf('/app/.compile-cache'),
          [`/proc/${KPID}/stat`]: `${KPID} (node) \n`,
        },
      }),
    );
    expect(vn.status).toBe(1);
    expect(vn.err).toContain('scaled away');
  });

  it('node: a zombie child, or one with an unreadable stat, is scaled away, never a match', () => {
    const withState = (state: string) =>
      nodeCase({
        proc: {
          [CHILDREN]: '4300 ',
          // A zombie's /proc environ reads EMPTY (it keeps only its comm), so the stat state is what
          // turns it into "scaled away" instead of a misleading "no child has the cache".
          '/proc/4300/environ': state === 'Z' || state === 'X' ? '' : envOf(TCACHE),
          '/proc/4300/stat': `4300 (next-server (v1) ${state} 4242 4300 4300 0\n`,
        },
      });
    expect(run(withState('S')).status).toBe(0);
    const z = run(withState('Z'));
    expect(z.status).toBe(1);
    expect(z.err).toContain('pod scaled away before the live check');
    expect(z.err).not.toContain('no child of the supervisor');
    expect(z.ev).toBeNull();
    const x = run(withState('X'));
    expect(x.status).toBe(1);
    expect(x.err).toContain('pod scaled away before the live check');
    expect(x.err).not.toContain('no child of the supervisor');
    expect(x.ev).toBeNull();
    const noStat = run(nodeCase({ noStat: ['4300'] }));
    expect(noStat.status).toBe(1);
    expect(noStat.err).toContain('scaled away');
    // A live child next to a zombie one is still found.
    const both = run(
      nodeCase({
        proc: {
          [CHILDREN]: '4299 4300 ',
          '/proc/4299/environ': '',
          '/proc/4299/stat': '4299 (n) Z 4242 0 0\n',
          '/proc/4300/environ': envOf(TCACHE),
        },
      }),
    );
    expect(both.status).toBe(0);
    expect((both.ev?.bytecode as Record<string, unknown>).live_pid).toBe(4300);
  });

  it('vinext+node: a zombie or stat-less main process is scaled away', () => {
    const vn = (over: Partial<Case>) =>
      nodeCase({
        build: 'vinext',
        files: { 'app/.compile-cache/v24/a.bin': 'y'.repeat(70000) },
        env: 'NODE_COMPILE_CACHE=/app/.compile-cache',
        proc: { [`/proc/${KPID}/environ`]: envOf('/app/.compile-cache') },
        ...over,
      });
    expect(run(vn({})).status).toBe(0);
    const noStat = run(vn({ noStat: [KPID] }));
    expect(noStat.status).toBe(1);
    expect(noStat.err).toContain('scaled away');
    const z = run(
      vn({
        proc: {
          [`/proc/${KPID}/environ`]: envOf('/app/.compile-cache'),
          [`/proc/${KPID}/stat`]: `${KPID} (node) Z 1 0 0\n`,
        },
      }),
    );
    expect(z.status).toBe(1);
    expect(z.err).toContain('zombie');
  });

  it('a non-numeric entry in the children file is never followed, node or bun', () => {
    // `4301/../4301` would resolve to a real fixture dir if it were used as a path.
    const bun = run(bunCase({ proc: { ...bunCase().proc, [CHILDREN]: '4301/../4301 ' } }));
    expect(bun.status).toBe(1);
    expect(bun.err).toContain('scaled away');
    expect(bun.err).toContain('not-a-pid');
    const node = run(nodeCase({ proc: { ...nodeCase().proc, [CHILDREN]: '4300/../4300 ' } }));
    expect(node.status).toBe(1);
    expect(node.err).toContain('scaled away');
  });

  it('whitespace-only children counts as no children, not as a child', () => {
    expect(run(nodeCase({ proc: { [CHILDREN]: ' \n' } })).err).toContain('exited or is draining');
    expect(run(bunCase({ proc: { [CHILDREN]: '  ' } })).err).toContain('exited or is draining');
  });

  it('quotes the read that FAILED even when a later read succeeds', () => {
    // node: 4300 environ is missing (its read fails first), 4301 is readable but has no cache env.
    const n = run(
      nodeCase({
        proc: {
          [CHILDREN]: '4300 4301 ',
          '/proc/4300/stat': '4300 (a) S 1 0 0\n',
          '/proc/4301/environ': 'PATH=/usr/bin\0',
        },
      }),
    );
    expect(n.status).toBe(1);
    expect(n.err).toContain('failed reads:');
    expect(n.err).toContain('[cat /proc/4300/environ]');
    expect(n.err).toContain('No such file');
    // bun: the first child has nothing readable, the second is readable but not the executable.
    const b = run(
      bunCase({
        proc: {
          [CHILDREN]: '4300 4301 ',
          '/proc/4301/cmdline': 'bun\0server.js\0',
          '/proc/4301/exe': '/usr/local/bin/bun\n',
          '/proc/4301/comm': 'bun\n',
        },
      }),
    );
    expect(b.status).toBe(1);
    expect(b.err).toContain('[cat /proc/4300/cmdline]');
    expect(b.err).not.toContain('fell back');
  });

  it('vinext bun: needs BYTECODE_BASELINE and a higher @bytecode pragma count than it', () => {
    const P = '// @bun @bytecode @bun-cjs\n';
    const d = mkdtempSync(join(tmpdir(), 'base-'));
    try {
      const baseline = join(d, 'baseline');
      writeFileSync(baseline, P);
      const vcase = (body: string): Case => ({
        runtime: 'bun',
        build: 'vinext',
        files: { 'app/server': body },
      });
      const noBaseline = run(vcase(`${P}${P}`));
      expect(noBaseline.status).toBe(2);
      expect(noBaseline.err).toContain('BYTECODE_BASELINE');
      const ok = run(vcase(`${P}${P}`), baseline);
      expect(ok.status).toBe(0);
      const bc = ok.ev?.bytecode as Record<string, unknown>;
      expect(bc.method).toBe('pragma-differential');
      expect(String(bc.verdict)).toContain('the build requested bytecode');
      expect(String(bc.verdict)).not.toMatch(/carries bytecode|proven/);
      expect(run(vcase(P), baseline).status).not.toBe(0);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});
describe('kind/check-versions.sh (behaviour)', () => {
  const CHECK = resolve(DIR, 'kind/check-versions.sh');
  type V = { next?: string; react?: string; 'react-dom'?: string };
  const evidence = (rows: { arm: string; build: string; app?: string; v: V }[]) => {
    const d = mkdtempSync(join(tmpdir(), 'ver-'));
    for (const r of rows)
      writeFileSync(
        join(d, `evidence-${r.arm}.json`),
        JSON.stringify({
          arm: r.arm,
          build_target: r.build,
          app: r.app ?? 'scaffold',
          versions: r.v,
        }),
      );
    const out = spawnSync('bash', [CHECK, d], { encoding: 'utf8' });
    rmSync(d, { recursive: true, force: true });
    return out;
  };
  const same = { next: '16.4.5', react: '19.3.1', 'react-dom': '19.3.1' };

  it('passes when every scaffold arm resolved the same versions', () => {
    const r = evidence([
      { arm: 'a', build: 'turbopack', v: same },
      { arm: 'b', build: 'vinext', v: same },
    ]);
    expect(r.status).toBe(0);
    expect(r.stdout).not.toContain('NOTE');
  });

  it('records, not fails, a react that differs between build tools, and says so', () => {
    const r = evidence([
      { arm: 'a', build: 'turbopack', v: { ...same, react: '19.2.6', 'react-dom': '19.2.6' } },
      { arm: 'b', build: 'vinext', v: same },
    ]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('NOTE: react differs between build tools');
    expect(r.stdout).toContain('turbopack=19.2.6');
    expect(r.stdout).toContain('vinext=19.3.1');
  });

  it('fails when react differs among the arms of one build tool', () => {
    const r = evidence([
      { arm: 'a', build: 'vinext', v: same },
      { arm: 'b', build: 'vinext', v: { ...same, react: '19.2.6' } },
    ]);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('react differs among the vinext arms');
  });

  it('fails when next differs across arms, or a version is missing', () => {
    expect(
      evidence([
        { arm: 'a', build: 'turbopack', v: same },
        { arm: 'b', build: 'vinext', v: { ...same, next: '16.4.4' } },
      ]).status,
    ).toBe(1);
    expect(evidence([{ arm: 'a', build: 'turbopack', v: { next: '16.4.5' } }]).status).toBe(1);
  });

  it('does not compare the spike-zone arms, and passes when there are no scaffold arms', () => {
    const r = evidence([
      { arm: 'a', build: 'turbopack', app: 'spike', v: { ...same, next: '1.0.0' } },
      { arm: 'b', build: 'turbopack', app: 'spike', v: same },
    ]);
    expect(r.status).toBe(0);
  });

  it('rejects a missing directory with exit 2', () => {
    expect(spawnSync('bash', [CHECK, '/nonexistent-dir'], { encoding: 'utf8' }).status).toBe(2);
  });
});

describe('workflow wiring of the evidence and version checks', () => {
  const lines = code.split('\n');
  const idx = (re: RegExp) => lines.findIndex((l) => re.test(l));
  const REC_LINE =
    'scripts/bench-cold-start-phases/kind/record-evidence.sh "$arm" "$runtime" "$build" "$app" "$img" "${out}/build-${key}.log" "$out" "$knode" "$kpid"';

  it('calls record-evidence.sh with exactly these arguments, once', () => {
    expect(lines.filter((l) => l.includes('kind/record-evidence.sh') && !/^\s*#/.test(l))).toEqual([
      `            ${REC_LINE}`,
    ]);
  });

  it('does not swallow its failure: no `|| true`, `|| :`, `if`, `!`, pipe or continuation around it', () => {
    const at = idx(/kind\/record-evidence\.sh/);
    expect(at).toBeGreaterThan(0);
    expect(lines[at].trim()).toBe(REC_LINE);
    expect(lines[at]).not.toMatch(/\|\||&&|\|\s*$|;\s*$|\\\s*$/);
    // The neighbours do not make it conditional or chain onto it.
    expect(lines[at - 1]).not.toMatch(/(\|\||&&|\\|\bthen|\bdo|\{)\s*$/);
    expect(lines[at + 1]).not.toMatch(/^\s*(\|\||&&|\|)/);
    // Same rule for the version comparison.
    const v = idx(/kind\/check-versions\.sh/);
    expect(lines[v].trim()).toBe('scripts/bench-cold-start-phases/kind/check-versions.sh "$out"');
    expect(lines[v - 1]).not.toMatch(/(\|\||&&|\\|\bthen|\bdo|\{)\s*$/);
  });

  it('sits inside the deploy loop, after the process check, and before drive.py', () => {
    const loopStart = idx(/while read -r -u 3 arm runtime cpulimit build app; do/);
    const loopEnd = lines.findIndex((l, i) => i > loopStart && /^\s*done 3< /.test(l));
    const rec = idx(/kind\/record-evidence\.sh/);
    const proc = idx(/"\$chk" "\$proc_rt"/);
    const drive = idx(/drive\.py "\$N" "\$ARMS"/);
    expect(loopStart).toBeGreaterThan(0);
    expect(rec).toBeGreaterThan(loopStart);
    expect(rec).toBeLessThan(loopEnd);
    expect(rec).toBeGreaterThan(proc);
    expect(idx(/kpid="\$\(printf/)).toBeLessThan(rec);
    expect(idx(/knode="\$\{CLUSTER\}-control-plane"/)).toBeLessThan(rec);
    // check-versions runs after every arm has its evidence, still before the wakes.
    const ver = idx(/kind\/check-versions\.sh/);
    expect(ver).toBeGreaterThan(loopEnd);
    expect(ver).toBeLessThan(drive);
    expect(rec).toBeLessThan(drive);
  });

  it('checks spec.build/spec.runtime BEFORE the pod and pid lookup, and the evidence right after the process check', () => {
    const specBuild = idx(/spec_build="\$\(kubectl/);
    const specRuntime = idx(/spec_runtime="\$\(kubectl/);
    const podLookup = idx(/^\s*pod=""$/);
    const crictl = idx(/crictl inspect "\$cid"/);
    const proc = idx(/"\$chk" "\$proc_rt"/);
    const rec = idx(/kind\/record-evidence\.sh/);
    expect(specBuild).toBeGreaterThan(0);
    expect(specBuild).toBeLessThan(podLookup);
    expect(specRuntime).toBeLessThan(podLookup);
    expect(podLookup).toBeLessThan(crictl);
    // Nothing but the error line and comments sits between the process check and the evidence call.
    const between = lines.slice(proc + 1, rec).filter((l) => !/^\s*#/.test(l) && l.trim() !== '');
    expect(between.map((l) => l.trim())).toEqual([
      '|| { echo "::error::arm ${arm} (${runtime}, ${build}) main process is not ${proc_rt}"; exit 1; }',
    ]);
    // The merge that needs the spec values comes after the evidence.
    expect(idx(/--arg sb "\$\{spec_build:-turbopack\}"/)).toBeGreaterThan(rec);
  });

  it('says "scaled away" when its own cmdline read fails', () => {
    expect(code).toMatch(
      /pod scaled away before the live check: could not read \/proc\/\$\{kpid\}\/cmdline/,
    );
  });

  it('judges a vinext+bun process as bun-exec only when BOTH build and runtime say so', () => {
    expect(code).toContain(
      'proc_rt="$runtime"; [ "$build" = vinext ] && [ "$runtime" = bun ] && proc_rt="bun-exec"',
    );
  });

  it('compiles the baseline probe WITHOUT bytecode, anchored to the exact command', () => {
    expect(code).toMatch(
      /^ +bun build --compile --minify --target=bun-linux-x64-musl "\$\{RUNNER_TEMP\}\/probe\.js" --outfile "\$\{RUNNER_TEMP\}\/bytecode-baseline"$/m,
    );
    // Adding --bytecode (or anything) to the probe defeats the differential.
    for (const l of lines.filter((x) => x.includes('probe.js') && x.includes('bun build')))
      expect(l).not.toMatch(/--bytecode/);
  });

  it('the versions snippet reads next, react and react-dom from the installed app', () => {
    // Run the workflow's own `node -e` against a fixture node_modules, not a text match.
    const line = lines.find((l) => l.includes('versions="$(cd'));
    expect(line).toBeDefined();
    const m = (line ?? '').match(/node -e "(.*)"\)"$/);
    expect(m).not.toBeNull();
    const d = mkdtempSync(join(tmpdir(), 'vers-'));
    try {
      for (const [name, version] of [
        ['next', '16.4.5'],
        ['react', '19.3.1'],
        ['react-dom', '19.3.2'],
      ]) {
        mkdirSync(join(d, 'node_modules', name), { recursive: true });
        writeFileSync(join(d, 'node_modules', name, 'package.json'), JSON.stringify({ version }));
      }
      const r = spawnSync('node', ['-e', m?.[1] ?? ''], { cwd: d, encoding: 'utf8' });
      expect(r.status).toBe(0);
      expect(JSON.parse(r.stdout)).toEqual({
        next: '16.4.5',
        react: '19.3.1',
        'react-dom': '19.3.2',
      });
      // The result is merged into the evidence file.
      expect(code).toMatch(/--argjson v "\$versions"/);
      expect(code).toMatch(/versions: \$v/);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });

  it('records spec_runtime as JSON null for vinext arms, never as an empty string', () => {
    // vinext omits spec.runtime from the CR, so its read is legitimately empty. An empty string in
    // the evidence would look exactly like a failed read, so the filter maps an EMPTY vinext read to
    // null (a non-empty vinext value is kept). Run the
    // workflow's own jq filter, not a text match, against a vinext arm and a bun arm.
    const m = text.match(/'(\. \+ \{spec_build: \$sb, [^']*\})'/);
    expect(m).not.toBeNull();
    const filter = m?.[1] ?? '';
    expect(filter).not.toMatch(/spec_runtime: \$sr[,}]/);
    const run = (build: string, runtime: string) => {
      const r = spawnSync(
        'jq',
        [
          '-c',
          '--arg',
          'sb',
          'turbopack',
          '--arg',
          'sr',
          runtime,
          '--arg',
          'b',
          build,
          '--arg',
          'cpu',
          '1000m',
          '--argjson',
          'v',
          '{"next":"16.4.5"}',
          filter,
        ],
        { input: '{"arm":"x"}', encoding: 'utf8' },
      );
      expect(r.status).toBe(0);
      return JSON.parse(r.stdout) as { spec_runtime: unknown };
    };
    expect(run('vinext', '').spec_runtime).toBeNull();
    // A vinext CR that does emit a runtime keeps it: only an empty read is mapped to null.
    expect(run('vinext', 'bun').spec_runtime).toBe('bun');
    expect(run('turbopack', 'bun').spec_runtime).toBe('bun');
    expect(run('turbopack', 'node').spec_runtime).toBe('node');
  });

  it('keeps every comment line at 110 columns or fewer', () => {
    const long = text
      .split('\n')
      .filter((l) => /^\s*#/.test(l) && l.length > 110 && !l.includes('sha256:'));
    expect(long).toEqual([]);
  });
});
