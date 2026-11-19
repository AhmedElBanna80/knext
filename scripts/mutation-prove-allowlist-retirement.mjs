#!/usr/bin/env node
/**
 * Mutation proof for the advisory-allowlist retirement probe (S9-7):
 *   - `tests/allowlist-retirement.test.ts` (logic, exit code, fail-closed paths)
 *   - `tests/nightly-alert-cancelled-condition.test.ts` (the workflow's alert
 *     must fire on a cancelled probe, and carry always())
 *
 * Shared harness: `mutate` aborts unless the anchor occurs exactly once;
 * `declareMutations`/`recordMutation` let the lane tell N-of-M from M-of-M;
 * judged on EXIT CODES, never on grepped output.
 *
 * Usage:  node scripts/mutation-prove-allowlist-retirement.mjs
 */

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSpecRunner } from './lib/ci-blocking-gate-proof.mjs';
import { mutate, restore, snapshot } from './lib/mutation-harness.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const PROOF = {
  subjects: {
    spec: 'tests/allowlist-retirement.test.ts',
    alertSpec: 'tests/nightly-alert-cancelled-condition.test.ts',
    lib: 'scripts/lib/allowlist-retirement.mjs',
    cli: 'scripts/verify-allowlist-retirement.mjs',
    workflow: '.github/workflows/allowlist-retirement-nightly.yml',
  },
};

function specPasses(spec) {
  const runner = resolveSpecRunner(REPO_ROOT, spec);
  const r = spawnSync(runner.command, [...runner.args, ...runner.runArgs(spec)], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return r.status === 0;
}

const MUTATIONS = [
  {
    label: 'lib: ignore withdrawn_at (a withdrawn advisory is no longer a RETIRE)',
    subject: 'lib',
    guard: 'spec',
    anchor: 'if (advisory.withdrawn_at) reasons.push(',
    replacement: 'if (false && advisory.withdrawn_at) reasons.push(',
  },
  {
    label: 'lib: never treat a patched version as retirable',
    subject: 'lib',
    guard: 'spec',
    anchor: 'if (!v.first_patched_version) continue;',
    replacement: 'continue;',
  },
  {
    label: 'lib: ignore the package/version range (flag patches for other packages and ranges)',
    subject: 'lib',
    guard: 'spec',
    anchor: 'if (entry.package && name !== entry.package) continue;',
    replacement: '',
  },
  {
    label: 'lib: a patch already named in the justification is flagged again',
    subject: 'lib',
    guard: 'spec',
    anchor: 'if (mentionsVersion(entry.justification, v.first_patched_version)) continue;',
    replacement: '',
  },
  {
    label: 'lib: swallow API errors instead of recording them (fail open)',
    subject: 'lib',
    guard: 'spec',
    anchor: 'errors.push({ file: entry.file',
    replacement: '[].push({ file: entry.file',
  },
  {
    label: 'lib: exit code ignores API errors',
    subject: 'lib',
    guard: 'spec',
    anchor: 'return findings.length > 0 || errors.length > 0 || checked === 0 ? 1 : 0;',
    replacement: 'return findings.length > 0 || checked === 0 ? 1 : 0;',
  },
  {
    label: 'lib: zero entries passes vacuously',
    subject: 'lib',
    guard: 'spec',
    anchor: 'return findings.length > 0 || errors.length > 0 || checked === 0 ? 1 : 0;',
    replacement: 'return findings.length > 0 || errors.length > 0 ? 1 : 0;',
  },
  {
    label: 'lib: exit code ignores RETIRE findings',
    subject: 'lib',
    guard: 'spec',
    anchor: 'return findings.length > 0 || errors.length > 0 || checked === 0 ? 1 : 0;',
    replacement: 'return errors.length > 0 || checked === 0 ? 1 : 0;',
  },
  {
    label: 'cli: a non-2xx API response is accepted instead of thrown',
    subject: 'cli',
    guard: 'spec',
    anchor: 'if (!res.ok) throw new Error(',
    replacement: 'if (false) throw new Error(',
  },
  {
    label: "workflow: drop 'cancelled' from the alert condition",
    subject: 'workflow',
    guard: 'alertSpec',
    anchor:
      "(needs.probe-allowlists.result == 'failure' || needs.probe-allowlists.result == 'cancelled')",
    replacement: "needs.probe-allowlists.result == 'failure'",
  },
  {
    label: 'workflow: drop always() from the alert condition',
    subject: 'workflow',
    guard: 'alertSpec',
    anchor: "always() &&\n      github.event_name == 'schedule' &&\n      (needs.probe-allowlists",
    replacement: "github.event_name == 'schedule' &&\n      (needs.probe-allowlists",
  },
];

declareMutations(11);
if (MUTATIONS.length !== 11) {
  console.error(`FATAL: declared 11 mutations, table has ${MUTATIONS.length}`);
  process.exit(1);
}

console.log('Baseline: every guarded spec must be GREEN before anything is mutated.');
for (const key of new Set(MUTATIONS.map((m) => m.guard))) {
  if (!specPasses(PROOF.subjects[key])) {
    console.error(`FATAL: baseline ${PROOF.subjects[key]} is not green to begin with`);
    process.exit(1);
  }
}
console.log('   ok baseline green\n');

const decorative = [];
for (const m of MUTATIONS) {
  const spec = PROOF.subjects[m.guard];
  console.log(`── mutation: ${m.label}`);
  const snap = snapshot(resolve(REPO_ROOT, PROOF.subjects[m.subject]));
  try {
    mutate(snap, m.anchor, m.replacement);
    if (specPasses(spec)) {
      console.log('   x DECORATION: the spec stayed GREEN with the behaviour removed');
      decorative.push(m.label);
    } else {
      console.log('   ok went RED as required');
    }
    recordMutation();
  } finally {
    restore(snap);
  }
  if (!specPasses(spec)) {
    console.error(`   FATAL: ${spec} did not go green again after restore`);
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
