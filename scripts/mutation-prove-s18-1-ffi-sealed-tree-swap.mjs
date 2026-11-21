#!/usr/bin/env node
/**
 * Mutation proof for the in-process Rust loader's defence against a whole-tree
 * swap (TD-S17-close-1, ADR-0069 Amendment 1).
 *
 * An attacker who can write a directory above the executable's can rename the
 * whole tree between the loader's by-path steps. The tree they swap in carries
 * their own integrity manifest and a link to a root-owned library, and they put
 * the real tree back before the directories are judged, so every check passed
 * and any library root owns loaded. The loader now:
 *   - walks every directory from the library up to / and requires each to be a
 *     real directory (lstat), root's, and closed to group and other, so a user
 *     who is not root cannot rename any of them (the primary fix);
 *   - and, as defence in depth, judges the manifest like the library (on the
 *     descriptor each was opened as), opens both without following a link and
 *     without blocking, accepts only regular files, pins the directories
 *     (dev:ino as bigint) before the manifest is read and looks at them again
 *     after the library is hashed, and checks the two paths still name the
 *     files that were read.
 * Each row below removes one of those and ffi-loader.test.ts (a real library,
 * the attacker's tree renamed in at the moment the loader reaches for the
 * manifest) must go red:
 *
 *   Files
 *   L01  the manifest is no longer judged              L02  the library is no longer judged
 *   L03  the library is opened following links         L04  the manifest is opened following links
 *   L05  O_NOFOLLOW only checked to be a number (0 passes)
 *   L06  O_NONBLOCK is no longer required              L07  O_NOFOLLOW is no longer required
 *   L08  a dangling link reads as "nothing staged"     L09  the "no manifest" refusal is lost
 *   F01  the open no longer asks for O_NONBLOCK (a FIFO blocks the call for ever)
 *   F02  anything that is not a regular file is read
 *   Directories
 *   W01  the ancestors above the exec's directory are never walked
 *   W02  the walk stops one short of /                 W03  the ancestors are not judged
 *   W04  a sticky world-writable ancestor (a /tmp) is let through
 *   W05  the directories are stat-ed, not lstat-ed (a link is followed)
 *   W06  a link at a pinned directory is not refused   H01  a link in the way to the exec is not resolved
 *   Second look
 *   S01  the directories are not looked at again       S02  the second look uses stat, not lstat
 *   S03  the second look checks existence, not identity
 *   S04  the manifest's path is not checked again      S05  the library's path is not checked again
 *   S06  the second look on a file checks existence, not identity
 *   Ids
 *   B01  the pin is taken as Numbers                   B02  the second look is taken as Numbers
 *   B03  ids are compared as Numbers (2^53 collides)
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
 * docker and root); and that nothing but root can touch a tree whose every
 * ancestor is root's, which is the permission model, not something a test of
 * this module can show. The defence-in-depth rows are proved by renaming trees
 * the way an actor who is not stopped by the walk (root, a mount) would.
 *
 * Usage:  node scripts/mutation-prove-s18-1-ffi-sealed-tree-swap.mjs
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGuardProver } from './lib/guard-prover.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const OPEN = '    fd = $openSync(path, $constants.O_RDONLY | nofollow | nonblock);\n';
const FLAGS = '  if (!(nofollow > 0) || !(nonblock > 0)) {\n';
const UNCHANGED = '    $unchanged(path, pins);\n';
const SEALED_LSTAT = '    const st = $lstatSync(dir, { bigint: true });\n';
const UNCHANGED_LSTAT =
  '    const now = $lstatSync(dir, { bigint: true, throwIfNoEntry: false });\n';
const ID = '  return \\`\\${st.dev}:\\${st.ino}\\`;\n';

const LOADER = [
  {
    id: 'L01',
    subject: 'render',
    claim: 'the integrity manifest is no longer judged by owner and mode',
    anchor: '    $judge(path, manifest, m.st, false);\n',
    replacement: '\n',
  },
  {
    id: 'L02',
    subject: 'render',
    claim: 'the library is no longer judged on the descriptor it is hashed through',
    anchor: '    $judge(path, path, lib.st, false);\n',
    replacement: '\n',
  },
  {
    id: 'L03',
    subject: 'render',
    claim: 'the library is opened following links (a link to a root-owned file loads)',
    anchor: OPEN,
    replacement:
      "    fd = $openSync(path, what === 'the library' ? $constants.O_RDONLY | nonblock : $constants.O_RDONLY | nofollow | nonblock);\n",
  },
  {
    id: 'L04',
    subject: 'render',
    claim: 'the integrity manifest is opened following links',
    anchor: OPEN,
    replacement:
      "    fd = $openSync(path, what === 'the integrity manifest' ? $constants.O_RDONLY | nonblock : $constants.O_RDONLY | nofollow | nonblock);\n",
  },
  {
    id: 'L05',
    subject: 'render',
    claim:
      'O_NOFOLLOW is only checked to be a number: a zero flag ORs in as nothing and links are followed',
    anchor: FLAGS,
    replacement: "  if (typeof nofollow !== 'number' || !(nonblock > 0)) {\n",
  },
  {
    id: 'L06',
    subject: 'render',
    claim: 'a platform with no O_NONBLOCK is let through',
    anchor: FLAGS,
    replacement: '  if (!(nofollow > 0)) {\n',
  },
  {
    id: 'L07',
    subject: 'render',
    claim: 'a platform with no O_NOFOLLOW is let through',
    anchor: FLAGS,
    replacement: '  if (!(nonblock > 0)) {\n',
  },
  {
    id: 'L08',
    subject: 'render',
    claim:
      'a dangling link at the staged path reads as nothing staged and falls through to the development build',
    anchor: '  if ($lstatSync(staged, { bigint: true, throwIfNoEntry: false }) !== undefined) {\n',
    replacement: '  if ($existsSync(staged)) {\n',
  },
  {
    id: 'L09',
    subject: 'render',
    claim: 'a missing integrity manifest is no longer refused with its own message',
    anchor: "    if (code === 'ENOENT') throw new FfiLoadError(missing);\n",
    replacement: '\n',
  },
  {
    id: 'F01',
    subject: 'render',
    claim:
      'the open does not ask for O_NONBLOCK: a FIFO at the manifest or the library blocks the first call for ever',
    anchor: OPEN,
    replacement: '    fd = $openSync(path, $constants.O_RDONLY | nofollow);\n',
  },
  {
    id: 'F02',
    subject: 'render',
    claim: 'anything that is not a regular file (a FIFO, a directory) is read',
    anchor: '  if ($type(st) !== $constants.S_IFREG) {\n',
    replacement: '  if (false as boolean) {\n',
  },
  {
    id: 'W01',
    subject: 'render',
    claim: 'the directories above the one native/ sits in are never walked',
    anchor: '  dirs.push(...$upTo($dirname(native)));\n',
    replacement: '  dirs.push($dirname(native));\n',
  },
  {
    id: 'W02',
    subject: 'render',
    claim: 'the walk stops one short of the root directory',
    anchor: '    if ($dirname(d) === d) return out;\n',
    replacement: "    if ($dirname(d) === '/') return out;\n",
  },
  {
    id: 'W03',
    subject: 'render',
    claim: 'the directories are looked at but not judged by owner and mode',
    anchor: '    $judge(path, dir, st, true);\n',
    replacement: '\n',
  },
  {
    id: 'W04',
    subject: 'render',
    claim:
      'a sticky, world-writable directory (a /tmp) is let through: sticky stops deleting, not renaming a directory you can write',
    anchor: '  } else if ((bits & 0o022) !== 0) {\n',
    replacement: '  } else if ((bits & 0o022) !== 0 && (bits & 0o1000) === 0) {\n',
  },
  {
    id: 'W05',
    subject: 'render',
    claim:
      'the directories are stat-ed, so a link at one is followed and its target is what is judged',
    anchor: SEALED_LSTAT,
    replacement: '    const st = $statSync(dir, { bigint: true });\n',
  },
  {
    id: 'W06',
    subject: 'render',
    claim: 'a directory that is a link (or anything but a directory) is not refused',
    anchor: '    if ($type(st) !== $constants.S_IFDIR) {\n',
    replacement: '    if (false as boolean) {\n',
  },
  {
    id: 'H01',
    subject: 'render',
    claim:
      'a link in the path to the executable is not resolved: the directories judged are not the ones the lookups go through',
    anchor: '    return $realpathSync(dir);\n',
    replacement: '    return dir;\n',
  },
  {
    id: 'S01',
    subject: 'render',
    claim: 'the directories are never looked at again after the library is hashed',
    anchor: UNCHANGED,
    replacement: '\n',
  },
  {
    id: 'S02',
    subject: 'render',
    claim:
      'the second look uses stat: a directory replaced by a link to itself is the same dev:ino and passes',
    anchor: UNCHANGED_LSTAT,
    replacement: '    const now = $statSync(dir, { bigint: true, throwIfNoEntry: false });\n',
  },
  {
    id: 'S03',
    subject: 'render',
    claim: 'the second look checks that a directory exists, not that it is the one that was judged',
    anchor: '    if (now === undefined || $id(now) !== id) {\n',
    replacement: '    if (now === undefined) {\n',
  },
  {
    id: 'S04',
    subject: 'render',
    claim:
      "the manifest's path is not checked again: a file renamed over it after it was read goes unseen",
    anchor: '    $same(path, manifest, $id(m.st));\n',
    replacement: '\n',
  },
  {
    id: 'S05',
    subject: 'render',
    claim:
      "the library's path is not checked again: a file renamed over it after it was hashed goes unseen",
    anchor: '    $same(path, path, $id(lib.st));\n',
    replacement: '\n',
  },
  {
    id: 'S06',
    subject: 'render',
    claim: 'the second look at a file checks that it exists, not that it is the file that was read',
    anchor: '\n  if (now === undefined || $id(now) !== id) {\n',
    replacement: '\n  if (now === undefined) {\n',
  },
  {
    id: 'B01',
    subject: 'render',
    claim: 'the pin is asked for as a Number: dev:ino above 2^53 collides',
    anchor: SEALED_LSTAT,
    replacement: '    const st = $lstatSync(dir);\n',
  },
  {
    id: 'B02',
    subject: 'render',
    claim: 'the second look is asked for as a Number',
    anchor: UNCHANGED_LSTAT,
    replacement: '    const now = $lstatSync(dir, { throwIfNoEntry: false });\n',
  },
  {
    id: 'B03',
    subject: 'render',
    claim: 'ids are compared as Numbers: two inodes that differ only above 2^53 are one directory',
    anchor: ID,
    replacement: '  return \\`\\${Number(st.dev)}:\\${Number(st.ino)}\\`;\n',
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
