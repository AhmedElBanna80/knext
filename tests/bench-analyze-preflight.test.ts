import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/**
 * Pins the analyze.py preflight (TD-S15-6c). A run in which EVERY row lacks EVERY probe
 * milestone (qp_probe_ok, app_tcp_3000, same_node_tcp_3000, same_node_health_ok) means
 * the harness probes never reached the pod, typically a NetworkPolicy dropping them.
 * analyze.py must refuse such a run with a non-zero exit and a stderr message, not fall
 * back silently. Partial nulls stay allowed.
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

function withProbesNulled(rows: Row[]): Row[] {
  return rows.map((r) => {
    const watch = { ...(r.watch ?? {}) };
    for (const k of PROBE_KEYS) watch[k] = null;
    return { ...r, watch };
  });
}

function runAnalyze(rows: Row[]) {
  const dir = mkdtempSync(join(tmpdir(), 'bench-preflight-'));
  const file = join(dir, 'run.jsonl');
  writeFileSync(file, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
  try {
    return spawnSync('python3', [ANALYZE, file, '--no-marker'], {
      encoding: 'utf8',
      env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1', KNEXT_BENCH_CONFIG: '' },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('analyze.py preflight: every row missing every probe milestone', () => {
  it('refuses an all-null run with a non-zero exit and names the problem', () => {
    const r = runAnalyze(withProbesNulled(baseRows));
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('every row');
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
    const r = runAnalyze(rows);
    expect(r.status).toBe(0);
  });

  it('still passes the committed kind fixture', () => {
    const r = runAnalyze(baseRows);
    expect(r.status).toBe(0);
  });
});
