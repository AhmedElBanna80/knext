#!/usr/bin/env node
/**
 * Mutation proof for the mandatory, strictly parsed allowlist `expires`:
 *   - `tests/allowlist-strict-expires.test.ts` (every validator rejects
 *     2026-13-45, 2026-02-30, 9999-99-99, "", missing, a number)
 *
 * An unparseable `expires` reads as "never expires" (Invalid Date <= now is false;
 * a lexical compare passes 9999-99-99), so each guard below removes ONE half of the
 * check and the spec must go red. Shared harness: `mutate` aborts unless the anchor
 * occurs exactly once; judged on EXIT CODES, never grepped output.
 *
 * Usage:  node scripts/mutation-prove-allowlist-expires.mjs
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
    spec: 'tests/allowlist-strict-expires.test.ts',
    precompileSpec: 'tests/precompile-closure-audit.test.ts',
    shippedSpec: 'tests/shipped-scan.test.ts',
    strict: 'scripts/lib/strict-date.mjs',
    precompile: 'scripts/lib/precompile-closure.mjs',
    shipped: 'scripts/lib/shipped-scan.mjs',
    audit: 'scripts/audit-published.mjs',
    osv: 'scripts/lib/osv-gate.mjs',
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
    label: 'strict: drop the calendar round-trip (2026-02-30 is accepted)',
    subject: 'strict',
    guard: 'spec',
    anchor: 'if (new Date(ms).toISOString().slice(0, 10) !== value) return null;',
    replacement: 'if (false) return null;',
  },
  {
    label: 'strict: drop the finite check (2026-13-45 is accepted as NaN)',
    subject: 'strict',
    guard: 'spec',
    anchor: 'if (!Number.isFinite(ms)) return null;',
    replacement: 'if (false) return null;',
  },
  {
    label: 'strict: expiresBefore compares strings',
    subject: 'strict',
    guard: 'spec',
    anchor:
      "return requireStrictIsoDate(expires, 'expires') < requireStrictIsoDate(today, 'today');",
    replacement: 'return String(expires) < String(today);',
  },
  {
    label: 'precompile: expires is optional again',
    subject: 'precompile',
    guard: 'spec',
    anchor: 'if (expiresMs === null) {',
    replacement: 'if (expiresMs === null && entry.expires !== undefined && false) {',
  },
  {
    label: 'precompile: an impossible expires reads as never-expiring (no strict parse)',
    subject: 'precompile',
    guard: 'spec',
    anchor: 'const expiresMs = parseStrictIsoDate(entry.expires);',
    replacement:
      "const expiresMs = /^\\d{4}-\\d{2}-\\d{2}$/.test(entry.expires ?? '') ? Date.parse(entry.expires) : null;",
  },
  {
    label: 'precompile: the expiry never lapses',
    subject: 'precompile',
    guard: 'precompileSpec',
    anchor: 'if (expiresMs <= now.getTime()) {',
    replacement: 'if (false) {',
  },
  {
    label: 'npm-audit: assertAllowlistExpires accepts anything',
    subject: 'shipped',
    guard: 'spec',
    anchor: 'if (parseStrictIsoDate(e.expires) === null) {',
    replacement: 'if (false) {',
  },
  {
    label: 'npm-audit: loadNpmAllowlist never lapses an expired entry',
    subject: 'shipped',
    guard: 'shippedSpec',
    anchor: 'if (expiresBefore(e.expires, today)) continue;',
    replacement: 'if (false) continue;',
  },
  {
    label: 'audit-published: skips the expires rule',
    subject: 'audit',
    guard: 'spec',
    anchor: '      assertAllowlistExpires(entry);',
    replacement: '      void entry;',
  },
  {
    label: 'audit-published: lexical expiry compare',
    subject: 'audit',
    guard: 'spec',
    anchor: 'if (expiresBefore(entry.expires, today)) {',
    replacement: 'if (entry.expires < today) {',
  },
  {
    label: 'osv: expires is not strictly parsed',
    subject: 'osv',
    guard: 'spec',
    anchor: 'parseStrictIsoDate(e.expires) === null',
    replacement: "typeof e.expires !== 'string'",
  },
  {
    label: 'osv: added is not strictly parsed',
    subject: 'osv',
    guard: 'spec',
    anchor: 'parseStrictIsoDate(e.added) === null',
    replacement: "typeof e.added !== 'string'",
  },
  {
    label: 'osv: the 180-day window is removed',
    subject: 'osv',
    guard: 'spec',
    anchor: 'if (span > MAX_ALLOW_DAYS) {',
    replacement: 'if (false) {',
  },
];

declareMutations(13);
if (MUTATIONS.length !== 13) {
  console.error(`FATAL: declared 13 mutations, table has ${MUTATIONS.length}`);
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
