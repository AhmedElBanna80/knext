import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * The remaining cold-start bench analyzers (those that do not share the phase-table
 * fixture in bench-cold-start-analyzers.test.ts). Each one reads harness JSONL and prints
 * the numbers that the benchmark write-ups quote, so each is run here on a small
 * synthetic fixture whose expected output can be derived by hand, and specific values are
 * pinned. The fixtures are generated inline, with abstract node names, no addresses and
 * no cluster context, so the derivation sits next to the assertion.
 *
 * Statistics that are seeded resampling (bootstrap CI, permutation p) are asserted by
 * shape and by the bounds the data forces; statistics that are closed-form (medians,
 * Hodges-Lehmann, Wilcoxon / Mann-Whitney normal approximations) are asserted exactly,
 * and were re-derived by hand for the fixture.
 */

const ROOT = resolve(import.meta.dir, '..');

// Repo-relative paths are written out in full on purpose: the directory-scan guard in
// bench-cold-start-analyzers.test.ts treats a quoted occurrence of a script's path in a
// test file as "this script has a test".
const BUNEXEC = 'scripts/bench-cold-start-phases/bunexec-ab-analyze.py';
const PREPULL = 'scripts/bench-cold-start-phases/prepull-ab-analyze.py';
const BURST = 'scripts/bench-cold-start-phases/burst-ab-analyze.py';
const CPUBOOST = 'scripts/bench-cold-start-phases/cpu-boost-analyze.py';
const NODEDIAG = 'scripts/bench-cold-start-phases/node-diagnosis-analyze.py';
const STABILITY = 'scripts/bench-cold-start-phases/baseline-stability-analyze.py';

function py(script: string, args: string[]): { out: string; code: number; err: string } {
  const r = spawnSync('python3', [join(ROOT, script), ...args], {
    encoding: 'utf8',
    // CPython would drop a __pycache__/ next to the imported helper modules.
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });
  return { out: r.stdout, code: r.status ?? -1, err: r.stderr };
}

function withTmp<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'bench-remaining-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const jsonl = (rows: unknown[]): string => `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`;

/** Run `fn` with `rows` written to a temp .jsonl file. */
function withRows<T>(rows: unknown[], fn: (file: string, dir: string) => T): T {
  return withTmp((dir) => {
    const file = join(dir, 'run.jsonl');
    writeFileSync(file, jsonl(rows));
    return fn(file, dir);
  });
}

// ---------------------------------------------------------------------------------------
// bunexec-ab-analyze.py
// ---------------------------------------------------------------------------------------

/**
 * Four complete rounds of arms `a` and `b`. Cold ms: a = 1000, 1100, 1200, 1300;
 * b = a - 200. Warm medians: a 60, b 50. Rounds 1-2 land on n1, rounds 3-4 on n2; odd
 * rounds ran `AB`, even rounds `BA`. Arm a, round 1, pulled its image inside the cycle.
 * Three rows must be excluded: a 503, an error row with no cold block, and a row whose
 * events fetch failed (so a pull cannot be ruled out).
 */
function abRows(): Record<string, unknown>[] {
  const ev = (over: Record<string, unknown> = {}) => ({
    pod: 'pod-x',
    node: 'n1',
    image_id: 'img1',
    build_id: 'b1',
    pull_events: [] as string[],
    created: '2026-01-01T00:00:00Z',
    container_started: '2026-01-01T00:00:02Z',
    ready: '2026-01-01T00:00:04Z',
    ...over,
  });
  const rows: Record<string, unknown>[] = [];
  for (let rnd = 1; rnd <= 4; rnd++) {
    for (const [arm, delta, warm] of [
      ['a', 0, [50, 60, 70]],
      ['b', -200, [40, 50, 60]],
    ] as const) {
      rows.push({
        arm,
        round: rnd,
        order: rnd % 2 ? 'AB' : 'BA',
        cold: { code: 200, ms: 900 + 100 * rnd + delta },
        warm: warm.map((ms) => ({ code: 200, ms })),
        evidence: ev({
          node: rnd < 3 ? 'n1' : 'n2',
          pull_events: arm === 'a' && rnd === 1 ? ['Successfully pulled image x in 3s'] : [],
        }),
      });
    }
  }
  rows.push({ arm: 'a', round: 5, order: 'AB', cold: { code: 503 }, warm: [], evidence: ev() });
  rows.push({ arm: 'b', round: 5, error: 'boom' });
  rows.push({
    arm: 'a',
    round: 6,
    order: 'AB',
    cold: { code: 200, ms: 1 },
    warm: [{ code: 200, ms: 1 }],
    evidence: ev({ events_invalid: true }),
  });
  return rows;
}

describe('bunexec-ab-analyze.py: paired A/B cold-start summary', () => {
  withRows(abRows(), (file) => {
    const r = py(BUNEXEC, [file, 'a', 'b']);

    it('exits 0 and names every excluded row with its reason', () => {
      expect(r.code).toBe(0);
      expect(r.out).toContain('rows=11 invalid=3');
      expect(r.out).toContain('INVALID round 5 a: cold code 503');
      expect(r.out).toContain('INVALID round 5 b: boom');
      expect(r.out).toContain('INVALID round 6 a: events fetch failed (pull unknown)');
    });

    it('counts valid rows, images, build ids and in-cycle pulls per arm', () => {
      expect(r.out).toContain('a: valid pairs-per-arm n=4');
      expect(r.out).toContain("images: ['img1'] build ids: 1");
      expect(r.out).toContain('pulls inside cycle: 1');
      expect(r.out).toContain('pulls inside cycle: 0');
      expect(r.out).toContain('complete rounds (both arms valid): 4');
    });

    it('reports median, IQR, p95, range and mean of the cold request per arm', () => {
      expect(r.out).toContain(
        'cold a: n=4 median=1150 IQR=[1075,1225] p95=1285 range=[1000,1300] mean=1150',
      );
      expect(r.out).toContain(
        'cold b: n=4 median=950 IQR=[875,1025] p95=1085 range=[800,1100] mean=950',
      );
    });

    it('computes the A-B difference, Hodges-Lehmann shift and Mann-Whitney p', () => {
      // 16 pairwise differences are 200 + 100*(i-j): symmetric, so the HL shift is 200.
      // Ties at 1000 and 1100 force the normal approximation: U = 14, mu = 8,
      // sd = sqrt(12), z = (6 - 0.5) / sd, p = erfc(z / sqrt 2) = 0.112.
      expect(r.out).toMatch(
        /cold diff\(A-B\) median=\+200 ms {2}HL=\+200 ms {2}bootstrap95 CI=\[\+\d+,\+\d+\] {2}MW p=0\.112\n/,
      );
      expect(r.out).toContain('warm diff(A-B) median=+10 ms  HL=+10 ms');
      expect(r.out).toContain('MW p=0.0304');
      expect(r.out).toMatch(
        /cold all-valid: a n=4 med=1150 {2}b n=4 med=950 {2}diff=\+200 HL=\+200/,
      );
    });

    it('breaks the cold median down by node and by slot', () => {
      expect(r.out).toContain('a node n1: n=2 median=1050');
      expect(r.out).toContain('a node n2: n=2 median=1250');
      expect(r.out).toContain('a slot AB: n=2 median=1100');
      expect(r.out).toContain('a slot BA: n=2 median=1200');
      expect(r.out).toContain('b node n1: n=2 median=850');
    });
  });

  it('fails loudly without arguments rather than printing an empty table', () => {
    const r = py(BUNEXEC, []);
    expect(r.code).not.toBe(0);
  });
});

