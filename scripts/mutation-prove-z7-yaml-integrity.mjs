#!/usr/bin/env node
/**
 * Mutation proof for the integrity-checked scratch `yaml` install of the z7-pin-skew nightly
 * job, guarded by `tests/z7-pin-skew.test.ts`. Each mutation removes one fail-closed
 * behaviour; the spec must go RED. Anchors must occur exactly once (abort otherwise),
 * restoration is content-addressed, judged on exit codes only.
 *
 * Usage: node scripts/mutation-prove-z7-yaml-integrity.mjs
 */

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSpecRunner } from './lib/ci-blocking-gate-proof.mjs';
import { mutate, restore, snapshot } from './lib/mutation-harness.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = 'tests/z7-pin-skew.test.ts';
const SUBJECTS = {
  script: 'scripts/verify-installed-yaml-integrity.mjs',
  workflow: '.github/workflows/z7-watchdog-nightly.yml',
};
const RUNNER = resolveSpecRunner(REPO_ROOT);

function specPasses() {
  const r = spawnSync(RUNNER.command, [...RUNNER.args, ...RUNNER.runArgs(SPEC)], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return r.status === 0;
}

const MUTATIONS = [
  {
    label: 'the integrity comparison is dropped (any tarball is accepted)',
    subject: 'script',
    anchor: 'if (entry?.integrity !== locked.integrity) {',
    replacement: 'if (false) {',
  },
  {
    label: 'the installed version is no longer checked',
    subject: 'script',
    anchor: 'if (entry?.version !== expectedVersion) {',
    replacement: 'if (false) {',
  },
  {
    label: 'the lockfile/workflow version drift is no longer detected',
    subject: 'script',
    anchor: 'if (locked.version !== expectedVersion) {',
    replacement: 'if (false) {',
  },
  {
    label: 'the CLI swallows a failure (exits 0)',
    subject: 'script',
    anchor: 'process.exit(1);',
    replacement: 'process.exit(0);',
  },
  {
    label: 'the workflow stops running the integrity check',
    subject: 'workflow',
    anchor:
      '          node scripts/verify-installed-yaml-integrity.mjs "${work}" "${GITHUB_WORKSPACE}/bun.lock" 2.9.0\n',
    replacement: '',
  },
];

const DECLARED = 5;
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
  const snap = snapshot(resolve(REPO_ROOT, SUBJECTS[m.subject]));
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
