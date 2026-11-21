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
 *   Advice (what the refusal tells the reader to do follows the situation: a directory inside
 *   native/ is fixed in place; a STICKY directory at the executable's level or above it is shared
 *   and is only told to move the install; any other, the executable's own or above it (a
 *   world-writable one that is not sticky, a chmod 777 /app, included), is told both, each with
 *   its condition, and a home directory is named as one to move, never to give to root)
 *   A01  a sticky directory is given the conditional advice
 *   A02  the executable's own directory is left out of the move advice when it is sticky
 *   A03  the executable's own directory is counted as inside native/
 *   A04  native/ itself is not counted as inside native/ (off by one)
 *   A05  a directory inside native/ is never given the fix in place
 *   A06  the setgid bit is looked at instead of the sticky bit
 *   A07  a world-writable directory that is not sticky is told only to move (the earlier rule)
 *   A08  any other failing directory is told only to fix it in place
 *   A09  the fix in place is always given     A10  the conditional advice is always given
 *   A11  the move advice is always given
 *   A12  the sticky bit is checked before the directory is known to be inside native/
 *   A13  the conditional advice loses its sentence about a home directory (fragment)
 *   A14  the one Dockerfile line that keeps a vinext app on the known-good path is never named (fragment)
 *   A15  it is named only next to the in-place fix of native/ (fragment)
 *   A16  it is no longer said to go DIRECTLY after the COPY (fragment)
 *   A17  "fixing the other directories is not enough" is never said (fragment)
 *   A18  it is said only next to the in-place fix, not next to the conditional advice (fragment)
 *   Printing (every path and system error a refusal prints goes through $show; the generated
 *   module is also scanned for any interpolation that is not, so a message cannot forget it)
 *   C01  a C0 control (a newline forges a list line) is printed raw    C02  a delete character
 *   C03  the list prints the raw name                 C04  a C1 control    C05  U+2028, U+2029
 *   C06  a backslash is not doubled    C07  a caret is not escaped (the output is ambiguous)
 *   C08  U+202A to U+202E    C09  U+2066 to U+2069    C10  U+061C (the Arabic letter mark)
 *   C11  U+200E, U+200F (the direction marks)   C12  U+200B to U+200D (zero-width)
 *   C13  U+2060 (the word joiner)   C14  U+FEFF (the byte order mark)
 *   C15  $show can throw (a null-prototype value, or a toString that throws)
 *   E01  the system error of an unparseable manifest  E02  of a file that cannot be opened
 *   E03  the library path of a not-a-regular-file refusal   E04  of an unresolvable directory
 *   E05  the platform directory names it found        E06  the system error of a failed load
 *   E07  the path of the development build
 *   E08  the KNEXT_FFI_SLOW_CALL_MS value (fragment)
 *   E09  the library file name in "cannot find the Rust library"    E10  the manifest key in
 *        "is not listed in"    E13  the name the library was opened as: E09, E10 and E13 are seen
 *        only by the scan of the generated module (the names are the generator's), so each is a
 *        row on the scan itself, which is keyed by function and expression (fragment)
 *   E11  the unsupported manifest version (fragment)   E12  the digest a manifest lists (fragment)
 *   E14  the system error of a load that fails outside the loader
 *   E15  the value of a 64-bit integer argument that is refused (fragment)
 *   E16  the value of a number argument that is refused (fragment)
 *   Digest and schema (a value compared as text and printed must be what it claims to be)
 *   Q01  a manifest entry that is not a sha256 digest is not refused    Q02  upper case is accepted
 *   Q03  the length is not required                    Q04  an unknown manifest version is accepted
 *   K01  an object that is not a directory or a link is called a link
 *   K02  such an object gets no advice of its own
 *   P01  a relative executable path is blamed on a link
 *   X01  the file refusal names two of the three commands that stage the Dockerfile
 *   X02  the unresolved-library refusal names one     X03  the missing-manifest refusal names two
 *   Init hint (`knext ffi init`, proved against init.test.ts, its own spec)
 *   V01  a Dockerfile that already closes both is told again   V02  one without a native/ COPY is told
 *   V03  the line leaves /app open        V04  the hint is never printed
 *   V05  init edits the Dockerfile        V06  the reason is dropped    V07  the placement is dropped
 *   V08  "change nothing else" is dropped          V09  the JSON form of COPY is not read
 *   V10  COPY flags are not skipped                V11  a trailing slash on the destination
 *   V12  a backslash continuation is not joined    V13  every stage is read, not the final one
 *   V14  /app/native alone is enough               V15  /app alone is enough
 *   V16  a chmod before the copy counts            V17  any chmod counts, go+w included
 *   V18  a recursive chmod of /app is not taken to close /app/native
 *   V19  a RUN line is read as one command (a chmod after && or ; is missed)
 *   V20  a mode with no who-letter (-w, =rx) is taken to close the directories (it is subject to the umask)
 *   V21  a later who-less +w is not seen to open them again
 *   V22  a later g+w or o+w does not take an earlier close back
 *   V23  a later chown to somebody but root does not take an earlier close back
 *   V24  a heredoc body is read as instructions     V25  the tabs of a <<- heredoc are not stripped
 *   V26  an app built with another builder is told   V27  the slower-path warning is never given
 *   V28  the slower-path warning is always given     V29  a config with no build is not read as turbopack
 *   V30  the CLI never reads the app's build (init.test.ts, through the CLI)
 *   V31  the tabs before the terminator of a plain << heredoc are stripped too
 *   Known-good variant (core, ffi-vinext-known-good.test.ts, its own spec): `knext deploy` knows
 *   the scaffolded vinext Dockerfile byte for byte and takes another path for any other; the one
 *   line the hint adds must not take an app off it
 *   G01  the template plus the line is not recognised    G02  the line goes before the COPY
 *   G03  any Dockerfile holding the line is recognised   G04  the line differs from the hint's
 *   G05  a template with no native/ COPY gets a variant  G06  one with the COPY twice does
 *   G07  the build the hint assumes for a config that names none drifts from core's default builder
 *   G08  the one build the hint speaks to is not the builder core calls vinext
 *   Generate and check (generate-check.test.ts, its own spec)
 *   H01  generate does not print the hint    H02  check does not print the hint
 *   H03  generate ignores the build           H04  check ignores the build
 *   Scan (template-scan.ts, the guard that every printed value went through $show; ffi-loader.test.ts
 *   feeds it a snippet for each sink and requires every one to be seen)
 *   T01  process.stderr.write is no longer a sink    T02  $openFile's 2nd and 4th arguments are not
 *   T03  Reflect.construct of an error class is not  T04  an assignment to .message is not
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
 * the rows marked (fragment): D01, D02, P01 and X01 to X03 anchor a
 * piece of an emitted message or expression, and the harness appends its marker
 * after the replacement on the same line. Each of those is chosen so that the
 * fragment ends inside the string it sits in, where the marker is plain text.
 *
 * The harness for the real Rust library (crates/harness/ffi-generated.ts) is proved by its own
 * committed check, not here, because it needs cargo and root:
 * crates/harness/ffi-generated-red.ts weakens the rendered loader in memory and requires the
 * harness to fail on each weakening, naming exactly the controls that go red. It runs in the Rust
 * crates lane. Its weakenings (loader-weakenings.ts):
 *   W01  the directories above the one native/ sits in are never walked    controls 1, 3, 4
 *   W02  the walk stops one short of the root directory                    control 4
 *   W03  the real-path assertion is removed (a link at or above the executable's directory, or a
 *        relative executable path)                                          controls 2, 5
 *   W04  the sticky exemption (a /tmp is let through)                       control 1
 *   W05  the owner of a directory is not judged                             control 1
 * W05 edits $why, which the library and manifest checks share with the directory walk, so it
 * removes the file-owner check too; only the directory control (the listed directory this user
 * owns) can show it, and only as a user that is not root. The check is stopped by SIGINT or
 * SIGTERM with what it has running (exit 130 and 143), and proves nothing then.
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

// The scan of the generated module (template-scan.ts) is the guard that says every value a message
// prints went through $show. Its sink list is what it looks at; ffi-loader.test.ts feeds it snippets
// that use each sink and requires every one to be seen.
const SCAN = [
  {
    id: 'T01',
    subject: 'scan',
    claim:
      'process.stderr.write is no longer a sink: a value written there is not required to be shown',
    anchor: "  'process.stderr.write',\n",
    replacement: '\n',
  },
  {
    id: 'T02',
    subject: 'scan',
    claim:
      'the arguments of $openFile that become message text (the 2nd and the 4th) are no longer sinks: what is passed there is not required to be shown',
    anchor: 'const PARAM_SINKS: Record<string, readonly number[]> = { $openFile: [1, 3] };\n',
    replacement: 'const PARAM_SINKS: Record<string, readonly number[]> = { $openFile: [] };\n',
  },
  {
    id: 'T03',
    subject: 'scan',
    claim: 'Reflect.construct of an error class is no longer a sink',
    anchor: "        callee === 'Reflect.construct' &&\n",
    replacement: '        false &&\n',
  },
  {
    id: 'T04',
    subject: 'scan',
    claim: 'an assignment to a .message is no longer a sink',
    anchor:
      "      ((ts.isPropertyAccessExpression(node.left) && node.left.name.text === 'message') ||\n",
    replacement:
      "      ((ts.isPropertyAccessExpression(node.left) && node.left.name.text === 'messag') ||\n",
  },
];

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
    anchor: 'inside native/: run ',
    replacement: 'inside native/: COPY --chown=0:0 --chmod=a-w it, or run ',
  },
  {
    id: 'A01',
    subject: 'render',
    claim:
      'a sticky directory at or above the executable is not told only to move the install: it is given the conditional advice (chmod it if it is yours) like any other',
    anchor: String.raw`      else if ((Number(st.mode) & 0o1000) !== 0) move = true;` + '\n',
    replacement: '      else if (false as boolean) move = true;\n',
  },
  {
    id: 'A02',
    subject: 'render',
    claim:
      "the executable's own directory is left out of the move advice: a sticky one (the app dropped into a /tmp) is given the conditional advice",
    anchor: String.raw`      else if ((Number(st.mode) & 0o1000) !== 0) move = true;` + '\n',
    replacement: '      else if (i > inside && (Number(st.mode) & 0o1000) !== 0) move = true;\n',
  },
  {
    id: 'A03',
    subject: 'render',
    claim:
      "the executable's own directory is counted as inside native/: it is given the unconditional fix and never told it may be shared (a root:staff /usr/local/bin)",
    anchor: '      if (i < inside) fix = true;\n',
    replacement: '      if (i <= inside) fix = true;\n',
  },
  {
    id: 'A04',
    subject: 'render',
    claim:
      'native/ itself is not counted as inside native/ (an off-by-one): it is given the conditional advice, not the fix',
    anchor: '      if (i < inside) fix = true;\n',
    replacement: '      if (i < inside - 1) fix = true;\n',
  },
  {
    id: 'A05',
    subject: 'render',
    claim: 'a directory inside native/ is never given the unconditional fix',
    anchor: '      if (i < inside) fix = true;\n',
    replacement: '      if (false as boolean) fix = true;\n',
  },
  {
    id: 'A06',
    subject: 'render',
    claim:
      'the setgid bit is looked at instead of the sticky bit: a sticky directory (1775) is given the conditional advice and a setgid one (2775) is told only to move',
    anchor: String.raw`      else if ((Number(st.mode) & 0o1000) !== 0) move = true;` + '\n',
    replacement: '      else if ((Number(st.mode) & 0o2000) !== 0) move = true;\n',
  },
  {
    id: 'A07',
    subject: 'render',
    claim:
      'a world-writable directory that is not sticky (chmod 777 /app) is told only to move the install: the world-write bit is counted as shared, which was the rule before the sticky bit alone decided',
    anchor: String.raw`      else if ((Number(st.mode) & 0o1000) !== 0) move = true;` + '\n',
    replacement: '      else if ((Number(st.mode) & 0o1002) !== 0) move = true;\n',
  },
  {
    id: 'A08',
    subject: 'render',
    claim:
      "any other failing directory (the executable's own, or one above it) is told only to fix it in place, never that it may be shared",
    anchor: '      else either = true;\n',
    replacement: '      else fix = true;\n',
  },
  {
    id: 'A09',
    subject: 'render',
    claim: 'the fix-in-place advice is given even when no directory inside native/ is bad',
    anchor: '  let fix = false;\n',
    replacement: '  let fix = true;\n',
  },
  {
    id: 'A10',
    subject: 'render',
    claim:
      'the conditional advice is given even when no directory holds the executable or sits above it unsharedly',
    anchor: '  let either = false;\n',
    replacement: '  let either = true;\n',
  },
  {
    id: 'A11',
    subject: 'render',
    claim:
      'the move-the-install advice is given even when no sticky or world-writable directory is bad',
    anchor: '  let move = false;\n',
    replacement: '  let move = true;\n',
  },
  {
    id: 'A12',
    subject: 'render',
    claim:
      'the sticky bit is checked before the directory is known to be inside native/: a sticky directory inside native/ is told to move the install instead of being fixed in place',
    anchor:
      String.raw`      if (i < inside) fix = true;` +
      '\n' +
      String.raw`      else if ((Number(st.mode) & 0o1000) !== 0) move = true;` +
      '\n',
    replacement:
      String.raw`      if ((Number(st.mode) & 0o1000) !== 0) move = true;` +
      '\n' +
      String.raw`      else if (i < inside) fix = true;` +
      '\n',
  },
  {
    id: 'A13',
    subject: 'render',
    claim:
      'the conditional advice no longer names a home directory as one to move (never to give to root) (fragment)',
    anchor:
      'If it is shared with other software, or is a home directory such as /home/<user>, do not change its owner or mode (never give a home directory to root): move the install instead.',
    replacement: 'If it is shared with other software, do not change it, move the install instead.',
  },
  {
    id: 'C01',
    subject: 'render',
    claim:
      'a C0 control character in a directory name is printed as itself: a newline forges another line of the list',
    anchor: '    if (n < 0x20 || n === 0x7f) out += \\`^\\${String.fromCharCode(n ^ 0x40)}\\`;\n',
    replacement: '    if (n < 0) out += \\`^\\${String.fromCharCode(n ^ 0x40)}\\`;\n',
  },
  {
    id: 'C02',
    subject: 'render',
    claim: 'a delete character (0x7f) in a directory name is printed as itself',
    anchor: '    if (n < 0x20 || n === 0x7f) out += \\`^\\${String.fromCharCode(n ^ 0x40)}\\`;\n',
    replacement: '    if (n < 0x20) out += \\`^\\${String.fromCharCode(n ^ 0x40)}\\`;\n',
  },
  {
    id: 'C04',
    subject: 'render',
    claim:
      'a C1 control character (U+0085, which many terminals read as a line end) in a directory name is printed as itself',
    anchor: '      (n >= 0x80 && n <= 0x9f) ||\n',
    replacement: '      false ||\n',
  },
  {
    id: 'C05',
    subject: 'render',
    claim:
      'the line and paragraph separators (U+2028, U+2029) in a directory name are printed as themselves',
    anchor: '      n === 0x2028 ||\n      n === 0x2029 ||\n',
    replacement: '      false ||\n',
  },
  {
    id: 'C06',
    subject: 'render',
    claim:
      'a backslash in a name is not doubled: a name that really holds the text of a unicode escape reads as the control character it spells',
    anchor: String.raw`    else if (ch === '\\\\' || ch === '^') out += \`\\\\\${ch}\`;` + '\n',
    replacement: String.raw`    else if (ch === '^') out += \`\\\\\${ch}\`;` + '\n',
  },
  {
    id: 'C07',
    subject: 'render',
    claim:
      'a caret in a name is not escaped: a name that really holds ^J reads as a newline in caret notation',
    anchor: String.raw`    else if (ch === '\\\\' || ch === '^') out += \`\\\\\${ch}\`;` + '\n',
    replacement: String.raw`    else if (ch === '\\\\') out += \`\\\\\${ch}\`;` + '\n',
  },
  {
    id: 'C08',
    subject: 'render',
    claim:
      'the bidirectional embeddings and overrides (U+202A to U+202E) in a directory name are printed as themselves: a right-to-left override reorders the text around it',
    anchor: '      (n >= 0x202a && n <= 0x202e) ||\n',
    replacement: '      false ||\n',
  },
  {
    id: 'C09',
    subject: 'render',
    claim:
      'the bidirectional isolates (U+2066 to U+2069) in a directory name are printed as themselves',
    anchor: '      (n >= 0x2066 && n <= 0x2069) ||\n',
    replacement: '      false ||\n',
  },
  {
    id: 'C10',
    subject: 'render',
    claim:
      'the Arabic letter mark (U+061C, a bidirectional control) in a directory name is printed as itself',
    anchor: '      n === 0x61c ||\n',
    replacement: '      false ||\n',
  },
  {
    id: 'C11',
    subject: 'render',
    claim:
      'the left-to-right and right-to-left marks (U+200E, U+200F) in a directory name are printed as themselves',
    anchor: '      (n >= 0x200b && n <= 0x200f) ||\n',
    replacement: '      (n >= 0x200b && n <= 0x200d) ||\n',
  },
  {
    id: 'C12',
    subject: 'render',
    claim:
      'the zero-width characters (U+200B to U+200D) in a directory name are printed as themselves: a name that holds one reads as the name without it',
    anchor: '      (n >= 0x200b && n <= 0x200f) ||\n',
    replacement: '      (n >= 0x200e && n <= 0x200f) ||\n',
  },
  {
    id: 'C13',
    subject: 'render',
    claim: 'the word joiner (U+2060) in a directory name is printed as itself',
    anchor: '      n === 0x2060 ||\n',
    replacement: '      false ||\n',
  },
  {
    id: 'C14',
    subject: 'render',
    claim: 'the byte order mark (U+FEFF) in a directory name is printed as itself',
    anchor: '      n === 0xfeff\n',
    replacement: '      false\n',
  },
  {
    id: 'C15',
    subject: 'render',
    claim:
      'the printing of a value can throw: an error value with no prototype, or a toString that throws, takes the refusal down with a TypeError instead of being shown',
    anchor: "  try {\n    text = String(p);\n  } catch {\n    text = '[object Object]';\n  }\n",
    replacement: '  text = String(p);\n',
  },
  {
    id: 'A14',
    subject: 'render',
    claim:
      'the one Dockerfile line that keeps a vinext app on the known-good path is never named in the refusal (fragment)',
    anchor: String.raw`\${fix || either ? " In a vinext app's Dockerfile, put exactly`,
    replacement: String.raw`\${false ? " In a vinext app's Dockerfile, put exactly`,
  },
  {
    id: 'A15',
    subject: 'render',
    claim:
      'the vinext line is named only where a directory inside native/ is fixed in place, and not for the conditional advice (fragment)',
    anchor: String.raw`\${fix || either ? " In a vinext app's Dockerfile, put exactly`,
    replacement: String.raw`\${fix ? " In a vinext app's Dockerfile, put exactly`,
  },
  {
    id: 'A16',
    subject: 'render',
    claim:
      'the vinext line is no longer said to go DIRECTLY after the COPY: any later place reads as fine, and a deploy takes the slower path (fragment)',
    anchor: String.raw`put exactly \`RUN chmod go-w /app /app/native\` directly after the \`COPY`,
    replacement: String.raw`put exactly \`RUN chmod go-w /app /app/native\` after the \`COPY`,
  },
  {
    id: 'A17',
    subject: 'render',
    claim:
      'a sticky directory on the list together with others is never said to need the install moved even if the others are fixed (fragment)',
    anchor: String.raw`\${move && (fix || either) ? " The other directories on this list`,
    replacement: String.raw`\${false ? " The other directories on this list`,
  },
  {
    id: 'A18',
    subject: 'render',
    claim:
      'the "fixing the others is not enough" sentence is given only next to the in-place fix of native/, not next to the conditional advice (fragment)',
    anchor: String.raw`\${move && (fix || either) ? " The other directories on this list`,
    replacement: String.raw`\${move && fix ? " The other directories on this list`,
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
    id: 'E01',
    subject: 'render',
    claim:
      'the system error quoted when the manifest cannot be parsed is printed raw (it carries what the manifest holds, and a path)',
    anchor:
      '      \\`knext ffi: refusing to load \\${$show(path)}: cannot read \\${$show(manifest)} (\\${$show(err instanceof Error ? err.message : err)}).\\`,\n',
    replacement:
      '      \\`knext ffi: refusing to load \\${$show(path)}: cannot read \\${$show(manifest)} (\\${err instanceof Error ? err.message : err}).\\`,\n',
  },
  {
    id: 'E02',
    subject: 'render',
    claim:
      'the system error quoted when a file cannot be opened is printed raw (it quotes the path)',
    anchor:
      '        : \\`knext ffi: refusing to load \\${$show(lib)}: cannot open \\${$show(path)} (\\${$show(err instanceof Error ? err.message : err)}).\\`,\n',
    replacement:
      '        : \\`knext ffi: refusing to load \\${$show(lib)}: cannot open \\${$show(path)} (\\${err instanceof Error ? err.message : err}).\\`,\n',
  },
  {
    id: 'E03',
    subject: 'render',
    claim: 'the library path in the refusal of a file that is not a regular file is printed raw',
    anchor:
      '    throw new FfiLoadError(\\`knext ffi: refusing to load \\${$show(lib)}: \\${$show(path)} is not a regular file. \\${what} must be a plain file: a pipe, a device or a directory is never read.\\`);\n',
    replacement:
      '    throw new FfiLoadError(\\`knext ffi: refusing to load \\${lib}: \\${$show(path)} is not a regular file. \\${what} must be a plain file: a pipe, a device or a directory is never read.\\`);\n',
  },
  {
    id: 'E04',
    subject: 'render',
    claim:
      "the system error quoted when the executable's directory cannot be resolved is printed raw",
    anchor:
      '      \\`knext ffi: refusing to load \\${$show(path)}: cannot resolve the directory \\${$show(home)} (\\${$show(err instanceof Error ? err.message : err)}).\\`,\n',
    replacement:
      '      \\`knext ffi: refusing to load \\${$show(path)}: cannot resolve the directory \\${$show(home)} (\\${err instanceof Error ? err.message : err}).\\`,\n',
  },
  {
    id: 'E05',
    subject: 'render',
    claim: 'the names of the platform directories it found are printed raw',
    anchor:
      "      \\`knext ffi: \\${$show($join(native, 'ffi'))} holds Rust libraries for \\${$show(others.join(', '))}, but this process runs on \\${triple}. Build the image for the platform it runs on.\\`,\n",
    replacement:
      "      \\`knext ffi: \\${$show($join(native, 'ffi'))} holds Rust libraries for \\${others.join(', ')}, but this process runs on \\${triple}. Build the image for the platform it runs on.\\`,\n",
  },
  {
    id: 'E06',
    subject: 'render',
    claim: 'the system error quoted when the library cannot be loaded is printed raw',
    anchor:
      '      \\`knext ffi: could not load \\${$show(path)}\\${via}: \\${$show(err instanceof Error ? err.message : err)}\\\\n\\` +\n',
    replacement:
      '      \\`knext ffi: could not load \\${$show(path)}\\${via}: \\${err instanceof Error ? err.message : err}\\\\n\\` +\n',
  },
  {
    id: 'E07',
    subject: 'render',
    claim: 'the path of the development build in its notice is printed raw',
    anchor:
      '        \\`knext ffi: loading the development build \\${$show(found[0])} without an integrity check (NODE_ENV is not "production").\\`,\n',
    replacement:
      '        \\`knext ffi: loading the development build \\${found[0]} without an integrity check (NODE_ENV is not "production").\\`,\n',
  },
  {
    id: 'E08',
    subject: 'render',
    claim:
      'the KNEXT_FFI_SLOW_CALL_MS value in the warning is printed raw (the environment can hold any characters) (fragment)',
    anchor: String.raw`KNEXT_FFI_SLOW_CALL_MS="\${$show(raw)}": it must be`,
    replacement: String.raw`KNEXT_FFI_SLOW_CALL_MS="\${raw}": it must be`,
  },
  {
    id: 'E09',
    subject: 'render',
    claim:
      'the library file name in "cannot find the Rust library" is printed raw (only the scan of the generated module sees it: the name is the generator\'s) (fragment)',
    anchor: String.raw`cannot find the Rust library \${$show(file)} for`,
    replacement: String.raw`cannot find the Rust library \${file} for`,
  },
  {
    id: 'E10',
    subject: 'render',
    claim:
      'the manifest key in "is not listed in" is printed raw (only the scan of the generated module sees it) (fragment)',
    anchor: String.raw`: \${$show(rel)} is not listed in`,
    replacement: String.raw`: \${rel} is not listed in`,
  },
  {
    id: 'E11',
    subject: 'render',
    claim:
      'the unsupported manifest version a refusal quotes is printed raw (it is whatever the manifest holds) (fragment)',
    anchor: String.raw`(unsupported version \${typeof version === 'string' ? \`"\${$show(version)}"\` : $show(String(JSON.stringify(version)))}).`,
    replacement: String.raw`(unsupported version \${typeof version === 'string' ? version : $show(String(JSON.stringify(version)))}).`,
  },
  {
    id: 'E12',
    subject: 'render',
    claim:
      'the digest a manifest lists, in the refusal that it is not one, is printed raw (it is whatever the manifest holds) (fragment)',
    anchor: String.raw`as "\${$show(expected)}", which is not a sha256 digest`,
    replacement: String.raw`as "\${expected}", which is not a sha256 digest`,
  },
  {
    id: 'E13',
    subject: 'render',
    claim:
      'the name the library was opened as, in the load-failure message, is printed raw (only the scan of the generated module sees it) (fragment)',
    anchor: String.raw`(opened as \${$show(load)}`,
    replacement: String.raw`(opened as \${load}`,
  },
  {
    id: 'E14',
    subject: 'render',
    claim:
      'the system error quoted when the load fails outside the loader (the generic "could not load the Rust library") is printed raw',
    anchor:
      '            \\`knext ffi: could not load the Rust library: \\${$show(err instanceof Error ? err.message : err)}\\`,\n',
    replacement:
      '            \\`knext ffi: could not load the Rust library: \\${err instanceof Error ? err.message : err}\\`,\n',
  },
  {
    id: 'E15',
    subject: 'render',
    claim:
      'the value a 64-bit integer argument was given, quoted when it is refused as not a decimal string, is printed raw (it is whatever the caller passed: it can hold a newline) (fragment)',
    anchor: String.raw`expected a 64-bit integer as a decimal string, got \${$show(JSON.stringify(v))}`,
    replacement: String.raw`expected a 64-bit integer as a decimal string, got \${JSON.stringify(v)}`,
  },
  {
    id: 'E16',
    subject: 'render',
    claim:
      'the value a finite-number argument was given, quoted when it is refused, is printed raw (it is whatever the caller passed) (fragment)',
    anchor: String.raw`(NaN and Infinity cannot cross as JSON)' : $show(JSON.stringify(v))}`,
    replacement: String.raw`(NaN and Infinity cannot cross as JSON)' : JSON.stringify(v)}`,
  },
  {
    id: 'Q01',
    subject: 'render',
    claim:
      'a manifest entry that is not a sha256 digest is no longer refused: whatever it holds is compared as text and printed on a mismatch',
    anchor: String.raw`  if (!/^[0-9a-f]{64}$/.test(expected)) {` + '\n',
    replacement: '  if (false as boolean) {\n',
  },
  {
    id: 'Q02',
    subject: 'render',
    claim: 'the digest check accepts upper case (the manifest is written in lower case)',
    anchor: String.raw`  if (!/^[0-9a-f]{64}$/.test(expected)) {` + '\n',
    replacement: String.raw`  if (!/^[0-9a-fA-F]{64}$/.test(expected)) {` + '\n',
  },
  {
    id: 'Q03',
    subject: 'render',
    claim: 'the digest check does not require 64 digits',
    anchor: String.raw`  if (!/^[0-9a-f]{64}$/.test(expected)) {` + '\n',
    replacement: String.raw`  if (!/^[0-9a-f]+$/.test(expected)) {` + '\n',
  },
  {
    id: 'Q04',
    subject: 'render',
    claim: 'a manifest of an unknown schema version is no longer refused',
    anchor: '  if (version !== 1) {\n',
    replacement: '  if (false as boolean) {\n',
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

// The `knext ffi init` hint for a vinext app (its own Dockerfile, which init never edits).
const INIT = [
  {
    id: 'V01',
    subject: 'init',
    claim: 'a Dockerfile that already closes /app and /app/native is told to add the line again',
    anchor: "  if (!(closed.has('/app') && closed.has('/app/native'))) {\n",
    replacement: '  if (true as boolean) {\n',
  },
  {
    id: 'V02',
    subject: 'init',
    claim: 'a Dockerfile that does not copy native/ to /app/native is given the vinext hint',
    anchor: "  if (copy === -1) return '';\n",
    replacement: '\n',
  },
  {
    id: 'V03',
    subject: 'init',
    claim: 'the line it tells the reader to add leaves /app itself open',
    anchor: "export const VINEXT_CLOSE_LINE = 'RUN chmod go-w /app /app/native';\n",
    replacement: "export const VINEXT_CLOSE_LINE = 'RUN chmod go-w /app/native';\n",
  },
  {
    id: 'V04',
    subject: 'init',
    claim: 'the hint is never printed',
    anchor:
      '      `the typed wrapper to ${DEFAULT_CONFIG.out}/.\\n${dockerfileHint(cwd, opts.build)}`,\n',
    replacement: '      `the typed wrapper to ${DEFAULT_CONFIG.out}/.\\n`,\n',
  },
  {
    id: 'V05',
    subject: 'init',
    claim:
      "init edits the app's Dockerfile itself (appends the line) instead of saying what to add",
    anchor: "    text = readFileSync(join(cwd, 'Dockerfile'), 'utf8');\n",
    replacement:
      "    writeFileSync(join(cwd, 'Dockerfile'), `${readFileSync(join(cwd, 'Dockerfile'), 'utf8')}\\n${VINEXT_CLOSE_LINE}\\n`);\n    text = readFileSync(join(cwd, 'Dockerfile'), 'utf8');\n",
  },
  {
    id: 'V06',
    subject: 'init',
    claim:
      "the hint no longer says why every directory above the library has to be root's (fragment)",
    anchor: 'every directory above the library is owned by root',
    replacement: 'a directory above the library is owned by root',
  },
  {
    id: 'V07',
    subject: 'init',
    claim: 'the hint no longer says where the line goes (fragment)',
    anchor: 'add this one line directly after the `COPY` that brings native/ in and before `USER`,',
    replacement: 'add this line to it,',
  },
  {
    id: 'V08',
    subject: 'init',
    claim:
      'the hint no longer says to change nothing else: an app that edits the Dockerfile further is taken off the path knext recognises (fragment)',
    anchor: ', and change nothing else in the file (knext recognises',
    replacement: ', and edit the file as you like (knext recognises',
  },
  {
    id: 'V09',
    subject: 'init',
    claim: 'the JSON form of a COPY is not read: such a Dockerfile is never given the hint',
    anchor: "  if (args.startsWith('[')) {\n",
    replacement: '  if (false as boolean) {\n',
  },
  {
    id: 'V10',
    subject: 'init',
    claim: 'a COPY flag (--chown, --from) is not skipped before the JSON form',
    anchor: String.raw`  const args = rest.replace(/^(?:--\S+\s+)*/, '');` + '\n',
    replacement: '  const args = rest;\n',
  },
  {
    id: 'V11',
    subject: 'init',
    claim: 'a destination with a trailing slash (/app/native/) is not the destination',
    anchor:
      String.raw`  return dest === undefined ? undefined : dest.replace(/(?<=.)\/+$/, '');` + '\n',
    replacement: '  return dest;\n',
  },
  {
    id: 'V12',
    subject: 'init',
    claim:
      'a backslash continuation is not joined: a COPY or RUN written over several lines is not read',
    anchor: String.raw`    if (line.endsWith('\\')) {` + '\n',
    replacement: '    if (false as boolean) {\n',
  },
  {
    id: 'V13',
    subject: 'init',
    claim:
      'every stage is read, not the final one: a copy or a chmod in a build stage counts for the image',
    anchor: '  return all.slice(from + 1);\n',
    replacement: '  return all;\n',
  },
  {
    id: 'V14',
    subject: 'init',
    claim: 'closing /app/native alone is enough: /app is left as the builder made it',
    anchor: "  if (!(closed.has('/app') && closed.has('/app/native'))) {\n",
    replacement: "  if (!closed.has('/app/native')) {\n",
  },
  {
    id: 'V15',
    subject: 'init',
    claim: 'closing /app alone is enough: /app/native is left as the builder made it',
    anchor: "  if (!(closed.has('/app') && closed.has('/app/native'))) {\n",
    replacement: "  if (!closed.has('/app')) {\n",
  },
  {
    id: 'V16',
    subject: 'init',
    claim: 'a chmod before the copy counts: the copy then makes the directory again',
    anchor:
      "  for (const i of stage.slice(copy + 1)) if (i.word === 'RUN') applyRun(i.rest, closed);\n",
    replacement: "  for (const i of stage) if (i.word === 'RUN') applyRun(i.rest, closed);\n",
  },
  {
    id: 'V17',
    subject: 'init',
    claim: 'any chmod counts, whatever mode it sets (go+w opens the directories)',
    anchor:
      "      if (effect === 'closes') closed.add(d);\n      else if (effect === 'opens') closed.delete(d);\n",
    replacement: '      closed.add(d);\n',
  },
  {
    id: 'V18',
    subject: 'init',
    claim: 'a recursive chmod of /app is not taken to close /app/native too',
    anchor: "    if (recursive && p === '/app') dirs.add('/app/native');\n",
    replacement: '\n',
  },
  {
    id: 'V19',
    subject: 'init',
    claim: 'a RUN line is read as one command: a chmod after && or ; is not seen',
    anchor: String.raw`  for (const command of run.split(/&&|\|\||;/)) {` + '\n',
    replacement: '  for (const command of [run]) {\n',
  },
  {
    id: 'V20',
    subject: 'init',
    claim:
      'a mode with no who-letter (-w, =rx) is taken as go-w: it is subject to the umask, so it closes nothing the loader needs',
    anchor: '    const who = m[1] as string;\n',
    replacement: "    const who = (m[1] as string) || 'go';\n",
  },
  {
    id: 'V21',
    subject: 'init',
    claim:
      'a later mode with no who-letter that gives write (+w) is not seen to open the directories again',
    anchor: "      if (writes && m[2] !== '-') for (const c of ['g', 'o']) last.set(c, 'open');\n",
    replacement: '\n',
  },
  {
    id: 'V22',
    subject: 'init',
    claim: 'a later chmod that gives group or other write does not take back an earlier close',
    anchor: "      else if (effect === 'opens') closed.delete(d);\n",
    replacement: '\n',
  },
  {
    id: 'V23',
    subject: 'init',
    claim: 'a later chown to somebody but root does not take back an earlier close',
    anchor:
      '      if (!staysRootOwned(what)) for (const d of named(paths, recursive)) closed.delete(d);\n',
    replacement: '\n',
  },
  {
    id: 'V24',
    subject: 'init',
    claim:
      'the body of a heredoc is read as instructions: a chmod, a COPY or a FROM inside one is taken for a real one',
    anchor: '      open = heredocsOf(m[2] as string);\n',
    replacement: '      open = [];\n',
  },
  {
    id: 'V25',
    subject: 'init',
    claim:
      'the tabs before the terminator of a <<- heredoc are not stripped: the heredoc never ends and swallows what follows',
    anchor:
      String.raw`      if ((inside.stripTabs ? raw.replace(/^\t+/, '') : raw).trimEnd() === inside.terminator) {` +
      '\n',
    replacement: '      if (raw.trimEnd() === inside.terminator) {\n',
  },
  {
    id: 'V26',
    subject: 'init',
    claim:
      'the hint is printed for an app built with another builder too (turbopack, webpack): its image already has the line',
    anchor: "  if (build !== undefined && build !== VINEXT_BUILD) return '';\n",
    replacement: '\n',
  },
  {
    id: 'V27',
    subject: 'init',
    claim:
      'a Dockerfile that closes both directories somewhere other than directly after the scaffolded COPY is never warned that deploy takes the slower path',
    anchor: '  if (at !== -1 && lines[at + 1] !== VINEXT_CLOSE_LINE) {\n',
    replacement: '  if (false as boolean) {\n',
  },
  {
    id: 'V28',
    subject: 'init',
    claim:
      'the slower-path warning is given even where the line IS directly after the COPY: the hint never goes quiet',
    anchor: '  if (at !== -1 && lines[at + 1] !== VINEXT_CLOSE_LINE) {\n',
    replacement: '  if (at !== -1) {\n',
  },
  {
    id: 'V29',
    subject: 'init',
    claim:
      'an app whose config names no build is not read as turbopack (the default): it is told as an unknown build is',
    anchor: '    const build = (config as { build?: unknown }).build ?? DEFAULT_BUILD;\n',
    replacement: '    const build = (config as { build?: unknown }).build;\n',
  },
  {
    id: 'V31',
    subject: 'init',
    claim:
      'the tabs before the terminator of a plain << heredoc are stripped too: the heredoc ends where it does not, and the chmod inside it is read as one',
    anchor:
      String.raw`      if ((inside.stripTabs ? raw.replace(/^\t+/, '') : raw).trimEnd() === inside.terminator) {` +
      '\n',
    replacement:
      String.raw`      if (raw.replace(/^\t+/, '').trimEnd() === inside.terminator) {` + '\n',
  },
  {
    id: 'V30',
    subject: 'cli',
    claim:
      "the CLI never reads the app's build: init and generate tell every app, whatever it builds with",
    anchor: '    const build = await appBuild(cwd);\n',
    replacement: '    const build = undefined;\n',
  },
];

// `knext deploy` recognises the scaffolded vinext Dockerfile byte for byte; the one line the init
// hint adds must not take an app off that path (ffi-vinext-known-good.test.ts).
const KNOWN = [
  {
    id: 'G01',
    subject: 'image',
    claim: 'the scaffolded Dockerfile plus the one line is no longer recognised',
    anchor: '                vinextTemplateWithCloseLine(text) === userContent\n',
    replacement: '                false\n',
  },
  {
    id: 'G02',
    subject: 'image',
    claim: 'the line is put before the native/ COPY instead of directly after it',
    anchor: '    const end = at + VINEXT_NATIVE_COPY.length;\n',
    replacement: '    const end = at;\n',
  },
  {
    id: 'G03',
    subject: 'image',
    claim:
      'any Dockerfile that contains the line is recognised: an app that edits the file elsewhere keeps the path that skips the in-image check',
    anchor: '                vinextTemplateWithCloseLine(text) === userContent\n',
    replacement: '                userContent.includes(VINEXT_FFI_CLOSE_LINE)\n',
  },
  {
    id: 'G04',
    subject: 'image',
    claim:
      'the line core recognises leaves /app/native alone (it no longer matches what the hint prints)',
    anchor: 'export const VINEXT_FFI_CLOSE_LINE = "RUN chmod go-w /app /app/native";\n',
    replacement: 'export const VINEXT_FFI_CLOSE_LINE = "RUN chmod go-w /app";\n',
  },
  {
    id: 'G05',
    subject: 'image',
    claim:
      'a template with no native/ COPY gets a variant anyway (the line is spliced at a bogus offset)',
    anchor: '    if (at === -1 || template.indexOf(VINEXT_NATIVE_COPY, at + 1) !== -1) {\n',
    replacement: '    if (template.indexOf(VINEXT_NATIVE_COPY, at + 1) !== -1) {\n',
  },
  {
    id: 'G06',
    subject: 'image',
    claim:
      'a template with the native/ COPY twice gets a variant (the line goes after the first only)',
    anchor: '    if (at === -1 || template.indexOf(VINEXT_NATIVE_COPY, at + 1) !== -1) {\n',
    replacement: '    if (at === -1) {\n',
  },
  {
    id: 'G07',
    subject: 'init',
    claim:
      "the build the hint assumes when a config names none drifts from core's default builder (the ffi package cannot import core, so it keeps its own copy)",
    anchor: "export const DEFAULT_BUILD = 'turbopack';\n",
    replacement: "export const DEFAULT_BUILD = 'webpack';\n",
  },
  {
    id: 'G08',
    subject: 'init',
    claim:
      'the one build the hint speaks to is not the builder core calls vinext: a vinext app is told nothing',
    anchor: "const VINEXT_BUILD = 'vinext';\n",
    replacement: "const VINEXT_BUILD = 'vinxet';\n",
  },
];

// `knext ffi generate` and `knext ffi check` print the hint for an app that already has its config.
const GENERATE = [
  {
    id: 'H01',
    subject: 'generate',
    claim: 'generate no longer prints the Dockerfile hint',
    anchor: '      }${dockerfileHint(cwd, opts.build)}`,\n',
    replacement: '      }`,\n',
  },
  {
    id: 'H03',
    subject: 'generate',
    claim:
      'generate ignores the build: an app built with turbopack or webpack is told about its Dockerfile too',
    anchor: '      }${dockerfileHint(cwd, opts.build)}`,\n',
    replacement: '      }${dockerfileHint(cwd)}`,\n',
  },
  {
    id: 'H02',
    subject: 'generate',
    claim: 'check no longer prints the Dockerfile hint',
    anchor:
      '          `generated code in ${config.out} is up to date (${expected.size} files)\\n${dockerfileHint(cwd, opts.build)}`,\n',
    replacement:
      '          `generated code in ${config.out} is up to date (${expected.size} files)\\n`,\n',
  },
  {
    id: 'H04',
    subject: 'generate',
    claim:
      'check ignores the build: an app built with turbopack or webpack is told about its Dockerfile too',
    anchor:
      '          `generated code in ${config.out} is up to date (${expected.size} files)\\n${dockerfileHint(cwd, opts.build)}`,\n',
    replacement:
      '          `generated code in ${config.out} is up to date (${expected.size} files)\\n${dockerfileHint(cwd)}`,\n',
  },
];

// The subject is an inline literal, not a shared constant: the lane's
// subject-existence audit reads it from the createGuardProver call.
const loader = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: 'packages/ffi/src/__tests__/ffi-loader.test.ts',
  subjects: {
    render: 'packages/ffi/src/render.ts',
    scan: 'packages/ffi/src/__tests__/template-scan.ts',
  },
});