// ---------------------------------------------------------------------------------------
// prepull-ab-analyze.py and burst-ab-analyze.py
// ---------------------------------------------------------------------------------------

const iso = (s: number): string => new Date(Date.UTC(2026, 0, 1, 0, 0, s)).toISOString();

/**
 * Pre-pull study. Rounds 1-5.
 *   pp-p  (pre-pulled):          cold 900, 950, 1000, 1050, 1100; warm medians 40
 *   pp-u  (fresh, cache hit):    rounds 1-4, cold = pp-p + 300 (1200..1400), warm median 60
 *   pp-u  (fresh, node w/o layer): round 5 pulled in-cycle, cold 2000
 *   pp-w  (all layers new):      4 wakes, all pulled, cold 3000, 3100, 3200, 3300
 * Deploy rows carry the kubelet pull durations: pp-u 2 s and 4 s; pp-w 8 s; pp-p
 * pre-pull pods 5 s and 7 s (these are the `pp-pull-*` pods and are counted separately).
 * Two wake rows must be excluded: a 503 and one whose events fetch failed.
 */
function prepullRows(withPulledU = true): Record<string, unknown>[] {
  const ev = (over: Record<string, unknown> = {}) => ({
    pod: 'pod-x',
    created: iso(0),
    container_started: iso(2),
    ready: iso(5),
    events_n: 3,
    ...over,
  });
  const wake = (role: string, round: number, ms: number, warm: number, pulled: boolean) => ({
    role,
    round,
    arm: role,
    pulled_in_cycle: pulled,
    cold: { code: 200, ms },
    warm: [warm - 10, warm, warm + 10].map((m) => ({ code: 200, ms: m })),
    evidence: ev(),
  });
  const rows: Record<string, unknown>[] = [
    {
      role: 'deploy',
      round: 1,
      deploy_pulls: {
        'pp-u': [
          { pod: 'pp-u-1', node: 'n1', pull_duration_s: 2 },
          { pod: 'pp-u-2', node: 'n2', pull_duration_s: 4 },
        ],
        'pp-w': [{ pod: 'pp-w-1', node: 'n1', pull_duration_s: 8 }],
        'pp-p': [
          { pod: 'pp-pull-1', node: 'n1', pull_duration_s: 5 },
          { pod: 'pp-pull-2', node: 'n2', pull_duration_s: 7 },
        ],
      },
    },
  ];
  for (let k = 1; k <= 5; k++) rows.push(wake('pulled', k, 850 + 50 * k, 40, false));
  for (let k = 1; k <= 4; k++)
    rows.push(wake('fresh-cached-or-unpulled', k, 1150 + 50 * k, 60, false));
  if (withPulledU) rows.push(wake('fresh-cached-or-unpulled', 5, 2000, 60, true));
  for (let k = 1; k <= 4; k++) rows.push(wake('all-layers-new', k, 2900 + 100 * k, 70, true));
  rows.push({ ...wake('pulled', 6, 1, 1, false), cold: { code: 503, ms: 1 } });
  rows.push({ ...wake('pulled', 7, 1, 1, false), evidence: ev({ events_invalid: true }) });
  return rows;
}

describe('prepull-ab-analyze.py: pre-pull scale-from-zero summary', () => {
  const r = withRows(prepullRows(), (file) => py(PREPULL, [file]));

  it('excludes unusable wake rows and says how many', () => {
    expect(r.code).toBe(0);
    // 1 deploy row + 16 wake rows; the 503 and the failed events fetch are dropped.
    expect(r.out).toContain('rounds(deploy rows)=1 wake rows=14 invalid wake rows=2');
    expect(r.out).toContain('INVALID 6 pulled');
    expect(r.out).toContain('INVALID 7 pulled');
  });

  it('summarises kubelet pull durations per image group, keeping pre-pull pods apart', () => {
    expect(r.out).toContain('pulls observed=2 with duration=2 nodes=');
    // pp-u pulls were 2 s and 4 s: median 3000, Q1 2500, Q3 3500, p95 = 2000 + 2000*0.95.
    expect(r.out).toContain(
      'pull ms: n=2 median=3000 IQR=[2500,3500] p95=3900 range=[2000,4000] mean=3000',
    );
    expect(r.out).toContain(
      'pull ms: n=1 median=8000 IQR=[8000,8000] p95=8000 range=[8000,8000] mean=8000',
    );
    // the two pp-pull-* pods (5 s and 7 s) are reported on their own line.
    expect(r.out).toContain(
      'pre-pull pod pulls (pp-p images, both nodes) ms: n=2 median=6000 IQR=[5500,6500] p95=6900 range=[5000,7000] mean=6000',
    );
  });

  it('splits wakes into pre-pulled, cache-hit, pulled-in-cycle and all-layers-new', () => {
    expect(r.out).toContain(
      'PRE-PULLED (image pulled onto both nodes before the wake): n=5 median=1000 IQR=[950,1050] p95=1090 range=[900,1100] mean=1000',
    );
    expect(r.out).toContain(
      '(cached on the node it landed): n=4 median=1275 IQR=[1238,1312] p95=1342 range=[1200,1350] mean=1275',
    );
    expect(r.out).toContain('(node without layer): n=1 median=2000');
    expect(r.out).toContain('pulled in-cycle: n=4 median=3150');
    expect(r.out).toContain('pp-u wakes landing on node without layer: 1 of 5');
    expect(r.out).toContain('pp-w wakes pulled in-cycle: 4 of 4');
  });

  it('pairs cache-hit and pre-pulled wakes by round with HL shift and a Wilcoxon p', () => {
    // every pair differs by exactly 300 ms, so median = HL = 300 and the bootstrap CI is [300, 300].
    // Four positive differences, all tied: W+ = 10, mu = 5, sd = sqrt(7.5), z = 4.5 / sd,
    // p = erfc(z / sqrt 2) = 0.1003.
    expect(r.out).toContain('paired (n=4 rounds): pp-u fresh-cached minus pp-p pulled');
    expect(r.out).toContain(
      'median diff=+300 ms  HL=+300 ms  95% bootstrap CI(HL)=[+300,+300]  Wilcoxon p=0.1',
    );
    // round 5: pulled-in-cycle 2000 against pre-pulled 1100.
    expect(r.out).toContain(
      'paired (n=1): pp-u wake that pulled minus pp-p pulled: median diff=+900 ms  HL=+900 ms',
    );
  });

  it('compares the all-layers-new wakes with the pre-pulled ones without pairing', () => {
    // 4 vs 5 wakes with no overlap and no ties: exact two-sided p = 2 / C(9,4) = 0.0159.
    expect(r.out).toContain('unpaired pp-w(pulled) vs pp-p: diff=+2150 ms, MW p=0.0159');
  });

  it('turns apiserver timestamps into created->started and created->Ready', () => {
    expect(r.out).toContain(
      'pp-p pre-pulled: pod created->container started median 2.0 s; created->Ready median 5.0 s (n=5)',
    );
  });

  it('prints a model line only when no wake had to pull', () => {
    expect(r.out).not.toContain('Model (not a measurement)');
    const m = withRows(prepullRows(false), (file) => py(PREPULL, [file]));
    // cached wake median 1275 (1200, 1250, 1300, 1350) + pull median 3000 (the two pp-u pulls) = 4275
    expect(m.out).toContain(
      'Model (not a measurement): cached wake median 1275 ms (pp-u, no in-cycle pull) + pull median 3000 ms = 4275 ms',
    );
  });

  it('warns when wake rows lack an events count', () => {
    const rows = prepullRows().map((x) => {
      if (x.role === 'pulled' && x.round === 1) {
        const e = { ...(x.evidence as Record<string, unknown>) };
        delete e.events_n;
        return { ...x, evidence: e };
      }
      return x;
    });
    const w = withRows(rows, (file) => py(PREPULL, [file]));
    expect(w.out).toContain('NOTE: 1 wake rows carry no events_n');
  });
});

