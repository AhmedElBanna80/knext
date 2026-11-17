import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * The opt-in predictive pre-wake study: the relative A/B harness, the Proposed ADR it feeds, and
 * the places that track Z9 and cold start, which must link to that ADR.
 *
 * The harness cannot run against a cluster here. It is run for real against a fake `kubectl` on
 * PATH that answers the handful of calls a cycle makes and records every call, so the tests can
 * check what the harness does to the cluster, in what order, and what it leaves behind.
 */

const ROOT = resolve(import.meta.dir, '..');
// Written out in full: the bench directory-scan guard treats a quoted path as "has a test".
const HARNESS = 'scripts/bench-cold-start-phases/prewake-ab.sh';
const ADR = 'docs/adr/0073-opt-in-predictive-prewake.md';
const RUNBOOK = 'docs/benchmarks/prewake-ab-oke-runbook.md';
const ADR_NAME = '0073-opt-in-predictive-prewake.md';

// Where Z9 and cold start are tracked; each must link the ADR.
const TRACKERS = [
  'docs/adr/0004-backend-service-crd.md',
  'docs/benchmarks/cold-start-ledger.md',
  'docs/benchmarks/cold-start-relist-and-sandbox-oke-2026-11-13.md',
];

const FAKE_KUBECTL = `#!/usr/bin/env bash
# Stand-in kubectl: logs every call, keeps the pre-wake annotation as a file.
echo "$*" >> "$FAKE_DIR/calls"
args=" $* "
case "$args" in
  *" get pod prewake-client "*) exit 0 ;;
  *" get pods "*) exit 0 ;;
  *" get ksvc "*) printf rev-1 ; exit 0 ;;
  *" annotate podautoscaler rev-1 autoscaling.knative.dev/min-scale=1 "*) touch "$FAKE_DIR/pinned"; exit 0 ;;
  *" annotate podautoscaler rev-1 autoscaling.knative.dev/min-scale- "*) rm -f "$FAKE_DIR/pinned"; exit 0 ;;
  *" exec "*)
    [ -e "$FAKE_DIR/exec-fail-when-pinned" ] && [ -e "$FAKE_DIR/pinned" ] && exit 1
    if [ -e "$FAKE_DIR/pinned" ]; then echo "200 200"; else echo "1000 200"; fi
    exit 0 ;;
esac
echo "fake kubectl: unexpected call: $*" >&2
exit 3
`;

function withFake<T>(fn: (dir: string, env: NodeJS.ProcessEnv) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'prewake-ab-'));
  try {
    const bin = join(dir, 'bin');
    spawnSync('mkdir', [bin]);
    writeFileSync(join(bin, 'kubectl'), FAKE_KUBECTL);
    chmodSync(join(bin, 'kubectl'), 0o755);
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_DIR: dir, TMPDIR: dir };
    return fn(dir, env);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function run(args: string[], env: NodeJS.ProcessEnv, cwd: string) {
  const r = spawnSync('bash', [join(ROOT, HARNESS), ...args], { env, cwd, encoding: 'utf8' });
  return { code: r.status, out: r.stdout, err: r.stderr };
}

const calls = (dir: string): string[] =>
  existsSync(join(dir, 'calls'))
    ? readFileSync(join(dir, 'calls'), 'utf8').split('\n').filter(Boolean)
    : [];

describe('prewake-ab.sh: usage and dry run', () => {
  it('exists and is executable', () => {
    expect(statSync(join(ROOT, HARNESS)).mode & 0o111).toBeGreaterThan(0);
  });

  it('--help exits 0 and documents the dry run and the context guard', () => {
    withFake((dir, env) => {
      const r = run(['--help'], env, dir);
      expect(r.code).toBe(0);
      expect(r.out).toContain('--dry-run');
      expect(r.out).toContain('--allow-non-kind');
      expect(calls(dir)).toEqual([]);
    });
  });

  it('--dry-run prints the arms and the rotated round order and touches nothing', () => {
    withFake((dir, env) => {
      const r = run(
        ['--context', 'kind-x', '--dry-run', '--rounds', '2', '--leads', '500,1500'],
        env,
        dir,
      );
      expect(r.code).toBe(0);
      expect(r.out).toContain('arms: cold prewake@500 prewake@1500');
      expect(r.out).toContain('round 1: cold prewake@500 prewake@1500');
      expect(r.out).toContain('round 2: prewake@500 prewake@1500 cold');
      expect(calls(dir)).toEqual([]);
    });
  });

  it('refuses a non-kind context unless --allow-non-kind is given', () => {
    withFake((dir, env) => {
      const refused = run(['--context', 'knext-oke-sa', '--dry-run'], env, dir);
      expect(refused.code).toBe(2);
      expect(refused.err).toContain('not a kind context');
      const allowed = run(['--context', 'knext-oke-sa', '--allow-non-kind', '--dry-run'], env, dir);
      expect(allowed.code).toBe(0);
      expect(calls(dir)).toEqual([]);
    });
  });

  it('refuses --setup on a non-kind context even with --allow-non-kind', () => {
    withFake((dir, env) => {
      const r = run(
        ['--context', 'knext-oke-sa', '--allow-non-kind', '--setup', '--dry-run'],
        env,
        dir,
      );
      expect(r.code).toBe(2);
      expect(r.err).toContain('--setup is for kind contexts only');
    });
  });

  it('refuses an image that is not pinned by digest, accepts one that is', () => {
    withFake((dir, env) => {
      const tag = run(['--context', 'kind-x', '--dry-run', '--image', 'node:22-alpine'], env, dir);
      expect(tag.code).toBe(2);
      expect(tag.err).toContain('pinned by digest');
      const pinned = run(
        ['--context', 'kind-x', '--dry-run', '--image', `node@sha256:${'a'.repeat(64)}`],
        env,
        dir,
      );
      expect(pinned.code).toBe(0);
    });
  });
});

