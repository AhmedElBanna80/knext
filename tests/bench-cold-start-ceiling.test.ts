import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * The kubelet ceiling test (scripts/bench-cold-start-phases/ceiling/) wakes one patched worker (P) and
 * one untouched control worker (S) in pairs, in six blocks (oke, stock, relist100, stock, relist100,
 * oke), and asks whether a 100 ms relist removes the pod-IP wait. These tests pin the analyzer's reading
 * on synthetic runs whose answer is known. The runs are generated here from a seeded generator (no
 * cluster data): the lattice periods are off the analyzer's scan grid, the arrivals carry jitter, the
 * blocks span three hours, and the cases include no effect, one shared node, error rows and file order.
 */

const ROOT = resolve(import.meta.dir, '..');
const ANALYZER = 'scripts/bench-cold-start-phases/ceiling/lattice_analyze.py';
const PATCH = 'scripts/bench-cold-start-phases/ceiling/kubelet-patch.diff';
const BUILD = 'scripts/bench-cold-start-phases/ceiling/build.sh';
const RUNBOOK = 'scripts/bench-cold-start-phases/ceiling/RUNBOOK.md';

type Run = { out: string; err: string; code: number };

function analyzeAsync(args: string[]): Promise<Run> {
  return new Promise((done) => {
    const c = spawn('python3', ['-I', join(ROOT, ANALYZER), ...args], {
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
    });
    let out = '';
    let err = '';
    c.stdout.on('data', (d) => {
      out += d;
    });
    c.stderr.on('data', (d) => {
      err += d;
    });
    c.on('close', (code) => done({ out, err, code: code ?? -1 }));
  });
}

function analyze(args: string[]): Run {
  const r = spawnSync('python3', ['-I', join(ROOT, ANALYZER), ...args], {
    encoding: 'utf8',
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });
  return { out: r.stdout, err: r.stderr, code: r.status ?? -1 };
}

// ------------------------------------------------------------------ synthetic runs

function rngOf(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const gauss = () => Math.sqrt(-2 * Math.log(1 - next())) * Math.cos(2 * Math.PI * next());
  return { next, gauss };
}

/** An arrival process for one arm in one block: pod-IP times fall on a lattice, or are free. */
type Lat =
  | { kind: 'lattice'; period: number; sigmaMs: number; drift?: [number, number] }
  | { kind: 'free'; widthS: number };

type Row = Record<string, unknown>;
type Scn = {
  design?: [string, string][];
  P: (treat: string) => Lat;
  S: Lat;
  qp0: (treat: string) => number;
  nodes?: { p: string; s: string };
  pairs?: number;
  seed?: number;
};

const DESIGN: [string, string][] = [
  ['b1', 'oke'],
  ['b2', 'stock'],
  ['b3', 'relist100'],
  ['b4', 'stock'],
  ['b5', 'relist100'],
  ['b6', 'oke'],
];
const T0 = 1_800_000_000;
const BLOCK_S = 1900; // 30 rounds of 60 s, plus the kubelet restart
// Periods chosen off any round-number grid.
const STOCK_LAT: Lat = { kind: 'lattice', period: 1.003571, sigmaMs: 5 };
const R100_LAT: Lat = { kind: 'lattice', period: 0.103371, sigmaMs: 5 };

