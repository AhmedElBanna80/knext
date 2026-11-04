import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * The kubelet ceiling test (scripts/bench-cold-start-phases/ceiling/) decides, from a paired run on a
 * patched node and a stock node, whether a 100 ms relist removes the cycle lock, moves the median under
 * 1000 ms, and changes the slower cluster. These tests pin the analyzer's reading on a synthetic paired
 * fixture (tests/fixtures/bench-cold-start-ceiling/paired.jsonl, generated, no cluster data), its refusals
 * on bad or undersized input, and the patch that the measurement depends on.
 *
 * The fixture is built so the answer is known: control pod IPs sit on an exact 1.0035 s lattice with every
 * odd round slow; patched pod IPs sit on a 0.1025 s lattice with every wake fast.
 */

const ROOT = resolve(import.meta.dir, '..');
const FIXTURE = join(ROOT, 'tests/fixtures/bench-cold-start-ceiling/paired.jsonl');
const ANALYZER = 'scripts/bench-cold-start-phases/ceiling/lattice_analyze.py';
const PATCH = 'scripts/bench-cold-start-phases/ceiling/kubelet-patch.diff';
const BUILD = 'scripts/bench-cold-start-phases/ceiling/build.sh';

function analyze(args: string[]): { out: string; err: string; code: number } {
  const r = spawnSync('python3', ['-I', join(ROOT, ANALYZER), ...args], {
    encoding: 'utf8',
    env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
  });
  return { out: r.stdout, err: r.stderr, code: r.status ?? -1 };
}