/**
 * Burst study (imagePrewarm). Rounds 1-3 of each arm, two pods per trial on n1 and n2.
 *   off: burst ms 100, 200, 300 (median 200, max 300). Both pods pulled in-cycle: pull 10 s on
 *        the first pod of n1 and 12 s on n2; scheduled -> Ready 20 s and 22 s.
 *   on:  burst ms 100, 120, 140 (median 120, max 140). Both pods cached: no pull, 3 s to Ready.
 * Round 4 of `off` has a failed burst and must be marked INVALID and left out of the pairing.
 */
function burstRows(): Record<string, unknown>[] {
  const pod = (name: string, node: string, off: boolean, createdAt: number) => ({
    pod: name,
    node,
    created: iso(createdAt),
    scheduled: iso(createdAt),
    ready: iso(createdAt + (off ? (node === 'n1' ? 20 : 22) : 3)),
    pulled_in_cycle: off,
    pull_duration_s: off ? (node === 'n1' ? 10 : 12) : null,
    events_n: 4,
  });
  const rows: Record<string, unknown>[] = [];
  for (let k = 1; k <= 3; k++) {
    for (const arm of ['off', 'on']) {
      const off = arm === 'off';
      rows.push({
        arm,
        round: k,
        burst: {
          res: (off ? [100, 200, 300] : [100, 120, 140]).map((ms) => ({ code: 200, ms })),
        },
        pods: [pod(`${arm}-${k}-a`, 'n1', off, 0), pod(`${arm}-${k}-b`, 'n2', off, 1)],
      });
    }
  }
  // The invalid trial still reports its pods: two on n1, the later one pulled for 4 s and took 8 s.
  rows.push({
    arm: 'off',
    round: 4,
    burst: { error: 'timeout', res: [] },
    pods: [
      pod('off-4-a', 'n1', true, 0),
      {
        ...pod('off-4-b', 'n1', true, 1),
        pull_duration_s: 4,
        ready: iso(1 + 8),
      },
    ],
  });
  return rows;
}

describe('burst-ab-analyze.py: scale-out burst A/B summary', () => {
  const r = withRows(burstRows(), (file) => py(BURST, [file]));

  it('counts trials per arm and marks a failed burst INVALID', () => {
    expect(r.code).toBe(0);
    expect(r.out).toContain('== off (BEFORE, imagePrewarm off): trials=4 valid=3');
    expect(r.out).toContain('== on (AFTER, imagePrewarm on): trials=3 valid=3');
    expect(r.out).toContain("off 4 2 ['n1', 'n1'] 2 [10, 4] None None INVALID");
  });

  it('prints per-trial pods, nodes, in-cycle pulls and burst latency', () => {
    expect(r.out).toContain("off 1 2 ['n1', 'n2'] 2 [10, 12] 200 300");
    expect(r.out).toContain("on 1 2 ['n1', 'n2'] 0 [] 120 140");
  });

  it('separates the first pulling pod on a node from later ones', () => {
    expect(r.out).toContain('off: pulled/pods by node: n1: 5/5, n2: 3/3');
    expect(r.out).toContain('on: pulled/pods by node: n1: 0/3, n2: 0/3');
    // first pod per node: 3 x 10 s (n1) + 3 x 12 s (n2) + the invalid trial's 10 s = 7 values.
    expect(r.out).toContain(
      'off Pulled event, first pod per node ms: n=7 median=10000 IQR=[10000,12000] p95=12000 range=[10000,12000] mean=10857',
    );
    expect(r.out).toContain('off Pulled event, later pod per node ms: n=1 median=4000');
    expect(r.out).toContain('off bound->Ready, later pulling pod per node: median=8.0 s (n=1)');
  });

  it('reports bound->Ready per pod, split by whether it pulled', () => {
    expect(r.out).toContain('off pulled: n=8');
    expect(r.out).toContain('off cached: n=0');
    expect(r.out).toContain('on cached: n=6 bound->Ready median=3.0 s p95=3.0 s');
  });

  it('summarises burst latency over valid trials only', () => {
    expect(r.out).toContain('off burst request median ms: n=3 median=200');
    // p95 of [100, 200, 300] is 290; the burst max is 300.
    expect(r.out).toContain(
      'off burst request p95 median=290 ms, max median=300 ms, pods/trial median=2',
    );
    expect(r.out).toContain(
      'on burst request p95 median=138 ms, max median=140 ms, pods/trial median=2',
    );
  });

  it('pairs AFTER-BEFORE by round and leaves the invalid round out', () => {
    // medians 120 vs 200 and maxima 140 vs 300 in every one of the 3 valid rounds.
    // Three equal negative differences: W+ = 0, mu = 3, sd = sqrt(3.5), z = 2.5 / sd,
    // p = erfc(z / sqrt 2) = 0.181.
    expect(r.out).toContain(
      'paired (n=3 rounds) AFTER-BEFORE, burst request median: median diff=-80 ms HL=-80 ms 95% CI(HL)=[-80,-80] Wilcoxon p=0.181',
    );
    expect(r.out).toContain(
      'paired (n=3 rounds) AFTER-BEFORE, burst request max: median diff=-160 ms HL=-160 ms 95% CI(HL)=[-160,-160] Wilcoxon p=0.181',
    );
  });
});

// ---------------------------------------------------------------------------------------
// cpu-boost-analyze.py
// ---------------------------------------------------------------------------------------