function generate(scn: Scn): Row[] {
  const { next, gauss } = rngOf(scn.seed ?? 11);
  const design = scn.design ?? DESIGN;
  const pairs = scn.pairs ?? 30;
  const nodes = scn.nodes ?? { p: 'node-p', s: 'node-s' };
  const total = design.length * BLOCK_S;
  const phaseS = next();
  const rows: Row[] = [];

  // First lattice instant at or after x (seconds since T0). Drift: the period moves linearly.
  const nextLattice = (x: number, lat: Lat & { kind: 'lattice' }, phase: number) => {
    if (!lat.drift) {
      const k = Math.ceil((x - phase * lat.period) / lat.period);
      return (k + phase) * lat.period;
    }
    const [p0, p1] = lat.drift;
    const s = (p1 - p0) / total;
    const cycles = Math.log(1 + (s * x) / p0) / s;
    const k = Math.ceil(cycles - phase);
    return (p0 / s) * (Math.exp(s * (k + phase)) - 1);
  };

  design.forEach(([block, treat], bi) => {
    const phaseP = next();
    for (const arm of ['p', 's'] as const) {
      for (let r = 1; r <= pairs; r++) {
        const base = bi * BLOCK_S + (r - 1) * 60 + (arm === 's' ? 30 : 0);
        const wall = base + next() * 3;
        const qp0 = scn.qp0(treat) + (next() - 0.5) * 40;
        const lat = arm === 'p' ? scn.P(treat) : scn.S;
        const ready = wall + qp0 / 1000;
        let arrival: number;
        if (lat.kind === 'free') arrival = ready + next() * lat.widthS;
        else {
          arrival =
            nextLattice(ready, lat, arm === 'p' ? phaseP : phaseS) + (gauss() * lat.sigmaMs) / 1000;
        }
        const ip = Math.round((arrival - wall) * 1000);
        const slow = next() < 0.5;
        rows.push({
          arm,
          block,
          round: r,
          node: arm === 'p' ? nodes.p : nodes.s,
          wall_start: new Date((T0 + wall) * 1000).toISOString(),
          watch: {
            pod_bound: 100,
            pod_ip: ip,
            first_byte: ip + 150 + Math.round((next() - 0.5) * 40),
          },
          logs: {
            'queue-proxy': [{ line: 'qp', t: Math.round(qp0) }],
            'user-container': [{ line: 'user', t: slow ? 900 : 400 }],
          },
        });
      }
    }
  });
  return rows;
}

const EFFECT: Scn = {
  P: (t) => (t === 'relist100' ? R100_LAT : STOCK_LAT),
  S: STOCK_LAT,
  qp0: () => 700,
};

const errorRow = (arm: string, block: string, round: number): Row => ({
  arm,
  block,
  round,
  order: 'fwd',
  waited_s: 12,
  treatment: 'none',
  error: 'harness produced no result in 240 s',
});

function write(dir: string, name: string, rows: Row[]): string {
  const p = join(dir, name);
  writeFileSync(p, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);
  return p;
}

const dir = mkdtempSync(join(tmpdir(), 'ceiling-analyzer-'));
const FAST = ['--boot=300', '--perms=20'];

const scenarios: Record<string, { rows: Row[]; args?: string[] }> = {};
const results: Record<string, Run> = {};

function define(name: string, rows: Row[], args: string[] = []) {
  scenarios[name] = { rows, args };
}

