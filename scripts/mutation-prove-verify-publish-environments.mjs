#!/usr/bin/env node
/**
 * Mutation proof for scripts/verify-publish-environments.mjs (#2035).
 *
 * Every mutation plants one defect in the verifier and asserts that
 * tests/publish-environments-verify.test.ts goes RED. The shared guard-prover
 * driver owns the ceremony (green baseline, canary, clean tree between
 * mutations, exit-code verdicts, runner resolution); this file owns the
 * mutation table and declares its count for the prover lane.
 *
 * DISCIPLINE (`.claude/rules/workflow.md`): exit codes only; green baseline;
 * a canary red first; anchors exactly once or abort; clean tree between
 * mutations.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGuardProver } from './lib/guard-prover.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FILE = 'scripts/verify-publish-environments.mjs';
const SPEC = 'tests/publish-environments-verify.test.ts';

// Every replacement here is a same-line expression. A `//` residue marker would
// comment out the rest of the line, so the marker is a block comment instead.
const INLINE = { commentPrefix: '/*' };

const MUTATIONS = [
  {
    id: 'M1',
    expect: 'red',
    claim: 'reviewer rule no longer required: the verifier must fail closed on it',
    subject: 'script',
    anchor: 'if (!rule) {',
    replacement: 'if (false) {',
    options: INLINE,
  },
  {
    id: 'M2',
    expect: 'red',
    claim: 'custom-policy check dropped: the verifier must fail closed on it',
    subject: 'script',
    anchor: 'custom_branch_policies !== true',
    replacement: 'custom_branch_policies === 7',
    options: INLINE,
  },
  {
    id: 'M3',
    expect: 'red',
    claim: 'glob not flagged: the verifier must fail closed on it',
    subject: 'script',
    anchor: 'if (/[*?[\\]]/.test(p.name)) problems.push(`${name}: glob',
    replacement: 'if (false) problems.push(`${name}: glob',
    options: INLINE,
  },
  {
    id: 'M4',
    expect: 'red',
    claim: 'missing lane not flagged: the verifier must fail closed on it',
    subject: 'script',
    anchor: 'if (!names.includes(want))',
    replacement: 'if (false)',
    options: INLINE,
  },
  {
    id: 'M5',
    expect: 'red',
    claim: 'extra branch not flagged: the verifier must fail closed on it',
    subject: 'script',
    anchor: 'if (!EXPECTED.includes(got) &&',
    replacement: 'if (false &&',
    options: INLINE,
  },
  {
    id: 'M6',
    expect: 'red',
    claim: 'non-branch type not flagged: the verifier must fail closed on it',
    subject: 'script',
    anchor: "if (p.type !== 'branch')",
    replacement: 'if (false)',
    options: INLINE,
  },
  {
    id: 'M7',
    expect: 'red',
    claim: 'absent policy type fails open: the verifier must fail closed on it',
    subject: 'script',
    anchor: "if (p.type !== 'branch')",
    replacement: "if (p.type && p.type !== 'branch')",
    options: INLINE,
  },
  {
    id: 'M8',
    expect: 'red',
    claim:
      'API error swallowed instead of rethrown (policies): the verifier must fail closed on it',
    subject: 'script',
    anchor: 'if (!/Not Found|404/.test(String(err.stderr ?? err.message))) throw err;',
    replacement: 'void 0;',
    options: INLINE,
  },
  {
    id: 'M9',
    expect: 'red',
    claim: 'team reviewer not flagged: the verifier must fail closed on it',
    subject: 'script',
    anchor: "rs.some((x) => x.type === 'Team')",
    replacement: 'false',
    options: INLINE,
  },
  {
    id: 'M10',
    expect: 'red',
    claim: 'non-user reviewer not flagged: the verifier must fail closed on it',
    subject: 'script',
    anchor: "!rs.some((x) => x.type === 'User')",
    replacement: 'false',
    options: INLINE,
  },
  {
    id: 'M11',
    expect: 'red',
    claim: 'missing NPM_TOKEN not flagged: the verifier must fail closed on it',
    subject: 'script',
    anchor: "!sec.includes('NPM_TOKEN')",
    replacement: 'false',
    options: INLINE,
  },
  {
    id: 'M12',
    expect: 'red',
    claim: 'absent env not flagged: the verifier must fail closed on it',
    subject: 'script',
    anchor: 'if (!e) {',
    replacement: 'if (false) {',
    options: INLINE,
  },
];

const prover = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: SPEC,
  subjects: { script: FILE },
});

console.log(`=== mutation proof: ${FILE} (#2035 publish-environments verifier) ===`);
prover.preflight(MUTATIONS);
declareMutations(MUTATIONS.length);
prover.baseline();

prover.proveCanSeeRed({
  subject: 'script',
  anchor: 'if (!rule) {',
  replacement: 'if (false) {',
  options: INLINE,
});

console.log('\n=== mutations ===');
for (const m of MUTATIONS) {
  prover.run(m);
  recordMutation();
}

prover.finish(MUTATIONS.length);
