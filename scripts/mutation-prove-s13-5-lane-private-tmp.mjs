#!/usr/bin/env node
/**
 * Mutation proof for the lane runner's signal cleanup (TD-S12-2a), guarded by
 * `tests/lane-private-tmp-signals.test.ts`. Each mutation removes one half of the cleanup (a signal
 * not routed through process.exit, a signal dropped from the list, or the runner no longer pinning
 * its signals); the spec must go RED. Anchors occur exactly once (abort otherwise), restoration is
 * content-addressed, verdicts are by exit code. A spec that hangs counts as RED (timeout), not green.
 *
 * Usage: node scripts/mutation-prove-s13-5-lane-private-tmp.mjs
 */

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSpecRunner } from './lib/ci-blocking-gate-proof.mjs';
import { mutate, restore, snapshot } from './lib/mutation-harness.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = 'tests/lane-private-tmp-signals.test.ts';
const PROOF = {
  subjects: {
    helper: 'scripts/lib/lane-exit-signals.mjs',
    runner: 'scripts/run-mutation-provers.mjs',
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
    label: 'SIGHUP is no longer routed through process.exit (a closed terminal leaves the dir)',
    subject: 'helper',
    anchor: "  ['SIGHUP', 129],\n",
    replacement: '',
  },
  {
    label: 'SIGQUIT is no longer routed through process.exit',
    subject: 'helper',
    anchor: "  ['SIGQUIT', 131],\n",
    replacement: '',
  },
  {
    label: 'a pinned signal runs a no-op handler instead of exiting (the exit cleanup never runs)',
    subject: 'helper',
    anchor: 'process.once(signal, () => process.exit(code));',
    replacement: 'process.once(signal, () => {});',
  },
  {
    label: 'the runner stops pinning its signals (back to the bare exit handler)',
    subject: 'runner',
    anchor: 'pinExitSignals();',
    replacement: '',
  },
];

const DECLARED = 4;
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