// The scenarios are defined up front so they can all be analysed in parallel in one beforeAll.
define('effect', generate(EFFECT));
// Seeds are fixed. The carryover screen (99% per treatment) has a few percent false-alarm rate by
// design, so each known-answer case keeps a seed that does not trip it by chance.
define('effectFloor', generate({ ...EFFECT, qp0: () => 900, seed: 12 }));
define(
  'noEffect', // the patched build changed nothing: P is still on the 1 s lattice in every block
  generate({ ...EFFECT, P: () => STOCK_LAT }),
);
define('sameNode', generate({ ...EFFECT, nodes: { p: 'node-x', s: 'node-x' } }));
define(
  'waitUnmoved', // the 1 s lock is gone but the wait is as long as ever
  generate({ ...EFFECT, P: (t) => (t === 'relist100' ? { kind: 'free', widthS: 1 } : STOCK_LAT) }),
);
define(
  'lockUnseen', // the wait collapsed, with no lattice at 100 ms
  generate({
    ...EFFECT,
    P: (t) => (t === 'relist100' ? { kind: 'free', widthS: 0.1 } : STOCK_LAT),
  }),
);
define(
  'smallMove', // the wait moved a little, within noise: the median is below 0, its interval is not
  generate({
    ...EFFECT,
    P: (t) => (t === 'relist100' ? { kind: 'free', widthS: 0.8 } : STOCK_LAT),
  }),
);
define(
  'partial', // the wait moved down but is still about 250 ms: part of it is not the relist
  generate({
    ...EFFECT,
    P: (t) => (t === 'relist100' ? { kind: 'free', widthS: 0.5 } : STOCK_LAT),
  }),
);
define(
  'worse', // the wait got longer under relist100
  generate({ ...EFFECT, P: (t) => (t === 'relist100' ? { kind: 'free', widthS: 2 } : STOCK_LAT) }),
);
define(
  'noBaselineLock', // there is no 1 s lock to remove on P under the stock build
  generate({
    ...EFFECT,
    P: (t) => (t === 'relist100' ? R100_LAT : { kind: 'free', widthS: 1 }),
  }),
);
define(
  'carryover', // the OKE binary behaves differently at the end than at the start
  generate({
    ...EFFECT,
    P: (t) => (t === 'relist100' ? R100_LAT : STOCK_LAT),
    // b6 is shifted by 300 ms through a longer wait: handled below by editing rows
  }).map((r) =>
    r.block === 'b6' && r.arm === 'p'
      ? {
          ...r,
          watch: {
            ...(r.watch as Row),
            pod_ip: (r.watch as { pod_ip: number }).pod_ip + 400,
            first_byte: (r.watch as { first_byte: number }).first_byte + 400,
          },
        }
      : r,
  ),
);
define(
  'drift', // every kubelet's period wanders 1.0031 -> 1.0038 s over the three hours
  generate({
    ...EFFECT,
    P: (t) =>
      t === 'relist100'
        ? R100_LAT
        : { kind: 'lattice', period: 1.0035, sigmaMs: 5, drift: [1.0031, 1.0038] },
    S: { kind: 'lattice', period: 1.0035, sigmaMs: 5, drift: [1.0031, 1.0038] },
  }),
);
{
  const rows = generate(EFFECT);
  // 2 of 60 wakes per block fail, as drive.py writes them: no node, no watch.
  const failed = rows.map((r) =>
    (r.round === 3 && r.arm === 'p') || (r.round === 9 && r.arm === 's')
      ? errorRow(r.arm as string, r.block as string, r.round as number)
      : r,
  );
  define('errorRows', failed);
  // Exactly 6 failed wakes of 60 in b3 (10%, at the limit), then 7 (over it).
  const limit = (n: number) =>
    rows.map((r) =>
      r.block === 'b3' && r.arm === 'p' && (r.round as number) <= n
        ? errorRow('p', 'b3', r.round as number)
        : r,
    );
  define('failAtLimit', limit(6));
  define('failOverLimit', limit(7));
  // File order: blocks written in the order they were run, then reversed.
  const byBlock = (labels: string[]) => labels.flatMap((b) => rows.filter((r) => r.block === b));
  define('reordered', byBlock(['b5', 'b2', 'b6', 'b1', 'b4', 'b3']));
  define(
    'missingBlock',
    rows.filter((r) => r.block !== 'b4'),
  );
  define(
    'fewPairs', // b2 loses P's wake in 7 rounds (no error rows): 23 complete pairs
    rows.filter((r) => !(r.block === 'b2' && r.arm === 'p' && (r.round as number) <= 7)),
  );
}

beforeAll(async () => {
  await Promise.all(
    Object.entries(scenarios).map(async ([name, s]) => {
      const file = write(dir, `${name}.jsonl`, s.rows);
      results[name] = await analyzeAsync([file, ...FAST, ...(s.args ?? [])]);
    }),
  );
  // The swapped design is the same file as `effect`, labelled differently.
  results.swapped = await analyzeAsync([
    join(dir, 'effect.jsonl'),
    ...FAST,
    '--blocks=b1:oke,b2:relist100,b3:stock,b4:relist100,b5:stock,b6:oke',
  ]);
}, 240_000);

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

const verdict = (r: Run) => r.out.match(/^VERDICT: (\w+)$/m)?.[1];