console.log('=== mutation proof: the loader against a whole-tree swap (TD-S17-close-1) ===');
loader.preflight(LOADER);
loader.preflight(SCAN);
declareMutations(LOADER.length + SCAN.length + INIT.length + KNOWN.length + GENERATE.length);

console.log('\n=== the behaviour, against a real library (ffi-loader.test.ts) ===');
loader.baseline();
loader.proveCanSeeRed({
  subject: 'render',
  anchor:
    '  if (Number(st.uid) !== 0) return \\`is owned by uid \\${st.uid}, but only root may own it\\`;\n',
  replacement:
    '  if (Number(st.uid) === 12345) return \\`is owned by uid \\${st.uid}, but only root may own it\\`;\n',
});
for (const m of [...LOADER, ...SCAN]) {
  loader.run({ ...m, expect: 'red' });
  recordMutation();
}
loader.finish(LOADER.length + SCAN.length);

const init = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: 'packages/ffi/src/__tests__/init.test.ts',
  subjects: { init: 'packages/ffi/src/init.ts', cli: 'packages/ffi/src/cli.ts' },
});
init.preflight(INIT);

console.log('\n=== the vinext Dockerfile hint of knext ffi init (init.test.ts) ===');
init.baseline();
init.proveCanSeeRed({
  subject: 'init',
  anchor: '  writeFileSync(join(cwd, CONFIG_FILE), serializeConfig(DEFAULT_CONFIG));\n',
  replacement: '  void serializeConfig(DEFAULT_CONFIG);\n',
});
for (const m of INIT) {
  init.run({ ...m, expect: 'red' });
  recordMutation();
}
init.finish(INIT.length);

