#!/usr/bin/env node
/**
 * CLI for the operator-e2e-nightly `scale-suite-tolerance` job (#2648).
 * See scripts/lib/scale-suite-tolerance.mjs.
 *
 * Env: OUTCOME (steps.<id>.outcome of the tolerated suite step), JOB_RESULT
 * (needs.<scale job>.result; distinguishes "suite never ran" from a failure), EVENT_NAME,
 * TOLERANCE_EXPIRES (YYYY-MM-DD), OWNER, RUN_URL, GITHUB_REPOSITORY, GH_TOKEN.
 * TODAY (YYYY-MM-DD) overrides the clock for tests only.
 *
 * Exit 1 when the tolerance has expired or its expiry is malformed — even after
 * the issue has been reconciled, so a passed review date is never silent.
 */

import { execFileSync } from 'node:child_process';
import { appendFileSync } from 'node:fs';
import { decideScaleSuiteAction, reconcileScaleSuiteIssue } from './lib/scale-suite-tolerance.mjs';

function gh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function main() {
  const outcome = process.env.OUTCOME ?? '';
  const event = process.env.EVENT_NAME ?? '';
  const expires = process.env.TOLERANCE_EXPIRES ?? '';
  const owner = process.env.OWNER ?? '';
  const today = process.env.TODAY ?? new Date().toISOString().slice(0, 10);

  const jobResult = process.env.JOB_RESULT ?? '';
  const { expired, issue, notRun } = decideScaleSuiteAction({
    outcome,
    expires,
    today,
    event,
    jobResult,
  });
  console.log(
    `scale suite outcome=${outcome || 'unknown'} event=${event} -> issue action: ${issue}`,
  );

  if (notRun) {
    const msg = `The scale-to-zero suite did not execute this run (scale job result: ${jobResult}); no suite verdict exists. No tracking issue was opened or closed. The failing upstream job is reported by the nightly red alert.`;
    console.log(`::warning::${msg}`);
    if (process.env.GITHUB_STEP_SUMMARY) {
      appendFileSync(
        process.env.GITHUB_STEP_SUMMARY,
        `### Scale-suite tolerance\n\n**Suite did not execute** (scale job: ${jobResult}). No verdict; tracking issue untouched.\n`,
      );
    }
  }

  if (issue !== 'none') {
    const repo = process.env.GITHUB_REPOSITORY;
    if (!repo) throw new Error('GITHUB_REPOSITORY is required to reconcile the tracking issue');
    reconcileScaleSuiteIssue({
      gh,
      repo,
      runUrl: process.env.RUN_URL ?? '(run url unavailable)',
      owner,
      expires,
      issue,
      outcome,
    });
  }

  if (expired) {
    console.error(
      `::error::The scale-suite failure tolerance EXPIRED on ${expires} (owner @${owner}). Review it: fix the flake and remove continue-on-error, or consciously extend TOLERANCE_EXPIRES.`,
    );
    process.exit(1);
  }
}

try {
  main();
} catch (error) {
  console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