describe('the analyzer on a patched run that works (known answer)', () => {
  it('exits 0, reads six blocks of 30 pairs and passes the gate', () => {
    const r = results.effect;
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    expect(r.out).toContain('rows read 360, unusable 0');
    for (const b of ['b1', 'b2', 'b3', 'b4', 'b5', 'b6'])
      expect(r.out).toMatch(new RegExp(`^${b}\\s+\\w+\\s+30\\s+0\\s+node-p / node-s$`, 'm'));
  });

  it('finds the 1 s lock on P under oke and stock, off the scan grid, and not under relist100', () => {
    const r = results.effect;
    for (const b of ['b1', 'b2', 'b4', 'b6'])
      expect(r.out).toMatch(new RegExp(`^${b}\\s+\\w+\\s+P\\s+node-p\\s+1s\\s.*\\byes$`, 'm'));
    for (const b of ['b3', 'b5'])
      expect(r.out).toMatch(new RegExp(`^${b}\\s+relist100\\s+P\\s+node-p\\s+1s\\s.*\\bno$`, 'm'));
  });

  it('finds the 100 ms lock on P under relist100 only, and S locked at 1 s in every block', () => {
    const r = results.effect;
    for (const b of ['b3', 'b5'])
      expect(r.out).toMatch(
        new RegExp(`^${b}\\s+relist100\\s+P\\s+node-p\\s+100ms\\s.*\\byes$`, 'm'),
      );
    for (const b of ['b1', 'b2', 'b4', 'b6'])
      expect(r.out).toMatch(new RegExp(`^${b}\\s+\\w+\\s+P\\s+node-p\\s+100ms\\s.*\\bno`, 'm'));
    for (const b of ['b1', 'b2', 'b3', 'b4', 'b5', 'b6'])
      expect(r.out).toMatch(new RegExp(`^${b}\\s+\\w+\\s+S\\s+node-s\\s+1s\\s.*\\byes$`, 'm'));
  });

  it('does not count the 1 s lattice sub-harmonic inside the 100 ms band as a new lock', () => {
    expect(results.effect.out).toMatch(
      /^b2\s+stock\s+P\s+node-p\s+100ms\s.*\bno \(sub-harmonic of the 1s lock\)$/m,
    );
  });

  it('reports the wait difference in differences as a drop with an interval below zero', () => {
    const m = results.effect.out.match(
      /^wait DiD \(relist100 - stock\): (-?\d+) \[(-?\d+), (-?\d+)\]$/m,
    );
    expect(m).not.toBeNull();
    const [, d, lo, hi] = m as RegExpMatchArray;
    expect(Number(d)).toBeLessThan(-300);
    expect(Number(lo)).toBeLessThanOrEqual(Number(d));
    expect(Number(hi)).toBeLessThan(0);
  });

  it('reads the relist100 wait on P as collapsed', () => {
    const m = results.effect.out.match(
      /^wait P-S\s+relist100\s+-?\d+ \[-?\d+, -?\d+\]\s+P wait median\s+(\d+) \[(\d+), (\d+)\]$/m,
    );
    expect(m).not.toBeNull();
    expect(Number((m as RegExpMatchArray)[3])).toBeLessThanOrEqual(150);
  });

  it('gives RELIST_IS_WAIT_GOAL_MET_ONCE, which is not a pass, when the interval is under 1000 ms', () => {
    const r = results.effect;
    expect(verdict(r)).toBe('RELIST_IS_WAIT_GOAL_MET_ONCE');
    expect(r.out).toContain('met in this run');
    expect(r.out).toContain('one run is not a pass');
    expect(r.out).not.toMatch(/VERDICT: PASS/);
  });

  it('gives a floor when the wait is gone but the first byte stays over 1000 ms', () => {
    const r = results.effectFloor;
    expect(verdict(r)).toBe('RELIST_IS_WAIT_FLOOR');
    expect(r.out).toContain('report as a floor');
  });

  it('prints p95 as descriptive and says the tail is too thin to judge', () => {
    expect(results.effect.out).toMatch(
      /^p95 relist100\s.*descriptive only: n=60 pairs, the tail is too thin to judge$/m,
    );
    expect(results.effect.out).not.toMatch(/p95 delta/);
  });
});