/**
 * Three arms x 4 wakes. Wake i (0..3) of every arm lands on n1 when i is even, n2 when odd.
 * First byte: cpu-base 1300 + 20 i, cpu-boost2 = base - 200, cpu-boost2req = base - 100.
 * Every other phase timestamp is the same constant in all wakes, so each gap is derivable:
 *   pod_added 100, pod_bound 150, pod_ip = containers running = 1000, app :3000 1010,
 *   queue-proxy :8012 1020, Ready 1050, EndpointSlice present 1060 / ready 1070,
 *   response end = first byte + 1;
 *   user container prints "Ready in" at 400; queue-proxy's first log is at 410.
 * Three more rows must be excluded: a harness error, a 503, and a wake whose Pod object
 * was never ADDED after the request.
 */
function cpuBoostRows(): Record<string, unknown>[] {
  const mk = (arm: string, i: number, fb: number, over: Record<string, unknown> = {}) => ({
    arm,
    round: i,
    node: i % 2 === 0 ? 'n1' : 'n2',
    code: 200,
    watch: {
      pod_added: 100,
      pod_bound: 150,
      pod_ip: 1000,
      cond_PodReadyToStartContainers: 1000,
      'user-container_running': 1000,
      'queue-proxy_running': 1000,
      app_tcp_3000: 1010,
      qp_tcp_8012: 1020,
      cond_Ready: 1050,
      eps_present: 1060,
      eps_ready: 1070,
      first_byte: fb,
      resp_end: fb + 1,
    },
    logs: {
      'user-container': [{ t: 400, line: '  ✓ Ready in 300ms' }],
      'queue-proxy': [{ t: 410, line: 'queue-proxy started' }],
    },
    ...over,
  });
  const rows: Record<string, unknown>[] = [];
  for (let i = 0; i < 4; i++) {
    rows.push(mk('cpu-base', i, 1300 + 20 * i));
    rows.push(mk('cpu-boost2', i, 1100 + 20 * i));
    rows.push(mk('cpu-boost2req', i, 1200 + 20 * i));
  }
  rows.push({ arm: 'cpu-base', round: 8, node: 'n1', error: 'harness timeout' });
  rows.push(mk('cpu-boost2', 9, 5000, { code: 503 }));
  rows.push(mk('cpu-boost2req', 10, 5000, { watch: { pod_added: 0, first_byte: 5000 } }));
  return rows;
}

describe('cpu-boost-analyze.py: startup-CPU-boost and listening->Ready tables', () => {
  const r = withRows(cpuBoostRows(), (file) => py(CPUBOOST, [file]));

  it('excludes wakes with an error, a non-200 or no ADDED pod, and says why', () => {
    expect(r.code).toBe(0);
    expect(r.out).toContain('== wakes: total 15 excluded 3');
    expect(r.out).toContain("excluded ('cpu-base', 8, 'error/non-200')");
    expect(r.out).toContain("excluded ('cpu-boost2', 9, 'error/non-200')");
    expect(r.out).toContain("excluded ('cpu-boost2req', 10, 'no pod added after t0')");
    expect(r.out).toContain("cpu-base: kept 4, nodes ['n1', 'n2']");
  });

  it('summarises first byte per arm, overall and per node', () => {
    expect(r.out).toContain('cpu-base: n=4 median=1330 p95=1357 mean=1330 min=1300 max=1360');
    expect(r.out).toContain('cpu-boost2: n=4 median=1130 p95=1157 mean=1130 min=1100 max=1160');
    expect(r.out).toContain('cpu-boost2req: n=4 median=1230 p95=1257 mean=1230 min=1200 max=1260');
    // n1 holds wakes 0 and 2 (1300, 1340), n2 holds wakes 1 and 3 (1320, 1360).
    expect(r.out).toContain('n1 cpu-base: n=2 median=1320 p95=1338 mean=1320 min=1300 max=1340');
    expect(r.out).toContain('n2 cpu-base: n=2 median=1340 p95=1358 mean=1340 min=1320 max=1360');
  });

  it('computes the Hodges-Lehmann shift, a bounded bootstrap CI and the Mann-Whitney p', () => {
    // 4 vs 4 with no overlap: U = 0, mu = 8, sd = sqrt(12), z = 8 / sd, p = erfc(z / sqrt 2) = 0.021.
    for (const [arm, shift] of [
      ['cpu-boost2', -200],
      ['cpu-boost2req', -100],
    ] as const) {
      const m = r.out.match(
        new RegExp(
          `${arm} - cpu-base: HL shift=(-?\\d+) ms, median diff CI95=\\[(-?\\d+), (-?\\d+)\\], MWU p=0\\.021`,
        ),
      );
      expect(m).not.toBeNull();
      expect(Number(m?.[1])).toBe(shift);
      // a difference of resampled medians cannot leave [min - max, max - min] of the arms.
      expect(Number(m?.[2])).toBeGreaterThanOrEqual(shift - 60);
      expect(Number(m?.[3])).toBeLessThanOrEqual(shift + 60);
      expect(Number(m?.[2])).toBeLessThan(Number(m?.[3]));
    }
  });

  it('tabulates phase timestamps and the gaps between consecutive phases', () => {
    expect(r.out).toContain('pod_bound                median=    150 p95=    150');
    expect(r.out).toContain('cond_Ready               median=   1050 p95=   1050');
    expect(r.out).toContain('first_byte               median=   1230 p95=   1349');
    expect(r.out).toContain('pod_bound                -> pod_ip                   median=    850');
    expect(r.out).toContain('qp_tcp_8012              -> cond_Ready               median=     30');
    expect(r.out).toContain('eps_ready                -> first_byte               median=    160');
  });

  it('anchors the container start to the "Ready in" log line, per arm', () => {
    // bound 150 -> "Ready in" at 400 is 250; "Ready in" -> Ready condition 1050 is 650.
    expect(r.out).toContain(
      'cpu-boost2     n= 4 bound->Ready-in median=250 p95=250 | Ready-in->cond_Ready median=650 p95=650 | first_byte median=1130',
    );
    expect(r.out).toContain(
      "distinct 'Ready in' lines: ['✓ Ready in 300ms'] ; wakes without one: 0",
    );
    expect(r.out).toContain(
      "'Ready in' -> queue-proxy first log (positive = qp later): n=12 min=10",
    );
  });

  it('checks that the status fields share a timestamp and bins the queue-proxy -> podIP lag', () => {
    expect(r.out).toContain('share one timestamp: 12/12 wakes');
    expect(r.out).toContain('cond_Ready has the same timestamp as podIP: 0/12 wakes');
    expect(r.out).toContain('wakes with body end > 1 ms after first byte: 0');
    // podIP 1000 - queue-proxy first log 410 = 590 ms: every wake falls in the 500-600 bin.
    expect(r.out).toContain('counts in 100 ms bins from 0: [0, 0, 0, 0, 0, 12, 0, 0, 0, 0, 0]');
  });

  it('runs a seeded within-node permutation test and reports an n-weighted effect', () => {
    for (const [arm, eff] of [
      ['cpu-boost2', -200],
      ['cpu-boost2req', -100],
    ] as const) {
      const m = r.out.match(
        new RegExp(
          `${arm} - cpu-base: n-weighted mean of per-node median differences=(-?\\d+) ms, two-sided p=(\\d\\.\\d+)`,
        ),
      );
      expect(m).not.toBeNull();
      expect(Number(m?.[1])).toBe(eff);
      expect(Number(m?.[2])).toBeGreaterThan(0);
      expect(Number(m?.[2])).toBeLessThanOrEqual(1);
    }
  });
});

