#!/usr/bin/env node
/**
 * Mutation proof for the allowlist $schema-note invariant (TD-S12-1a), guarded by
 * `tests/allowlist-schema-note-invariant.test.ts`. Each mutation edits a note so that it names a stale
 * key, or stops saying `expires` is REQUIRED; the spec must go RED. Anchors occur exactly once (abort
 * otherwise), restoration is content-addressed, verdicts are by exit code.
 *
 * Usage: node scripts/mutation-prove-s13-5-allowlist-note.mjs
 */

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSpecRunner } from './lib/ci-blocking-gate-proof.mjs';
import { mutate, restore, snapshot } from './lib/mutation-harness.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = 'tests/allowlist-schema-note-invariant.test.ts';
const PROOF = {
  subjects: {
    npmNote: 'security/npm-audit-allowlist.json',
    osvNote: 'security/osv-allowlist.json',
    checker: 'tests/allowlist-schema-note-invariant.test.ts',
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
    label: 'the npm note names a stale extra key (`note`) the validator does not accept',
    subject: 'npmNote',
    anchor: '`added` (ISO date it was accepted)',
    replacement: '`added` (ISO date it was accepted) and `note`',
  },
  {
    label: 'the npm note says `expires` is "not REQUIRED" (the REQUIRED word is still there)',
    subject: 'npmNote',
    anchor: '`expires` (strict YYYY-MM-DD, REQUIRED:',
    replacement: '`expires` is not REQUIRED (strict YYYY-MM-DD, REQUIRED:',
  },
  {
    label: 'the osv note names a stale extra key (`note`) the validator does not accept',
    subject: 'osvNote',
    anchor: '`expires` (ISO date, REQUIRED, at most',
    replacement: '`expires` (ISO date, REQUIRED, at most 180 days; `note` is also fine, at most',
  },
  {
    label: 'the osv note drops REQUIRED from the expires sentence (it becomes optional)',
    subject: 'osvNote',
    anchor: '`expires` (ISO date, REQUIRED, at most',
    replacement: '`expires` (ISO date, is optional, at most',
  },
  {
    label: 'the npm note says `expires` is "no longer REQUIRED" (a negation the old check missed)',
    subject: 'npmNote',
    anchor: '`expires` (strict YYYY-MM-DD, REQUIRED:',
    replacement: '`expires` is no longer REQUIRED (strict YYYY-MM-DD, REQUIRED:',
  },
  {
    label: "the osv note says `expires` isn't REQUIRED (a contraction the old check missed)",
    subject: 'osvNote',
    anchor: '`expires` (ISO date, REQUIRED, at most',
    replacement: "`expires` (ISO date, isn't REQUIRED, at most",
  },
  {
    label: "ROUND 2 item 4: the negation branch never flags \"not REQUIRED\" (the checker returns undefined)",
    subject: 'checker',
    anchor: "    return '`expires` is said to be negated before REQUIRED';",
    replacement: "    return undefined;",
  },
  {
    label: "ROUND 2 item 4: the old window regex is back (it flags \"not blank, REQUIRED\" and \"not optional, REQUIRED\")",
    subject: 'checker',
    anchor: "    /`expires`[^.]*\\b(?:(?:is|are)\\s+)?(?:not|no\\s+longer|never|isn['’]t)\\s+(?:really\\s+)?REQUIRED\\b/i.test(",
    replacement: "    /`expires`[^.]*\\b(?:not|no longer|isn['’]t|never|optional)\\b(?:[^\\w.]+\\w+){0,3}?[^\\w.]+REQUIRED\\b/i.test(",
  },
  {
    label: "ROUND 2 item 4: the \"is optional\" predicate check is removed",
    subject: 'checker',
    anchor: "  if (/`expires`[^.]*\\bis optional\\b/i.test(note)) return '`expires` is said to be optional';",
    replacement: "  if (false) return '`expires` is said to be optional';",
  },
];

const DECLARED = 9;
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