function withTmp<T>(fn: (dir: string, write: (name: string, lines: string[]) => string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'ceiling-analyzer-'));
  try {
    return fn(dir, (name, lines) => {
      const p = join(dir, name);
      writeFileSync(p, `${lines.join('\n')}\n`);
      return p;
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const fixtureLines = (): string[] => readFileSync(FIXTURE, 'utf8').trim().split('\n');

describe('lattice_analyze.py on the synthetic paired fixture', () => {
  const run = analyze([FIXTURE, '--boot=500', '--perms=50']);

  it('exits 0 and reads all 60 wakes as 30 complete pairs', () => {
    expect(run.code).toBe(0);
    expect(run.out).toContain('rows read 60, skipped');
    expect(run.out).toContain('pairs 30, unpaired rounds 0');
    expect(run.out).toContain('gate: pairs >= 30 and >= 15 wakes per arm per node, passed');
  });

  it('finds the stock 1 s cycle lock on control and none on patched at 1 s', () => {
    expect(run.out).toMatch(/^control\s+node-control\s+1s\s.*\byes$/m);
    expect(run.out).toMatch(/^patched\s+node-patched\s+1s\s.*\bno$/m);
  });

  it('does not count the 1 s lattice sub-harmonic inside the 100 ms band as a new lock', () => {
    expect(run.out).toMatch(
      /^control\s+node-control\s+100ms\s.*\bno \(sub-harmonic of the 1s lock\)$/m,
    );
  });

  it('finds the 100 ms lattice on the patched node', () => {
    expect(run.out).toMatch(/^patched\s+node-patched\s+100ms\s.*\byes$/m);
  });

  it('reports a paired median delta that is negative with an interval below zero', () => {
    const m = run.out.match(
      /paired median delta \(patched - control\): (-?\d+) \[(-?\d+), (-?\d+)\]/,
    );
    expect(m).not.toBeNull();
    const [, d, lo, hi] = m as RegExpMatchArray;
    expect(Number(d)).toBeLessThan(-500);
    expect(Number(hi)).toBeLessThan(0);
    expect(Number(lo)).toBeLessThanOrEqual(Number(d));
  });

  it('reports the slower-cluster share change, with an interval that excludes zero', () => {
    expect(run.out).toContain('difference -0.500');
    expect(run.out).toContain('-> changed (interval excludes 0)');
  });

  it('gives PASS when the patched median interval lies under 1000 ms', () => {
    const m = run.out.match(
      /VERDICT: (\w+) \(patched median (\d+) ms, interval \[(\d+), (\d+)\]\)/,
    );
    expect(m).not.toBeNull();
    const [, verdict, , hi] = m as RegExpMatchArray;
    expect(verdict).toBe('PASS');
    expect(Number(hi)).toBeLessThan(1000);
  });
});

describe('refusals and input errors', () => {
  it('refuses a sample of fewer than 30 pairs with exit 3 and judges nothing', () => {
    withTmp((_dir, write) => {
      const p = write('ten.jsonl', fixtureLines().slice(0, 20));
      const r = analyze([p]);
      expect(r.code).toBe(3);
      expect(r.err).toContain('refused');
      expect(r.out).toBe('');
    });
  });

  it('refuses when a round is missing its patched wake, which leaves 29 pairs', () => {
    withTmp((_dir, write) => {
      const kept = fixtureLines().filter(
        (l) => !(l.includes('"arm": "patched"') && l.includes('"round": 5,')),
      );
      const p = write('unpaired.jsonl', kept);
      const r = analyze([p]);
      expect(r.code).toBe(3);
      expect(r.err).toContain('29 complete pairs');
    });
  });

  it('refuses when one node has fewer than 15 wakes for an arm', () => {
    withTmp((_dir, write) => {
      let moved = 0;
      const lines = fixtureLines().map((l) => {
        if (l.includes('"arm": "patched"') && moved < 16) {
          moved += 1;
          return l.replace('"node": "node-patched"', '"node": "node-other"');
        }
        return l;
      });
      expect(moved).toBe(16);
      const r = analyze([write('pernode.jsonl', lines)]);
      expect(r.code).toBe(3);
      expect(r.err).toContain('need 15 per node');
    });
  });

  it('exits 2 on a line that is not JSON', () => {
    withTmp((_dir, write) => {
      const lines = fixtureLines();
      lines[3] = '{not json';
      const r = analyze([write('bad.jsonl', lines)]);
      expect(r.code).toBe(2);
      expect(r.err).toContain('not JSON');
    });
  });

  it('exits 2 on an arm that is neither patched nor control', () => {
    withTmp((_dir, write) => {
      const lines = fixtureLines();
      lines[0] = lines[0].replace('"arm": "control"', '"arm": "cpu-base"');
      const r = analyze([write('arm.jsonl', lines)]);
      expect(r.code).toBe(2);
      expect(r.err).toContain("arm 'cpu-base'");
    });
  });

  it('exits 2 on a row with no integer round', () => {
    withTmp((_dir, write) => {
      const lines = fixtureLines();
      lines[0] = lines[0].replace(/"round": \d+/, '"round": "5"');
      const r = analyze([write('round.jsonl', lines)]);
      expect(r.code).toBe(2);
      expect(r.err).toContain('missing integer round');
    });
  });

  it('exits 2 on a missing file', () => {
    const r = analyze([join(ROOT, 'tests/fixtures/bench-cold-start-ceiling/does-not-exist.jsonl')]);
    expect(r.code).toBe(2);
    expect(r.err).toContain('cannot read');
  });

  it('exits 2 below 20 permutations, because p < 0.05 is unreachable', () => {
    const r = analyze([FIXTURE, '--perms=5']);
    expect(r.code).toBe(2);
    expect(r.err).toContain('--perms must be at least 20');
  });
});

describe('the analyzer functions', () => {
  const dir = join(ROOT, 'scripts/bench-cold-start-phases/ceiling');
  // -I drops the script directory from sys.path, so the module is put there explicitly.
  const py = (code: string): string => {
    const r = spawnSync(
      'python3',
      ['-I', '-c', `import sys; sys.path.insert(0, ${JSON.stringify(dir)})\n${code}`],
      {
        encoding: 'utf8',
        env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' },
      },
    );
    expect(r.status).toBe(0);
    return r.stdout.trim();
  };

  it('finds the period of an exact lattice with R near 1, and no such peak in random phases', () => {
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

  it('computes percentiles by linear interpolation', () => {
    expect(py('import lattice_analyze as m\nprint(m.pct([1, 2, 3, 4], 0.5))')).toBe('2.5');
    expect(py('import lattice_analyze as m\nprint(m.pct([10, 20, 30, 40, 50], 0.95))')).toBe(
      '48.0',
    );
  });

  it('gives a bootstrap interval of zero width when every resample has the same statistic', () => {
    expect(
      py('import lattice_analyze as m\n' + 'print(m.boot_ci(lambda idx: 5.0, 12, 200, 3))'),
    ).toBe('(5.0, 5.0)');
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
    const stock = build.indexOf('kubelet-v1.34.10-stock-linux-amd64');
    const apply = build.indexOf('git -C "$WORK" apply "$HERE/kubelet-patch.diff"');
    expect(stock).toBeGreaterThan(0);
    expect(apply).toBeGreaterThan(stock);
  });
});
