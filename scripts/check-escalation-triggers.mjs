#!/usr/bin/env node
/**
 * Detect the MECHANICALLY DETECTABLE escalation triggers from
 * `.claude/rules/workflow.md`, so a trigger-class change cannot reach `main` on
 * an agent's self-report.
 *
 * WHY THIS EXISTS. The sprint model moved the architect + system-designer gates
 * from per-PR to per-sprint, and pulled them back only on five triggers. The rules
 * file is explicit that three of those are detectable and that leaving them to
 * self-reporting is the failure mode to watch:
 *
 *   "Three of these are mechanically detectable, so detect them rather than
 *    relying on someone to self-report against their own interest."
 *
 * It was never implemented. On 2026-08-11 a breaking CRD + CLI change (#715)
 * merged with no design gate and no per-PR review; the retroactive review found
 * two HIGH defects, one of them in a safety control. Nothing flagged it as
 * trigger-class because nothing was looking.
 *
 * WHAT IT DOES NOT DO. It does not decide whether the change is correct, and it
 * does not block one. It asserts that a trigger-class change was ACKNOWLEDGED —
 * that the trigger was consciously noted. The triggers (ids from
 * `escalation/catalogue.mjs`) and the module that detects each:
 *   - `adr`: a modified or deleted ADR (`paths.mjs`);
 *   - `crd`: any `api/**\/*_types.go` (`paths.mjs`);
 *   - `config-schema`: `packages/kn-next/src/config.ts` (`paths.mjs`);
 *   - `cli-surface`: every package's CLI (`paths.mjs`);
 *   - `crates`: anything under `crates/` (`paths.mjs`);
 *   - `public-api`: a package manifest's published surface (`public-surface.mjs`);
 *   - `supply-chain`: `security/**` and other static paths (`paths.mjs`), and a
 *     credential-bearing workflow or a file one names directly
 *     (`credential-workflows.mjs`).
 * The first three are the triggers workflow.md calls mechanically detectable; the
 * rest widen them (every package CLI) or come from security.md. The two judgement
 * triggers (a discovered fact that invalidates the sprint plan; a hard-rule
 * contradiction that touches no tracked path) stay unenforced.
 *
 * LAYOUT. This file is the CLI; each concern is its own module under
 * `scripts/escalation/`: `catalogue.mjs` (every trigger's id, label and reason),
 * `classify.mjs` (all findings for a diff), `paths.mjs` (path triggers), `public-surface.mjs`
 * (package manifest surface), `credential-workflows.mjs` (credential-bearing
 * workflows and the files they name), `acknowledgement.mjs`, `git.mjs` and
 * `report.mjs`. The named exports below keep existing importers working.
 *
 * Usage:
 *   node scripts/check-escalation-triggers.mjs --base <ref> [--head <ref>]
 *                                              [--labels "a,b"] [--body "<text>"] [--json]
 *
 * Exit 0 = no trigger, or triggered and acknowledged. Exit 1 = triggered, unacknowledged.
 *
 * ACKNOWLEDGEMENT, not gate-clear (workflow.md amendment, 2026-09-22): a trigger-class
 * PR no longer needs a design gate to sign off before merge — it needs a human/agent to
 * have CONSCIOUSLY NOTED the trigger, so sprint close can collect it as a tech-debt
 * backlog item. Any of the following counts:
 *   - the `trigger:acknowledged` label (or, backward compatible, the older
 *     `design-gate:cleared` label from when this WAS a gate);
 *   - a line in the PR body matching `Escalation trigger acknowledged: <...>` — this
 *     also records WHICH trigger and WHY inline, where sprint close can read it without
 *     needing GitHub timeline/label history.
 */

import { ACK_LABEL, isAcknowledged } from './escalation/acknowledgement.mjs';
import { classifyAll } from './escalation/classify.mjs';
import { git, gitReader, parseNameStatus } from './escalation/git.mjs';
import { printReport, writeJobSummary } from './escalation/report.mjs';

export {
  ACK_BODY_EXAMPLE,
  ACK_BODY_PATTERN,
  ACK_LABEL,
  isAcknowledged,
  LEGACY_ACK_LABEL,
} from './escalation/acknowledgement.mjs';
export { classify, classifyAll, classifyContent } from './escalation/classify.mjs';
export {
  LOW_PRIVILEGE_SECRETS,
  namedFiles,
  referencedPaths,
  workflowHoldsCredential,
} from './escalation/credential-workflows.mjs';
export { parseNameStatus } from './escalation/git.mjs';
export { isStaticSupplyChainPath, TRIGGERS } from './escalation/paths.mjs';
export { PUBLIC_MANIFEST_KEYS, publicSurfaceChanged } from './escalation/public-surface.mjs';
export { mergeFired } from './escalation/report.mjs';

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const base = arg('base');
  const head = arg('head', 'HEAD');
  if (!base) {
    console.error(
      'usage: check-escalation-triggers.mjs --base <ref> [--head <ref>] [--labels a,b]',
    );
    process.exit(2);
  }
  // `-z`: NUL-separated and never C-quoted, so a non-ASCII path is classified as itself.
  const changes = parseNameStatus(git(['diff', '-z', '--name-status', `${base}...${head}`]));
  // The diff is three-dot, so the "before" side of a content comparison is the merge base.
  const mergeBase = git(['merge-base', base, head]).trim();
  const fired = classifyAll(changes, gitReader(mergeBase, head));
  const labels = (arg('labels', '') || '').split(',').filter(Boolean);
  const acked = isAcknowledged(labels, arg('body', '') || '');
  writeJobSummary(fired, acked);
  // `--json` prints JSON and nothing else, so a caller can parse stdout directly.
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ fired, acked, ackLabel: ACK_LABEL }, null, 2));
    process.exit(fired.length > 0 && !acked ? 1 : 0);
  }
  process.exit(printReport(fired, acked));
}
