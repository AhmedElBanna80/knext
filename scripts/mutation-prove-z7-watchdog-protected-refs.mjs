#!/usr/bin/env node
/**
 * Mutation proof for the Z7 caller watchdog (D3) and the protected-ref check (D4),
 * guarded by `tests/z7-watchdog-protected-refs.test.ts`. Each mutation removes one
 * fail-closed behaviour; the spec must go RED. Shared harness: anchors must occur
 * exactly once (abort otherwise), restoration is content-addressed, judged on exit
 * codes only.
 *
 * Usage: node scripts/mutation-prove-z7-watchdog-protected-refs.mjs
 */

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSpecRunner } from './lib/ci-blocking-gate-proof.mjs';
import { mutate, restore, snapshot } from './lib/mutation-harness.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = 'tests/z7-watchdog-protected-refs.test.ts';

const PROOF = {
  subjects: {
    watchdog: 'scripts/lib/z7-watchdog.mjs',
    refs: 'scripts/lib/protected-refs.mjs',
    workflow: '.github/workflows/z7-watchdog-nightly.yml',
  },
};

const RUNNER = resolveSpecRunner(REPO_ROOT);

function specPasses(spec) {
  const r = spawnSync(RUNNER.command, [...RUNNER.args, ...RUNNER.runArgs(spec)], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return r.status === 0;
}

const MUTATIONS = [
  {
    label: 'a workflow that never started passes',
    subject: 'watchdog',
    anchor: 'if (!Array.isArray(runs) || runs.length === 0) {',
    replacement: 'if (!Array.isArray(runs)) {',
  },
  {
    label: 'a non-success latest run (cancelled/failure) is ignored',
    subject: 'watchdog',
    anchor: "if (!IN_FLIGHT.has(latest.status) && latest.conclusion !== 'success') {",
    replacement: 'if (false) {',
  },
  {
    label: 'the staleness window is disabled (an old success counts forever)',
    subject: 'watchdog',
    anchor: 'if (!lastSuccess || stamp(lastSuccess) < cutoff) {',
    replacement: 'if (!lastSuccess) {',
  },
  {
    label: 'an unparseable timestamp no longer fails closed',
    subject: 'watchdog',
    anchor: 'if (runs.some((r) => !Number.isFinite(stamp(r)))) {',
    replacement: 'if (false) {',
  },
  {
    label: 'a malformed runs payload no longer throws',
    subject: 'watchdog',
    anchor: 'if (!payload || !Array.isArray(payload.workflow_runs)) {',
    replacement: 'if (false) {',
  },
  {
    label: 'an UNPROTECTED branch is not reported',
    subject: 'refs',
    anchor: 'else if (body?.protected === false) {',
    replacement: 'else if (false) {',
  },
  {
    label: 'a branch API error is swallowed instead of UNVERIFIABLE',
    subject: 'refs',
    anchor: 'findings.push(`branch ${ref}: UNVERIFIABLE (${errText(e).split',
    replacement: '0 && findings.push(`branch ${ref}: UNVERIFIABLE (${errText(e).split',
  },
  {
    label: 'a tag shadowing a protected branch name is not reported',
    subject: 'refs',
    anchor: 'findings.push(`tag ${ref}: EXISTS',
    replacement: '0 && findings.push(`tag ${ref}: EXISTS',
  },
  {
    label: 'a non-404 tag lookup error is treated as absent',
    subject: 'refs',
    anchor: 'if (!isNotFound(e)) {',
    replacement: 'if (false) {',
  },
  {
    label: 'an empty ref set passes',
    subject: 'refs',
    anchor: 'if (checked === 0) findings.push',
    replacement: 'if (false) findings.push',
  },
  {
    label: 'the alert job loses its cancelled arm for the watchdog job',
    subject: 'workflow',
    anchor: "needs.z7-watchdog.result == 'cancelled' ||",
    replacement: '',
  },
  {
    label: 'the alert job loses always() so it never runs after a failed needs',
    subject: 'workflow',
    anchor: '      always() &&\n',
    replacement: '',
  },
];

const DECLARED = 12;
declareMutations(DECLARED);

if (MUTATIONS.length !== DECLARED) {
  console.error(`FATAL: declared ${DECLARED} mutations, table has ${MUTATIONS.length}`);
  process.exit(1);
}

console.log('Baseline: the spec must be GREEN before anything is mutated.');
if (!specPasses(SPEC)) {
  console.error('FATAL: baseline is not green to begin with');
  process.exit(1);
}
console.log('   ok baseline green\n');

const decorative = [];
for (const m of MUTATIONS) {
  console.log(`── mutation: ${m.label}`);
  const snap = snapshot(resolve(REPO_ROOT, PROOF.subjects[m.subject]));
  try {
    mutate(snap, m.anchor, m.replacement);
    if (specPasses(SPEC)) {
      console.log('   x DECORATION: the spec stayed GREEN with the behaviour removed');
      decorative.push(m.label);
    } else {
      console.log('   ok went RED as required');
    }
    recordMutation();
  } finally {
    restore(snap);
  }
  if (!specPasses(SPEC)) {
    console.error(`   FATAL: ${SPEC} did not go green again after restore`);
    process.exit(1);
  }
}

console.log(
  `\n${MUTATIONS.length - decorative.length} caught, ${decorative.length} decorative, of ${MUTATIONS.length}.`,
);
if (decorative.length > 0) {
  for (const label of decorative) console.error(`DECORATIVE: ${label}`);
  process.exit(1);
}
