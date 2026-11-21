#!/usr/bin/env node
/**
 * Mutation proof for the sharp shim's native-payload classifier.
 *
 * `isNativePayload` decides which manifest entries the shim hashes before
 * `dlopen`. The real libvips file is `libvips-cpp.so.8.18.6`; a classifier that
 * only knew `.so.<one number>` silently skipped it, so the largest native
 * payload was never verified. Each mutation below puts a narrower or wider
 * classifier back and the spec must notice.
 *
 * DISCIPLINE (`.claude/rules/workflow.md`): exit codes only; green baseline; a
 * canary red first; anchors exactly once or abort; clean tree between mutations.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGuardProver } from './lib/guard-prover.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = 'packages/kn-next/src/__tests__/sharp-native-payload.test.ts';
const ANCHOR = String.raw`  return /\.(node|dylib)$|\.so(\.[0-9]+)*$/.test(file);`;

const MUTATIONS = [
  {
    id: 'M1',
    expect: 'red',
    claim:
      'the classifier reverts to the old single-number soname, so libvips-cpp.so.8.18.6 is never hashed',
    subject: 'shim',
    anchor: ANCHOR,
    replacement: String.raw`  return /\.(node|dylib|so)$|\.so\.[0-9]+$/.test(file);`,
  },
  {
    id: 'M2',
    expect: 'red',
    claim:
      'the soname suffix accepts only exactly two numeric parts, dropping libfoo.so.1.2 or libx.so.42',
    subject: 'shim',
    anchor: ANCHOR,
    replacement: String.raw`  return /\.(node|dylib)$|\.so(\.[0-9]+){2}$/.test(file);`,
  },
  {
    id: 'M3',
    expect: 'red',
    claim: 'the classifier goes wide (any .so. suffix), so foo.so.txt counts as native',
    subject: 'shim',
    anchor: ANCHOR,
    replacement: String.raw`  return /\.(node|dylib)$|\.so(\..*)?$/.test(file);`,
  },
  {
    id: 'M4',
    expect: 'red',
    claim: 'the classifier is never true, so no payload is ever verified',
    subject: 'shim',
    anchor: ANCHOR,
    replacement: '  return false;',
  },
];

const prover = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: SPEC,
  subjects: { shim: 'packages/kn-next/src/adapters/sharp-addon-dlopen.mjs' },
});

console.log(`=== mutation proof: ${SPEC} (sharp native-payload classifier) ===`);
prover.preflight(MUTATIONS);
declareMutations(MUTATIONS.length);
prover.baseline();

prover.proveCanSeeRed({
  subject: 'shim',
  anchor: ANCHOR,
  replacement: '  return false;',
});

console.log('\n=== mutations ===');
for (const m of MUTATIONS) {
  prover.run(m);
  recordMutation();
}

prover.finish(MUTATIONS.length);