describe('the verdict follows the reading table, not the median alone', () => {
  it('a patched build that changed nothing (P still 1 s locked in relist100) never gets a goal verdict', () => {
    const r = results.noEffect;
    expect(r.code).toBe(0);
    expect(verdict(r)).toBe('INVALID_LOCK_PERSISTS');
    expect(r.out).not.toMatch(/GOAL_MET/);
    expect(r.out).toMatch(/^b3\s+relist100\s+P\s+node-p\s+1s\s.*\byes$/m);
  });

  it('arms on one node are INVALID_NODES, whatever the numbers say', () => {
    const r = results.sameNode;
    expect(r.code).toBe(0);
    expect(verdict(r)).toBe('INVALID_NODES');
    expect(r.out).not.toMatch(/GOAL_MET/);
  });

  it('a gone 1 s lock with an unmoved wait is a floor with the wait unattributed', () => {
    expect(verdict(results.waitUnmoved)).toBe('FLOOR_WAIT_UNMOVED');
  });

  it('a collapsed wait and gone 1 s lock with no 100 ms lock is named as such (1 s lock gone, 100 ms undetected)', () => {
    const r = results.lockUnseen;
    expect(verdict(r)).toBe('WAIT_REMOVED_LOCK_UNSEEN');
    expect(r.out).toMatch(/^b3\s+relist100\s+P\s+node-p\s+100ms\s.*\bno$/m);
  });

  it('a wait difference in differences that is negative but includes 0 is not read as a move', () => {
    const r = results.smallMove;
    const m = r.out.match(/^wait DiD \(relist100 - stock\): (-?\d+) \[(-?\d+), (-?\d+)\]$/m);
    expect(m).not.toBeNull();
    const [, d, lo, hi] = m as RegExpMatchArray;
    expect(Number(d)).toBeLessThan(0);
    expect(Number(lo)).toBeLessThan(0);
    expect(Number(hi)).toBeGreaterThan(0);
    expect(verdict(r)).toBe('FLOOR_WAIT_UNMOVED');
  });

  it('a wait that moved down but stays over 150 ms is a partial floor', () => {
    expect(verdict(results.partial)).toBe('FLOOR_WAIT_PARTIAL');
  });

  it('a wait that got longer under relist100 is reported as worse', () => {
    expect(verdict(results.worse)).toBe('WAIT_WORSE');
  });

  it('no 1 s lock on P under the stock build leaves nothing to attribute', () => {
    expect(verdict(results.noBaselineLock)).toBe('NO_BASELINE_LOCK');
  });

  it('a late block that differs from the first block of the same treatment is CARRYOVER', () => {
    const r = results.carryover;
    expect(verdict(r)).toBe('CARRYOVER');
    expect(r.out).toMatch(/^carryover oke .*DIFFERS$/m);
  });

  it('takes the treatment from the block label, not from the order of the file or the run', () => {
    const a = results.effect;
    const b = results.reordered;
    expect(verdict(b)).toBe(verdict(a));
    expect(b.out.match(/^wait DiD.*$/m)?.[0]).toBe(a.out.match(/^wait DiD.*$/m)?.[0]);
    // The same file under a swapped label map is a different experiment.
    expect(verdict(results.swapped)).not.toBe('RELIST_IS_WAIT_GOAL_MET_ONCE');
  });

  it('finds every per-block lock when the period drifts over three hours', () => {
    const r = results.drift;
    expect(verdict(r)).toBe('RELIST_IS_WAIT_GOAL_MET_ONCE');
    for (const b of ['b1', 'b2', 'b3', 'b4', 'b5', 'b6'])
      expect(r.out).toMatch(new RegExp(`^${b}\\s+\\w+\\s+S\\s+node-s\\s+1s\\s.*\\byes$`, 'm'));
  });
});

describe('error rows and failure rate', () => {
  it('skips and counts failed wakes (no node, no watch) instead of refusing to run', () => {
    const r = results.errorRows;
    expect(r.code).toBe(0);
    expect(r.out).toContain('unusable 12');
    expect(r.out).toContain("'wake_error': 12");
    expect(verdict(r)).toBe('RELIST_IS_WAIT_GOAL_MET_ONCE');
  });

  it('still analyses a block with exactly 10% failed wakes (6 of 60, 24 pairs)', () => {
    expect(results.failAtLimit.code).toBe(0);
  });

  it('exits 4 and judges nothing when a block has more than 10% failed wakes (7 of 60)', () => {
    const r = results.failOverLimit;
    expect(r.code).toBe(4);
    expect(r.err).toContain('block b3');
    expect(r.err).toContain('7 of 60');
    expect(r.out).toBe('');
  });
});