// ---------------------------------------------------------------------------------------
// node-diagnosis-analyze.py
// ---------------------------------------------------------------------------------------

/**
 * Five complete wakes i = 0..4 plus a sixth that has only a bound time and a first byte.
 *   bound 100 + 10 i;  user-container first log 300 + 10 i;  "Ready in" log at 320 + 10 i;
 *   queue-proxy first log 310 + 10 i;
 *   podIP = queue-proxy first log + lag_i, lag = 100, 300, 500, 700, 900;
 *   Ready = podIP + 50;  first byte = Ready + 100;  app :3000 = podIP + 20;
 *   container startedAt = bound + 20.
 * Wake 0 has two readiness-probe failures and wake 3 has one; wake 2 needed two :3000 probes.
 * Rows that must not count: a harness error, a 503, and a row with no watch block.
 */
function nodeDiagRows(): Record<string, unknown>[] {
  const lags = [100, 300, 500, 700, 900];
  const rows: Record<string, unknown>[] = lags.map((lag, i) => {
    const bound = 100 + 10 * i;
    const podIp = 310 + 10 * i + lag;
    const unhealthy = (n: number) =>
      Array.from({ length: n }, () => ({ reason: 'Unhealthy', msg: 'Readiness probe failed: x' }));
    return {
      arm: 'cpu-base',
      code: 200,
      clock: { offset_ms: 0.2, rtt_ms: 1.0 },
      probe_attempts: { tcp3000: i === 2 ? 2 : 1 },
      status: { startedAt_user: bound + 20 },
      events: [
        ...unhealthy(i === 0 ? 2 : i === 3 ? 1 : 0),
        { reason: 'Pulled', msg: 'already present' },
      ],
      watch: {
        pod_bound: bound,
        pod_ip: podIp,
        cond_Ready: podIp + 50,
        first_byte: podIp + 150,
        app_tcp_3000: podIp + 20,
      },
      logs: {
        'user-container': [
          { t: 300 + 10 * i, line: 'starting' },
          { t: 320 + 10 * i, line: '  ✓ Ready in 400ms' },
        ],
        'queue-proxy': [{ t: 310 + 10 * i, line: 'qp up' }],
      },
    };
  });
  rows.push({ arm: 'cpu-base', code: 200, watch: { pod_bound: 200, first_byte: 900 } });
  rows.push({ arm: 'cpu-base', error: 'harness timeout', watch: { pod_bound: 1 } });
  rows.push({ arm: 'cpu-base', code: 503, watch: { pod_bound: 1, first_byte: 2 } });
  rows.push({ arm: 'cpu-base', code: 200 });
  return rows;
}

describe('node-diagnosis-analyze.py: segment analysis of the node diagnosis run', () => {
  const { r, json } = withRows(nodeDiagRows(), (file, dir) => {
    const out = join(dir, 'out.json');
    const r = py(NODEDIAG, [file, '--json', out]);
    return { r, json: JSON.parse(readFileSync(out, 'utf8')) };
  });
  const seg = (name: string) =>
    (json.segments as { name: string }[]).find((s) => s.name === name) as unknown as Record<
      string,
      number
    >;

  it('counts rows and keeps only wakes with a watch block, HTTP 200 and no error', () => {
    expect(r.code).toBe(0);
    expect(json.rows).toBe(9);
    // five full wakes + the sparse one; the error row, the 503 and the watch-less row are out.
    expect(json.valid).toBe(6);
  });

  it('reports each segment on the harness clock', () => {
    expect(seg('bound_to_user_log')).toMatchObject({ n: 5, median: 200, min: 200, max: 200 });
    expect(seg('bound_to_ready_in')).toMatchObject({ n: 5, median: 220 });
    expect(seg('bound_to_qp_log')).toMatchObject({ n: 5, median: 210 });
    expect(seg('user_log_to_qp_log')).toMatchObject({ n: 5, median: 10 });
    expect(seg('podip_to_ready')).toMatchObject({ n: 5, median: 50 });
    expect(seg('ready_to_first_byte')).toMatchObject({ n: 5, median: 100 });
    expect(seg('bound_to_started_at')).toMatchObject({ n: 5, median: 20 });
    expect(seg('podip_to_app_tcp3000')).toMatchObject({ n: 5, median: 20 });
  });

  it('drops a missing timestamp from a segment instead of counting it as zero', () => {
    // wake_to_bound and total_first_byte exist for all 6 wakes; every segment that needs a
    // log or a podIP has only the 5 wakes that carry them.
    expect(seg('wake_to_bound')).toMatchObject({ n: 6, median: 125, min: 100, max: 200 });
    expect(seg('bound_to_user_log').n).toBe(5);
    // first bytes 560, 770, 900, 980, 1190, 1400: median (900 + 980) / 2.
    expect(seg('total_first_byte')).toMatchObject({ n: 6, median: 940, min: 560, max: 1400 });
  });

  it('measures the lag from the queue-proxy log and from "Ready in" to the podIP', () => {
    // lag_i = 100, 300, 500, 700, 900 from the queue-proxy log; "Ready in" is 10 ms later.
    expect(seg('qp_log_to_podip')).toMatchObject({ n: 5, median: 500, min: 100, max: 900 });
    expect(seg('ready_in_to_podip')).toMatchObject({ n: 5, median: 490, min: 90, max: 890 });
    expect(seg('ready_in_to_ready')).toMatchObject({ n: 5, median: 540 });
  });

  it('tests the lags against Uniform(0, 1000) with the Kolmogorov-Smirnov statistic', () => {
    // lag/1000 = .1 .3 .5 .7 .9: D = max(|(i+1)/5 - x|, |x - i/5|) = 0.1.
    expect(json.uniform_test_qp_log_to_podip_U0_1000).toMatchObject({ n: 5, D: 0.1 });
    // shifted 10 ms earlier: .09 .29 .49 .69 .89, D = 0.2 - 0.09 = 0.11.
    expect(json.uniform_test_ready_in_to_podip_U0_1000).toMatchObject({ n: 5, D: 0.11 });
    expect(json.uniform_test_qp_log_to_podip_U0_1000.p).toBeGreaterThan(0.99);
  });

  it('counts "Ready in" lines, first-try probes, readiness failures and the clock bounds', () => {
    expect(json.ready_in_lines_count).toEqual({ '✓ Ready in 400ms': 5 });
    // wake 2 needed two probes, and the sparse wake carries no probe data at all.
    expect(json.harness_tcp3000_first_try).toEqual([4, 6]);
    expect(json.wakes_with_readiness_unhealthy).toBe(2);
    expect(json.readiness_unhealthy_events_per_wake).toMatchObject({ n: 6, max: 2, mean: 0.5 });
    expect(json.clock_offset_ms).toMatchObject({ n: 5, median: 0.2 });
  });

  it('prints the same numbers to stdout without --json', () => {
    expect(r.out).toContain("'name': 'wake_to_bound', 'n': 6, 'median': 125.0");
    expect(r.out).toContain('harness tcp3000 first try [4, 6]');
    expect(r.out).toContain('wakes with any: 2');
  });
});

