/**
 * Scale-to-zero e2e suite: make the TOLERATED failure visible (#2648).
 *
 * `operator-e2e-nightly.yml` keeps `continue-on-error: true` on the
 * `make test-e2e-scale` step (ADR-0037 tolerates genuine Knative scale-timing
 * flake — that decision is NOT changed here). `continue-on-error` masks
 * `steps.<id>.conclusion` (reports success), so the workflow records
 * `steps.<id>.outcome` and routes it here:
 *
 *   - outcome failure / cancelled / unknown -> open or update ONE tracking issue
 *   - outcome success                       -> comment "recovered" and close it
 *   - outcome skipped                       -> nothing (an earlier step already
 *                                              reded the job loudly)
 *   - outcome EMPTY, scale job failed/cancelled/skipped
 *                                           -> the suite never ran (e.g. the image
 *                                              preflight failed): NOT a suite failure,
 *                                              no issue opened and none closed, only a
 *                                              visible warning (`notRun`)
 *   - outcome EMPTY, scale job succeeded    -> impossible (the recorder always runs):
 *                                              throw, never pass
 *   - issue handling is scheduled-run only (a dispatching human is watching)
 *   - the tolerance EXPIRES: the day after TOLERANCE_EXPIRES the caller exits
 *     non-zero, so the tolerance cannot outlive its review.
 *
 * `gh` is injected so tests exercise every branch without a network.
 */

import { ensureAlertIssue } from './nightly-alert-issue.mjs';

export const SCALE_SUITE_ISSUE_TITLE = 'Scale-to-zero e2e suite FAILED (tolerated)';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * @param {{ outcome: string, expires: string, today: string, event: string, jobResult?: string }} o
 * @returns {{ expired: boolean, issue: 'alert' | 'recover' | 'none', notRun: boolean }}
 */
export function decideScaleSuiteAction({ outcome, expires, today, event, jobResult }) {
  if (!ISO_DATE.test(expires ?? '') || Number.isNaN(Date.parse(`${expires}T00:00:00Z`))) {
    throw new Error(`TOLERANCE_EXPIRES must be an ISO date (YYYY-MM-DD), got "${expires}"`);
  }
  if (!ISO_DATE.test(today ?? '')) {
    throw new Error(`today must be an ISO date (YYYY-MM-DD), got "${today}"`);
  }
  // ISO dates compare correctly as strings. Expired = strictly AFTER the date.
  const expired = today > expires;

  if (!outcome) {
    if (jobResult === 'failure' || jobResult === 'cancelled' || jobResult === 'skipped') {
      // The scale job never recorded an outcome: the suite did not execute.
      return { expired, issue: 'none', notRun: true };
    }
    throw new Error(
      `the scale suite recorded no outcome although the scale job result is "${jobResult ?? ''}" (expected the outcome recorder to have run); refusing to pass`,
    );
  }

  if (event !== 'schedule') return { expired, issue: 'none', notRun: false };
  if (outcome === 'success') return { expired, issue: 'recover', notRun: false };
  if (outcome === 'skipped') return { expired, issue: 'none', notRun: false };
  // failure, cancelled or anything unrecognised: fail closed to an alert.
  return { expired, issue: 'alert', notRun: false };
}

/**
 * @param {{
 *   gh: (args: string[]) => string,
 *   repo: string,
 *   runUrl: string,
 *   owner: string,
 *   expires: string,
 *   issue: 'alert' | 'recover' | 'none',
 *   outcome: string,
 * }} o
 */
export function reconcileScaleSuiteIssue({ gh, repo, runUrl, owner, expires, issue, outcome }) {
  if (issue === 'none') return;

  if (issue === 'alert') {
    const body = `The nightly scale-to-zero e2e suite (\`make test-e2e-scale\`) did not pass: step outcome **${outcome || 'unknown'}**.

- Run: ${runUrl}
- Tolerance owner: @${owner}
- Tolerance expires: ${expires} (the nightly goes RED the day after; review or remove the tolerance before then)

The step is \`continue-on-error\` (ADR-0037 tolerates genuine Knative scale-timing flake), so the workflow stays green on this failure; this issue is the signal. It is updated on every failing night and closed automatically on the first passing one. A failure that repeats is not flake: fix it or remove the tolerance.`;
    ensureAlertIssue({ gh, repo, title: SCALE_SUITE_ISSUE_TITLE, body });
    return;
  }

  // recover
  const issues = JSON.parse(
    gh([
      'issue',
      'list',
      '--repo',
      repo,
      '--state',
      'open',
      '--limit',
      '100',
      '--json',
      'number,title',
    ]),
  );
  for (const existing of issues.filter((i) => i.title === SCALE_SUITE_ISSUE_TITLE)) {
    const n = String(existing.number);
    gh([
      'issue',
      'comment',
      n,
      '--repo',
      repo,
      '--body',
      `**Recovered.** The scale-to-zero suite passed on ${runUrl}. Closing; this reopens as a new issue on the next failure.`,
    ]);
    gh(['issue', 'close', n, '--repo', repo]);
  }
}
