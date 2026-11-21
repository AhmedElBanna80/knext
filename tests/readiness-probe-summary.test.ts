import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Pins scripts/bench-cold-start-phases/readiness-probe-summary.py on hand-derived fixtures.
 *
 * Table 1, arm "a", four wakes (request at 2026-11-21T00:00:00Z, so t_ready = ready/1000 + 1 s of stamp slack):
 *   p0 first byte 1000, Ready 1100, one `deadline exceeded` event x2 at +1 s      -> 2 failures, 2 timeouts
 *   p1 first byte 2000, Ready 2100, no Unhealthy events (but its Scheduled event) -> 0
 *   p2 first byte 3000, Ready 3100, a 503 event x5 stamped +1 s..+30 s (straddles
 *      Ready: it keeps counting through the scale-down)                            -> counts once, 1 failure
 *   p3 first byte 4000, Ready 11000, timeout x3 at +1..+3 s, and a 503 x3 at
 *      +21..+41 s (scale-down, after Ready)                                        -> 3 failures, 3 timeouts
 * First byte 1000/2000/3000/4000: median 2500, p95 at rank 0.95*3 = 2.85 -> 3000 + 0.85*1000 = 3850.
 * Ready 1100/2100/3100/11000: median 2600, p95 -> 3100 + 0.85*7900 = 9815.
 * Ready minus first byte: 100, 100, 100, 7000 -> median 100.
 * Failures 2+0+1+3 = 6 over 4 wakes = 1.50 per wake; timeouts 2+0+0+3 = 5 -> 1.25; 3 of 4 pods failed.
 * Arm "b": one wake whose Ready was never seen -> Ready columns "-", no failure statistics.
 * Arm "d": one wake on a pod the events capture never mentions -> failures UNKNOWN, not 0.
 *
 * Table 2 uses its own degenerate samples (every value in an arm equal) so the bootstrap CI collapses to the
 * point estimate and the expected output is derivable by hand.
 */
const ROOT = resolve(import.meta.dir, '..');
const SCRIPT = join(ROOT, 'scripts/bench-cold-start-phases/readiness-probe-summary.py');
const T0 = '2026-11-21T00:00:00.000Z';

function row(arm: string, pod: string, firstByte: number, ready: number | null) {
  const watch: Record<string, number> = { first_byte: firstByte };
  if (ready !== null) watch.cond_Ready = ready;
  return { arm, pod, code: 200, wall_start: T0, watch };
}

function ev(
  uid: string,
  pod: string,
  reason: string,
  message: string,
  count: number,
  firstSec: number,
  lastSec: number,
) {
  const at = (s: number) =>
    `2026-11-21T00:${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}Z`;
  return {
    metadata: { uid },
    reason,
    involvedObject: { name: pod },
    message,
    count,
    firstTimestamp: at(firstSec),
    lastTimestamp: at(lastSec),
  };
}

const TIMEOUT = 'Readiness probe failed: Get "http://10.0.0.1:8012/": context deadline exceeded';
const R503 = 'Readiness probe failed: HTTP probe failed with statuscode: 503';
const unhealthy = (uid: string, pod: string, msg: string, n: number, f: number, l: number) =>
  ev(uid, pod, 'Unhealthy', msg, n, f, l);
const scheduled = (pod: string) => ev(`s-${pod}`, pod, 'Scheduled', 'assigned', 1, 0, 0);

type Result = { status: number | null; stdout: string; stderr: string };