// ---------------------------------------------------------------------------------------
// baseline-stability-analyze.py
// ---------------------------------------------------------------------------------------

/**
 * This analyzer takes no arguments: it reads three fixed files from docs/benchmarks/data/,
 * located relative to the script (parents[2]). The test therefore copies the script into a
 * temp tree shaped like the repo (`scripts/bench-cold-start-phases/`, `docs/benchmarks/data/`)
 * and writes synthetic data there, so the analysis never depends on the committed benchmark
 * data (which is evidence, not a fixture) and never writes next to it.
 *
 * The data is built from closed-form rows so the headline numbers can be derived by hand:
 *
 *   balanced run, 24 target wakes i = 0..23 (plus a companion arm per round):
 *     node      .169 when i is odd, .118 when i is even       (12 each)
 *     spacing   long when floor(i/2) is odd                    (12 each; 6 per node)
 *     response  1000 + 400*[.169] + 100*[long] + 3*i + 10*(((5 i) mod 7) - 3)
 *   three-arm run, 8 rounds: cpu-base on .118 when i mod 3 = 2, else .169
 *   single-arm run, 8 wakes, all on .169
 *
 * bound -> first user log is 440 ms (fast) or 880 ms (slow) in every run.
 */
const NODE_A = '10.0.1.169';
const NODE_B = '10.0.1.118';
const T0 = Date.UTC(2026, 10, 2, 18, 0, 0);
const wall = (sec: number): string => new Date(T0 + sec * 1000).toISOString();

function stabilityRow(
  arm: string,
  node: string,
  sec: number,
  y: number,
  slow: boolean,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  const bound = 120;
  return {
    arm,
    node,
    code: 200,
    wall_start: wall(sec),
    watch: { pod_bound: bound, pod_ip: bound + (slow ? 1000 : 600), resp_end: y },
    logs: { 'user-container': [{ t: bound + (slow ? 880 : 440), line: 'x' }] },
    ...over,
  };
}

function stabilityData(): { threeArm: unknown[]; singleArm: unknown[]; balanced: unknown[] } {
  const threeArm: unknown[] = [];
  for (let i = 0; i < 8; i++) {
    const t = 3600 * i;
    const slow = i % 2 === 1;
    const node = i % 3 === 2 ? NODE_B : NODE_A;
    const order = i % 2 === 0 ? 'fwd' : 'rev';
    const common = { round: i + 1, order, waited_s: 60 + (i % 3) * 10 };
    const y = 1200 + (node === NODE_A ? 300 : 0) + 40 * ((i * 3) % 5);
    threeArm.push(stabilityRow('cpu-base', node, t, y, slow, common));
    threeArm.push(
      stabilityRow('cpu-boost2', i % 2 ? NODE_B : NODE_A, t + 60, y - 100, slow, common),
    );
    threeArm.push(stabilityRow('cpu-boost2req', NODE_A, t + 120, y - 50, slow, common));
  }
  const singleArm: unknown[] = [];
  for (let i = 0; i < 8; i++) {
    singleArm.push(
      stabilityRow('cpu-base', NODE_A, 3600 * i, 1800 + 50 * (i % 3), i % 3 !== 0, {
        round: i + 1,
        waited_s: 70 + i,
      }),
    );
  }
  const balanced: unknown[] = [];
  for (let i = 0; i < 24; i++) {
    const node169 = i % 2 === 1;
    const long = Math.floor(i / 2) % 2 === 1;
    const y = 1000 + (node169 ? 400 : 0) + (long ? 100 : 0) + 3 * i + 10 * (((5 * i) % 7) - 3);
    // slow start mode: 9 of 12 wakes on .118 but only 4 of 12 on .169
    const slow = node169 ? (5 * i) % 7 < 2 : (5 * i) % 7 < 5;
    const bg = (k: number) => ({
      [NODE_A]: {
        node_cpu_nc: 1000 + 10 * ((i * k) % 9),
        psi_cpu_some_avg10: 0.1 * ((i * k) % 5),
        node_mem_ws: 5e9 + 1e6 * i,
        n_running: 5 + (i % 3),
        n_running_bench_cells: 2,
      },
      [NODE_B]: {
        node_cpu_nc: 900 + 10 * ((i * k) % 7),
        psi_cpu_some_avg10: 0.05 * ((i * k) % 4),
        node_mem_ws: 4e9 + 1e6 * i,
        n_running: 4 + (i % 2),
        n_running_bench_cells: 2,
      },
    });
    const common = {
      round: i + 1,
      slot: Math.floor(i / 4) % 2,
      order: i % 2 === 0 ? 'fwd' : 'rev',
      waited_s: 60 + (i % 4),
      spacing: long ? 'long' : 'short',
      extra_idle_s: long ? 150 : 0,
      bg_pre: bg(1),
      bg_post: bg(2),
    };
    const t = 1800 * i;
    balanced.push(stabilityRow('cpu-base', node169 ? NODE_A : NODE_B, t, y, slow, common));
    balanced.push(
      stabilityRow(
        'cpu-boost2req',
        node169 ? NODE_B : NODE_A,
        t + 60,
        y - 100 + 5 * (i % 4),
        slow,
        common,
      ),
    );
  }
  return { threeArm, singleArm, balanced };
}

/** Runs the analyzer in a repo-shaped temp tree; `mutate` can edit the data first. */
function runStability(
  extraArgs: string[] = [],
  mutate: (d: ReturnType<typeof stabilityData>) => void = () => {},
): { out: string; code: number; err: string; json?: Record<string, unknown> } {
  return withTmp((dir) => {
    const scriptDir = join(dir, 'scripts/bench-cold-start-phases');
    const dataDir = join(dir, 'docs/benchmarks/data');
    mkdirSync(scriptDir, { recursive: true });
    mkdirSync(dataDir, { recursive: true });
    copyFileSync(join(ROOT, STABILITY), join(scriptDir, 'baseline-stability-analyze.py'));
    const d = stabilityData();
    mutate(d);
    writeFileSync(join(dataDir, 'cpu-boost-oke-2026-11-02.jsonl'), jsonl(d.threeArm));
    writeFileSync(
      join(dataDir, 'cold-start-node-diagnosis-oke-2026-11-02.jsonl'),
      jsonl(d.singleArm),
    );
    writeFileSync(
      join(dataDir, 'cold-start-baseline-stability-oke-2026-11-02.jsonl'),
      jsonl(d.balanced),
    );
    const jsonOut = join(dir, 'o.json');
    const r = spawnSync(
      'python3',
      [
        join(scriptDir, 'baseline-stability-analyze.py'),
        ...extraArgs.map((a) => a.replace('$JSON', jsonOut)),
      ],
      { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } },
    );
    let json: Record<string, unknown> | undefined;
    try {
      json = JSON.parse(readFileSync(jsonOut, 'utf8'));
    } catch {}
    return { out: r.stdout, code: r.status ?? -1, err: r.stderr, json };
  });
}

