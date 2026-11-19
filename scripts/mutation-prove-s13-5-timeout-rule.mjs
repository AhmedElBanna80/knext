#!/usr/bin/env node
/**
 * Mutation proof for the measured-timeout rule (TD-S12-3b), guarded by
 * `tests/e2e-timeout-measured-rule.test.ts`. Each mutation either shortens a cited kind e2e timeout
 * below 1.5x its measured slowest run, or removes the citation the rule is read from; the spec must go
 * RED. Anchors occur exactly once (abort otherwise), restoration is content-addressed, verdicts are by
 * exit code.
 *
 * Usage: node scripts/mutation-prove-s13-5-timeout-rule.mjs
 */

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSpecRunner } from './lib/ci-blocking-gate-proof.mjs';
import { mutate, restore, snapshot } from './lib/mutation-harness.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = 'tests/e2e-timeout-measured-rule.test.ts';
const PROOF = {
  subjects: {
    z11: '.github/workflows/z11-activator-drill-e2e.yml',
    z7: '.github/workflows/z7-identity-kind-e2e.yml',
  },
};
const RUNNER = resolveSpecRunner(REPO_ROOT);
const SPEC_TIMEOUT_MS = 240_000;

function specPasses() {
  const r = spawnSync(RUNNER.command, [...RUNNER.args, ...RUNNER.runArgs(SPEC)], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    timeout: SPEC_TIMEOUT_MS,
  });
  return r.status === 0;
}

const MUTATIONS = [
  {
    label: 'the z11 kind timeout is cut to 50 min, below 1.5x its 2313 s slowest run (57.8 min)',
    subject: 'z11',
    anchor: '    timeout-minutes: 60',
    replacement: '    timeout-minutes: 50',
  },
  {
    label: 'the z7 kind timeout falls back to 60 min, below 1.5x its 2557 s slowest run (63.9 min)',
    subject: 'z7',
    anchor: '|| 65 }}',
    replacement: '|| 60 }}',
  },
  {
    label: 'the z11 citation is reworded, so the rule is no longer read from the comment',
    subject: 'z11',
    anchor: 'The slowest is 2313 s',
    replacement: 'The slowest was 2313 s',
  },
];

const DECLARED = 3;
declareMutations(DECLARED);
if (MUTATIONS.length !== DECLARED) {
  console.error(`FATAL: declared ${DECLARED} mutations, table has ${MUTATIONS.length}`);
  process.exit(1);
}
if (!specPasses()) {
  console.error('FATAL: baseline is not green to begin with');
  process.exit(1);
}
const decorative = [];
for (const m of MUTATIONS) {
  console.log(`── mutation: ${m.label}`);
  const snap = snapshot(resolve(REPO_ROOT, PROOF.subjects[m.subject]));
  try {
    mutate(snap, m.anchor, m.replacement);
    if (specPasses()) {
      console.log('   x DECORATION: the spec stayed GREEN with the behaviour removed');
      decorative.push(m.label);
    } else console.log('   ok went RED as required');
    recordMutation();
  } finally {
    restore(snap);
  }
  if (!specPasses()) {
    console.error('   FATAL: spec did not go green again after restore');
    process.exit(1);
  }
}
console.log(`\n${MUTATIONS.length - decorative.length} caught, ${decorative.length} decorative.`);
if (decorative.length > 0) {
  for (const label of decorative) console.error(`DECORATIVE: ${label}`);
  process.exit(1);
}
