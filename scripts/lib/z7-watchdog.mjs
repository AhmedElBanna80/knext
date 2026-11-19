/**
 * Z7 rotation caller watchdog (D3). `z7-rotation-weekly.yml` is a thin caller whose
 * schedule only fires from main; if it never starts (disabled, startup failure, a
 * missing called workflow) NOTHING inside it can alert. This module judges the run
 * history from the OUTSIDE.
 *
 * Fail-closed throughout: no runs, a stale success, a non-success latest run
 * (cancelled and timed_out included, per tests/nightly-alert-cancelled-condition.test.ts),
 * an unparseable timestamp, or an unreachable API are all failures.
 */

export const Z7_WORKFLOW_FILE = 'z7-rotation-weekly.yml';
/** One week plus margin. */
export const DEFAULT_MAX_AGE_DAYS = 9;

const IN_FLIGHT = new Set(['queued', 'in_progress', 'waiting', 'requested', 'pending']);
const stamp = (r) => Date.parse(r.updated_at ?? r.created_at);

/**
 * @param {Array<{status: string, conclusion: string|null, created_at: string, updated_at?: string}>} runs
 * @param {number} nowMs
 * @param {number} maxAgeDays
 * @returns {{ok: boolean, reason: string}}
 */
export function evaluateZ7Runs(runs, nowMs, maxAgeDays = DEFAULT_MAX_AGE_DAYS) {
  if (!Array.isArray(runs) || runs.length === 0) {
    return { ok: false, reason: `${Z7_WORKFLOW_FILE} has never started (no runs found)` };
  }
  if (runs.some((r) => !Number.isFinite(stamp(r)))) {
    return { ok: false, reason: 'a run carries an unparseable timestamp (fail closed)' };
  }
  const byRecency = [...runs].sort((a, b) => stamp(b) - stamp(a));
  const latest = byRecency[0];
  if (!IN_FLIGHT.has(latest.status) && latest.conclusion !== 'success') {
    return {
      ok: false,
      reason: `the latest run did not succeed (conclusion: ${latest.conclusion ?? latest.status})`,
    };
  }
  const cutoff = nowMs - maxAgeDays * 86_400_000;
  const lastSuccess = byRecency.find((r) => r.conclusion === 'success');
  if (!lastSuccess || stamp(lastSuccess) < cutoff) {
    return {
      ok: false,
      reason: `no successful run within the last ${maxAgeDays} days`,
    };
  }
  return { ok: true, reason: `last success ${new Date(stamp(lastSuccess)).toISOString()}` };
}

/**
 * @param {{gh: (args: string[]) => string, repo: string}} p
 * @returns {Array<object>} throws when the API is unreachable or the payload is malformed
 */
export function fetchZ7Runs({ gh, repo }) {
  const out = gh(['api', `repos/${repo}/actions/workflows/${Z7_WORKFLOW_FILE}/runs?per_page=30`]);
  let payload;
  try {
    payload = JSON.parse(out);
  } catch {
    throw new Error('runs API returned non-JSON');
  }
  if (!payload || !Array.isArray(payload.workflow_runs)) {
    throw new Error('runs API payload has no workflow_runs array');
  }
  return payload.workflow_runs;
}
