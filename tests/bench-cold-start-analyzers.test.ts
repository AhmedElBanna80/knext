import { describe, expect, it } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * The cold-start bench analyzers turn raw harness JSONL into the phase tables that
 * the cold-start ledger and the benchmark write-ups cite, and performance decisions
 * are made from those tables. This file runs each shared analyzer on a small
 * checked-in fixture and pins specific output values, then scans the directory so
 * a new analyzer cannot arrive without a test.
 *
 * The fixture (tests/fixtures/bench-cold-start-phases/) is synthetic: abstract node
 * pool names, no addresses, no kubeconfig contexts, no secrets. Eight valid wakes in
 * two arms (`base`, `var`) plus three rows the analyzers must exclude. Every value is
 * chosen so the expected output can be derived by hand:
 *
 *   base[i]: pod_added 100+10i, pod_bound 150+10i, first log 400+20i, "Ready in" 900+20i,
 *            qp ready 1200+20i, first byte 1300+20i
 *   var[i]:  the same, except "Ready in" 700+20i, qp ready 1000+20i, first byte 1100+20i
 *
 * Control-plane logs are joined to a wake by revision name and a time window.
 */

const ROOT = resolve(import.meta.dir, '..');
const FIXTURE = join(ROOT, 'tests/fixtures/bench-cold-start-phases');
const RUN = join(FIXTURE, 'run.jsonl');
const AUTOSCALER = join(FIXTURE, 'autoscaler.jsonl');
const ACTIVATOR = join(FIXTURE, 'activator.jsonl');

// Repo-relative paths are written out in full on purpose: the directory-scan guard
// below treats a quoted occurrence of a script's path in a test file as "this
// script has a test".
const ANALYZE = 'scripts/bench-cold-start-phases/analyze.py';
const STATS = 'scripts/bench-cold-start-phases/stats.py';
const COMPACT = 'scripts/bench-cold-start-phases/compact.py';
const COMPARE = 'scripts/bench-cold-start-phases/gke/compare.py';
const CPUPROFILE = 'scripts/bench-cold-start-phases/gke/cpuprofile-window.py';

function py(script: string, args: string[]): { out: string; code: number; err: string } {
  const r = spawnSync('python3', [join(ROOT, script), ...args], {
    encoding: 'utf8',
    // CPython would drop a __pycache__/ next to the imported modules (analyze, stats).
    env: {
      ...process.env,
      PYTHONDONTWRITEBYTECODE: '1',
      // Never let a developer's local bench-config.json change an analyzer's output.
      KNEXT_BENCH_CONFIG: join(FIXTURE, 'empty-config.json'),
    },
  });
  return { out: r.stdout, code: r.status ?? -1, err: r.stderr };
}

function withTmp<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'bench-analyzers-'));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// The harness no longer assumes a namespace, so the filter that drops other-ns lines is asked for.
const withLogs = [
  `--autoscaler=${AUTOSCALER}`,
  `--activator=${ACTIVATOR}`,
  '--namespace=bench-cells',
];

