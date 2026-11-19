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
    anchor: 'if (advisory.withdrawn_at) {',
    replacement: 'if (false) {',
  },
  {
    label:
      'lib: drop the vulnerable-range check (a patch for another range applies to the installed version)',
    subject: 'lib',
    guard: 'spec',
    anchor:
      'if (versionInRange(iv, v.vulnerable_version_range)) candidates.push({ lock, lf, iv });',
    replacement: 'candidates.push({ lock, lf, iv });',
  },
  {
    label: 'lib: drop the reachability check (a blocked patch is flagged red)',
    subject: 'lib',
    guard: 'spec',
    anchor: "} else if (r.status === 'reachable') reachable.push(",
    replacement: '} else if (true) reachable.push(',
  },
  {
    label: 'lib: a reachable patch in a pinned fixture lockfile goes red',
    subject: 'lib',
    guard: 'spec',
    anchor: "if (r.status === 'reachable' && isPinnedFixtureLockfile(c.lf)) {",
    replacement: 'if (false) {',
  },
  {
    label: 'lib: informational findings are routed to the red list',
    subject: 'lib',
    guard: 'spec',
    anchor: "else if (level === 'INFO') informational.push(row);",
    replacement: "else if (level === 'INFO') findings.push(row);",
  },
  {
    label: 'lib: informational findings fail the exit code',
    subject: 'lib',
    guard: 'spec',
    anchor: 'return findings.length > 0 || errors.length > 0 || checked === 0 ? 1 : 0;',
    replacement:
      'return findings.length + arguments[0].informational.length > 0 || errors.length > 0 || checked === 0 ? 1 : 0;',
  },
  {
    label: 'lib: swallow API errors instead of recording them (fail open)',
    subject: 'lib',
    guard: 'spec',
    anchor: 'errors.push({',
    replacement: '[].push({',
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
    anchor: 'if (res.ok) break;',
    replacement: 'if (true) break;',
  },
  {
    label: 'cli: the retry bound is effectively removed',
    subject: 'cli',
    guard: 'spec',
    anchor: 'attempt < MAX_RETRIES',
    replacement: 'attempt < MAX_RETRIES + 100',
  },
  {
    label: 'cli: 403 is no longer retried',
    subject: 'cli',
    guard: 'spec',
    anchor: '(res.status === 403 || res.status === 429)',
    replacement: '(res.status === 429)',
  },
  {
    label: 'cli: a CVE id with several advisories is accepted',
    subject: 'cli',
    guard: 'spec',
    anchor: 'body.length !== 1',
    replacement: 'body.length < 1',
  },
  {
    label: "workflow: drop 'cancelled' from the alert condition",
    subject: 'workflow',
    guard: 'spec',
    anchor:
      "(needs.probe-allowlists.result == 'failure' || needs.probe-allowlists.result == 'cancelled')",
    replacement: "needs.probe-allowlists.result == 'failure'",
  },
  {
    label: 'workflow: drop always() from the alert condition',
    subject: 'workflow',
    guard: 'spec',
    anchor: "always() &&\n      github.event_name == 'schedule' &&\n      (needs.probe-allowlists",
    replacement: "github.event_name == 'schedule' &&\n      (needs.probe-allowlists",
  },
  {
    label: 'workflow: the checkout ignores checkout_ref (a call would probe main)',
    subject: 'workflow',
    guard: 'spec',
    anchor:
      '          ref: ${{ inputs.checkout_ref }}\n          persist-credentials: false\n\n      - name: Probe',
    replacement: '          persist-credentials: false\n\n      - name: Probe',
  },
  {
    label: 'workflow: a dead schedule trigger is added back',
    subject: 'workflow',
    guard: 'spec',
    anchor: 'on:\n  workflow_call:',
    replacement: "on:\n  schedule:\n    - cron: '19 7 * * *'\n  workflow_call:",
  },
  {
    label: 'lib: an absolute or escaping lockfile path is read',
    subject: 'lib',
    guard: 'spec',
    anchor: 'if (isAbsolute(rel) || outside(abs)) {',
    replacement: 'if (false) {',
  },
  {
    label: 'lib: a symlinked lockfile escaping the root is read',
    subject: 'lib',
    guard: 'spec',
    anchor: 'if (outside(realpathSync(abs).replace(realpathSync(root), root))) {',
    replacement: 'if (false) {',
  },
  {
    label: 'lib: an unknown allowlist file name is accepted',
    subject: 'lib',
    guard: 'spec',
    anchor: 'if (!ALLOWLIST_FILES.includes(n)) throw',
    replacement: 'if (false) throw',
  },
];

declareMutations(21);
if (MUTATIONS.length !== 21) {
  console.error(`FATAL: declared 21 mutations, table has ${MUTATIONS.length}`);
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
