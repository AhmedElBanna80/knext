import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * GUARD TEST for .github/workflows/coldstart-phases-kind-native.yml, the native amd64 run of the
 * kind cold-start phase harness.
 *
 * Invariants a casual edit could silently destroy:
 * 1. DISPATCH-ONLY. A measurement tool, not a gate: no schedule, push or pull_request trigger.
 * 2. Inputs n, arms, ready_window_s with the agreed defaults (12, three arms, 20), validated in the
 *    shell (n >= 12, window 16..45) and reaching the shell through env only.
 * 3. The three arms resolve (node 1000m, node no-limit, bun 1000m) and unknown arms are refused.
 * 4. Every action is pinned by a 40-hex SHA with a `# vX.Y.Z` comment; permissions are read-only;
 *    concurrency cancels in progress.
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
const SUMMARY_PY = resolve(DIR, 'kind/summarize-native.py');
const text = readFileSync(WF, 'utf8');

/** The workflow text with whole-line comments removed, so a comment cannot satisfy a scan. */
const code = text
  .split('\n')
  .filter((l) => !/^\s*#/.test(l))
  .join('\n');

function arms(arg?: string) {
  return spawnSync('bash', [ARMS_SH, ...(arg === undefined ? [] : [arg])], { encoding: 'utf8' });
}

describe('coldstart-phases-kind-native workflow shape', () => {
  it('is dispatch-only: no schedule, push or pull_request trigger', () => {
    const on = code.slice(code.indexOf('\non:'), code.indexOf('\npermissions:'));
    expect(on).toMatch(/workflow_dispatch:/);
    expect(on).not.toMatch(/\bschedule:/);
    expect(on).not.toMatch(/\bcron:/);
    expect(on).not.toMatch(/\bpush:/);
    expect(on).not.toMatch(/\bpull_request(_target)?:/);
  });

  it('declares the three inputs with the agreed defaults', () => {
    expect(code).toMatch(/\n {6}n:\n(?: {8}.*\n)*? {8}default: '12'/);
    expect(code).toMatch(
      /\n {6}arms:\n(?: {8}.*\n)*? {8}default: 'node-1000m,node-nolimit,bun-1000m'/,
    );
    expect(code).toMatch(/\n {6}ready_window_s:\n(?: {8}.*\n)*? {8}default: '20'/);
  });

  it('validates the inputs in the shell and passes them through env only', () => {
    expect(code).toMatch(/\[ "\$N" -ge 12 \]/);
    expect(code).toMatch(/"\$READY_WINDOW_S" -lt 16/);
    expect(code).toMatch(/"\$READY_WINDOW_S" -gt 45/);
    // No dispatch input is templated into a run: script.
    const runBodies = code.split(/\n\s+run: /).slice(1);
    for (const body of runBodies) expect(body).not.toMatch(/github\.event\.inputs/);
  });

  it('has read-only permissions and a cancel-in-progress concurrency group', () => {
    expect(code).toMatch(/\npermissions:\n {2}contents: read\n/);
    expect(code).toMatch(/\nconcurrency:\n {2}group: \S+\n {2}cancel-in-progress: true\n/);
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

  it('runs on amd64 ubuntu-latest and checks the node architecture', () => {
    expect(code).toMatch(/runs-on: ubuntu-latest/);
    expect(code).toMatch(/uname -m/);
    expect(code).toMatch(/test "\$\(cat "\$\{RUNNER_TEMP\}\/node-arch\.txt"\)" = amd64/);
  });

  it('loads images into kind rather than pulling inside it', () => {
    expect(code).toMatch(/kind load docker-image "\$IMG" --name "\$CLUSTER"/);
    expect(code).toMatch(/kind load docker-image node:24-alpine --name "\$CLUSTER"/);
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