describe('analyze.py: phase tables', () => {
  const r = py(ANALYZE, [RUN]);

  it('exits 0 and reports which rows it excluded and why', () => {
    expect(r.code).toBe(0);
    expect(r.out).toContain(
      "valid 8, excluded 3: [(4, 'base', 'timeout waiting for first byte'), (5, 'base', '503'), (6, 'base', '200')]",
    );
  });

  it('groups by arm and sizes each group from the valid rows only', () => {
    expect(r.out).toContain('### base (n=4)');
    expect(r.out).toContain('### var (n=4)');
  });

  it('computes median, IQR and range per phase', () => {
    // base: request -> pod object is 100,110,120,130: median 115, Q1 105, Q3 125.
    expect(r.out).toContain(
      '| 1 activation: request -> Pod object | 115 | 20 [105, 125] | 100–130 |',
    );
    // base: first log 400+20i -> "Ready in" 900+20i is 500 every wake; var is 300.
    expect(r.out).toContain(
      '| 4 runtime boot: first log -> Next listening | 500 | 0 [500, 500] | 500–500 |',
    );
    expect(r.out).toContain(
      '| 4 runtime boot: first log -> Next listening | 300 | 0 [300, 300] | 300–300 |',
    );
    // total is first byte: base 1300..1360, var 1100..1160.
    expect(r.out).toContain(
      '| total: request -> first byte | 1330 | 40 [1310, 1350] | 1300–1360 |',
    );
    expect(r.out).toContain(
      '| total: request -> first byte | 1130 | 40 [1110, 1150] | 1100–1160 |',
    );
  });

  it('takes ctr_first_log from the earlier of the two containers', () => {
    // user container 400+20i is earlier than queue-proxy 410+20i, so phase 3 is
    // bound 150+10i -> 400+20i = 250..280 (median 265), not 260..290.
    expect(r.out).toContain(
      '| 3 sandbox + containers start: bound -> first log line | 265 | 20 [255, 275] | 250–280 |',
    );
  });

  it('takes qp_ready from the earliest of probe, Ready condition and first byte', () => {
    // base probe 1200+20i beats Ready 1250+20i and first byte 1300+20i: phase 5 is
    // "Ready in" 900+20i -> 1200+20i = 300, phase 6 is 1200+20i -> 1300+20i = 100.
    expect(r.out).toContain('| 5 routable: listening -> ready | 300 | 0 [300, 300] | 300–300 |');
    expect(r.out).toContain(
      '| 6 forward + render: ready -> first byte | 100 | 0 [100, 100] | 100–100 |',
    );
  });

  it('omits control-plane phases when no log is given', () => {
    expect(r.out).not.toContain('0 autoscaler decides');
    expect(r.out).not.toContain('5w activator');
  });

  it('splits by treatment and by node on request', () => {
    const t = py(ANALYZE, [RUN, '--by-treatment']);
    expect(t.out).toContain('### base [cold] (n=2)');
    expect(t.out).toContain('### base [warm] (n=2)');
    const n = py(ANALYZE, [RUN, '--by-node']);
    expect(n.out).toContain('### var on pool-a-1 (n=2)');
    expect(n.out).toContain('### var on pool-b-1 (n=2)');
    // pool-b-1 holds var wakes 2 and 3: pod objects at 120 and 130.
    expect(n.out).toContain(
      '| 1 activation: request -> Pod object | 125 | 10 [120, 130] | 120–130 |',
    );
  });

  it('prints one row per valid wake with --rows', () => {
    const rows = py(ANALYZE, [RUN, '--rows']);
    expect(rows.out).toContain('| 0 | base | cold | pool-a-1 |  |  | 100 | 150 | 400 | 900 |');
    expect(rows.out).toContain('| 3 | var | none | pool-b-1 |  |  | 130 | 180 | 460 | 760 |');
    expect(rows.out).toContain('| 0.2/1.1 |');
  });

  describe('control-plane log join', () => {
    const j = py(ANALYZE, [RUN, '--rows', ...withLogs]);

    it('joins a log line to its wake by revision and rebases fractional seconds', () => {
      // base-00000 starts 00:00:00.000; its autoscaler line is 00:00:00.250000000.
      expect(j.out).toContain('| 0 | base | cold | pool-a-1 |  | 250 | 100 |');
      // activator lines: 300 ms after the request, and 900 ms for the throttler update.
      expect(j.out).toContain('| 300 |  | 1200 | 1300 |');
      expect(j.out).toContain('| 900 | 1220 | 1320 |');
    });

    it('joins a line exactly 20000 ms after the request, and not one 20001 ms after', () => {
      // base-00001 is at +20000.000 (joined), base-00002 at +20001 (not joined).
      expect(j.out).toContain('| 1 | base | cold | pool-a-1 |  | 20000 | 110 |');
      expect(j.out).toContain('| 2 | base | warm | pool-a-1 |  |  | 120 |');
      // Phase 0 therefore sees exactly two samples: 250 and 20000.
      expect(j.out).toContain(
        '| 0 autoscaler decides 0->1 (log; inside phase 1) | 10125 | 19750 [250, 20000] | 250–20000 (n=2) |',
      );
    });

    it('allows a line 50 ms before the request and rejects one 51 ms before', () => {
      // var-00000 is at -50 (joined); var-00001 is at -51 (not joined).
      expect(j.out).toContain('| 0 | var | none | pool-a-1 |  | -50 | 100 |');
      expect(j.out).toContain('| 1 | var | none | pool-a-1 |  |  | 110 |');
    });

    it('ignores keys outside bench-cells/, other messages, and non-JSON lines', () => {
      // var-00002 has an autoscaler line under another namespace; base-00003 has a
      // scale-down message; the file also holds two unparseable lines.
      expect(j.out).toContain('| 2 | var | none | pool-b-1 |  |  | 120 |');
      expect(j.out).toContain('| 3 | base | warm | pool-a-1 |  |  | 130 |');
      expect(j.code).toBe(0);
    });
  });
});

