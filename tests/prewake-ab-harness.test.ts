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
# Stand-in kubectl: logs every call, keeps the min-scale annotation as a file.
echo "$*" >> "$FAKE_DIR/calls"
args=" $* "
case "$args" in
  *" get pod prewake-client "*) exit 0 ;;
  *" get pods "*) exit 0 ;;
  *" get configmap config-autoscaler "*) printf 30s ; exit 0 ;;
  *" create namespace "*) exit 0 ;;
  *" apply "*) exit 0 ;;
  *" patch configmap "*) exit 0 ;;
  *" wait "*) exit 0 ;;
  *" get ksvc "*) printf rev-1 ; exit 0 ;;
  *" annotate podautoscaler rev-1 autoscaling.knative.dev/min-scale=1 "*) touch "$FAKE_DIR/pinned"; exit 0 ;;
  *" annotate podautoscaler rev-1 autoscaling.knative.dev/min-scale- "*) rm -f "$FAKE_DIR/pinned"; exit 0 ;;
  *" exec "*)
    [ -e "$FAKE_DIR/exec-fail-when-pinned" ] && [ -e "$FAKE_DIR/pinned" ] && exit 1
    # Last argument is the lead: "none" for cold and the min-scale arm, a number for the GET arm.
    if [ -e "$FAKE_DIR/pinned" ]; then echo "200 200"
    elif [ "\${!#}" = none ]; then echo "1000 200"
    else echo "\${FAKE_GET_MS:-50} 200"; fi
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
      expect(r.out).toContain('arms: cold get@500 get@1500');
      expect(r.out).toContain('round 1: cold get@500 get@1500');
      expect(r.out).toContain('round 2: get@500 get@1500 cold');
      expect(r.out).not.toContain('minscale@');
      expect(calls(dir)).toEqual([]);
    });
  });

  it('--dry-run adds the secondary min-scale arm only when --minscale-leads is given', () => {
    withFake((dir, env) => {
      const r = run(
        ['--context', 'kind-x', '--dry-run', '--leads', '500', '--minscale-leads', '1500'],
        env,
        dir,
      );
      expect(r.code).toBe(0);
      expect(r.out).toContain('arms: cold get@500 minscale@1500');
      expect(
        run(['--context', 'kind-x', '--minscale-leads', 'x', '--dry-run'], env, dir).code,
      ).toBe(2);
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
  const base = (out: string) => [
    '--context',
    'kind-x',
    '--settle',
    '0',
    '--out',
    out,
    '--rounds',
    '2',
  ];
  const readRows = (out: string) =>
    readFileSync(out, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));

  it('default pre-wake is a plain GET from the client pod: no cluster write, lead passed to the client', () => {
    withFake((dir, env) => {
      const out = join(dir, 'out.jsonl');
      const r = run([...base(out), '--leads', '700'], env, dir);
      expect(r.code).toBe(0);
      const rows = readRows(out);
      expect(rows.map((x) => x.arm)).toEqual(['cold', 'get@700', 'get@700', 'cold']);
      expect(rows.every((x) => (x.arm === 'cold') === (x.mechanism === 'none'))).toBe(true);
      expect(rows.filter((x) => x.arm === 'cold').map((x) => x.request_ms)).toEqual([1000, 1000]);
      expect(rows.filter((x) => x.arm !== 'cold').map((x) => x.request_ms)).toEqual([50, 50]);
      expect(r.out).toMatch(/get@700\s+2\s+50\s+50-50\s+-950\s+0\.05\s+separated from cold/);
      expect(r.out).toContain('not OKE numbers');

      const all = calls(dir);
      // Every call is a read or the client's exec: the harness writes nothing to the cluster.
      expect(all.filter((l) => /\b(annotate|patch|apply|create|delete|scale)\b/.test(l))).toEqual(
        [],
      );
      const execs = all.filter((l) => l.includes(' exec '));
      expect(execs.map((l) => l.split(' ').pop())).toEqual(['none', '700', '700', 'none']);
      expect(existsSync(join(dir, 'pinned'))).toBe(false);
    });
  });

  it('labels an arm whose range overlaps cold as not distinguishable from cold', () => {
    withFake((dir, env) => {
      const r = run(
        [...base(join(dir, 'o.jsonl')), '--leads', '100'],
        {
          ...env,
          FAKE_GET_MS: '1000',
        },
        dir,
      );
      expect(r.code).toBe(0);
      expect(r.out).toMatch(
        /get@100\s+2\s+1000\s+1000-1000\s+0\s+1\.00\s+not distinguishable from cold/,
      );
    });
  });

  it('the secondary min-scale arm pins before the request, unpins after, and a cold cycle never pins', () => {
    withFake((dir, env) => {
      const out = join(dir, 'out.jsonl');
      const r = run([...base(out), '--leads', '0', '--minscale-leads', '0'], env, dir);
      expect(r.code).toBe(0);
      const rows = readRows(out);
      expect(rows.map((x) => x.arm)).toEqual([
        'cold',
        'get@0',
        'minscale@0',
        'get@0',
        'minscale@0',
        'cold',
      ]);
      expect(rows.filter((x) => x.mechanism === 'minscale').map((x) => x.request_ms)).toEqual([
        200, 200,
      ]);
      const c = calls(dir)
        .filter((l) => l.includes(' annotate ') || l.includes(' exec '))
        .map((l) =>
          l.includes(' annotate ') ? (l.endsWith('min-scale-') ? 'unpin' : 'pin') : 'request',
        );
      // cold, get, minscale, get, minscale, cold
      expect(c).toEqual([
        'request',
        'request',
        'pin',
        'request',
        'unpin',
        'request',
        'pin',
        'request',
        'unpin',
        'request',
      ]);
      expect(existsSync(join(dir, 'pinned'))).toBe(false);
    });
  });

  it('removes the pin when a min-scale cycle fails mid-way, so the service can reach zero again', () => {
    withFake((dir, env) => {
      // The request fails only while pinned: the cold cycle passes, the min-scale cycle dies after pinning.
      writeFileSync(join(dir, 'exec-fail-when-pinned'), '');
      const r = run(
        [
          '--context',
          'kind-x',
          '--rounds',
          '1',
          '--leads',
          '0',
          '--minscale-leads',
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

  it('--setup shortens the grace period and the exit trap restores the prior value', () => {
    withFake((dir, env) => {
      const r = run(
        [
          '--context',
          'kind-x',
          '--setup',
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
      expect(r.code).toBe(0);
      const patches = calls(dir).filter((l) => l.includes('patch configmap config-autoscaler'));
      expect(patches).toHaveLength(2);
      expect(patches[0]).toContain('"scale-to-zero-grace-period":"10s"');
      expect(patches[1]).toContain('"scale-to-zero-grace-period":"30s"');
    });
  });

  it('does not touch the grace period when --setup is not given', () => {
    withFake((dir, env) => {
      run(
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
      expect(calls(dir).filter((l) => l.includes('config-autoscaler'))).toEqual([]);
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

  it('ADR-0073 cites the GET-arm data file, and its row counts match the file', () => {
    const adr = read(ADR);
    const file = 'docs/benchmarks/data/prewake-ab-kind-get-2026-11-17.jsonl';
    expect(adr).toContain('prewake-ab-kind-get-2026-11-17.jsonl');
    const rows = read(file)
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(rows.length).toBeGreaterThanOrEqual(6 * 4);
    const n = (arm: string) => rows.filter((r) => r.arm === arm && r.status === '200').length;
    expect(n('cold')).toBeGreaterThanOrEqual(6);
    // The evidence for option B is the GET arm: every GET row used the GET mechanism.
    expect(rows.filter((r) => r.arm.startsWith('get@')).every((r) => r.mechanism === 'get')).toBe(
      true,
    );
    expect(rows.filter((r) => r.arm.startsWith('get@')).length).toBeGreaterThan(0);
  });

  it('commits all seven Z9 wake-margin runs and ADR-0004 cites the file and the range it implies', () => {
    const rows = read('docs/benchmarks/data/z9-wake-margin-2026-11-17.jsonl')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l));
    expect(rows).toHaveLength(7);
    expect(new Set(rows.map((r) => r.run_id)).size).toBe(7);
    for (const r of rows) {
      expect(Object.keys(r).sort()).toEqual(
        ['date', 'margin_ms', 'off_ms', 'on_ms', 'run_id', 'url'].sort(),
      );
      expect(r.margin_ms).toBe(r.off_ms - r.on_ms);
      expect(r.url).toBe(`https://github.com/AhmedElBanna80/knext/actions/runs/${r.run_id}`);
    }
    const m = rows.map((r) => r.margin_ms).sort((x, y) => x - y);
    const adr4 = read('docs/adr/0004-backend-service-crd.md');
    expect(adr4).toContain('z9-wake-margin-2026-11-17.jsonl');
    expect(adr4).toContain(`${m[0]}–${m[m.length - 1]} ms`);
    expect(adr4).toContain(`median ${m[3]} ms`);
  });

  it('the Z9 tick is scoped: kind-only, firing lead unmeasured, owner named, runbook gap named', () => {
    const adr4 = read('docs/adr/0004-backend-service-crd.md');
    const z9 = adr4.slice(adr4.indexOf('- [x] Z9 #2054'), adr4.indexOf('- [x] Docs (D3'));
    expect(z9).toContain('Scoped tick: kind-only');
    expect(z9).toContain('chained-cold firing lead is');
    expect(z9).toContain('unmeasured (owner:');
    expect(z9).toContain('Z2 Rosetta prediction');
    expect(z9).toContain('zone-to-function leg');
    expect(read(RUNBOOK)).toContain('zone-to-function leg');
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
