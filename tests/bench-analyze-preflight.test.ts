import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Pins the analyze.py preflight (TD-S15-6c, review round 1 of #229).
 *
 * The preflight runs on the VALID rows, the rows the tables are built from, after the
 * error/code/marker filter:
 *  - empty input exits 0 (nothing to refuse);
 *  - non-empty input with zero valid rows exits 2: "no valid rows", or, when every row
 *    errored (for example the 90 s watchdog), "every row errored", never the NetworkPolicy
 *    message;
 *  - valid rows where EVERY row lacks EVERY probe milestone (qp_probe_ok, app_tcp_3000,
 *    same_node_tcp_3000, same_node_health_ok; null or absent) exit 2 and name the
 *    NetworkPolicy as the likely cause. Partial nulls pass.
 *
 * Exit codes are the assertion surface; stderr is checked only for the named problem.
 */
const ROOT = resolve(import.meta.dir, '..');
const ANALYZE = join(ROOT, 'scripts/bench-cold-start-phases/analyze.py');
const KIND_FIXTURE = join(ROOT, 'docs/benchmarks/data/coldstart-phases-kind-2026-11-20.jsonl');
const PROBE_KEYS = ['qp_probe_ok', 'app_tcp_3000', 'same_node_tcp_3000', 'same_node_health_ok'];

type Row = { watch?: Record<string, unknown>; [k: string]: unknown };

const baseRows: Row[] = readFileSync(KIND_FIXTURE, 'utf8')
  .split('\n')
  .filter((l) => l.trim())
  .map((l) => JSON.parse(l) as Row);

/** The committed fixture's rows carry marker:false; these pass the marker filter. */
const markered: Row[] = baseRows.map((r) => ({ ...r, marker: true }));

function withProbesNulled(rows: Row[]): Row[] {
  return rows.map((r) => {
    const watch = { ...(r.watch ?? {}) };
    for (const k of PROBE_KEYS) watch[k] = null;
    return { ...r, watch };
  });
}

function runAnalyze(rows: Row[], args: string[] = ['--no-marker']) {
  const dir = mkdtempSync(join(tmpdir(), 'bench-preflight-'));
  const file = join(dir, 'run.jsonl');
  writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
  try {
    return spawnSync('python3', [ANALYZE, file, ...args], {
      encoding: 'utf8',
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', KNEXT_BENCH_CONFIG: '' },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('analyze.py preflight: probe milestones on the valid rows', () => {
  it('refuses an all-null run with a non-zero exit and names the problem', () => {
    const r = runAnalyze(withProbesNulled(baseRows));
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('every valid row');
    expect(r.stderr).toContain('probe');
    expect(r.stderr).toContain('NetworkPolicy');
  });

  it('refuses when the probe keys are absent rather than null', () => {
    const rows = baseRows.map((r) => {
      const watch = { ...(r.watch ?? {}) };
      for (const k of PROBE_KEYS) delete watch[k];
      return { ...r, watch };
    });
    const r = runAnalyze(rows);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('probe');
  });

  it('passes when a single row carries qp_probe_ok', () => {
    const rows = withProbesNulled(baseRows);
    rows[0].watch = { ...rows[0].watch, qp_probe_ok: 3000 };
    const r = runAnalyze(rows);
    expect(r.status).toBe(0);
    expect(r.stderr).not.toContain('probe');
  });

  it('allows partial nulls: qp_probe_ok null on every row, another probe present', () => {
    const rows = baseRows.map((r) => ({
      ...r,
      watch: { ...(r.watch ?? {}), qp_probe_ok: null },
    }));
    expect(runAnalyze(rows).status).toBe(0);
  });

  it('still passes the committed kind fixture', () => {
    expect(runAnalyze(baseRows).status).toBe(0);
  });
});

describe('analyze.py preflight: marker-on ordering (no --no-marker)', () => {
  it('refuses markered rows whose probes are all null', () => {
    const r = runAnalyze(withProbesNulled(markered), []);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('probe');
  });

  it('passes markered rows when one carries qp_probe_ok', () => {
    const rows = withProbesNulled(markered);
    rows[0].watch = { ...rows[0].watch, qp_probe_ok: 3000 };
    expect(runAnalyze(rows, []).status).toBe(0);
  });

  it('refuses when probe data sits only in rows the marker filter drops', () => {
    // Row 0 carries probes but has no marker, so it is excluded; row 1 is valid, with nulls.
    const probeRow = { ...baseRows[0], marker: false, watch: { ...(baseRows[0].watch ?? {}) } };
    const nullRow = { ...withProbesNulled([baseRows[1]])[0], marker: true };
    const r = runAnalyze([probeRow, nullRow], []);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('probe');
  });

  it('passes the same rows with --no-marker, where the probe row is valid', () => {
    const probeRow = { ...baseRows[0], marker: false, watch: { ...(baseRows[0].watch ?? {}) } };
    const nullRow = { ...withProbesNulled([baseRows[1]])[0], marker: true };
    expect(runAnalyze([probeRow, nullRow], ['--no-marker']).status).toBe(0);
  });
});

describe('analyze.py preflight: zero valid rows', () => {
  it('refuses an all-error run and reports the wakes errored, not a NetworkPolicy', () => {
    const rows = [
      { arm: 'base', round: 1, error: 'watchdog: no first byte within 90 s' },
      { arm: 'var', round: 1, error: 'watchdog: no first byte within 90 s' },
    ];
    const r = runAnalyze(rows);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('errored');
    expect(r.stderr).not.toContain('NetworkPolicy');
  });

  it('refuses non-empty input with no valid rows and no errors', () => {
    const rows = baseRows.map((r) => ({ ...r, code: 503 }));
    const r = runAnalyze(rows);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('no valid rows');
  });

  it('exits 0 on empty input', () => {
    const r = runAnalyze([]);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('valid 0, excluded 0');
  });
});