describe('stats.py: two-sample comparison', () => {
  it('reports medians, the exact Mann-Whitney p and a bootstrap CI for a phase total', () => {
    const r = py(STATS, [RUN, 'first_byte', 'base', 'var']);
    expect(r.code).toBe(0);
    // Complete separation of 4 vs 4 with no ties: exact two-sided p = 2/70.
    expect(r.out).toMatch(
      /^first_byte: base n=4 median 1330 \| var n=4 median 1130 \| diff \+200 ms, Mann-Whitney p=0\.0286, bootstrap 95% CI \[\+(\d+), \+(\d+)\]\n$/,
    );
    const m = r.out.match(/CI \[\+(\d+), \+(\d+)\]/);
    const [lo, hi] = [Number(m?.[1]), Number(m?.[2])];
    expect(lo).toBeGreaterThanOrEqual(160); // smallest possible difference of medians
    expect(hi).toBeLessThanOrEqual(240); // largest possible difference of medians
    expect(lo).toBeLessThan(hi);
  });

  it('computes an a..b phase and falls back to a normal approximation under ties', () => {
    const r = py(STATS, [RUN, 'ctr_first_log..app_listening', 'base', 'var']);
    // 500 x4 vs 300 x4: U = 16, mu = 8, sd = sqrt(12), z = 7.5/sd, p = erfc(z/sqrt 2).
    expect(r.out).toContain(
      'ctr_first_log..app_listening: base n=4 median 500 | var n=4 median 300 | diff +200 ms, Mann-Whitney p=0.0304, bootstrap 95% CI [+200, +200]',
    );
  });

  it('selects a treatment with arm[treatment] and a node with --node', () => {
    const r = py(STATS, [RUN, 'first_byte', 'base[cold]', 'var', '--node=pool-a-1']);
    // base[cold] is wakes 0,1 on pool-a-1 (1300, 1320); var on pool-a-1 is 1100, 1120.
    expect(r.out).toContain(
      'first_byte: base[cold] n=2 median 1310 | var n=2 median 1110 | diff +200 ms, Mann-Whitney p=0.333',
    );
    expect(r.out).toContain('(node pool-a-1)');
  });

  it('joins control-plane logs before computing a milestone metric', () => {
    const r = py(STATS, [
      RUN,
      'autoscaler_scale',
      'base',
      'var',
      `--autoscaler=${AUTOSCALER}`,
      '--namespace=bench-cells',
    ]);
    // base joined {250, 20000}: median 10125. var joined {-50}: median -50.
    expect(r.out).toContain(
      'autoscaler_scale: base n=2 median 10125 | var n=1 median -50 | diff +10175 ms',
    );
  });
});

describe('compact.py: trimming harness JSONL for committing', () => {
  it('keeps every timing field and cuts only log payloads', () => {
    withTmp((dir) => {
      const src = join(dir, 'in.jsonl');
      const dst = join(dir, 'out.jsonl');
      const long = 'x'.repeat(300);
      const row = {
        round: 3,
        arm: 'base',
        clock: { offset_ms: 0.2, rtt_ms: 1.1 },
        watch: { pod_added: 100, first_byte: 1300 },
        logs: {
          'user-container': Array.from({ length: 20 }, (_, i) => ({ t: 400 + i, line: long })),
          'queue-proxy': Array.from({ length: 9 }, (_, i) => ({ t: 410 + i, line: long })),
        },
      };
      writeFileSync(src, `${JSON.stringify(row)}\n${JSON.stringify({ round: 4, arm: 'var' })}\n`);
      const r = py(COMPACT, [src, dst]);
      expect(r.code).toBe(0);
      const text = readFileSync(dst, 'utf8');
      const lines = text.trim().split('\n');
      expect(lines.length).toBe(2);
      const out = JSON.parse(lines[0]);
      expect(out.round).toBe(3);
      expect(out.clock).toEqual(row.clock);
      expect(out.watch).toEqual(row.watch);
      // first 14 user-container lines at 240 chars, first 4 queue-proxy lines at 160.
      expect(out.logs['user-container'].length).toBe(14);
      expect(out.logs['user-container'][0].line.length).toBe(240);
      expect(out.logs['user-container'][13].t).toBe(413);
      expect(out.logs['queue-proxy'].length).toBe(4);
      expect(out.logs['queue-proxy'][3].line.length).toBe(160);
      // separators are compact, and a row without logs passes through unchanged.
      expect(lines[0]).not.toContain('": ');
      expect(JSON.parse(lines[1])).toEqual({ round: 4, arm: 'var' });
    });
  });

  it('keeps the timestamps analyze.py reads, so a compacted file analyzes the same', () => {
    withTmp((dir) => {
      const dst = join(dir, 'compact.jsonl');
      expect(py(COMPACT, [RUN, dst]).code).toBe(0);
      const before = py(ANALYZE, [RUN]).out;
      const after = py(ANALYZE, [dst]).out;
      expect(after).toBe(before);
    });
  });
});