describe('prewake-ab.sh: a real run against a stand-in cluster', () => {
  it('pins min-scale before the request, unpins it after, and reports deltas relative to cold', () => {
    withFake((dir, env) => {
      const out = join(dir, 'out.jsonl');
      const r = run(
        ['--context', 'kind-x', '--rounds', '2', '--leads', '0', '--settle', '0', '--out', out],
        env,
        dir,
      );
      expect(r.code).toBe(0);
      const rows = readFileSync(out, 'utf8')
        .trim()
        .split('\n')
        .map((l) => JSON.parse(l));
      expect(rows.map((x) => x.arm)).toEqual(['cold', 'prewake@0', 'prewake@0', 'cold']);
      expect(rows.filter((x) => x.arm === 'cold').map((x) => x.request_ms)).toEqual([1000, 1000]);
      expect(rows.filter((x) => x.arm !== 'cold').map((x) => x.request_ms)).toEqual([200, 200]);
      expect(r.out).toMatch(/prewake@0\s+2\s+200\s+-800\s+0\.20/);
      expect(r.out).toContain('not OKE numbers');

      // Order of cluster calls in a pre-wake cycle: pin, request, unpin. A cold cycle never pins.
      const c = calls(dir).map((l) =>
        l.includes(' annotate ')
          ? l.endsWith('min-scale-')
            ? 'unpin'
            : 'pin'
          : l.includes(' exec ')
            ? 'request'
            : '',
      );
      expect(c.filter(Boolean)).toEqual([
        'request',
        'pin',
        'request',
        'unpin',
        'pin',
        'request',
        'unpin',
        'request',
      ]);
      expect(existsSync(join(dir, 'pinned'))).toBe(false);
    });
  });

  it('removes the pin when a pre-wake cycle fails mid-way, so the service can reach zero again', () => {
    withFake((dir, env) => {
      // The request fails only while pinned: the cold cycle passes, the pre-wake cycle dies after pinning.
      writeFileSync(join(dir, 'exec-fail-when-pinned'), '');
      const r = run(
        [
          '--context',
          'kind-x',
          '--rounds',
          '1',
          '--leads',
          '0',
          '--settle',
          '0',
          '--out',
          join(dir, 'o.jsonl'),
        ],
        env,
        dir,
      );
      expect(r.code).not.toBe(0);
      const lines = calls(dir);
      const pin = lines.findIndex((l) => l.includes('min-scale=1'));
      const unpin = lines.findIndex((l) => l.endsWith('min-scale-'));
      expect(pin).toBeGreaterThan(-1);
      expect(unpin).toBeGreaterThan(pin);
      expect(existsSync(join(dir, 'pinned'))).toBe(false);
    });
  });
});

describe('the pre-wake ADR, its evidence, and the trackers that link it', () => {
  const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

  it('is Proposed, design-only, and has every section the ADR format requires', () => {
    const adr = read(ADR);
    expect(adr).toMatch(/^# ADR-0073: /);
    expect(adr).toMatch(/- \*\*Status:\*\* \*\*Proposed/);
    for (const h of [
      '## Context',
      '## Decision',
      '## Options considered',
      '## Consequences',
      '## Action items',
    ]) {
      expect(adr).toContain(h);
    }
  });

  it('weighs all four options in a trade-off table', () => {
    const adr = read(ADR);
    const opts = adr.slice(adr.indexOf('## Options considered'), adr.indexOf('## Consequences'));
    const rows = opts.split('\n').filter((l) => l.startsWith('|'));
    for (const o of [
      'Scheduled min-scale windows',
      'Signal-driven pre-wake',
      'Activator-side prediction',
      'Do nothing',
    ]) {
      expect(rows.some((l) => l.includes(o))).toBe(true);
    }
  });

  it('links its harness and the founder OKE runbook, and the runbook drives the same harness', () => {
    const adr = read(ADR);
    expect(adr).toContain(HARNESS.replace('scripts/', '../../scripts/'));
    expect(adr).toContain('../benchmarks/prewake-ab-oke-runbook.md');
    const runbook = read(RUNBOOK);
    expect(runbook).toContain(HARNESS);
    expect(runbook).toContain('--allow-non-kind');
    expect(runbook).toContain(ADR_NAME);
  });

  it('is linked from every place Z9 and cold start are tracked', () => {
    const missing = TRACKERS.filter((t) => !read(t).includes(ADR_NAME));
    expect(missing).toEqual([]);
  });

  it('records Z9 with its CI run link in ADR-0004, ticked', () => {
    const z9 = read('docs/adr/0004-backend-service-crd.md')
      .split('\n')
      .find((l) => l.includes('Z9 #2054') && l.trimStart().startsWith('- ['));
    expect(z9).toBeDefined();
    expect(z9).toMatch(/^- \[x\]/);
    const block = read('docs/adr/0004-backend-service-crd.md');
    expect(block).toMatch(/https:\/\/github\.com\/AhmedElBanna80\/knext\/actions\/runs\/\d+/);
  });
});
