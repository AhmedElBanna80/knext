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
 *   L08  a dangling link reads as "nothing staged"
 *   L09  the "no manifest" refusal loses its own message (the load is still refused, by the
 *        generic open failure: only the message, and the test that pins it, change)
 *   F01  the open no longer asks for O_NONBLOCK (a FIFO blocks the call for ever)
 *   F02  anything that is not a regular file is read
 *   Directories
 *   W01  the ancestors above the exec's directory are never walked
 *   W02  the walk stops one short of /                 W03  the ancestors are not judged
 *   W04  a sticky world-writable ancestor (a /tmp) is let through
 *   W05  the directories are stat-ed, not lstat-ed (a link is followed)
 *   W06  a link at a pinned directory is not refused
 *   H01  a link at or above the executable's directory is not refused up front (its realpath is
 *        no longer compared): the lstat walk still stops the load, but with another message and
 *        after statting the tree; the loader tests build a real link to a good tree and require
 *        the up-front refusal before any directory is looked at
 *   Messages
 *   M01  the refusal prints the mode masked to 0777 (a sticky or setgid directory reads as plain)
 *   N01  only the first failing directory is listed
 *   D01  the directory refusal loses the build explanation (a copied tree keeps the host's mode)
 *   D02  the directory refusal carries the FILE hint (COPY --chown=0:0 --chmod=a-w)
 *   Advice (what the refusal tells the reader to do follows the directory)
 *   A01  a shared directory (above the executable, or sticky, or world-writable) is never told
 *        to move the install
 *   A02  only the position decides            A03  the position is off by one
 *   A04  the sticky bit is not looked at      A05  the world-write bit is not looked at
 *   A06  the fix-in-place advice is always given       A07  the move advice is always given
 *   Printing
 *   C01  a control character in a directory name is printed raw (a newline forges a list line)
 *   C02  a delete character is printed raw             C03  the list prints the raw name
 *   K01  an object that is not a directory or a link is called a link
 *   K02  such an object gets no advice of its own
 *   P01  a relative executable path is blamed on a link
 *   X01  the file refusal names two of the three commands that stage the Dockerfile
 *   X02  the unresolved-library refusal names one     X03  the missing-manifest refusal names two
 *   Second look
 *   S01  the directories are not looked at again       S02  the second look uses stat, not lstat
 *   S03  the second look checks existence, not identity
 *   S04  the manifest's path is not checked again      S05  the library's path is not checked again
 *   S06  the second look on a file checks existence, not identity
 *   Ids
 *   B01  the pin is taken as Numbers                   B02  the second look is taken as Numbers
 *   B03  ids are compared as Numbers (2^53 collides)
 *        (B01 and B02 are caught through the bigint-option spy: a test records every stat the
 *        loader makes and requires the bigint option on each; a collision test catches B03)
 *
 * Verdicts are by EXIT CODE only (scripts/lib/guard-prover.mjs never parses
 * output), every anchor must occur exactly once (preflight first), the baseline
 * must be green, a canary must go red before any green is trusted, and every
 * restore is content-verified. The loader spec needs a system `cc`. Every
 * replacement is a whole line, so the harness's residue marker (a comment line
 * before it) never comments out the rest of an emitted statement, except
 * the rows marked (fragment): D01, D02, A06, A07, P01 and X01 to X03 anchor a
 * piece of an emitted message or expression, and the harness appends its marker
 * after the replacement on the same line. Each of those is chosen so that the
 * fragment ends inside the string it sits in, where the marker is plain text.
 *
 * The harness for the real Rust library (crates/harness/ffi-generated.ts) is
 * proved separately, not here, because it needs cargo and root: W01, W02 and
 * W04 were applied to a copy of render.ts and the harness run against it in a
 * Linux container, and each turned it red (see the pull request).
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
    anchor: '    $judge(path, manifest, m.st);\n',
    replacement: '\n',
  },
  {
    id: 'L02',
    subject: 'render',
    claim: 'the library is no longer judged on the descriptor it is hashed through',
    anchor: '    $judge(path, path, lib.st);\n',
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
    claim:
      'a missing integrity manifest loses its own refusal message (it is still refused, by the generic open failure)',
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
    anchor: '  dirs.push(...up);\n',
    replacement: '  dirs.push(home);\n',
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
    anchor: '      bad.push(\\`\\${$show(dir)} \\${why}\\`);\n',
    replacement: '\n',
  },
  {
    id: 'W04',
    subject: 'render',
    claim:
      'a sticky, world-writable directory (a /tmp) is let through: the rule is the mode bits and nothing else, as OpenSSH StrictModes has it',
    anchor:
      '  if ((bits & 0o022) !== 0) return \\`is writable by its group or by everyone (mode \\${mode})\\`;\n',
    replacement:
      '  if ((bits & 0o022) !== 0 && (bits & 0o1000) === 0) return \\`is writable by its group or by everyone (mode \\${mode})\\`;\n',
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
    anchor: '    if (type !== $constants.S_IFDIR) {\n',
    replacement: '    if (false as boolean) {\n',
  },
  {
    id: 'H01',
    subject: 'render',
    claim:
      "a link at or above the executable's directory is not refused up front: the real path is no longer compared, so any refusal comes after the tree was statted, from the walk",
    anchor: '  if (real !== home) {\n',
    replacement: '  if (false as boolean) {\n',
  },
  {
    id: 'M01',
    subject: 'render',
    claim:
      'the mode in a refusal is masked to 0777: a sticky (1777) or setgid (2775) directory reads as a plain one',
    anchor: "  const mode = (bits & 0o7777).toString(8).padStart(4, '0');\n",
    replacement: "  const mode = (bits & 0o777).toString(8).padStart(4, '0');\n",
  },
  {
    id: 'N01',
    subject: 'render',
    claim: 'only the first failing directory is listed, so the reader fixes one and meets the next',
    anchor: '  if (bad.length > 0) {\n',
    replacement: '  if (bad.splice(1).length >= 0 && bad.length > 0) {\n',
  },
  {
    id: 'D01',
    subject: 'render',
    claim:
      "the directory refusal no longer says why a build needs the chmod (a directory inside a copied tree keeps the build host's mode)",
    anchor:
      " after the COPY that brought it in (a directory inside a copied tree keeps the build host's mode).",
    replacement: ' after the COPY that brought it in.',
  },
  {
    id: 'D02',
    subject: 'render',
    claim:
      'the directory refusal carries the file hint (COPY --chown=0:0 --chmod=a-w) instead of the directory one',
    anchor: 'own directory: run ',
    replacement: 'own directory: COPY --chown=0:0 --chmod=a-w it, or run ',
  },
  {
    id: 'A01',
    subject: 'render',
    claim:
      "a directory above the executable, or a sticky or world-writable one, is never told to move the install: it is offered chmod and chown like the app's own",
    anchor: '      if (i >= above || (Number(st.mode) & 0o1002) !== 0) move = true;\n',
    replacement: '      if (false as boolean) move = true;\n',
  },
  {
    id: 'A02',
    subject: 'render',
    claim:
      'a sticky or world-writable directory below the executable is offered chmod (only its position counts)',
    anchor: '      if (i >= above || (Number(st.mode) & 0o1002) !== 0) move = true;\n',
    replacement: '      if (i >= above) move = true;\n',
  },
  {
    id: 'A03',
    subject: 'render',
    claim:
      "the first directory above the executable is counted as the app's own (an off-by-one in where the advice changes)",
    anchor: '      if (i >= above || (Number(st.mode) & 0o1002) !== 0) move = true;\n',
    replacement: '      if (i > above || (Number(st.mode) & 0o1002) !== 0) move = true;\n',
  },
  {
    id: 'A04',
    subject: 'render',
    claim:
      'a sticky directory that is not world-writable (1775) is offered chmod: the sticky bit is not looked at',
    anchor: '      if (i >= above || (Number(st.mode) & 0o1002) !== 0) move = true;\n',
    replacement: '      if (i >= above || (Number(st.mode) & 0o002) !== 0) move = true;\n',
  },
  {
    id: 'A05',
    subject: 'render',
    claim: 'a world-writable directory is offered chmod: only the sticky bit is looked at',
    anchor: '      if (i >= above || (Number(st.mode) & 0o1002) !== 0) move = true;\n',
    replacement: '      if (i >= above || (Number(st.mode) & 0o1000) !== 0) move = true;\n',
  },
  {
    id: 'A06',
    subject: 'render',
    claim:
      "the fix-in-place advice (chmod, chown, RUN chmod) is given even when no directory of the app's own is bad (fragment)",
    anchor: '\\${fix ? " To fix',
    replacement: '\\${true ? " To fix',
  },
  {
    id: 'A07',
    subject: 'render',
    claim:
      "the move-the-install advice is given even when every bad directory is the app's own (fragment)",
    anchor: '\\${move ? " A directory above',
    replacement: '\\${true ? " A directory above',
  },
  {
    id: 'C01',
    subject: 'render',
    claim:
      'a control character in a directory name is printed as itself: a newline forges another line of the list',
    anchor: '    out += n < 0x20 || n === 0x7f ? \\`^\\${String.fromCharCode(n ^ 0x40)}\\` : ch;\n',
    replacement: '    out += ch;\n',
  },
  {
    id: 'C02',
    subject: 'render',
    claim: 'a delete character (0x7f) in a directory name is printed as itself',
    anchor: '    out += n < 0x20 || n === 0x7f ? \\`^\\${String.fromCharCode(n ^ 0x40)}\\` : ch;\n',
    replacement: '    out += n < 0x20 ? \\`^\\${String.fromCharCode(n ^ 0x40)}\\` : ch;\n',
  },
  {
    id: 'C03',
    subject: 'render',
    claim: 'the failing directories are listed by their raw names, not as shown',
    anchor: '      bad.push(\\`\\${$show(dir)} \\${why}\\`);\n',
    replacement: '      bad.push(\\`\\${dir} \\${why}\\`);\n',
  },
  {
    id: 'K01',
    subject: 'render',
    claim:
      'a regular file or other object where a directory belongs is treated as a link (it is told a link is never followed)',
    anchor: '      if (type === $constants.S_IFLNK) link = true;\n',
    replacement: '      if (true as boolean) link = true;\n',
  },
  {
    id: 'K02',
    subject: 'render',
    claim: 'an object that is neither a link nor a directory gets no advice of its own',
    anchor: '      else other = true;\n',
    replacement: '\n',
  },
  {
    id: 'P01',
    subject: 'render',
    claim: 'a relative executable path is blamed on a symbolic link (fragment)',
    anchor: "\\${home.startsWith('/') ? \"so the",
    replacement: '\\${true ? "so the',
  },
  {
    id: 'X01',
    subject: 'render',
    claim:
      'the file refusal names only knext deploy and knext preview as the commands that stage the Dockerfile (fragment)',
    anchor: '(the Dockerfile that \\\\\\`knext build\\\\\\`, ',
    replacement: '(the Dockerfile that ',
  },
  {
    id: 'X02',
    subject: 'render',
    claim: 'the unresolved-library refusal names only knext build (fragment)',
    anchor:
      "'The Dockerfile that \\`knext build\\`, \\`knext deploy\\` and \\`knext preview\\` stage puts",
    replacement: "'The Dockerfile that \\`knext build\\` stage puts",
  },
  {
    id: 'X03',
    subject: 'render',
    claim: 'the missing-manifest refusal names only knext deploy and knext preview (fragment)',
    anchor: '. The Dockerfile that \\\\\\`knext build\\\\\\`, ',
    replacement: '. The Dockerfile that ',
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
  anchor:
    '  if (Number(st.uid) !== 0) return \\`is owned by uid \\${st.uid}, but only root may own it\\`;\n',
  replacement:
    '  if (Number(st.uid) === 12345) return \\`is owned by uid \\${st.uid}, but only root may own it\\`;\n',
});
for (const m of LOADER) {
  loader.run({ ...m, expect: 'red' });
  recordMutation();
}
loader.finish(LOADER.length);