describe('gke/compare.py: A/B tables with a Holm-corrected family', () => {
  it('prints B-minus-A per phase with raw and Holm-adjusted p', () => {
    const r = py(COMPARE, [RUN, 'base:var', '--phases=T,4,1']);
    expect(r.code).toBe(0);
    expect(r.out).toContain('excluded rows: 3; Holm family size: 3');
    expect(r.out).toContain('#### var vs base (n=4 vs 4)');
    // Holm over p = 0.0286 (T), 0.0304 (4), 1 (1): 3*0.0286 = 0.086; max(.086, 2*.0304) = .086; 1.
    expect(r.out).toMatch(
      /\| total request -> first byte \| 1330 · 40 \| 1130 · 40 \| -200 \| 0\.029 \| 0\.086 \| \[-\d+, -\d+\] \|/,
    );
    expect(r.out).toMatch(
      /\| 4 runtime boot \| 500 · 0 \| 300 · 0 \| -200 \| 0\.03 \| 0\.086 \| \[-200, -200\] \|/,
    );
    expect(r.out).toMatch(/\| 1 activation \| 115 · 20 \| 115 · 20 \| \+0 \| 1 \| 1 \|/);
  });

  it('corrects across the whole family it prints, not per phase', () => {
    const one = py(COMPARE, [RUN, 'base:var', '--phases=T']);
    expect(one.out).toContain('Holm family size: 1');
    // a family of one is not inflated: raw p equals the adjusted p.
    expect(one.out).toMatch(/\| 0\.029 \| 0\.029 \|/);
  });

  it('filters an arm to a node pool with arm@pool', () => {
    // base wakes are all on pool-a-1, so base@pool-b has none and is skipped (< 3 per arm).
    expect(py(COMPARE, [RUN, 'base@pool-b:var', '--phases=T']).out).toContain(
      'Holm family size: 0',
    );
    expect(py(COMPARE, [RUN, 'base@pool-a:var', '--phases=T']).out).toContain(
      'Holm family size: 1',
    );
  });

  it('skips a comparison with fewer than 3 wakes on either side', () => {
    // var@pool-a has 2 wakes (the other 2 are on pool-b).
    expect(py(COMPARE, [RUN, 'base:var@pool-a', '--phases=T']).out).toContain(
      'Holm family size: 0',
    );
  });

  it('writes the results as JSON with --json', () => {
    withTmp((dir) => {
      const out = join(dir, 'c.json');
      expect(py(COMPARE, [RUN, 'base:var', '--phases=T', `--json=${out}`]).code).toBe(0);
      const rows = JSON.parse(readFileSync(out, 'utf8'));
      expect(rows.length).toBe(1);
      expect(rows[0]).toMatchObject({
        A: 'base',
        B: 'var',
        key: 'T',
        nA: 4,
        nB: 4,
        medA: 1330,
        medB: 1130,
        diff: -200,
      });
      expect(rows[0].p_holm).toBeCloseTo(rows[0].p, 10);
    });
  });
});

describe('gke/cpuprofile-window.py: .cpuprofile timeline', () => {
  // 300 samples 1 ms apart: 1..100 busy in work() (pkg-a), 101..200 idle, 201..300 busy in other() (pkg-b).
  const profile = {
    startTime: 1_000_000,
    nodes: [
      { id: 1, callFrame: { functionName: '(root)', url: '' } },
      { id: 2, callFrame: { functionName: '(idle)', url: '' } },
      {
        id: 3,
        callFrame: { functionName: 'work', url: 'file:///app/node_modules/pkg-a/index.js' },
      },
      { id: 4, callFrame: { functionName: 'other', url: 'file:///app/node_modules/pkg-b/lib.js' } },
    ],
    samples: [...Array(100).fill(3), ...Array(100).fill(2), ...Array(100).fill(4)],
    timeDeltas: Array(300).fill(1000),
  };

  it('prints the sampling interval and a busy(idle) timeline in 100 ms buckets', () => {
    withTmp((dir) => {
      const f = join(dir, 'p.cpuprofile');
      writeFileSync(f, JSON.stringify(profile));
      const r = py(CPUPROFILE, [f]);
      expect(r.code).toBe(0);
      expect(r.out).toContain('mean sample interval 1.00 ms');
      expect(r.out).toContain('0.0s:99(0) 0.1s:1(99) 0.2s:99(1) 0.3s:1(0)');
      expect(r.out).not.toContain('window');
    });
  });

  it('attributes self time inside a window to the script that ran in it', () => {
    withTmp((dir) => {
      const f = join(dir, 'p.cpuprofile');
      writeFileSync(f, JSON.stringify(profile));
      const late = py(CPUPROFILE, [f, '0.2', '0.3']).out;
      expect(late).toContain('window 0.2-0.3 s: 100 ms sampled');
      expect(late).toContain('99.0 ms  pkg-b/lib.js');
      expect(late).not.toContain('pkg-a');
      const early = py(CPUPROFILE, [f, '0', '0.1']).out;
      expect(early).toContain('99.0 ms  pkg-a/index.js');
      expect(early).not.toContain('pkg-b');
    });
  });
});

