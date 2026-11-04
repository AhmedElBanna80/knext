import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';

/**
 * The cold-start bench harness (drive.py + cold-cycle.mjs) produces the OKE numbers
 * the cold-start ledger cites. It used to exist as two diverging copies with one
 * cluster's context, namespace, node IPs and scratch paths hard-coded. These tests
 * pin the single-copy layout, scan the harness code for cluster literals, and drive
 * the real drive.py against a fake `kubectl` on PATH (no cluster) to prove that
 * every setting comes from flags, environment or a config file.
 */

const ROOT = resolve(import.meta.dir, '..');
const DIR = join(ROOT, 'scripts/bench-cold-start-phases');
// Repo-relative paths are written out in full on purpose: the directory-scan guard in
// bench-cold-start-analyzers.test.ts treats a quoted occurrence of a script's path as
// "this script has a test".
const DRIVE = 'scripts/bench-cold-start-phases/drive.py';
const COLD_CYCLE = 'scripts/bench-cold-start-phases/cold-cycle.mjs';
const BENCHCONFIG = 'scripts/bench-cold-start-phases/benchconfig.py';
const ANALYZE = 'scripts/bench-cold-start-phases/analyze.py';
const VERIFY_ARMS = 'scripts/bench-cold-start-phases/gke/verify-arms.sh';
const FIXTURE = join(ROOT, 'tests/fixtures/bench-cold-start-phases');