function runRaw(rowsText: string, eventFiles: unknown[], args: string[] = []): Result {
  const dir = mkdtempSync(join(tmpdir(), 'rps-'));
  try {
    const phases = join(dir, 'phases.jsonl');
    writeFileSync(phases, rowsText);
    const files = eventFiles.map((e, i) => {
      const f = join(dir, `events-${i}.json`);
      writeFileSync(f, JSON.stringify(e));
      return f;
    });
    const r = spawnSync('python3', ['-I', SCRIPT, ...args, phases, ...files], {
      encoding: 'utf8',
    });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function run(rows: unknown[], eventFiles: unknown[], args: string[] = []): string {
  const r = runRaw(`${rows.map((x) => JSON.stringify(x)).join('\n')}\n`, eventFiles, args);
  expect(r.status).toBe(0);
  return r.stdout;
}

const ROWS = [
  row('a', 'p0', 1000, 1100),
  row('a', 'p1', 2000, 2100),
  row('a', 'p2', 3000, 3100),
  row('a', 'p3', 4000, 11000),
  row('b', 'q0', 500, null),
  row('c', 'r0', 1500, 2000),
  row('d', 'z0', 900, 1000),
];

const EVENTS = {
  kind: 'List',
  items: [
    scheduled('p0'),
    scheduled('p1'),
    scheduled('p2'),
    scheduled('p3'),
    scheduled('q0'),
    scheduled('r0'),
    unhealthy('u0', 'p0', TIMEOUT, 2, 1, 1),
    unhealthy('u2', 'p2', R503, 5, 1, 30),
    unhealthy('u3a', 'p3', TIMEOUT, 3, 1, 3),
    unhealthy('u3b', 'p3', R503, 3, 21, 41),
    // stamped exactly 1 s after Ready: still before Ready in real time, kubelet stamps are 1 s coarse
    unhealthy('u4', 'r0', TIMEOUT, 2, 3, 3),
  ],
};

function line(out: string, arm: string): string[] {
  const l = out.split('\n').find((x) => x.startsWith(`${arm} `));
  expect(l).toBeDefined();
  return (l as string).trim().split(/\s+/);
}

describe('readiness-probe-summary.py table 1', () => {
  it('prints first byte / Ready median, interpolated p95 and max per arm', () => {
    const t = line(run(ROWS, [EVENTS]), 'a');
    // arm n | fb med p95 max | Ready med p95 max seen | Ready-fb med | pods-with-fail fails timeouts no-events
    expect(t.slice(0, 13)).toEqual([
      'a',
      '4',
      '|',
      '2500',
      '3850',
      '4000',
      '|',
      '2600',
      '9815',
      '11000',
      '4/4',
      '|',
      '100',
    ]);
  });

  it('counts failed probes up to Ready, counting a straddling event once', () => {
    const t = line(run(ROWS, [EVENTS]), 'a');
    expect(t.slice(14)).toEqual(['3/4', '1.50', '1.25', '0']);
  });

  it('keeps the highest count when a watch stream re-sends an event, across files', () => {
    const lower = { type: 'MODIFIED', object: unhealthy('u0', 'p0', TIMEOUT, 1, 1, 1) };
    const t = line(run(ROWS, [EVENTS, lower]), 'a');
    // u0 stays at count 2 (not overwritten by the later, lower count): same totals as above
    expect(t.slice(14)).toEqual(['3/4', '1.50', '1.25', '0']);
  });

  it('reports "-" for Ready when it was never seen and excludes that wake from failure stats', () => {
    const t = line(run(ROWS, [EVENTS]), 'b');
    expect(t.slice(0, 12)).toEqual([
      'b',
      '1',
      '|',
      '500',
      '500',
      '500',
      '|',
      '-',
      '-',
      '-',
      '0/1',
      '|',
    ]);
    expect(t.slice(12)).toEqual(['-', '|', 'unknown', 'unknown', 'unknown', '0']);
  });

  it('allows one second of stamp resolution after Ready', () => {
    const t = line(run(ROWS, [EVENTS]), 'c');
    expect(t.slice(14)).toEqual(['1/1', '2.00', '2.00', '0']);
  });

  it('reports UNKNOWN, not 0, for a pod the events capture never mentions', () => {
    const t = line(run(ROWS, [EVENTS]), 'd');
    expect(t.slice(14)).toEqual(['unknown', 'unknown', 'unknown', '1']);
  });
});

describe('readiness-probe-summary.py input validation', () => {
  const rowsText = `${ROWS.map((x) => JSON.stringify(x)).join('\n')}\n`;

  it('fails, not "0 failures", on an empty events capture', () => {
    for (const empty of [{ kind: 'List', items: [] }, {}]) {
      const r = runRaw(rowsText, [empty]);
      expect(r.status).not.toBe(0);
      expect(r.stderr).toContain('events capture is empty');
      expect(r.stdout).not.toContain('timeouts/wake');
    }
  });

  it('fails on an events capture that mentions none of the pods', () => {
    const r = runRaw(rowsText, [{ kind: 'List', items: [scheduled('someone-else')] }]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('mentions none of the pods');
  });

  it('fails loudly on an empty phases file', () => {
    const r = runRaw('\n', [EVENTS]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('no rows');
  });

  it('names the missing key and line instead of a KeyError', () => {
    const bad = `${JSON.stringify(ROWS[0])}\n${JSON.stringify({ arm: 'a', pod: 'p9', code: 200 })}\n`;
    const r = runRaw(bad, [EVENTS]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain(':2: row is missing wall_start, watch');
    expect(r.stderr).not.toContain('Traceback');
  });

  it('reports a non-JSON line with its number', () => {
    const r = runRaw(`${JSON.stringify(ROWS[0])}\nnot json\n`, [EVENTS]);
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain(':2: not JSON');
  });

  it('exits non-zero with a usage line when no events file is given', () => {
    const r = spawnSync('python3', ['-I', SCRIPT, '/nonexistent.jsonl'], { encoding: 'utf8' });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toContain('usage: readiness-probe-summary.py');
  });
});

// Table 2. Arm "base" is every value 1000; "slow" 3000; "same" 1100, three wakes each, Ready equal to
// first byte + 100. Difference of medians and HL shift: slow +2000, same +100. Every sample is constant, so
// every bootstrap resample has the same median and the 95% CI collapses to [diff, diff].
const T2_ROWS = ['base', 'slow', 'same'].flatMap((arm) => {
  const fb = { base: 1000, slow: 3000, same: 1100 }[arm] as number;
  return [0, 1, 2].map((i) => row(arm, `${arm}-${i}`, fb, fb + 100));
});
const T2_EVENTS = {
  kind: 'List',
  items: T2_ROWS.map((r) => scheduled(r.pod)),
};

describe('readiness-probe-summary.py table 2 (effect vs baseline)', () => {
  const out = run(T2_ROWS, [T2_EVENTS]);
  const t2 = (arm: string, metric = 'first byte') =>
    out
      .split('\n')
      .find((x) => x.startsWith(`${metric} `.padEnd(11)) && x.slice(11).startsWith(arm))
      ?.slice(11)
      .trim()
      .split(/\s+/) as string[];

  it('prints difference of medians, HL shift and a collapsed CI, candidate minus baseline', () => {
    // arm n diff HL [lo, hi] p ...
    expect(t2('slow').slice(0, 6)).toEqual(['slow', '3', '2000', '2000', '[2000,', '2000]']);
    expect(t2('same').slice(0, 6)).toEqual(['same', '3', '100', '100', '[100,', '100]']);
  });

  it('says whether the CI excludes the +-1200 ms effect', () => {
    expect(t2('slow').join(' ')).toContain('slowdown NOT excluded; speedup excluded');
    expect(t2('same').join(' ')).toContain('slowdown excluded; speedup excluded');
  });

  it('applies --effect-ms and --baseline', () => {
    expect(run(T2_ROWS, [T2_EVENTS])).toMatch(
      /same\s+3\s+100.*slowdown excluded; speedup excluded/,
    );
    const tight = run(T2_ROWS, [T2_EVENTS], ['--effect-ms=50']);
    expect(tight).toMatch(/same\s+3\s+100.*slowdown NOT excluded; speedup excluded/);
    const rev = run(T2_ROWS, [T2_EVENTS], ['--baseline=slow']);
    expect(rev).toContain('vs baseline slow');
    expect(rev).toMatch(/first byte\s+base\s+3\s+-2000\s+-2000/);
    expect(rev).toMatch(/base\s+3\s+-2000.*slowdown excluded; speedup NOT excluded/);
  });

  it('reports the two-sided exact Mann-Whitney p of fully separated samples', () => {
    // 3 vs 3, no overlap: U = 0, tail 1/C(6,3) = 0.05, two-sided 0.10. (base vs slow have ties
    // inside each arm only, so the exact branch applies.)
    const sep = [0, 1, 2]
      .map((i) => row('lo', `lo-${i}`, 10 + i, 20 + i))
      .concat([0, 1, 2].map((i) => row('hi', `hi-${i}`, 100 + i, 200 + i)));
    const o = run(sep, [{ kind: 'List', items: sep.map((r) => scheduled(r.pod)) }]);
    expect(o).toMatch(/first byte\s+hi\s+3\s+90\s+90\s+\[.*\]\s+0\.1000/);
  });
});

// The estimators, called directly from the script as a module.
function py(expr: string): unknown {
  const code = [
    'import importlib.util, json, sys',
    `spec = importlib.util.spec_from_file_location("rps", ${JSON.stringify(SCRIPT)})`,
    'm = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)',
    `print(json.dumps(${expr}))`,
  ].join('\n');
  const r = spawnSync('python3', ['-I', '-c', code], { encoding: 'utf8' });
  expect(r.status).toBe(0);
  return JSON.parse(r.stdout);
}

describe('readiness-probe-summary.py estimators', () => {
  it('Hodges-Lehmann is the median of every pairwise b - a', () => {
    // diffs of [1,2,3] -> [11,12,13]: 8 9 9 10 10 10 11 11 12, median 10
    expect(py('m.hodges_lehmann([1,2,3],[11,12,13])')).toBe(10);
    // sign: candidate smaller than baseline is negative
    expect(py('m.hodges_lehmann([11,12,13],[1,2,3])')).toBe(-10);
  });

  it('bootstrap CI of constant samples collapses to the difference of medians', () => {
    expect(py('m.bootstrap_median_diff_ci([100]*5,[300]*5)')).toEqual([200, 200, 200]);
    expect(py('m.bootstrap_median_diff_ci([300]*5,[100]*5)')).toEqual([-200, -200, -200]);
  });

  it('bootstrap CI is seeded, ordered, and brackets zero for identical samples', () => {
    const a = py('m.bootstrap_median_diff_ci([1,2,3,4,5,6],[1,2,3,4,5,6],2000)') as number[];
    const b = py('m.bootstrap_median_diff_ci([1,2,3,4,5,6],[1,2,3,4,5,6],2000)') as number[];
    expect(a).toEqual(b);
    expect(a[0]).toBe(0);
    expect(a[1]).toBeLessThan(0);
    expect(a[2]).toBeGreaterThan(0);
  });

  it('bootstrap CI translates exactly when the candidate shifts (same seed, same resamples)', () => {
    const base = py('m.bootstrap_median_diff_ci([1,5,9,30,31],[2,6,8,40,70],2000)') as number[];
    const shifted = py(
      'm.bootstrap_median_diff_ci([1,5,9,30,31],[1002,1006,1008,1040,1070],2000)',
    ) as number[];
    expect(shifted.map((x, i) => x - base[i])).toEqual([1000, 1000, 1000]);
  });

  it('bootstrap CI bounds are the (1-level)/2 and (1+level)/2 percentiles', () => {
    // a = [0]; b resampled from [0,10,10,10,10]: the resampled median is 0 with probability ~0.058
    // (>= 2.5%, so the 2.5th percentile is 0) and 10 otherwise.
    expect(py('m.bootstrap_median_diff_ci([0],[0,10,10,10,10],4000)')).toEqual([10, 0, 10]);
  });

  it('bootstrap CI widens with the confidence level', () => {
    const lo = py('m.bootstrap_median_diff_ci([1,5,9,30,31],[2,6,8,40,70],4000,7,0.5)') as number[];
    const hi = py(
      'm.bootstrap_median_diff_ci([1,5,9,30,31],[2,6,8,40,70],4000,7,0.95)',
    ) as number[];
    expect(hi[2] - hi[1]).toBeGreaterThan(lo[2] - lo[1]);
  });

  it('Mann-Whitney is exact and two-sided without ties, symmetric in its arguments', () => {
    expect(py('m.mann_whitney_p([1,2,3],[4,5,6])')).toBeCloseTo(0.1, 10);
    expect(py('m.mann_whitney_p([4,5,6],[1,2,3])')).toBeCloseTo(0.1, 10);
    expect(py('m.mann_whitney_p([1,2,3],[1,2,3])')).toBeGreaterThan(0.9);
  });
});
