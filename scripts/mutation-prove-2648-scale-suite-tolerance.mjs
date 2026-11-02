#!/usr/bin/env node
/**
 * Mutation proof for the scale-suite tolerance visibility guard (#2648), graded by
 * `tests/operator-e2e-scale-suite-outcome.test.ts` on the shared driver.
 *
 * Subjects: `scripts/lib/scale-suite-tolerance.mjs` (decision + issue flow),
 * `scripts/scale-suite-tolerance.mjs` (CLI) and `.github/workflows/operator-e2e-nightly.yml`.
 * Each row plants ONE textual mutation (anchor EXACTLY ONCE, preflight-checked) and
 * the spec must go red; verdicts are by EXIT CODE only, the baseline must be green, a
 * canary must go red first, restores are content-verified.
 *
 * Usage:  node scripts/mutation-prove-2648-scale-suite-tolerance.mjs
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGuardProver } from './lib/guard-prover.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = 'tests/operator-e2e-scale-suite-outcome.test.ts';

const CHECKOUT =
  '      - name: Checkout code\n        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1\n        with:\n          persist-credentials: false\n\n      - name: Surface';
const LOOP = 'for (const existing of issues.filter((i) => i.title === SCALE_SUITE_ISSUE_TITLE)) {';
const EXPIRED = 'const expired = today > expires;';
const NEEDS = '    needs: scale-to-zero-cache\n    if: always()\n';
const NOT_RUN = "return { expired, issue: 'none', notRun: true };";
const NO_OUTCOME_THROW = '    throw new Error(\n      `the scale suite recorded no outcome';

const MUTATIONS = [
  // --- the workflow: outcome read, recorded, surfaced, wired ---
  {
    id: 'W01',
    subject: 'wf',
    claim: 'the tolerated suite step loses its id',
    anchor: '        id: scale-suite\n',
    replacement: '',
  },
  {
    id: 'W02',
    subject: 'wf',
    claim: 'the tolerance on the suite step is removed',
    anchor: '        id: scale-suite\n        continue-on-error: true\n',
    replacement: '        id: scale-suite\n',
  },
  {
    id: 'W03',
    subject: 'wf',
    claim: 'the outcome is read through the masked .conclusion',
    anchor: '          SUITE_OUTCOME: ${{ steps.scale-suite.outcome }}',
    replacement: '          SUITE_OUTCOME: ${{ steps.scale-suite.conclusion }}',
  },
  {
    id: 'W04',
    subject: 'wf',
    claim: 'the recorder no longer runs on failure',
    anchor: '        id: record-scale-outcome\n        if: always()\n',
    replacement: '        id: record-scale-outcome\n',
  },
  {
    id: 'W05',
    subject: 'wf',
    claim: 'the outcome is no longer written to GITHUB_OUTPUT',
    anchor: '          echo "suite_outcome=${SUITE_OUTCOME}" >> "$GITHUB_OUTPUT"\n',
    replacement: '',
  },
  {
    id: 'W06',
    subject: 'wf',
    claim: 'the job output key points at a different step output',
    anchor: '      suite_outcome: ${{ steps.record-scale-outcome.outputs.suite_outcome }}',
    replacement: '      suite_outcome: ${{ steps.record-scale-outcome.outputs.other }}',
  },
  {
    id: 'W07',
    subject: 'wf',
    claim: 'the tolerance job is not run when the scale job failed',
    anchor: NEEDS,
    replacement: '    needs: scale-to-zero-cache\n',
  },
  {
    id: 'W08',
    subject: 'wf',
    claim: 'the tolerance job no longer receives the scale job result',
    anchor: '          JOB_RESULT: ${{ needs.scale-to-zero-cache.result }}\n',
    replacement: '',
  },
  {
    id: 'W09',
    subject: 'wf',
    claim: 'the tolerance job loses issues:write',
    anchor: `      issues: write\n    steps:\n${CHECKOUT}`,
    replacement: `    steps:\n${CHECKOUT}`,
  },
  {
    id: 'W10',
    subject: 'wf',
    claim: 'the owner is dropped from the tolerance env',
    anchor: '          OWNER: AhmedElBanna80\n',
    replacement: '',
  },
  {
    id: 'W11',
    subject: 'wf',
    claim: 'the expiry date is dropped from the tolerance env',
    anchor: "          TOLERANCE_EXPIRES: '2026-12-15'\n",
    replacement: '',
  },
  {
    id: 'W12',
    subject: 'wf',
    claim: 'the expiry check is made schedule-only at job level',
    anchor: NEEDS,
    replacement:
      "    needs: scale-to-zero-cache\n    if: always() && github.event_name == 'schedule'\n",
  },
  {
    id: 'W13',
    subject: 'wf',
    claim: 'a red tolerance job no longer reaches the nightly alert',
    anchor:
      "       needs.scale-suite-tolerance.result == 'failure' || needs.scale-suite-tolerance.result == 'cancelled' ||\n",
    replacement: '',
  },
  {
    id: 'W14',
    subject: 'wf',
    claim: 'the alert drops the suite outcome',
    anchor:
      '            e2e_scale_suite_outcome=${{ needs.scale-to-zero-cache.outputs.suite_outcome }}\n',
    replacement: '',
  },
  {
    id: 'W15',
    subject: 'wf',
    claim: 'the tolerance job gains continue-on-error',
    anchor: '    timeout-minutes: 5\n    permissions:\n      contents: read\n      issues: write',
    replacement:
      '    timeout-minutes: 5\n    continue-on-error: true\n    permissions:\n      contents: read\n      issues: write',
  },
  // --- the decision ---
  {
    id: 'D01',
    subject: 'lib',
    claim: 'expiry fires ON the date, not after it',
    anchor: EXPIRED,
    replacement: 'const expired = today >= expires;',
  },
  {
    id: 'D02',
    subject: 'lib',
    claim: 'expiry never fires',
    anchor: EXPIRED,
    replacement: 'const expired = false;',
  },
  {
    id: 'D03',
    subject: 'lib',
    claim: 'a dispatched run touches the issue',
    anchor: "if (event !== 'schedule') return { expired, issue: 'none', notRun: false };",
    replacement: '',
  },
  {
    id: 'D04',
    subject: 'lib',
    claim: 'success no longer recovers',
    anchor: "if (outcome === 'success') return { expired, issue: 'recover', notRun: false };",
    replacement: '',
  },
  {
    id: 'D05',
    subject: 'lib',
    claim: 'skipped alerts',
    anchor: "if (outcome === 'skipped') return { expired, issue: 'none', notRun: false };",
    replacement: '',
  },
  {
    id: 'D06',
    subject: 'lib',
    claim: 'an unrecognised outcome fails open instead of closed',
    anchor: "return { expired, issue: 'alert', notRun: false };",
    replacement: "return { expired, issue: 'none', notRun: false };",
  },
  {
    id: 'D07',
    subject: 'lib',
    claim: 'a malformed expiry no longer throws',
    anchor:
      "if (!ISO_DATE.test(expires ?? '') || Number.isNaN(Date.parse(`${expires}T00:00:00Z`))) {",
    replacement: 'if (false) {',
  },
  {
    id: 'D08',
    subject: 'lib',
    claim: 'a suite that never ran alerts as a suite failure',
    anchor: NOT_RUN,
    replacement: "return { expired, issue: 'alert', notRun: true };",
  },
  {
    id: 'D09',
    subject: 'lib',
    claim: 'a suite that never ran is not flagged notRun',
    anchor: NOT_RUN,
    replacement: "return { expired, issue: 'none', notRun: false };",
  },
  {
    id: 'D10',
    subject: 'lib',
    claim: 'a cancelled scale job is not recognised as "did not run"',
    anchor:
      "if (jobResult === 'failure' || jobResult === 'cancelled' || jobResult === 'skipped') {",
    replacement: "if (jobResult === 'failure' || jobResult === 'skipped') {",
  },
  {
    id: 'D11',
    subject: 'lib',
    claim: 'empty outcome with a SUCCEEDED job passes instead of failing loud',
    anchor: NO_OUTCOME_THROW,
    replacement: `    return { expired, issue: 'none', notRun: false };\n${NO_OUTCOME_THROW}`,
  },
  // --- the issue flow ---
  {
    id: 'I01',
    subject: 'lib',
    claim: 'recover closes only the first matching issue',
    anchor: LOOP,
    replacement:
      'for (const existing of issues.filter((i) => i.title === SCALE_SUITE_ISSUE_TITLE).slice(0, 1)) {',
  },
  {
    id: 'I02',
    subject: 'lib',
    claim: 'recover closes any issue regardless of title',
    anchor: LOOP,
    replacement: 'for (const existing of issues) {',
  },
  {
    id: 'I03',
    subject: 'lib',
    claim: 'recover no longer closes',
    anchor: "    gh(['issue', 'close', n, '--repo', repo]);\n",
    replacement: '',
  },
  {
    id: 'I04',
    subject: 'lib',
    claim: 'the failure body drops the run link',
    anchor: '- Run: ${runUrl}\n- Tolerance owner',
    replacement: '- Tolerance owner',
  },
  {
    id: 'I05',
    subject: 'lib',
    claim: 'the failure body drops the expiry',
    anchor: '- Tolerance expires: ${expires} (the nightly',
    replacement: '- Tolerance (the nightly',
  },
  {
    id: 'I06',
    subject: 'lib',
    claim: 'issue "none" still calls gh',
    anchor: "if (issue === 'none') return;",
    replacement: "if (issue === 'none') gh(['issue', 'list']);",
  },
  // --- the CLI ---
  {
    id: 'C01',
    subject: 'cli',
    claim: 'an expired tolerance no longer exits non-zero',
    anchor: '    process.exit(1);\n  }\n}\n\ntry {',
    replacement: '  }\n}\n\ntry {',
  },
  {
    id: 'C02',
    subject: 'cli',
    claim: 'JOB_RESULT is not read from the env',
    anchor: "const jobResult = process.env.JOB_RESULT ?? '';",
    replacement: "const jobResult = 'success';",
  },
  {
    id: 'C03',
    subject: 'cli',
    claim: 'the not-run warning is not emitted',
    anchor: 'console.log(`::warning::${msg}`);',
    replacement: '',
  },
  {
    id: 'C04',
    subject: 'cli',
    claim: 'an error in main no longer exits non-zero',
    anchor:
      '`::error::${error instanceof Error ? error.message : String(error)}`);\n  process.exit(1);',
    replacement: '`::error::${error instanceof Error ? error.message : String(error)}`);',
  },
];

// A real mutation of a real subject, distinct from the rows.
const CANARY = {
  subject: 'lib',
  anchor: 'const ISO_DATE = /^\\d{4}-\\d{2}-\\d{2}$/;',
  replacement: 'const ISO_DATE = /^\\d{4}-\\d{2}-\\d{2}x$/;',
};

// Inline literal: the lane's subject-existence audit reads these from the call.
const prover = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: SPEC,
  subjects: {
    wf: '.github/workflows/operator-e2e-nightly.yml',
    lib: 'scripts/lib/scale-suite-tolerance.mjs',
    cli: 'scripts/scale-suite-tolerance.mjs',
  },
});

console.log('=== mutation proof: the scale-suite tolerance is visible and time-boxed (#2648) ===');
prover.preflight([...MUTATIONS, { id: 'canary', ...CANARY }]);
declareMutations(MUTATIONS.length);
prover.baseline();
prover.proveCanSeeRed(CANARY);
for (const m of MUTATIONS) {
  prover.run({ ...m, expect: 'red' });
  recordMutation();
}
prover.finish(MUTATIONS.length);