// ------------------------------------------------------------ directory-scan guard

/**
 * Every script under scripts/bench-cold-start-phases/ (and the scripts/bench-*.py
 * drivers beside it) must be named by a test, or sit on the dated allowlist. The
 * scan reads the tree, not a list of files, so a new analyzer is caught the day it
 * is added. An untracked file counts (`--others`), so the failure shows locally
 * before the first commit.
 */
const ALLOWLIST_PATH = 'tests/fixtures/bench-cold-start-phases/untested-allowlist.json';

interface Allowlist {
  expires: string;
  tracking: string;
  entries: { path: string; kind: string; reason: string }[];
}

function repoFiles(patterns: string[]): string[] {
  return execFileSync(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '--', ...patterns],
    {
      cwd: ROOT,
      encoding: 'utf8',
      maxBuffer: 64 << 20,
    },
  )
    .split('\n')
    .filter(Boolean);
}

const benchScripts = (): string[] =>
  repoFiles([
    'scripts/bench-cold-start-phases/*.py',
    'scripts/bench-cold-start-phases/*.mjs',
    'scripts/bench-cold-start-phases/*.js',
    'scripts/bench-*.py',
  ]);

/** A script is covered when a test file names its repo-relative path as a string literal. */
function coveredBy(testTexts: string[], script: string): boolean {
  const q = `['"\`]${script.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}['"\`]`;
  const re = new RegExp(q);
  return testTexts.some((t) => re.test(t));
}

const testTexts = (): string[] =>
  repoFiles(['*.test.ts', '*.test.mjs']).map((f) => readFileSync(join(ROOT, f), 'utf8'));

describe('every bench script has a test or a dated allowlist entry', () => {
  const allow: Allowlist = JSON.parse(readFileSync(join(ROOT, ALLOWLIST_PATH), 'utf8'));
  const allowed = new Set(allow.entries.map((e) => e.path));
  const scripts = benchScripts();
  const texts = testTexts();

  it('finds the scripts it is meant to guard (the scan is not vacuous)', () => {
    expect(scripts).toContain(ANALYZE);
    expect(scripts.length).toBeGreaterThanOrEqual(20);
  });

  it('fails for a script that no test names and no allowlist entry covers', () => {
    const uncovered = scripts.filter((s) => !allowed.has(s) && !coveredBy(texts, s));
    expect(uncovered).toEqual([]);
  });

  it('fails for an allowlist entry whose script now has a test (promote it)', () => {
    const promoted = allow.entries.map((e) => e.path).filter((p) => coveredBy(texts, p));
    expect(promoted).toEqual([]);
  });

  it('fails for an allowlist entry whose script no longer exists (stale)', () => {
    const stale = allow.entries.map((e) => e.path).filter((p) => !scripts.includes(p));
    expect(stale).toEqual([]);
  });

  it('fails once the allowlist has expired: the debt must be paid or consciously renewed', () => {
    expect(Date.parse(`${allow.expires}T00:00:00Z`)).toBeGreaterThan(Date.now());
  });

  it('names a tracking issue and a reason for every entry', () => {
    expect(allow.tracking).toMatch(/\/issues\/\d+$/);
    for (const e of allow.entries) expect(e.reason.length).toBeGreaterThan(10);
  });

  it('covers every shared analyzer this file exercises', () => {
    for (const s of [ANALYZE, STATS, COMPACT, COMPARE, CPUPROFILE]) {
      expect(scripts).toContain(s);
      expect(allowed.has(s)).toBe(false);
    }
  });
});
