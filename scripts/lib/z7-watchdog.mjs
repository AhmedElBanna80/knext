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

/**
 * GRACE for the first scheduled run. The caller's cron is `23 3 * * 0` (Sundays 03:23
 * UTC) and the caller landed on main on 2026-11-19, so the first run that can ever
 * exist is Sunday 2026-11-22T03:23Z. Before that, zero runs is "not due yet", not
 * "never started". The margin covers GitHub's scheduled-run delay (often an hour or
 * more under load). Once now >= first-expected + margin, zero runs is RED. This is a
 * FIXED dated constant on purpose: a relative grace ("N days since the watchdog
 * began") would restart on every edit and could hide a dead caller forever.
 */
export const Z7_FIRST_EXPECTED_MS = Date.parse('2026-11-22T03:23:00Z');
export const Z7_GRACE_MARGIN_MS = 24 * 3_600_000;

const IN_FLIGHT = new Set(['queued', 'in_progress', 'waiting', 'requested', 'pending']);
const stamp = (r) => Date.parse(r.updated_at ?? r.created_at);

/**
 * @param {Array<{status: string, conclusion: string|null, created_at: string, updated_at?: string}>} runs
 * @param {number} nowMs
 * @param {number} maxAgeDays
 * @returns {{ok: boolean, reason: string}}
 */
export function evaluateZ7Runs(
  allRuns,
  nowMs,
  maxAgeDays = DEFAULT_MAX_AGE_DAYS,
  { firstExpectedMs = Z7_FIRST_EXPECTED_MS, graceMs = Z7_GRACE_MARGIN_MS } = {},
) {
  // Only SCHEDULED runs on main count (also enforced in the query). A manual or
  // other-branch dispatch must neither mask a failed scheduled run nor cause one.
  const runs = Array.isArray(allRuns)
    ? allRuns.filter((r) => r.event === 'schedule' && r.head_branch === 'main')
    : [];
  if (runs.length === 0) {
    if (nowMs < firstExpectedMs + graceMs) {
      return {
        ok: true,
        reason: `no scheduled run yet; the first is due ${new Date(firstExpectedMs).toISOString()} (grace until +${graceMs / 3_600_000}h)`,
      };
    }
    return { ok: false, reason: `${Z7_WORKFLOW_FILE} has never started (no scheduled runs found)` };
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
 * Scheduled runs on main only, all pages (newest first). Fails closed: a request
 * error, a malformed payload, or more pages than `maxPages` throws.
 * @param {{gh: (args: string[]) => string, repo: string, perPage?: number, maxPages?: number}} p
 * @returns {Array<object>}
 */
export function fetchZ7Runs({ gh, repo, perPage = 100, maxPages = 10 }) {
  const all = [];
  for (let page = 1; page <= maxPages; page++) {
    const out = gh([
      'api',
      `repos/${repo}/actions/workflows/${Z7_WORKFLOW_FILE}/runs?branch=main&event=schedule&per_page=${perPage}&page=${page}`,
    ]);
    let payload;
    try {
      payload = JSON.parse(out);
    } catch {
      throw new Error('runs API returned non-JSON');
    }
    if (!payload || !Array.isArray(payload.workflow_runs)) {
      throw new Error('runs API payload has no workflow_runs array');
    }
    all.push(...payload.workflow_runs);
    const total = Number.isFinite(payload.total_count) ? payload.total_count : undefined;
    if (payload.workflow_runs.length < perPage || (total !== undefined && all.length >= total)) {
      return all;
    }
  }
  throw new Error(`more than ${maxPages} pages of runs (fail closed)`);
}