describe('baseline-stability-analyze.py: baseline-stability study', () => {
  // One run (about 5 s: the script resamples thousands of times); every test reads it.
  const r = runStability(['--json', '$JSON']);
  const num = (re: RegExp): number[] => {
    const m = r.out.match(re);
    expect(m).not.toBeNull();
    return (m ?? []).slice(1).map(Number);
  };

  it('runs to completion on the three data files and writes its JSON record', () => {
    expect(r.err).toBe('');
    expect(r.code).toBe(0);
    for (const section of [
      '##### A. OFFLINE',
      '##### B. LIVE',
      '##### C. START MODE',
      '##### D. SHAPE OF',
    ])
      expect(r.out).toContain(section);
    expect(Object.keys(r.json ?? {}).length).toBeGreaterThan(20);
  });

  describe('A. committed runs', () => {
    it('describes each run per node', () => {
      // three-arm: y = 1200 + 300*[.169] + 40*((3 i) mod 5) for i = 0..7.
      expect(r.out).toContain(
        '== three-arm run, cpu-base only: n=8 median=1560 mean=1495 sd=166 min=1200 max=1660',
      );
      expect(r.out).toContain('node .118: n=2 median=1220 mean=1220 sd=20');
      expect(r.out).toContain('node .169: n=6 median=1600 mean=1587 sd=54');
      // single-arm: y = 1800 + 50 * (i mod 3).
      expect(r.out).toContain(
        '== single-arm run, cpu-base only: n=8 median=1850 mean=1844 sd=39 min=1800 max=1900',
      );
    });

    it('compares the same node across runs and refuses a comparison with fewer than 3 wakes', () => {
      expect(r.out).toMatch(
        /offline: single-arm@169 minus three-arm@169: median single@169=1850 \(n=8, mean 1844, sd 39\) three@169=1600 \(n=6, mean 1587, sd 54\) diff=\+250 ms {2}95% CI \[\+\d+, \+\d+\] {2}perm p=0\.\d{3}/,
      );
      expect(r.out).toContain(
        'offline: three-arm@169 minus three-arm@118: n(169)=6 n(118)=2 too few',
      );
    });

    it('reports wake spacing and the order effect', () => {
      expect(r.out).toContain(
        '[three-arm] zero-pod wait: median 70 s (min 60, max 80); gap between consecutive cpu-base wakes: median 60.0 min',
      );
      expect(r.out).toContain('offline: fwd order minus rev order: median fwd=1540 (n=4');
      expect(r.out).toContain("(slot, node): count  -> {(0, '118'): 2, (0, '169'): 6}");
    });

    it('breaks the .169 comparison into segments and gets the shared segments exactly equal', () => {
      expect(r.out).toContain(
        'offline segment wake_to_bound: single@169 minus three@169: median single=120 (n=8, mean 120, sd 0) three=120 (n=6, mean 120, sd 0) diff=+0 ms',
      );
      expect(r.out).toContain(
        'offline segment total: single@169 minus three@169: median single=1850',
      );
    });
  });

  describe('B. the balanced run', () => {
    it('describes the target arm overall and per node', () => {
      // y = 1000 + 400*[.169] + 100*[long] + 3 i + 10*(((5 i) mod 7) - 3), i = 0..23.
      expect(r.out).toContain(
        '== balanced run, cpu-base target: n=24 median=1304 mean=1284 sd=209 min=970 max=1569',
      );
      expect(r.out).toContain('node .118: n=12 median=1078 mean=1084 sd=60');
      expect(r.out).toContain('node .169: n=12 median=1461 mean=1484 sd=62');
      expect(r.out).toContain('wakes per node (target): .118=12  .169=12');
      for (const cell of ['.118 / short', '.169 / short', '.118 / long', '.169 / long'])
        expect(r.out).toContain(`cell node ${cell}: n=6`);
    });

    it('measures the node effect as a difference of medians with a CI that contains it', () => {
      const [diff, lo, hi] = num(
        /live: node \.169 minus \.118: median 169=1461 \(n=12, mean 1484, sd 62\) 118=1078 \(n=12, mean 1084, sd 60\) diff=\+(\d+) ms {2}95% CI \[\+(\d+), \+(\d+)\]/,
      );
      expect(diff).toBe(383);
      expect(lo).toBeLessThanOrEqual(383);
      expect(hi).toBeGreaterThanOrEqual(383);
      const rec = (r.json as Record<string, { diff_ms: number; n_a: number; n_b: number }>)[
        'live: node .169 minus .118'
      ];
      expect(rec).toMatchObject({ diff_ms: 383, n_a: 12, n_b: 12 });
    });

    it('measures the spacing effect overall and within each node', () => {
      expect(r.out).toContain('live: long minus short (all): median long=1338');
      expect(r.out).toMatch(/short=1236 \(n=12, mean 1231, sd 198\) diff=\+101 ms/);
      expect(r.out).toMatch(/live: long minus short on \.118: .* diff=\+66 ms/);
      expect(r.out).toMatch(/live: long minus short on \.169: .* diff=\+136 ms/);
      expect(r.out).toContain('harness zero-pod wait: median 62 s; long-level extra idle 150 s');
    });

    it('reports the node effect segment by segment', () => {
      // .118 holds 8 of the 12 slow starts (880 ms), .169 only 4: so the user-log segment is
      // longer on .118 (median 880 vs 440) while the total is longer on .169.
      expect(r.out).toContain(
        'live segment wake_to_bound: .169 minus .118: median 169=120 (n=12, mean 120, sd 0) 118=120 (n=12, mean 120, sd 0) diff=+0 ms',
      );
      expect(r.out).toContain(
        'live segment bound_to_first_user_log: .169 minus .118: median 169=440 (n=12, mean 587, sd 207) 118=880 (n=12, mean 733, sd 207) diff=-440 ms',
      );
      expect(r.out).toContain(
        'live segment bound_to_podip: .169 minus .118: median 169=600 (n=12, mean 733, sd 189) 118=1000 (n=12, mean 867, sd 189) diff=-400 ms',
      );
      expect(r.out).toContain('live segment total: .169 minus .118: median 169=1461');
    });

    it('correlates the background load, and says so when a reading is constant', () => {
      expect(r.out).toMatch(
        /bg_pre\.node_cpu_nc \[both\]: n=24 rho=[+-]\d\.\d\d p=\d\.\d{3} {2}\(range 900\.\.1080\)/,
      );
      expect(r.out).toContain(
        'bg_pre.n_running_bench_cells [both]: n=24 constant, no correlation computable',
      );
      expect(r.out).toContain('bg_pre.n_running [.118]: n=12 constant, no correlation computable');
      expect(r.out).toContain('.118 pre-wake node_cpu_nc: median 925 (min 900, max 960, n=12)');
      expect(r.out).toContain('.169 pre-wake n_running: median 6 (min 5, max 7, n=12)');
    });

    it('fits total ~ node + spacing + hours and recovers the planted effects', () => {
      // planted: 400 for the node, 100 for long spacing, ~3 ms per wake (6 ms per hour).
      const [icpt, node, longSp, perHour] = [
        'intercept',
        'node \\.169 \\(vs \\.118\\)',
        'long spacing \\(vs short\\)',
        'per hour of run',
      ].map((n) => {
        const m = r.out.match(
          new RegExp(`\\[without start mode\\] n=24[\\s\\S]*?${n}: ([+-]\\d+) ms`),
        );
        expect(m).not.toBeNull();
        return Number(m?.[1]);
      });
      expect(Math.abs(icpt - 1000)).toBeLessThan(40);
      expect(Math.abs(node - 400)).toBeLessThan(20);
      expect(Math.abs(longSp - 100)).toBeLessThan(20);
      expect(perHour).toBeGreaterThan(0);
      expect(perHour).toBeLessThan(12);
      expect(r.out).toMatch(/R\^2=0\.9\d {2}residual sd=\d+ ms/);
      expect(r.out).toContain('slow start mode (vs fast):');
      expect(Object.keys(r.json ?? {})).toContain('model_without start mode');
    });

    it('sizes the protocol from the variance it measured', () => {
      expect(r.out).toContain('total sd=214 ms; within-node sd=63 ms');
      expect(r.out).toContain('consecutive same-node target wakes, difference sd=107 ms (n=22)');
      // 2.8 * 63 * sqrt(2/15) = 64 ms unpaired; 2.8 * 107 / sqrt(15) = 78 ms paired.
      expect(r.out).toContain('per arm n=15, sd=63): 64 ms; paired on sd_diff=107: 78 ms');
    });

    it('compares against the earlier runs on the same node', () => {
      expect(r.out).toContain('live@118 minus three-arm@118: n(live)=12 n(three)=2 too few');
      expect(r.out).toMatch(
        /live@169 minus three-arm@169: median live=1461 .* three=1600 .* diff=-139 ms/,
      );
      expect(r.out).toMatch(/live@169 minus single-arm@169: median live=1461 .* diff=-389 ms/);
    });
  });

  describe('C. start-mode bimodality', () => {
    it('splits bound -> first user log at 650 ms and counts the two modes', () => {
      // 4 of 8 three-arm, 5 of 8 single-arm and 12 of 24 balanced wakes are slow: 21 of 40.
      expect(r.out).toContain(
        'all target wakes: fast mode median 440 (n=19, range 440-440); slow mode median 880 (n=21, range 880-880); gap between modes 440 ms',
      );
    });

    it('gives each run and node a slow share with a Wilson 95% interval', () => {
      // Wilson for 8/12: centre (p + z^2/2n) / (1 + z^2/n); computed independently = [39%, 86%].
      expect(r.out).toContain('balanced@118: slow 8/12 = 67% [39%, 86%]; total median 1078 ms');
      expect(r.out).toContain('balanced@169: slow 4/12 = 33% [14%, 61%]; total median 1461 ms');
      expect(r.out).toContain('three-arm@118: slow 1/2 = 50% [9%, 91%]; total median 1220 ms');
      expect(r.out).toContain('single-arm@169: slow 5/8 = 62% [31%, 86%]; total median 1850 ms');
    });

    it('computes exact Fisher p-values for the share comparisons', () => {
      // [[8,4],[4,8]]: two-sided hypergeometric p = 0.2203 (summed over tables no likelier).
      expect(r.out).toContain('slow/fast .118=(8, 4)  .169=(4, 8)  Fisher exact p=0.220');
      expect(r.out).toContain('three-arm@169 vs balanced@169=(4, 8): Fisher p=0.6267');
      expect(r.out).toContain(
        'three-arm@169 slow/fast=(3, 3) vs single-arm@169=(5, 3): Fisher p=1.0000',
      );
    });

    it('describes the sequence of modes per node in time order', () => {
      expect(r.out).toMatch(/\.118: sequence [Hl]{12}; consecutive same-mode \d+\/11/);
      expect(r.out).toMatch(/\.169: sequence [Hl]{12}; consecutive same-mode \d+\/11/);
    });
  });

  describe('D. shape and multiplicity', () => {
    it('finds the empty gap between the modes', () => {
      expect(r.out).toContain(
        'n=40 target wakes. Empirical gap at the 650 ms cut: fast max 440, slow min 880 (440 ms).',
      );
      expect(r.out).toContain(
        'three largest gaps between adjacent sorted values: 440 ms (440->880); 0 ms',
      );
      expect(r.out).toContain(
        'values between 600 and 700 ms: []  (n=0); values 643-664 inclusive: 0',
      );
      expect(r.out).toContain('cut 650: all 21/40 = 52%');
    });

    it('runs the seeded Silverman test', () => {
      const [h, p] = num(/h_crit=([\d.]+) ms, p=([\d.]+)\./);
      expect(h).toBeGreaterThan(0);
      expect(h).toBeLessThan(440);
      expect(p).toBeGreaterThan(0);
      expect(p).toBeLessThanOrEqual(1);
    });

    it('decomposes the total into the segment share and the R^2 of each predictor', () => {
      // mean segment (19 x 440 + 21 x 880) / 40 = 671 of mean total 1438.2 = 47%.
      expect(r.out).toContain(
        'decomposition (all 40 target wakes): the segment is part of the total. mean segment 671 ms of mean total 1438 ms = 47%; R^2 of total on the continuous segment alone = 0.01; R^2 of total on the slower-cluster indicator alone = 0.01',
      );
    });

    it('applies Bonferroni corrections to the quoted p-values', () => {
      expect(r.out).toContain('p=0.0432: Bonferroni(4) = 0.17, Bonferroni(19) = 0.82');
      expect(r.out).toContain('p=0.037: Bonferroni(4) = 0.15, Bonferroni(19) = 0.70');
    });

    it('attributes the single-arm vs three-arm change to the share of slow starts', () => {
      expect(r.out).toContain(
        'attribution on .169, single-arm vs three-arm: share 0.500 -> 0.625, change 0.125; same-node median difference 250 ms',
      );
      // 0.125 * 590 = 74 ms of the 250; 0.125 * 507 = 63 ms.
      expect(r.out).toContain('change x 590 (slower minus faster, total) = 74 ms = 30% of 250');
      expect(r.out).toContain('change x 507 (regression coefficient) = 63 ms = 25% of 250');
      expect(r.out).toContain('three-arm has 2 of 8 wakes on .118, single-arm is all .169');
    });

    it('tabulates node x slot and the within-round pairs', () => {
      expect(r.out).toContain(
        "balanced run node x slot counts: {('118', 0): 6, ('118', 1): 6, ('169', 0): 6, ('169', 1): 6}",
      );
      // companion = target - 100 + 5 * (i mod 4): the difference has sample sd 5.7, and the
      // companion always lands on the other node.
      expect(r.out).toContain('n=24, both on same node in 0 rounds');
      expect(r.out).toContain('sd of within-round difference 6');
      expect(r.out).toContain(
        'proxy paired MDE (sd of within-round difference 6, n pairs=15): 4 ms',
      );
    });
  });
});
