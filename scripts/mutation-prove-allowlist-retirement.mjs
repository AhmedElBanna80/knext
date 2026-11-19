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
  {
    label: "workflow: drop 'cancelled' from the alert condition",
    subject: 'workflow',
    guard: 'spec',
    anchor: "needs.probe-allowlists.result == 'cancelled'",
    replacement: "needs.probe-allowlists.result == 'skipped'",
  },
  {
    label: 'workflow: drop always() from the alert condition',
    subject: 'workflow',
    guard: 'spec',
    anchor: 'always() &&\n      github.event_name',
    replacement: 'github.event_name',
  },
  {
    label: 'workflow: the branch checkout ignores matrix.ref (both legs would probe main)',
    subject: 'workflow',
    guard: 'spec',
    anchor: '          ref: ${{ matrix.ref }}\n          path: target\n',
    replacement: '          path: target\n',
  },
  {
    label: 'workflow: the integration/v2 leg stops naming the OSV allowlist',
    subject: 'workflow',
    guard: 'spec',
    anchor: 'security/npm-audit-allowlist.json,security/osv-allowlist.json',
    replacement: 'security/npm-audit-allowlist.json',
  },
  {
    label: 'workflow: the probe is not pointed at the checked-out branch (ALLOWLIST_ROOT)',
    subject: 'workflow',
    guard: 'spec',
    anchor: '          ALLOWLIST_ROOT: target\n',
    replacement: '\n',
  },
  {
    label: 'workflow: the probe ignores the per-leg file list',
    subject: 'workflow',
    guard: 'spec',
    anchor: '          ALLOWLIST_FILES: ${{ matrix.files }}\n',
    replacement: '\n',
  },
  {
    label: 'lib: a prerelease of the patched version counts as patched',
    subject: 'lib',
    guard: 'spec',
    anchor: 'return Number(!pre(a)) - Number(!pre(b));',
    replacement: 'return 0;',
  },
  {
    label: 'lib: the newest-stable pick accepts prereleases',
    subject: 'lib',
    guard: 'spec',
    anchor: 'if (!STABLE.test(String(v))) continue;',
    replacement: '',
  },
  {
    label: 'lib: a vendored patch is informational instead of red',
    subject: 'lib',
    guard: 'spec',
    anchor: "if (vc.level === 'RETIRE') level = 'RETIRE';",
    replacement: "if (vc.level === 'NEVER') level = 'RETIRE';",
  },
  {
    label: 'lib: an unpatched vendored copy is flagged red',
    subject: 'lib',
    guard: 'spec',
    anchor: "level: 'INFO',\n    reasons: [`vendored patch not available",
    replacement: "level: 'RETIRE',\n    reasons: [`vendored patch not available",
  },
  {
    label: 'lib: a vendoredIn entry with no resolver is skipped instead of an error',
    subject: 'lib',
    guard: 'spec',
    anchor:
      "if (!resolveVendored)\n          throw new Error('entry declares vendoredIn but no vendored resolver was supplied');",
    replacement: 'if (!resolveVendored) continue;',
  },
  {
    label: 'lib: a malformed vendoredIn path (..) is accepted',
    subject: 'lib',
    guard: 'spec',
    anchor: "v.path.split('/').some((seg) => seg === '..' || seg === '')",
    replacement: 'false',
  },
  {
    label: 'cli: the tarball integrity check is skipped',
    subject: 'cli',
    guard: 'spec',
    anchor: 'if (actual !== expected)',
    replacement: 'if (false)',
  },
  {
    label: 'cli: a tarball URL off the registry host is fetched',
    subject: 'cli',
    guard: 'spec',
    anchor: "if (tarUrl.protocol !== 'https:' || tarUrl.host !== new URL(REGISTRY).host) {",
    replacement: 'if (false) {',
  },
  {
    label: 'cli: the vendored retry bound is effectively removed',
    subject: 'cli',
    guard: 'spec',
    anchor: 'attempt <= MAX_RETRIES; attempt++',
    replacement: 'attempt <= MAX_RETRIES + 100; attempt++',
  },
  {
    label: 'cli: a missing vendored file in the tarball is tolerated',
    subject: 'cli',
    guard: 'spec',
    anchor: 'if (file === null)',
    replacement: 'if (false)',
  },
];

declareMutations(33);
if (MUTATIONS.length !== 33) {
  console.error(`FATAL: declared 33 mutations, table has ${MUTATIONS.length}`);
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