const known = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: 'packages/kn-next/src/__tests__/ffi-vinext-known-good.test.ts',
  subjects: {
    image: 'packages/kn-next/src/cli/runtime-image.ts',
    init: 'packages/ffi/src/init.ts',
  },
});
known.preflight(KNOWN);

console.log(
  '\n=== the scaffolded vinext Dockerfile plus the one line stays known-good (ffi-vinext-known-good.test.ts) ===',
);
known.baseline();
known.proveCanSeeRed({
  subject: 'image',
  anchor: '            if (text === userContent) return true;\n',
  replacement: '            if (text === userContent) return false;\n',
});
for (const m of KNOWN) {
  known.run({ ...m, expect: 'red' });
  recordMutation();
}
known.finish(KNOWN.length);

const generate = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: 'packages/ffi/src/__tests__/generate-check.test.ts',
  subjects: { generate: 'packages/ffi/src/generate.ts' },
});
generate.preflight(GENERATE);

console.log('\n=== generate and check print the Dockerfile hint (generate-check.test.ts) ===');
generate.baseline();
generate.proveCanSeeRed({
  subject: 'generate',
  anchor: '    const config = loadConfig(cwd);\n',
  replacement: "    const config = loadConfig(cwd);\n    throw new Error('canary');\n",
});
for (const m of GENERATE) {
  generate.run({ ...m, expect: 'red' });
  recordMutation();
}
generate.finish(GENERATE.length);
