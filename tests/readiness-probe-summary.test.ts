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

// pass this in args to run with the script's own --min-valid default instead of the test default of 1
const DEFAULT_GATE = '--default-gate';

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
    // the small fixtures here have one-row arms; the --min-valid gate has its own tests below
    const defaultGate = args.includes(DEFAULT_GATE);
    args = args.filter((a) => a !== DEFAULT_GATE);
    const gate =
      defaultGate || args.some((a) => a.startsWith('--min-valid')) ? [] : ['--min-valid=1'];
    const r = spawnSync('python3', ['-I', SCRIPT, ...gate, ...args, phases, ...files], {
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

// Every input-shape and option error must exit exactly 2 with a message and no traceback; one
// well-formed control exits 0. The "guard:" cases are ones only the top-level guard catches: a value that
// is a string of the right type but does not parse or is out of range (ValueError / OverflowError).
describe('readiness-probe-summary.py every input error exits 2', () => {
  const rowsText = `${ROWS.map((x) => JSON.stringify(x)).join('\n')}\n`;
  const goodEvent = (extra: Record<string, unknown> = {}) => ({
    metadata: { uid: 'u-ok' },
    reason: 'Unhealthy',
    involvedObject: { name: 'p0' },
    message: TIMEOUT,
    count: 1,
    firstTimestamp: '2026-11-21T00:00:01Z',
    lastTimestamp: '2026-11-21T00:00:01Z',
    ...extra,
  });
  const withRow = (patch: Record<string, unknown>) =>
    `${JSON.stringify({ ...ROWS[0], ...patch })}\n`;

  const optionCases: [string, string[]][] = [
    ['--effect-ms=abc', ['--effect-ms=abc']],
    ['--effect-ms=nan', ['--effect-ms=nan']],
    ['--effect-ms=inf', ['--effect-ms=inf']],
    ['--effect-ms=1e999 (overflows to inf)', ['--effect-ms=1e999']],
    ['--effect-ms=-1', ['--effect-ms=-1']],
    ['--reps=abc', ['--reps=abc']],
    ['--reps=0', ['--reps=0']],
    ['--reps=-5', ['--reps=-5']],
    ['--reps=1.5', ['--reps=1.5']],
    ['--baseline=nosucharm', ['--baseline=nosucharm']],
    ['--effect-ms=1e13 (above the 1e12 bound)', ['--effect-ms=1e13']],
    ['--reps=100000000 (above the 1e7 bound)', ['--reps=100000000']],
  ];
  for (const [name, args] of optionCases) {
    it(`option ${name}`, () => {
      const r = runRaw(rowsText, [EVENTS], args);
      expect(r.status).toBe(2);
      expect(r.stderr).not.toContain('Traceback');
      expect(r.stderr.length).toBeGreaterThan(0);
    });
  }

  const eventCases: [string, unknown][] = [
    ['top-level array', [goodEvent()]],
    ['top-level number', 5],
    ['items is a string', { kind: 'List', items: 'x' }],
    ['an item is a number', { kind: 'List', items: [1] }],
    ['an item is an array', { kind: 'List', items: [[]] }],
    ['metadata without uid', { items: [{ metadata: {}, involvedObject: { name: 'p0' } }] }],
    ['involvedObject is a string', { items: [goodEvent({ involvedObject: 'p0' })] }],
    ['involvedObject.name is a number', { items: [goodEvent({ involvedObject: { name: 5 } })] }],
    ['message is a number', { items: [goodEvent({ message: 5 })] }],
    ['count is a string', { items: [goodEvent({ count: 'x' })] }],
    ['count is negative', { items: [goodEvent({ count: -1 })] }],
    ['firstTimestamp is a number', { items: [goodEvent({ firstTimestamp: 5 })] }],
    ['an Unhealthy event has no stamp', { items: [goodEvent({ firstTimestamp: undefined })] }],
    ['reason is missing', { items: [goodEvent({ reason: undefined })] }],
    ['reason is a number', { items: [goodEvent({ reason: 7 })] }],
    ['reason is null', { items: [goodEvent({ reason: null })] }],
    [
      'a non-Unhealthy event with a non-string reason is not skipped',
      {
        items: [{ metadata: { uid: 'x' }, involvedObject: { name: 'p0' }, reason: ['Scheduled'] }],
      },
    ],
    ['metadata.uid is a list', { items: [goodEvent({ metadata: { uid: ['u'] } })] }],
    ['count is above the 1e6 bound', { items: [goodEvent({ count: 2000000 })] }],
    ['guard: firstTimestamp is not a date', { items: [goodEvent({ firstTimestamp: 'soon' })] }],
  ];
  for (const [name, capture] of eventCases) {
    it(`events: ${name}`, () => {
      // EVENTS mentions every pod, so only the malformed second capture can explain a failure
      const r = runRaw(rowsText, [EVENTS, capture]);
      expect(r.status).toBe(2);
      expect(r.stderr).not.toContain('Traceback');
      expect(r.stderr.length).toBeGreaterThan(0);
    });
  }

  const rowCases: [string, string][] = [
    ['watch is null', withRow({ watch: null })],
    ['watch is an array', withRow({ watch: [] })],
    ['arm is a number', withRow({ arm: 5 })],
    ['pod is empty', withRow({ pod: '' })],
    ['wall_start is not a date', withRow({ wall_start: 'yesterday' })],
    ['wall_start is a number', withRow({ wall_start: 5 })],
    ['first_byte is a string', withRow({ watch: { first_byte: 'x' } })],
    ['cond_Ready is a boolean', withRow({ watch: { first_byte: 1, cond_Ready: true } })],
    [
      'first_byte overflows to infinity',
      `{"arm":"a","pod":"p0","wall_start":"${T0}","watch":{"first_byte":1e999}}\n`,
    ],
    ['row is an array', '[1,2]\n'],
    ['row is a number', '7\n'],
    ['code is the string "200"', withRow({ code: '200' })],
    ['code is a float', withRow({ code: 200.5 })],
    ['code is null', withRow({ code: null })],
    ['code is a boolean', withRow({ code: true })],
    ['first_byte is above the 1e12 bound', withRow({ watch: { first_byte: 1e13 } })],
    ['first_byte is below -1e12', withRow({ watch: { first_byte: -1e13 } })],
    [
      'first_byte is an integer too big for a float',
      withRow({ watch: { first_byte: 'BIGINT' } }).replace('"BIGINT"', '9'.repeat(400)),
    ],
    ['guard: wall_start is year 0', withRow({ wall_start: '0000-01-01T00:00:00Z' })],
    ['an error row without an arm', `${JSON.stringify({ error: 'pod gone' })}\n`],
    ['an error row with a numeric arm', `${JSON.stringify({ arm: 5, error: 'pod gone' })}\n`],
    ['row lacks pod', `${JSON.stringify({ arm: 'a', wall_start: T0, watch: {} })}\n`],
  ];
  for (const [name, text] of rowCases) {
    it(`row: ${name}`, () => {
      const r = runRaw(text, [EVENTS]);
      expect(r.status).toBe(2);
      expect(r.stderr).not.toContain('Traceback');
      expect(r.stderr.length).toBeGreaterThan(0);
    });
  }

  it('control: well-formed input with every option set exits 0', () => {
    const r = runRaw(rowsText, [EVENTS], ['--effect-ms=0', '--reps=1', '--baseline=a']);
    expect(r.status).toBe(0);
    expect(r.stderr).toBe('');
    expect(r.stdout).toContain('vs baseline a');
  });
});

describe('readiness-probe-summary.py input validation', () => {
  const rowsText = `${ROWS.map((x) => JSON.stringify(x)).join('\n')}\n`;

  it('fails, not "0 failures", on an empty events capture', () => {
    for (const empty of [{ kind: 'List', items: [] }, {}]) {
      const r = runRaw(rowsText, [empty]);
      expect(r.status).toBe(2); // input errors exit exactly 2
      expect(r.stderr).toContain('events capture is empty');
      expect(r.stdout).not.toContain('timeouts/wake');
    }
  });

  it('fails on an events capture that mentions none of the pods', () => {
    const r = runRaw(rowsText, [{ kind: 'List', items: [scheduled('someone-else')] }]);
    expect(r.status).toBe(2); // input errors exit exactly 2
    expect(r.stderr).toContain('mentions none of the pods');
  });

  it('fails loudly on an empty phases file', () => {
    const r = runRaw('\n', [EVENTS]);
    expect(r.status).toBe(2); // input errors exit exactly 2
    expect(r.stderr).toContain('no rows');
  });

  it('names the missing key and line instead of a KeyError', () => {
    const bad = `${JSON.stringify(ROWS[0])}\n${JSON.stringify({ arm: 'a', pod: 'p9', code: 200 })}\n`;
    const r = runRaw(bad, [EVENTS]);
    expect(r.status).toBe(2); // input errors exit exactly 2
    expect(r.stderr).toContain(':2: row is missing wall_start, watch');
    expect(r.stderr).not.toContain('Traceback');
  });

  it('reports a non-JSON line with its number', () => {
    const r = runRaw(`${JSON.stringify(ROWS[0])}\nnot json\n`, [EVENTS]);
    expect(r.status).toBe(2); // input errors exit exactly 2
    expect(r.stderr).toContain(':2: not JSON');
  });

  it('exits 2 on an unknown option and on a missing events file', () => {
    const bad = runRaw(rowsText, [EVENTS], ['--bogus=1']);
    expect(bad.status).toBe(2);
    expect(bad.stderr).toContain('unknown or valueless option');
    const r = spawnSync(
      'python3',
      ['-I', SCRIPT, '/nonexistent.jsonl', '/nonexistent-events.json'],
      {
        encoding: 'utf8',
      },
    );
    expect(r.status).toBe(2);
  });

  it('exits non-zero with a usage line when no events file is given', () => {
    const r = spawnSync('python3', ['-I', SCRIPT, '/nonexistent.jsonl'], { encoding: 'utf8' });
    expect(r.status).toBe(2); // input errors exit exactly 2
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

  it('Mann-Whitney applies the tie correction when there are ties', () => {
    // a=[1,1,2], b=[2,3,3]: U = 0.5, mu = 4.5, tie sum 3*(2^3-2) = 18, N = 6,
    // var = 9/12 * (7 - 18/30) = 4.8, z = (|0.5-4.5| - 0.5)/sqrt(4.8) = 1.59752, p = erfc(z/sqrt 2) = 0.11015.
    // The uncorrected approximation would give 0.12663.
    expect(py('m.mann_whitney_p([1,1,2],[2,3,3])')).toBeCloseTo(0.11015, 4);
    expect(py('m.mann_whitney_p([5,5,5],[5,5,5])')).toBe(1);
  });

  it('Mann-Whitney is exact and two-sided without ties, symmetric in its arguments', () => {
    expect(py('m.mann_whitney_p([1,2,3],[4,5,6])')).toBeCloseTo(0.1, 10);
    expect(py('m.mann_whitney_p([4,5,6],[1,2,3])')).toBeCloseTo(0.1, 10);
    expect(py('m.mann_whitney_p([1,2,3],[1,2,3])')).toBeGreaterThan(0.9);
  });
});

// "Ready timing" block: counted by the tool so a write-up quotes it. Arm "t", five wakes (first byte 1000):
//   w1 Ready 900  (before first byte), endpoint 1010 (after), queue-proxy probe 1020, timeout stamped +1 s
//   w2 Ready 1000 (equal: not after),  endpoint 990  (before), queue-proxy probe 800,  no timeout
//   w3 Ready 12000 (after, 11 s later), endpoint 12010, queue-proxy probe 1100, timeout stamped +2 s
//   w4 Ready 3000 (2 s later, under the 5 s bar), endpoint 3010, queue-proxy probe 1000, timeout stamped +1 s
//   w5 Ready 7500 (6.5 s later), endpoint 7510, queue-proxy probe 1000, timeout stamped +1 s
//   w6 Ready 1500 (0.5 s later), endpoint 1510, queue-proxy probe 1000, its only timeout stamped +300 s (scale-down)
// Ready>fb = 4/6 (w3 w4 w5 w6); eps>fb = 5/6 (all but w2); Ready>fb+5s = 2/6 (w3 w5); qp-fb = -200..100;
// timeout stamps 1.0..2.0 s over 4 timeout pods; gap from the first timeout to Ready: w1 0.9-1 = -0.1 s,
// w3 12-2 = 10 s, w4 3-1 = 2 s, w5 7.5-1 = 6.5 s -> gap>=9s 1 (w3), gap<9s 3.
describe('readiness-probe-summary.py Ready timing block', () => {
  const rowT = (pod: string, ready: number, eps: number, qp: number) => ({
    arm: 't',
    pod,
    code: 200,
    wall_start: T0,
    watch: { first_byte: 1000, cond_Ready: ready, eps_ready: eps, qp_probe_ok: qp },
  });
  const rows = [
    rowT('w1', 900, 1010, 1020),
    rowT('w2', 1000, 990, 800),
    rowT('w3', 12000, 12010, 1100),
    rowT('w4', 3000, 3010, 1000),
    rowT('w5', 7500, 7510, 1000),
    rowT('w6', 1500, 1510, 1000),
  ];
  const events = {
    kind: 'List',
    items: [
      scheduled('w1'),
      scheduled('w2'),
      scheduled('w3'),
      scheduled('w4'),
      scheduled('w5'),
      scheduled('w6'),
      unhealthy('t1', 'w1', TIMEOUT, 1, 1, 1),
      unhealthy('t3', 'w3', TIMEOUT, 1, 2, 2),
      unhealthy('t4', 'w4', TIMEOUT, 1, 1, 1),
      unhealthy('t5', 'w5', TIMEOUT, 1, 1, 1),
      // a timeout 300 s after the request (the scale-down) is not a boot timeout and must not count
      unhealthy('t6', 'w6', TIMEOUT, 1, 300, 300),
    ],
  };
  const out = run(rows, [events]);
  const block = out
    .split('\n')
    .slice(out.split('\n').findIndex((l) => l.startsWith('Ready timing per arm')));

  it('counts Ready and endpoint-ready strictly after the first byte', () => {
    const t = (block.find((l) => l.startsWith('t ')) as string).trim().split(/\s+/);
    // arm Ready>fb eps>fb Ready>fb+5s qp-fb timeout-stamp timeout-pods gap>=9s gap<9s
    expect(t).toEqual(['t', '4/6', '5/6', '2/6', '-200..100', '1.0..2.0', '4', '1', '3']);
  });

  it('flags the straddle artefact of the failure count', () => {
    expect(out).toContain('counting artefact');
  });
});

describe('readiness-probe-summary.py nothing is dropped for its type', () => {
  const rowsText = `${ROWS.map((x) => JSON.stringify(x)).join('\n')}\n`;

  it('a drive.py failed-wake row ({arm, error}) is accepted and excluded, not rejected', () => {
    const text = `${rowsText}${JSON.stringify({ arm: 'a', error: 'pod gone' })}\n`;
    const r = runRaw(text, [EVENTS]);
    expect(r.status).toBe(0);
    // arm "a" still reports its four real wakes
    expect(line(r.stdout, 'a').slice(0, 2)).toEqual(['a', '4']);
  });

  it('a row with an integer non-200 code is excluded on purpose, and counted', () => {
    const text = `${rowsText}${JSON.stringify({ ...ROWS[0], arm: 'bad', code: 404 })}\n${JSON.stringify({ ...ROWS[0], arm: 'bad' })}\n`;
    const r = runRaw(text, [EVENTS]);
    expect(r.status).toBe(0);
    expect(line(r.stdout, 'bad').slice(0, 2)).toEqual(['bad', '1']);
    expect(rowsLine(r.stdout, 'bad')).toEqual(['bad', '2', '1', '0', '0', '1']);
  });

  it('null or absent watch numbers are accepted as "not observed"', () => {
    const text = `${JSON.stringify({ ...ROWS[0], arm: 'nul', watch: { first_byte: null } })}\n`;
    const r = runRaw(`${rowsText}${text}`, [EVENTS]);
    expect(r.status).toBe(0);
    expect(line(r.stdout, 'nul').slice(0, 2)).toEqual(['nul', '1']);
  });
});

// guarded() must map ONLY value / overflow / decode / OS errors to exit 2. A TypeError, AttributeError or
// KeyError escaping an input stage is a bug in the tool and has to show a traceback (exit 1).
function guardExit(raiseExpr: string): { status: number | null; stderr: string } {
  const code = [
    'import importlib.util',
    `spec = importlib.util.spec_from_file_location("rps", ${JSON.stringify(SCRIPT)})`,
    'm = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)',
    `m.guarded("stage", lambda: ${raiseExpr})`,
  ].join('\n');
  const r = spawnSync('python3', ['-I', '-c', code], { encoding: 'utf8' });
  return { status: r.status, stderr: r.stderr };
}

describe('readiness-probe-summary.py guarded() scope', () => {
  const mapped: [string, string][] = [
    ['ValueError', 'int("x")'],
    ['OverflowError', 'int(float("inf"))'],
    ['UnicodeDecodeError', 'b"\\xff".decode("utf-8")'],
    ['JSONDecodeError', '__import__("json").loads("{")'],
    ['OSError', 'open("/nonexistent/x")'],
  ];
  for (const [name, expr] of mapped) {
    it(`maps ${name} to exit 2 with a message`, () => {
      const r = guardExit(expr);
      expect(r.status).toBe(2);
      expect(r.stderr).toContain('stage: malformed input');
      expect(r.stderr).not.toContain('Traceback');
    });
  }

  const bugs: [string, string][] = [
    ['TypeError', '1 + "a"'],
    ['AttributeError', 'None.x'],
    ['KeyError', '{}["k"]'],
    ['IndexError', '[][1]'],
  ];
  for (const [name, expr] of bugs) {
    it(`lets ${name} through as a bug (traceback, exit 1)`, () => {
      const r = guardExit(expr);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('Traceback');
      expect(r.stderr).toContain(name);
    });
  }
});

// rows-per-arm table: arm rows valid error no-code non-200
function rowsLine(out: string, arm: string): string[] {
  const sect = out.split('Rows per arm')[1].split('Ready timing')[0];
  const l = sect.split('\n').find((x) => x.startsWith(`${arm} `));
  expect(l).toBeDefined();
  return (l as string)
    .trim()
    .split(/\s+/)
    .filter((x) => x !== 'code');
}

describe('readiness-probe-summary.py excluded-row counts', () => {
  const good = (arm: string, i: number) => ({ ...ROWS[0], arm, pod: `${arm}${i}` });
  const mk = (extra: unknown[]) =>
    [...[0, 1, 2].map((i) => good('a', i)), ...[0, 1, 2].map((i) => good('b', i)), ...extra]
      .map((x) => JSON.stringify(x))
      .join('\n');
  const evs = {
    items: [0, 1, 2].flatMap((i) => [scheduled(`a${i}`), scheduled(`b${i}`)]),
  };

  it('counts error, missing-code and non-200 rows per arm, each once', () => {
    const noCode: Record<string, unknown> = { ...good('b', 9) };
    delete noCode.code;
    const text = `${mk([{ arm: 'b', error: 'pod gone' }, noCode, { ...good('b', 8), code: 503 }, { ...good('b', 7), code: 503, error: 'x' }])}\n`;
    const r = runRaw(text, [evs]);
    expect(r.status).toBe(0);
    expect(rowsLine(r.stdout, 'a')).toEqual(['a', '3', '3', '0', '0', '0']);
    expect(rowsLine(r.stdout, 'b')).toEqual(['b', '7', '3', '2', '1', '1']);
  });
});

describe('readiness-probe-summary.py --min-valid gate', () => {
  const good = (arm: string, i: number) => ({ ...ROWS[0], arm, pod: `${arm}${i}` });
  const evs = { items: [0, 1, 2, 3].flatMap((i) => [scheduled(`a${i}`), scheduled(`b${i}`)]) };
  const text = (rows: unknown[]) => `${rows.map((x) => JSON.stringify(x)).join('\n')}\n`;

  it('exits 2 when the baseline arm is made only of error rows (it used to print "no values" and exit 0)', () => {
    const rows = [
      good('a', 0),
      good('a', 1),
      good('a', 2),
      ...[0, 1, 2].map(() => ({ arm: 'b', error: 'pod gone' })),
    ];
    const r = runRaw(text(rows), [evs], ['--baseline=b', DEFAULT_GATE]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("arm 'b' has 0 valid row(s)");
    expect(r.stderr).toContain('--min-valid=3');
    expect(r.stderr).toContain('3 error');
    expect(r.stdout).toBe('');
  });

  it('exits 2 when a non-baseline arm has too few valid rows', () => {
    const rows = [0, 1, 2].map((i) => good('a', i)).concat([good('b', 0), good('b', 1)]);
    const r = runRaw(text(rows), [evs], [DEFAULT_GATE]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain("arm 'b' has 2 valid row(s)");
  });

  it('exactly the minimum passes, and the default is 3', () => {
    const rows = [0, 1, 2].flatMap((i) => [good('a', i), good('b', i)]);
    expect(runRaw(text(rows), [evs], [DEFAULT_GATE]).status).toBe(0);
    expect(runRaw(text(rows), [evs], ['--min-valid=4']).status).toBe(2);
    const two = [0, 1].flatMap((i) => [good('a', i), good('b', i)]);
    expect(runRaw(text(two), [evs], [DEFAULT_GATE]).status).toBe(2);
    expect(runRaw(text(two), [evs], ['--min-valid=2']).status).toBe(0);
  });

  it.each([['0'], ['-1'], ['abc'], ['2.5'], ['1000001']])('--min-valid=%s exits 2', (v) => {
    const rows = [0, 1, 2].flatMap((i) => [good('a', i), good('b', i)]);
    const r = runRaw(text(rows), [evs], [`--min-valid=${v}`]);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('--min-valid');
  });
});

describe('readiness-probe-summary.py error-row fields and nesting', () => {
  const errRow = (extra: Record<string, unknown>) =>
    `${JSON.stringify({ arm: 'a', error: 'x', ...extra })}\n`;
  const base = `${ROWS.map((x) => JSON.stringify(x)).join('\n')}\n`;

  it.each([
    ['pod is a list', { pod: ['p'] }],
    ['pod is a dict', { pod: { a: 1 } }],
    ['pod is a number', { pod: 5 }],
    ['pod is empty', { pod: '' }],
    ['wall_start is a number', { wall_start: 5 }],
    ['watch is a list', { watch: [] }],
    ['watch.first_byte is a string', { watch: { first_byte: 'x' } }],
  ])('an error row where %s exits 2 with a message, not a traceback', (_n, extra) => {
    const r = runRaw(base + errRow(extra), [EVENTS]);
    expect(r.status).toBe(2);
    expect(r.stderr).not.toContain('Traceback');
  });

  it('an error row with a string pod, a watch object or nothing else is accepted', () => {
    for (const extra of [{}, { pod: 'p9' }, { watch: { first_byte: null } }]) {
      expect(runRaw(base + errRow(extra), [EVENTS]).status).toBe(0);
    }
  });

  it('deeply nested JSON exits 2, not a RecursionError traceback', () => {
    const deep = `${'['.repeat(100000)}${']'.repeat(100000)}`;
    for (const text of [`${deep}\n`, `${base}{"arm":"a","error":"x","pod":${deep}}\n`]) {
      const r = runRaw(text, [EVENTS]);
      expect(r.status).toBe(2);
      expect(r.stderr).not.toContain('Traceback');
    }
    const r = runRaw(base, [{ items: [{ metadata: { uid: deep } }] }]);
    expect(r.status).toBe(2);
    expect(r.stderr).not.toContain('Traceback');
  });
});