describe('refusals and input errors', () => {
  const lines = (name: string) => scenarios[name].rows.map((r) => JSON.stringify(r));
  const file = (name: string, ls: string[]) => {
    const p = join(dir, name);
    writeFileSync(p, `${ls.join('\n')}\n`);
    return p;
  };

  it('exits 3 when a whole block is missing', () => {
    const r = results.missingBlock;
    expect(r.code).toBe(3);
    expect(r.err).toContain('block b4 has no wakes');
    expect(r.out).toBe('');
  });

  it('exits 3 when a block has 23 complete pairs, below the minimum of 24', () => {
    const r = results.fewPairs;
    expect(r.code).toBe(3);
    expect(r.err).toContain('block b2 has 23 complete pairs');
  });

  it('exits 2 on a line that is not JSON', () => {
    const ls = lines('effect');
    ls[3] = '{not json';
    const r = analyze([file('bad.jsonl', ls)]);
    expect(r.code).toBe(2);
    expect(r.err).toContain('not JSON');
  });

  it('exits 2 on an arm that is neither the P arm nor the S arm', () => {
    const ls = lines('effect');
    ls[0] = ls[0].replace('"arm":"p"', '"arm":"cpu-base"');
    const r = analyze([file('arm.jsonl', ls)]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("arm 'cpu-base'");
  });

  it('exits 2 on a block label the design does not list', () => {
    const ls = lines('effect');
    ls[0] = ls[0].replace('"block":"b1"', '"block":"b9"');
    const r = analyze([file('block.jsonl', ls)]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("block 'b9'");
  });

  it('exits 2 on a row with no integer round', () => {
    const ls = lines('effect');
    ls[0] = ls[0].replace(/"round":\d+/, '"round":"5"');
    const r = analyze([file('round.jsonl', ls)]);
    expect(r.code).toBe(2);
    expect(r.err).toContain('missing integer round');
  });

  it('exits 2 on a missing file, a design without both treatments, and few permutations', () => {
    expect(analyze([join(dir, 'does-not-exist.jsonl')]).code).toBe(2);
    const bad = analyze([join(dir, 'effect.jsonl'), '--blocks=b1:oke,b2:stock']);
    expect(bad.code).toBe(2);
    expect(bad.err).toContain('relist100');
    const perms = analyze([join(dir, 'effect.jsonl'), '--perms=5']);
    expect(perms.code).toBe(2);
    expect(perms.err).toContain('--perms must be at least 20');
  });
});

describe('the analyzer functions', () => {
  const adir = join(ROOT, 'scripts/bench-cold-start-phases/ceiling');
  // -I drops the script directory from sys.path, so the module is put there explicitly.
  const py = (code: string): string => {
    const r = spawnSync(
      'python3',
      ['-I', '-c', `import sys; sys.path.insert(0, ${JSON.stringify(adir)})\n${code}`],
      { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } },
    );
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    return r.stdout.trim();
  };

  it('finds an exact lattice with R near 1, and no such peak in random phases', () => {
    const out = py(
      [
        'import random, lattice_analyze as m',
        'rng = random.Random(7)',
        'lat = [rng.randrange(0, 4000) * 0.5 + 1000.0 for _ in range(40)]',
        'r, p = m.lock_scan(lat, 0.45, 0.55)',
        'rnd = [rng.uniform(1000.0, 3000.0) for _ in range(40)]',
        'rr, _ = m.lock_scan(rnd, 0.45, 0.55)',
        'print(round(r, 3), round(p, 4), rr < 0.6)',
      ].join('\n'),
    );
    const [r, p, randomLow] = out.split(' ');
    expect(Number(r)).toBeGreaterThan(0.99);
    expect(Number(p)).toBeCloseTo(0.5, 3);
    expect(randomLow).toBe('True');
  });

  it('finds an off-grid 100 ms lattice over a three-hour span (the old 7.5 us grid read R 0.34)', () => {
    const out = py(
      [
        'import random, lattice_analyze as m',
        'rng = random.Random(3)',
        'P = 0.103371',
        'ts = sorted(rng.uniform(0, 10800) for _ in range(60))',
        'ts = [round(t / P) * P + rng.gauss(0, 0.001) for t in ts]',
        'r, p = m.lock_scan(ts, *m.BAND_100MS)',
        'print(round(r, 3), round(p, 6))',
      ].join('\n'),
    );
    const [r, p] = out.split(' ');
    expect(Number(r)).toBeGreaterThan(0.9);
    expect(Math.abs(Number(p) - 0.103371)).toBeLessThan(2e-6);
  });

  it('finds an off-grid 1 s lattice over three hours, and R falls with jitter as the model says', () => {
    const out = py(
      [
        'import math, random, lattice_analyze as m',
        'rng = random.Random(5)',
        'P = 1.003571',
        'def make(sigma, per, n=400):',
        '    return [round(rng.uniform(0, 10800) / per) * per + rng.gauss(0, sigma) for _ in range(n)]',
        'r1, p1 = m.lock_scan(make(0.002, P), *m.BAND_1S)',
        // sigma 10 ms on a 100 ms period: R = exp(-(2*pi*sigma/period)^2/2) = 0.82
        'rj, _ = m.lock_scan(make(0.010, 0.1035), *m.BAND_100MS)',
        'print(round(r1, 3), round(p1, 6), round(rj, 2), round(math.exp(-(2*math.pi*0.010/0.1035)**2/2), 2))',
      ].join('\n'),
    );
    const [r1, p1, rj, model] = out.split(' ').map(Number);
    expect(r1).toBeGreaterThan(0.95);
    expect(Math.abs(p1 - 1.003571)).toBeLessThan(2e-5);
    expect(Math.abs(rj - model)).toBeLessThan(0.08);
  });

  it('pooled over three hours a drifting period smears, while each 30-minute window still locks', () => {
    const out = py(
      [
        'import math, random, lattice_analyze as m',
        'rng = random.Random(9)',
        'p0, p1, total = 1.0031, 1.0038, 10800.0',
        's = (p1 - p0) / total',
        'def lat(x, phase):',
        '    k = math.ceil(math.log(1 + s * x / p0) / s - phase)',
        '    return (p0 / s) * (math.exp(s * (k + phase)) - 1)',
        'xs = sorted(rng.uniform(0, total) for _ in range(180))',
        'ts = [lat(x, 0.3) + rng.gauss(0, 0.004) for x in xs]',
        'pooled, _ = m.lock_scan(ts, *m.BAND_1S)',
        'wins = []',
        'for w in range(6):',
        '    seg = [t for t in ts if w * 1800 <= t < (w + 1) * 1800]',
        '    wins.append(m.lock_scan(seg, *m.BAND_1S)[0])',
        'print(round(pooled, 2), round(min(wins), 2))',
      ].join('\n'),
    );
    const [pooled, minWindow] = out.split(' ').map(Number);
    expect(pooled).toBeLessThan(0.5);
    expect(minWindow).toBeGreaterThan(0.8);
  });

  it('treats a 100 ms lock as the 1 s lattice sub-harmonic only when the periods match to the measured resolution', () => {
    const out = py(
      [
        'import lattice_analyze as m',
        'def t(period, locked=True, span=1800.0):',
        '    return {"period": period, "locked": locked, "span": span}',
        'one = t(1.0035)',
        'print(m.is_subharmonic(one, t(0.10035)),', // exactly a tenth
        '      m.is_subharmonic(one, t(0.1008)),', // 4.5 ms off, inside a fixed 1% tolerance
        '      m.is_subharmonic(one, t(0.1035)),', // the expected patched period
        '      m.is_subharmonic(t(1.0035, False), t(0.10035)),',
        '      m.is_subharmonic(one, t(0.10035, False)))',
      ].join('\n'),
    );
    expect(out).toBe('True False False False False');
  });

  it('computes percentiles by linear interpolation', () => {
    expect(py('import lattice_analyze as m\nprint(m.pct([1, 2, 3, 4], 0.5))')).toBe('2.5');
    expect(py('import lattice_analyze as m\nprint(m.pct([10, 20, 30, 40, 50], 0.95))')).toBe(
      '48.0',
    );
  });
});

describe('the stock-to-patched patch is one constant and the build is pinned', () => {
  const patch = readFileSync(join(ROOT, PATCH), 'utf8');
  const build = readFileSync(join(ROOT, BUILD), 'utf8');

  it('changes exactly one line of pkg/kubelet/kubelet.go, the generic PLEG relist period', () => {
    expect(patch).toContain('diff --git a/pkg/kubelet/kubelet.go b/pkg/kubelet/kubelet.go');
    expect(patch.match(/^@@/gm)?.length).toBe(1);
    const changed = patch.split('\n').filter((l) => /^[+-](?![+-])/.test(l));
    expect(changed).toEqual([
      '-\tgenericPlegRelistPeriod    = time.Second * 1',
      '+\tgenericPlegRelistPeriod    = time.Millisecond * 100',
    ]);
  });

  it('pins the v1.34.10 tag to its commit and refuses any other source', () => {
    expect(build).toContain('TAG="v1.34.10"');
    expect(build).toContain('COMMIT="bd6c4ad159ac77a879838b8f14f23a49bf97de5f"');
    expect(build).toContain('source is $GOT, expected $COMMIT');
  });

  it('builds the control from the untouched tree before it applies the patch', () => {
    const stock = build.indexOf('kubelet-v1.34.10-stock-linux-$ARCH');
    const apply = build.indexOf('git -C "$WORK" apply "$HERE/kubelet-patch.diff"');
    expect(stock).toBeGreaterThan(0);
    expect(apply).toBeGreaterThan(stock);
  });

  it('honours GO_TOOLCHAIN: the toolchain check compares against the override, not a literal', () => {
    // The default names the toolchain once; the check and the build read the variable.
    expect(build.match(/go1\.25\.12/g)?.length).toBe(1); // only the default names a toolchain
    expect(build).toContain('GOTOOLCHAIN="$GO_TOOLCHAIN"');
    expect(build).toContain('*" $GO_TOOLCHAIN "*) ;;');
  });

  it('refuses a target architecture it does not know, before cloning anything', () => {
    const r = spawnSync('bash', [join(ROOT, BUILD), join(dir, 'never-created')], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH ?? '', KUBELET_CEILING_GOARCH: 'sparc' },
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('KUBELET_CEILING_GOARCH must be amd64 or arm64');
  });
});

describe('the runbook states the safety procedure the harness and the analyzer implement', () => {
  const rb = readFileSync(join(ROOT, RUNBOOK), 'utf8');

  it('reverts with install and mv, never cp over the running binary, and hashes /proc/<pid>/exe', () => {
    expect(rb).not.toMatch(/\bcp\b[^\n]*"\$(KP|KUBELET_PATH)[^"]*"\s+"\$(KP|KUBELET_PATH)"/);
    expect(rb).toContain('/proc/');
    expect(rb).toContain('/exe');
  });

  it('runs the wakes with the restore placement mode and one block label per kubelet', () => {
    expect(rb).toMatch(/drive\.py 30[\s\S]*?--place-mode=restore[\s\S]*?--block=b1/);
    expect(rb).toContain('--block=b1');
    expect(rb).toContain('--block=b6');
  });

  it('never tells the operator to delete anything or to drain', () => {
    expect(rb).not.toMatch(/^\s*(sudo )?kubectl delete/m);
    expect(rb).not.toMatch(/^\s*kubectl drain/m);
    expect(rb).not.toMatch(/^\s*kind delete/m);
  });

  it('keeps the H3 arithmetic consistent: 1640 - 550 is not under 1000', () => {
    expect(rb).toContain('1640');
    expect(rb).not.toMatch(/bootstrap interval lies below 1000/);
  });
});
