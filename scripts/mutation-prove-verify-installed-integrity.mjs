#!/usr/bin/env node
/**
 * Mutation proof for the installed-package integrity gate (`scripts/verify-installed-integrity.mjs`)
 * of the prover-ratchet job in ci.yml, guarded by `tests/verify-installed-integrity.test.ts`. Each mutation removes one fail-closed
 * behaviour; the spec must go RED. Anchors must occur exactly once (abort otherwise),
 * restoration is content-addressed, judged on exit codes only.
 *
 * Usage: node scripts/mutation-prove-verify-installed-integrity.mjs
 */

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSpecRunner } from './lib/ci-blocking-gate-proof.mjs';
import { mutate, restore, snapshot } from './lib/mutation-harness.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = 'tests/verify-installed-integrity.test.ts';
const PROOF = {
  subjects: {
    script: 'scripts/verify-installed-integrity.mjs',
    workflow: '.github/workflows/ci.yml',
  },
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
    anchor: 'if (entry.integrity !== locked.integrity) {',
    replacement: 'if (false) {',
  },
  {
    label: 'the installed version is no longer compared with the lockfile pin',
    subject: 'script',
    anchor: 'if (entry.version !== locked.version) {',
    replacement: 'if (false) {',
  },
  {
    label: 'a package missing from the installed lockfile is accepted',
    subject: 'script',
    anchor: 'if (!entry) throw new Error(`${pkg} is not in the installed lockfile`);',
    replacement: '',
  },
  {
    label: 'only the first package is verified',
    subject: 'script',
    anchor: 'for (const pkg of packages) {',
    replacement: 'for (const pkg of packages.slice(0, 1)) {',
  },
  {
    label: 'an empty package list passes vacuously',
    subject: 'script',
    anchor:
      "if (!Array.isArray(packages) || packages.length === 0) throw new Error('no packages to verify');",
    replacement: '',
  },
  {
    label:
      'the lockfile entry is matched by prefix (a sibling like typescript-tsc7 can satisfy it)',
    subject: 'script',
    anchor: '`^\\\\s*"${n}": ',
    replacement: '`\\\\s*"${n}[^"]*": ',
  },
  {
    label:
      'a package with dependencies in its bun.lock tuple is verified anyway (transitive deps unchecked)',
    subject: 'script',
    anchor: 'if (locked.hasDependencies) {',
    replacement: 'if (false) {',
  },
  {
    label: "a package with dependencies in npm's entry is verified anyway",
    subject: 'script',
    anchor: 'if (entry.dependencies || entry.optionalDependencies) {',
    replacement: 'if (false) {',
  },
  {
    label: 'optionalDependencies are not counted as dependencies in the bun.lock tuple',
    subject: 'script',
    anchor: '/"(?:optionalD|d)ependencies"/',
    replacement: '/"dependencies"/',
  },
  {
    label: 'the CLI swallows a failure (exits 0)',
    subject: 'script',
    anchor: 'process.exit(1);',
    replacement: 'process.exit(0);',
  },
  {
    label: 'the CLI does not require --prefix and package names (usage error is not a failure)',
    subject: 'script',
    anchor: "if (!prefix || args.length === 0 || args.some((a) => a.startsWith('--'))) {",
    replacement: 'if (false) {',
  },
  {
    label: 'the workflow stops running the integrity check',
    subject: 'workflow',
    kind: 'wiring',
    anchor:
      '          node scripts/verify-installed-integrity.mjs --prefix "$RUNNER_TEMP/ratchet-deps" typescript yaml\n',
    replacement: '',
  },
  {
    label: 'the workflow links node_modules before verifying',
    subject: 'workflow',
    kind: 'wiring',
    anchor:
      '          node scripts/verify-installed-integrity.mjs --prefix "$RUNNER_TEMP/ratchet-deps" typescript yaml\n          ln -s "$RUNNER_TEMP/ratchet-deps/node_modules" node_modules',
    replacement:
      '          ln -s "$RUNNER_TEMP/ratchet-deps/node_modules" node_modules\n          node scripts/verify-installed-integrity.mjs --prefix "$RUNNER_TEMP/ratchet-deps" typescript yaml',
  },
  {
    label: 'the workflow verifies only typescript',
    subject: 'workflow',
    kind: 'wiring',
    anchor: '--prefix "$RUNNER_TEMP/ratchet-deps" typescript yaml\n',
    replacement: '--prefix "$RUNNER_TEMP/ratchet-deps" typescript\n',
  },
];

const DECLARED = 14;
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
