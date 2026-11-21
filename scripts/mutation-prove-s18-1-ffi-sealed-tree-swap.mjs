#!/usr/bin/env node
/**
 * Mutation proof for the in-process Rust loader's defence against a whole-tree
 * swap (TD-S17-close-1, ADR-0069 Amendment 1).
 *
 * An attacker who can write the parent of the executable's directory can rename
 * the whole tree between the loader's by-path steps. The tree they swap in
 * carries their own integrity manifest and a link to a root-owned library, and
 * they put the real tree back before the directories are judged, so every check
 * passed and any library root owns loaded. The loader now judges the manifest
 * like the library (on the descriptor each was opened as), opens both without
 * following a link, pins the directories before the manifest is read and looks
 * at them again after the library is hashed. Each row below removes one of those
 * and ffi-loader.test.ts (a real library, the attacker's tree renamed in at the
 * moment the loader reaches for the manifest) must go red:
 *
 *   L01  the manifest is no longer judged        -> the swapped-in manifest passes
 *   L02  the library is no longer judged         -> any owner passes
 *   L03  the library is opened following links   -> a link to a root-owned file loads
 *   L04  the manifest is opened following links  -> the same, for the manifest
 *   L05  a platform with no O_NOFOLLOW is let through (the flag ORs in as 0)
 *   L06  a dangling link reads as "nothing staged" -> the unchecked development build
 *   L07  the directories are not looked at again -> a tree swapped in and left passes
 *   L08  they are looked at, but only for existence
 *   L09  they are pinned late, at the second look, not before the manifest is read
 *   L10  the "no integrity manifest" refusal is lost
 *
 * Verdicts are by EXIT CODE only (scripts/lib/guard-prover.mjs never parses
 * output), every anchor must occur exactly once (preflight first), the baseline
 * must be green, a canary must go red before any green is trusted, and every
 * restore is content-verified. The loader spec needs a system `cc`. Every
 * replacement is a whole line, so the harness's residue marker never comments
 * out the rest of an emitted statement.
 *
 * What this does not prove: the kind and musl lanes, which load the same
 * generated module from a root-owned tree on a real Alpine image (they need
 * docker and root); and that closing the swap is complete. The directories are
 * looked up by path, so a tree put back before the second look is not seen
 * (nothing is lost: see the ADR). Rows L03 and L04 are each proved by their own
 * test; neither is hidden behind another layer.
 *
 * Usage:  node scripts/mutation-prove-s18-1-ffi-sealed-tree-swap.mjs
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGuardProver } from './lib/guard-prover.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const OPEN = '    return $openSync(path, $constants.O_RDONLY | nofollow);\n';
const UNCHANGED = '    $unchanged(path, pins);\n';

const LOADER = [
  {
    id: 'L01',
    subject: 'render',
    claim: 'the integrity manifest is no longer judged by owner and mode',
    anchor: '    $judge(path, manifest, $fstatSync(mfd, { bigint: true }));\n',
    replacement: '    $fstatSync(mfd, { bigint: true });\n',
  },
  {
    id: 'L02',
    subject: 'render',
    claim: 'the library is no longer judged on the descriptor it is hashed through',
    anchor: '    $judge(path, path, $fstatSync(fd, { bigint: true }));\n',
    replacement: '    $fstatSync(fd, { bigint: true });\n',
  },
  {
    id: 'L03',
    subject: 'render',
    claim: 'the library is opened following links (a link to a root-owned file loads)',
    anchor: OPEN,
    replacement: `    return $openSync(path, what === 'the library' ? $constants.O_RDONLY : $constants.O_RDONLY | nofollow);\n`,
  },
  {
    id: 'L04',
    subject: 'render',
    claim: 'the integrity manifest is opened following links',
    anchor: OPEN,
    replacement: `    return $openSync(path, what === 'the integrity manifest' ? $constants.O_RDONLY : $constants.O_RDONLY | nofollow);\n`,
  },
  {
    id: 'L05',
    subject: 'render',
    claim: 'a platform with no O_NOFOLLOW is let through: the missing flag ORs in as 0',
    anchor: "  if (typeof nofollow !== 'number') {\n",
    replacement: '  if (false as boolean) {\n',
  },
  {
    id: 'L06',
    subject: 'render',
    claim:
      'a dangling link at the staged path reads as nothing staged and falls through to the development build',
    anchor: '  if ($lstatSync(staged, { throwIfNoEntry: false }) !== undefined) {\n',
    replacement: '  if ($existsSync(staged)) {\n',
  },
  {
    id: 'L07',
    subject: 'render',
    claim: 'the directories are never looked at again after the library is hashed',
    anchor: UNCHANGED,
    replacement: '\n',
  },
  {
    id: 'L08',
    subject: 'render',
    claim: 'the second look checks that a directory exists, not that it is the one that was judged',
    anchor: '    if (now === undefined || $id(now) !== id) {\n',
    replacement: '    if (now === undefined) {\n',
  },
  {
    id: 'L09',
    subject: 'render',
    claim: 'the directories are pinned at the second look, not before the manifest is read',
    anchor: UNCHANGED,
    replacement: '    $unchanged(path, $sealed(native, rel, path));\n',
  },
  {
    id: 'L10',
    subject: 'render',
    claim: 'a missing integrity manifest is no longer refused with its own message',
    anchor: "    if (code === 'ENOENT') throw new FfiLoadError(missing);\n",
    replacement: '\n',
  },
];

// The subject is an inline literal, not a shared constant: the lane's
// subject-existence audit reads it from the createGuardProver call.
const loader = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: 'packages/ffi/src/__tests__/ffi-loader.test.ts',
  subjects: { render: 'packages/ffi/src/render.ts' },
});

console.log('=== mutation proof: the loader against a whole-tree swap (TD-S17-close-1) ===');
loader.preflight(LOADER);
declareMutations(LOADER.length);

console.log('\n=== the behaviour, against a real library (ffi-loader.test.ts) ===');
loader.baseline();
loader.proveCanSeeRed({
  subject: 'render',
  anchor: '  if (Number(st.uid) !== 0) {\n',
  replacement: '  if (Number(st.uid) === 12345) {\n',
});
for (const m of LOADER) {
  loader.run({ ...m, expect: 'red' });
  recordMutation();
}
loader.finish(LOADER.length);
