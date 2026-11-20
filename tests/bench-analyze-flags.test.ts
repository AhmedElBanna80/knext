import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';

/**
 * Pins the two analyze.py flags added for the kind phase breakdown, on the shared
 * synthetic fixture (tests/fixtures/bench-cold-start-phases/run.jsonl; see
 * bench-cold-start-analyzers.test.ts for its layout):
 *
 *  - default output is byte-for-byte the four-column table (no p95 column);
 *  - --p95 adds a column, linearly interpolated between order statistics;
 *  - --no-marker keeps rows whose body lacks the file-manager "items:50" marker.
 *
 * Base arm, valid rows only: first-byte totals 1300, 1320, 1340, 1360 -> p95 at rank
 * 0.95 * 3 = 2.85 -> 1340 + 0.85 * 20 = 1357. With --no-marker a fifth base row (total
 * 1420) joins: rank 3.8 -> 1360 + 0.8 * 60 = 1408.
 */
const ROOT = resolve(import.meta.dir, '..');
const FIXTURE = join(ROOT, 'tests/fixtures/bench-cold-start-phases');
const ANALYZE = 'scripts/bench-cold-start-phases/analyze.py';

function analyze(args: string[]): string {
  const r = spawnSync('python3', [join(ROOT, ANALYZE), join(FIXTURE, 'run.jsonl'), ...args], {
    encoding: 'utf8',
    env: {
      ...process.env,
      PYTHONDONTWRITEBYTECODE: '1',
      KNEXT_BENCH_CONFIG: join(FIXTURE, 'empty-config.json'),
    },
  });
  expect(r.status).toBe(0);
  return r.stdout;
}

describe('analyze.py --p95 / --no-marker', () => {
  it('leaves the default table unchanged', () => {
    const out = analyze([]);
    expect(out).toContain('| phase | median ms | IQR [Q1, Q3] | min–max |');
    expect(out).not.toContain('p95');
    expect(out).toContain('| total: request -> first byte | 1330 | 40 [1310, 1350] | 1300–1360 |');
    expect(out).toContain('valid 8, excluded 3');
  });

  it('adds an interpolated p95 column with --p95', () => {
    const out = analyze(['--p95']);
    expect(out).toContain('| phase | median ms | p95 ms | IQR [Q1, Q3] | min–max |');
    expect(out).toContain(
      '| total: request -> first byte | 1330 | 1357 | 40 [1310, 1350] | 1300–1360 |',
    );
  });

  it('keeps marker-less rows with --no-marker', () => {
    const out = analyze(['--no-marker', '--p95']);
    expect(out).toContain('valid 9, excluded 2');
    expect(out).toContain(
      '| total: request -> first byte | 1340 | 1408 | 80 [1310, 1390] | 1300–1420 |',
    );
  });
});
