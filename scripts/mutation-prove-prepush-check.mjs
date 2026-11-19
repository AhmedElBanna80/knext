#!/usr/bin/env node
/**
 * Mutation prover for `scripts/prepush-check.mjs` and its lib.
 *
 * The guard is `tests/prepush-check.test.ts`. Each row plants one regression and
 * requires the guard to go RED, by exit code:
 *
 *   P1  allowlist detection starts matching nested directories.
 *   P2  gate discovery stops skipping the mutation provers.
 *   P3  a reader of the allowlist with no invocation is silently dropped.
 *   P4  the leak snapshot diff reports nothing.
 *   P5  the static scan ignores each file's baseline.
 *   P6  the static scan looks beyond tests/**.
 *   P7  `**` stops crossing directories.
 *   P8  the out-of-scope filter inverts.
 *   C1  a non-zero gate exit stops failing.
 *   C2  a missing gate tool is downgraded to a warning without the flag.
 *   C3  a tmpdir leak stops failing.
 *   C4  a repo-root leak stops failing.
 *   C5  an unknown reader stops failing.
 *   C6  an out-of-scope file stops failing.
 *   C7  the static scan finding stops failing.
 *   C8  an undeclared scope starts failing instead of warning.
 *   N1  negative control: a heading changes.
 *
 *   node scripts/mutation-prove-prepush-check.mjs
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGuardProver } from './lib/guard-prover.mjs';
import { MUTATION_MARKER } from './lib/mutation-harness.mjs';
import { jsStillParses } from './lib/parse-validity.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = 'tests/prepush-check.test.ts';

const MUTATIONS = [
  {
    id: 'P1',
    claim: 'allowlist detection matches nested directories',
    subject: 'lib',
    anchor: 'export const ALLOWLIST_RE = /^security\\/[^/]*allowlist[^/]*\\.json$/;',
    replacement: 'export const ALLOWLIST_RE = /^security\\/.*allowlist.*\\.json$/;',
  },
  {
    id: 'P2',
    claim: 'gate discovery stops skipping the mutation provers',
    subject: 'lib',
    anchor: "f.endsWith('.mjs') && !f.startsWith('mutation-prove-')",
    replacement: "f.endsWith('.mjs')",
  },
  {
    id: 'P3',
    claim: 'a reader with no invocation is silently dropped',
    subject: 'lib',
    anchor: 'unknown.push({ allowlist, script });',
    replacement: 'void allowlist;',
  },
  {
    id: 'P4',
    claim: 'the leak snapshot diff reports nothing',
    subject: 'lib',
    anchor: 'return [...after].filter((e) => !was.has(e)).sort();',
    replacement:
      'return [...after].filter((e) => !was.has(e) && !was.has(e)).filter(() => false).sort();',
  },
  {
    id: 'P5',
    claim: 'the static scan ignores each file baseline',
    subject: 'lib',
    anchor: 'if (n > allowed) out.push',
    replacement: 'if (n > 0) out.push',
  },
  {
    id: 'P6',
    claim: 'the static scan looks beyond tests/**',
    subject: 'lib',
    anchor: "!f.startsWith('tests/') || ",
    replacement: '',
  },
  {
    id: 'P7',
    claim: '`**` stops crossing directories',
    subject: 'lib',
    anchor: "} else re += '.*';",
    replacement: "} else re += '[^/]*';",
  },
  {
    id: 'P8',
    claim: 'the out-of-scope filter inverts',
    subject: 'lib',
    anchor: 'files.filter((f) => !res.some((r) => r.test(f)))',
    replacement: 'files.filter((f) => res.some((r) => r.test(f)))',
  },
  {
    id: 'C1',
    claim: 'a non-zero gate exit stops failing',
    subject: 'cli',
    anchor: 'if (status !== 0) failures.push(`${label}: exit ${status}`);',
    replacement: 'if (status !== 0) warnings.push(`${label}: exit ${status}`);',
  },
  {
    id: 'C2',
    claim: 'a missing gate tool is a warning even without the flag',
    subject: 'cli',
    anchor: '(opts.allowMissingTools ? warnings : failures).push(msg);',
    replacement: 'warnings.push(msg);',
  },
  {
    id: 'C3',
    claim: 'a tmpdir leak stops failing',
    subject: 'cli',
    anchor: 'for (const e of leakedTmp) failures.push(',
    replacement: 'for (const e of leakedTmp) warnings.push(',
  },
  {
    id: 'C4',
    claim: 'a repo-root leak stops failing',
    subject: 'cli',
    anchor: 'for (const e of leakedRepo) failures.push(',
    replacement: 'for (const e of leakedRepo) warnings.push(',
  },
  {
    id: 'C5',
    claim: 'an unknown reader stops failing',
    subject: 'cli',
    anchor: 'for (const u of unknown) {\n      failures.push(',
    replacement: 'for (const u of unknown) {\n      warnings.push(',
  },
  {
    id: 'C6',
    claim: 'an out-of-scope file stops failing',
    subject: 'cli',
    anchor: 'for (const f of outOfScope(committed, globs)) failures.push(',
    replacement: 'for (const f of outOfScope(committed, globs)) warnings.push(',
  },
  {
    id: 'C7',
    claim: 'the static scan finding stops failing',
    subject: 'cli',
    anchor: 'for (const f of findings) {\n    failures.push(',
    replacement: 'for (const f of findings) {\n    warnings.push(',
  },
  {
    id: 'C8',
    claim: 'an undeclared scope fails instead of warning',
    subject: 'cli',
    anchor: "if (globs.length === 0) {\n    warnings.push(\n      'no scope declared",
    replacement: "if (globs.length === 0) {\n    failures.push(\n      'no scope declared",
  },
  {
    id: 'N1',
    expect: 'green',
    claim: 'negative control: a heading changes',
    subject: 'cli',
    anchor: "say('\\n=== 4. scope report ===');",
    replacement: "say('\\n=== 4. scope and area report ===');",
  },
].map((m) => ({
  expect: 'red',
  validate: jsStillParses,
  ...m,
  // A block comment, never the harness's default line comment: most anchors end
  // mid-line, and a trailing `//` marker would swallow the rest of the line.
  replacement: `${m.replacement} /* ${MUTATION_MARKER} */`,
}));

const CANARY = {
  subject: 'lib',
  anchor: 'export const changedAllowlists = (files) => files.filter((f) => ALLOWLIST_RE.test(f));',
  replacement: 'export const changedAllowlists = (files) => [];',
};

const prover = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: SPEC,
  subjects: { lib: 'scripts/lib/prepush-check.mjs', cli: 'scripts/prepush-check.mjs' },
});

console.log('=== mutation proof: prepush-check ===');
prover.preflight([...MUTATIONS, { id: 'canary', ...CANARY }]);
declareMutations(MUTATIONS.length);
prover.baseline();
prover.proveCanSeeRed(CANARY);
for (const m of MUTATIONS) {
  prover.run(m);
  recordMutation();
}
prover.finish(MUTATIONS.length);