function walk(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir)) {
    const p = join(dir, e);
    if (statSync(p).isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

describe('one harness, no diverging copy', () => {
  it('has exactly one drive.py and one cold-cycle.mjs under the bench directory', () => {
    const files = walk(DIR).map((p) => relative(DIR, p));
    expect(files.filter((f) => f.endsWith('drive.py') && !f.includes('-drive.py'))).toEqual([
      'drive.py',
    ]);
    expect(files.filter((f) => f.endsWith('cold-cycle.mjs'))).toEqual(['cold-cycle.mjs']);
  });

  it('keeps cluster-specific literals out of the harness code', () => {
    // Scan the directory, not a list: a literal added to any harness script must go red.
    // Code files only; the YAML manifests under it are example cluster objects.
    const scanned = walk(DIR)
      .filter((p) => /\.(py|sh|mjs|js)$/.test(p))
      .map((p) => relative(ROOT, p));
    expect(scanned.length).toBeGreaterThanOrEqual(20);
    for (const f of [DRIVE, COLD_CYCLE, BENCHCONFIG, ANALYZE, VERIFY_ARMS]) {
      expect(scanned).toContain(f);
    }
    const forbidden: Array<[string, RegExp]> = [
      // Loopback and the unspecified bind address are not cluster literals.
      ['an IPv4 address', /\b(?!127\.0\.0\.1\b|0\.0\.0\.0\b)\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/],
      ['a kubectl context name', /knext-oke-sa|knext-coldstart/],
      ['the bench namespace', /bench-cells/],
      ['a node-agent pod name', /\bagent-(?:118|169|1ws1|c8bn|fm3s)\b/],
      ['a GKE node name', /gke-knext-/],
    ];
    const hits: string[] = [];
    for (const rel of scanned) {
      const text = readFileSync(join(ROOT, rel), 'utf8');
      for (const [what, re] of forbidden) if (re.test(text)) hits.push(`${rel}: ${what}`);
    }
    expect(hits).toEqual([]);
  });
});

// ------------------------------------------------------------------ fake kubectl

const FAKE_KUBECTL = `#!/usr/bin/env python3
import json, os, sys
args = sys.argv[1:]
with open(os.environ["FAKE_KUBECTL_LOG"], "a") as f:
    f.write(json.dumps(args) + "\\n")
joined = " ".join(args)
if "get nodes" in joined:
    print(json.dumps({"items": [
        {"metadata": {"name": "n1", "labels": {os.environ.get("FAKE_POOL_LABEL", "pool"): "p1"}}},
        {"metadata": {"name": "n2", "labels": {os.environ.get("FAKE_POOL_LABEL", "pool"): "p2"}}},
    ]}))
elif "get pods" in joined:
    print(json.dumps({"items": []}))
elif " cat " in joined:
    print(json.dumps({"arm": "a1", "code": 200, "node": "n1", "marker": "ok", "watch": {"resp_end": 1}}))
`;

type Run = { code: number; out: string; err: string; calls: string[][]; rows: unknown[] };

function runDrive(
  argv: string[],
  opts: { env?: Record<string, string>; config?: object } = {},
): Run {
  const dir = mkdtempSync(join(tmpdir(), 'bench-harness-'));
  try {
    const bin = join(dir, 'bin');
    const log = join(dir, 'kubectl.log');
    const outFile = join(dir, 'out.jsonl');
    mkdirSync(bin);
    writeFileSync(join(bin, 'kubectl'), FAKE_KUBECTL);
    chmodSync(join(bin, 'kubectl'), 0o755);
    writeFileSync(log, '');
    // Always point at a config file so a developer's local bench-config.json can never
    // leak into the run.
    const cfgPath = join(dir, 'config.json');
    writeFileSync(cfgPath, JSON.stringify(opts.config ?? {}));
    const env: Record<string, string> = {
      PATH: `${bin}:${process.env.PATH}`,
      HOME: dir,
      PYTHONDONTWRITEBYTECODE: '1',
      FAKE_KUBECTL_LOG: log,
      KNEXT_BENCH_CONFIG: cfgPath,
      ...opts.env,
    };
    const r = spawnSync(
      'python3',
      [join(ROOT, DRIVE), ...argv.map((a) => a.replace('$OUT', outFile))],
      { encoding: 'utf8', env, timeout: 60_000 },
    );
    const calls = readFileSync(log, 'utf8')
      .split('\n')
      .filter(Boolean)
      .map((l) => JSON.parse(l) as string[]);
    const rows = existsSync(outFile)
      ? readFileSync(outFile, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((l) => JSON.parse(l))
      : [];
    return { code: r.status ?? -1, out: r.stdout, err: r.stderr, calls, rows };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const FAST = ['--settle=0', '--poll-interval=0'];
const base = (extra: string[] = []) => ['1', 'a1', '$OUT', ...FAST, ...extra];
const flat = (calls: string[][]) => calls.map((c) => c.join(' '));

describe('drive.py: settings come from flags, env or a config file', () => {
  it('with no settings at all, passes no context and no namespace to kubectl and uses the default pod and /tmp', () => {
    const r = runDrive(base());
    expect(r.code).toBe(0);
    expect(r.calls.length).toBeGreaterThan(0);
    for (const c of r.calls) {
      expect(c).not.toContain('--context');
      expect(c).not.toContain('-n');
    }
    const lines = flat(r.calls);
    expect(
      lines.some((l) =>
        /^cp \S+cold-cycle\.mjs phase-bench:\/tmp\/cold-cycle\.mjs -c harness$/.test(l),
      ),
    ).toBe(true);
    expect(
      lines.some((l) => l.includes('exec phase-bench -c harness') && l.includes('/tmp/run-')),
    ).toBe(true);
    expect(r.rows).toHaveLength(1);
  });

  it('applies --context, --namespace, --pod and --scratch-dir to every call', () => {
    const r = runDrive(
      base(['--context=ctx-x', '--namespace=ns-y', '--pod=pod-z', '--scratch-dir=/scratch/q']),
    );
    expect(r.code).toBe(0);
    for (const c of r.calls) {
      expect(c.slice(0, 4)).toEqual(['--context', 'ctx-x', '-n', 'ns-y']);
    }
    const lines = flat(r.calls);
    expect(lines.some((l) => l.endsWith('pod-z:/scratch/q/cold-cycle.mjs -c harness'))).toBe(true);
    const launch = lines.find((l) => l.includes('nohup'));
    expect(launch).toContain('exec pod-z -c harness');
    expect(launch).toContain('node /scratch/q/cold-cycle.mjs a1 > /scratch/q/run-');
    expect(launch).toContain('NS=ns-y');
    expect(launch).not.toContain('/tmp/');
  });

  it('reads the same settings from a config file', () => {
    const r = runDrive(base(), {
      config: { context: 'ctx-f', namespace: 'ns-f', harnessPod: 'pod-f', scratchDir: '/sf' },
    });
    expect(r.code).toBe(0);
    for (const c of r.calls) expect(c.slice(0, 4)).toEqual(['--context', 'ctx-f', '-n', 'ns-f']);
    expect(flat(r.calls).some((l) => l.includes('pod-f:/sf/cold-cycle.mjs'))).toBe(true);
  });

  it('ranks flag over environment over config file', () => {
    const cfg = { context: 'from-file', namespace: 'ns-file', harnessPod: 'pod-file' };
    const env = { KNEXT_BENCH_CONTEXT: 'from-env', KNEXT_BENCH_NAMESPACE: 'ns-env' };
    const r = runDrive(base(['--namespace=ns-flag']), { config: cfg, env });
    expect(r.code).toBe(0);
    // context: env beats file; namespace: flag beats env; pod: only the file sets it.
    for (const c of r.calls)
      expect(c.slice(0, 4)).toEqual(['--context', 'from-env', '-n', 'ns-flag']);
    expect(flat(r.calls).some((l) => l.includes('exec pod-file -c harness'))).toBe(true);
  });

  it('still honours the older PHASE_POD variable for the harness pod', () => {
    const r = runDrive(base(), { env: { PHASE_POD: 'phase-bench-2' } });
    expect(flat(r.calls).some((l) => l.includes('exec phase-bench-2 -c harness'))).toBe(true);
  });

  it('hands the node -> agent-pod map and the namespace to the in-cluster harness', () => {
    const r = runDrive(base(['--namespace=ns-y', '--agent-pods={"node-1":"agent-a"}']));
    const launch = flat(r.calls).find((l) => l.includes('nohup')) ?? '';
    expect(launch).toContain('NS=ns-y');
    expect(launch).toContain('AGENT_PODS=');
    expect(launch).toContain('node-1');
    expect(launch).toContain('agent-a');
  });

  it('rejects a config file with an unknown key instead of silently ignoring it', () => {
    const r = runDrive(base(), { config: { contxt: 'typo' } });
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('contxt');
  });

  it('places an arm@pool spec by cordoning the other pools, then uncordons everything', () => {
    const r = runDrive(['1', 'a1@p1', '$OUT', ...FAST, '--pool-label=my/pool'], {
      env: { FAKE_POOL_LABEL: 'my/pool' },
    });
    expect(r.code).toBe(0);
    const verbs = r.calls
      .filter((c) => c.some((a) => a === 'cordon' || a === 'uncordon'))
      .map((c) =>
        c
          .filter((a) => a !== '--context')
          .slice(-2)
          .join(' '),
      );
    // wake placed on p1: cordon n2 (p2), uncordon n1 (p1); finally uncordon both.
    expect(verbs).toContain('cordon n2');
    expect(verbs).toContain('uncordon n1');
    expect(verbs.slice(-2).sort()).toEqual(['uncordon n1', 'uncordon n2']);
    expect(r.rows[0]).toMatchObject({ arm: 'a1@p1', pool: 'p1' });
  });

  it('does not touch node scheduling when no arm names a pool', () => {
    const r = runDrive(base());
    expect(flat(r.calls).some((l) => /cordon|get nodes/.test(l))).toBe(false);
  });
});

describe('cold-cycle.mjs: in-cluster settings', () => {
  function printConfig(env: Record<string, string>) {
    const r = spawnSync('node', [join(ROOT, COLD_CYCLE), '--print-config', 'a1'], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', ...env },
    });
    return { code: r.status ?? -1, json: r.stdout ? JSON.parse(r.stdout) : null, err: r.stderr };
  }

  it('takes the namespace, agent map and agent label from the environment', () => {
    const r = printConfig({
      NS: 'ns-y',
      AGENT_PODS: '{"node-1":"agent-a"}',
      AGENT_LABEL: 'role=probe',
    });
    expect(r.code).toBe(0);
    expect(r.json).toMatchObject({
      namespace: 'ns-y',
      agentPods: { 'node-1': 'agent-a' },
      agentLabel: 'role=probe',
      arm: 'a1',
    });
  });

  it('defaults to no agent map and the phase-agent label, with no namespace literal', () => {
    const r = printConfig({ NS: 'ns-y' });
    expect(r.json).toMatchObject({ agentPods: {}, agentLabel: 'app=phase-agent' });
  });
});

describe('analyze.py: namespace filter is a flag, not a literal', () => {
  function analyze(extra: string[]) {
    const r = spawnSync(
      'python3',
      [
        join(ROOT, ANALYZE),
        join(FIXTURE, 'run.jsonl'),
        `--autoscaler=${join(FIXTURE, 'autoscaler.jsonl')}`,
        `--activator=${join(FIXTURE, 'activator.jsonl')}`,
        ...extra,
      ],
      {
        encoding: 'utf8',
        env: {
          ...process.env,
          PYTHONDONTWRITEBYTECODE: '1',
          KNEXT_BENCH_CONFIG: join(FIXTURE, 'empty-config.json'),
        },
      },
    );
    return r.stdout;
  }

  it('--namespace keeps only that namespace; another namespace yields no control-plane rows', () => {
    const mine = analyze(['--namespace=bench-cells']);
    const none = analyze(['--namespace=nowhere']);
    expect(mine).toContain('0 autoscaler decides 0->1');
    expect(none).not.toContain('autoscaler decides');
    expect(none).toContain('### base (n=4)');
  });

  it('without a namespace the filter is off: lines under any namespace are joined by revision name', () => {
    // var-00002 has one autoscaler line under another namespace; only the unfiltered
    // run can see it. (Filtered runs above exclude it.)
    const filtered = analyze(['--namespace=bench-cells']);
    const open = analyze([]);
    const varRow = (t: string) =>
      t
        .split('### var')[1]
        ?.split('\n')
        .find((l) => l.startsWith('| 0 autoscaler')) ?? '';
    expect(varRow(open)).not.toBe(varRow(filtered));
  });
});
