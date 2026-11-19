#!/usr/bin/env node
/**
 * Mutation proof for the narrow own-repo reusable-workflow exemption in
 * `scripts/verify-action-pins.mjs` (`isOwnRepoReusableWorkflow`), guarded by
 * `tests/workflow-action-pins.test.ts` and `tests/action-pin-own-repo-nightly.test.ts`.
 *   1. Removing the exemption reds the REAL file (z7-rotation-weekly.yml).
 *   2. Widening it to any repo reds the lookalike/third-party rejection cases.
 * Anchors must occur exactly once (harness aborts otherwise); judged on exit
 * codes; the subject is restored from a byte snapshot.
 *
 * Usage:  node scripts/mutation-prove-own-repo-workflow-exemption.mjs
 */
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSpecRunner } from './lib/ci-blocking-gate-proof.mjs';
import { mutate, restore, snapshot } from './lib/mutation-harness.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPECS = ['tests/workflow-action-pins.test.ts', 'tests/action-pin-own-repo-nightly.test.ts'];
const SUBJECT = 'scripts/verify-action-pins.mjs';
// Named `subjects` map: the PR-time prover-lane audit reads this shape to check every
// `{ subject, anchor }` entry below resolves exactly once in its file.
const PROVER = { specs: SPECS, subjects: { verify: SUBJECT } };
const RUNNER = resolveSpecRunner(REPO_ROOT);

function specPasses() {
  const r = spawnSync(
    RUNNER.command,
    [...RUNNER.args, ...SPECS.flatMap((s) => RUNNER.runArgs(s))],
    {
      cwd: REPO_ROOT,
      encoding: 'utf8',
    },
  );
  return r.status === 0;
}

const MUTATIONS = [
  {
    subject: 'verify',
    label: 'remove the exemption entirely (always false)',
    anchor: "  if (typeof action !== 'string' || !PROTECTED_REFS.has(ref)) return false;",
    replacement: '  return false;',
  },
  {
    subject: 'verify',
    label: 'widen the exemption to any owner/repo',
    anchor: '!OWN_REPOS.has(`${parts[0]}/${parts[1]}`)',
    replacement: 'false',
  },
  {
    subject: 'verify',
    label: 'delete the nightly call-site exemption (every own-repo call SHA-resolved)',
    anchor: '} else if (!isOwnRepoReusableWorkflow(pin.action, pin.ref)) {',
    replacement: '} else if (true) {',
  },
  {
    subject: 'verify',
    label: 'widen the nightly call-site exemption to owner/repo only',
    anchor: '} else if (!isOwnRepoReusableWorkflow(pin.action, pin.ref)) {',
    replacement: '} else if (!OWN_REPOS.has(`${pin.owner}/${pin.repo}`)) {',
  },
  {
    subject: 'verify',
    label: 'skip the input check for exempted calls',
    anchor:
      'const ref = pin.sha ?? (isOwnRepoReusableWorkflow(pin.action, pin.ref) ? pin.ref : undefined);',
    replacement: 'const ref = pin.sha;',
  },
];

declareMutations(MUTATIONS.length);

if (!specPasses()) {
  console.error('FATAL: baseline is not green');
  process.exit(1);
}
const decorative = [];
for (const m of MUTATIONS) {
  console.log(`-- mutation: ${m.label}`);
  const snap = snapshot(resolve(REPO_ROOT, PROVER.subjects[m.subject]));
  try {
    mutate(snap, m.anchor, m.replacement);
    if (specPasses()) {
      console.log('   x DECORATION: spec stayed GREEN');
      decorative.push(m.label);
    } else {
      console.log('   ok went RED as required');
    }
    recordMutation();
  } finally {
    restore(snap);
  }
  if (!specPasses()) {
    console.error('   FATAL: spec not green after restore');
    process.exit(1);
  }
}
console.log(`${MUTATIONS.length - decorative.length} caught, ${decorative.length} decorative.`);
if (decorative.length > 0) process.exit(1);
