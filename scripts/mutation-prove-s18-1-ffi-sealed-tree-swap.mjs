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
 *   A19  it is named for any directory that can be fixed in place, not only /app and /app/native
 *   A24  a sticky directory counts toward it    A25  any failing directory counts toward it
 *        (fragment)    A20  /app/native is not counted among those two    A21  /app is not
 *   A22  the sentence names another line than core recognises (it is not built from the constant)
 *        (fragment)    A23  it names another COPY than the scaffolded one (fragment)
 *   A17  "fixing the other directories is not enough" is never said (fragment)
 *   A18  it is said only next to the in-place fix, not next to the conditional advice (fragment)
 *   Printing (every path and system error a refusal prints goes through $show; the generated
 *   module is also scanned for any interpolation that is not, so a message cannot forget it)
 *   C01  a C0 control (a newline forges a list line) is printed raw    C02  a delete character
 *   C03  the list prints the raw name                 C04  a C1 control    C05  U+2028, U+2029
 *   C06  a backslash is not doubled    C07  a caret is not escaped (the output is ambiguous)
 *   C08  every format character (Unicode category Cf) is printed raw    C09  the soft hyphen U+00AD
 *   C10  the tag characters U+E0001, U+E0020 to U+E007F    C11  the invisible operators U+2061 to U+2064
 *   C12  U+202A to U+202E (bidirectional overrides)    C13  U+200B to U+200F (zero-width, direction marks)
 *   C14  U+FEFF (the byte order mark)
 *   C15  $show can throw (a null-prototype value, or a toString that throws)
 *   C16  U+034F (the combining grapheme joiner, not a format character)
 *   C17  a lone surrogate (a JSON string in the manifest can hold one) is printed raw
 *   C18  a character beyond U+FFFF is shown as a four-digit escape (the braces form is dropped)
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
 *   E15  the value a call returned in place of a 64-bit integer string, refused by $d64 (fragment)
 *   E16  the value a call returned in place of a finite number, refused by $fin (fragment)
 *   Digest and schema (a value compared as text and printed must be what it claims to be)
 *   Q01  a manifest entry that is not a sha256 digest is not refused    Q02  upper case is accepted
 *   Q03  the length is not required                    Q04  an unknown manifest version is accepted
 *   K01  an object that is not a directory or a link is called a link
 *   K02  such an object gets no advice of its own
 *   P01  a relative executable path is blamed on a link
 *   X01  the file refusal names two of the three commands that stage the Dockerfile
 *   X02  the unresolved-library refusal names one     X03  the missing-manifest refusal names two
 *   Init hint (`knext ffi init`, proved against init.test.ts, its own spec). The hint does not read
 *   what a command does: it confirms ONE form (the scaffolded COPY, the close line as the very next
 *   line of the file, byte for byte, then only instructions that cannot change a mode and the one
 *   read-only RUN, in a file that is clean as a whole: no unreadable character, no continuation
 *   backslash that no space or tab precedes, no heredoc, no escape or syntax directive, no SHELL or
 *   ONBUILD in any stage and no line that does not start with an instruction Docker knows) and
 *   everything else
 *   prints. Each row below widens that rule by one clause, or lets one named form through, and the
 *   spec must go red:
 *   V01  the confirmed form is told it cannot be confirmed    V02  no native/ COPY is told anyway
 *   V03  the pair names /app/native twice (the line leaves /app open)    V04  the hint is never printed
 *   V05  init edits the Dockerfile    V06  the reason is dropped    V07  the placement is dropped
 *   V08  "change nothing else" is dropped    V09  the JSON form of COPY is not read
 *   V10  COPY flags are not skipped    V11  a trailing slash on the destination
 *   V12  a backslash continuation is not joined    V13  every stage is read, not the final one
 *   V120 to V126  the join: a space is put between the lines (V120), the next line's indent is dropped (V121),
 *        the first line's indent is kept (V122), a lone backslash does not continue (V123), the keyword is
 *        matched from the start of the joined line (V124), its trailing whitespace is kept (V125), a
 *        space or tab after the backslash ends the continuation (V126)
 *   V127 to V131  the glued-continuation rule: absent, a lone backslash passes, a tab counts as no space,
 *        spaces after the backslash end it, its message names the next line
 *   V132 to V134  the read-only check is for any test, is on one line with single spaces, takes no tab
 *   V135 to V137, V142  the instruction list: not looked for, only the final stage, case-sensitive, its
 *        message names the next line    V138 to V140  MAINTAINER, VOLUME, ADD are not on it
 *   V74  ONBUILD is not looked for    V141 it is looked for only in the final stage
 *   V26  an app built with another builder is told    V29  a config with no build is not read as turbopack
 *   V30  the CLI never reads the app's build (init.test.ts, through the CLI)
 *   V45  a COPY destination is compared as written    V50  a destination that starts with /app/native
 *   V51  the WORKDIR is not tracked
 *   V52  the line may be anywhere after the COPY    V53  the line is matched by its start
 *   V54  the COPY's spelling is not compared    V55  the COPY is compared trimmed
 *   V56  the line need not be the next line (a blank line or a comment between)
 *   V57  the line is compared trimmed    V58  a CRLF file is read with its carriage returns
 *   V59  a heredoc is not looked for    V60  only the usual heredoc spellings (<<\EOF is missed)
 *   V61  a directive is not looked for    V62  a SHELL is not looked for
 *   V63  a SHELL is looked for only in the final stage
 *   V64  an unknown instruction is allowed    V65  any RUN is allowed
 *   V66 to V71  the read-only check is matched loosely, one clause at a time: not whole (V66), not
 *        from its start (V67), the text may hold $ (V68), a backtick (V69), a backslash (V70), the
 *        path may be any word (V71)
 *   V72, V73, V75  COPY, ADD, VOLUME are taken to leave the directories alone
 *   V76 to V94  a named RUN is let through, one row each: sudo -n, xargs -r, ./script, sh /script,
 *        install -d -m, install -m, mkdir -m, --mount, cd -P, a plain chmod, chown, the exec form,
 *        setfacl, umask, python, node, perl, true, echo
 *   V95  a heredoc into cat (`RUN cat > /entry.sh <<'ENV'`) is let through
 *   V96  the cannot-confirm message says the loader should accept the directories (fragment)
 *   V97  the add-this-line message says it of a Dockerfile closed another way (fragment)
 *   V98  the cannot-confirm message prints the text of the instruction (a control character reaches the terminal)
 *   The whole-file rule (judged first, before the stage is cut, the COPY found or a line trimmed):
 *   V99  unreadable characters are not looked for    V100 to V105  one clause of the class each: controls,
 *        invisible format characters, space-like characters, an invalid byte, a carriage return that
 *        does not end a line, and the lookahead that lets a space, tab and line end through
 *   V106 the line number is off by one    V107 a file that is not clean is told nothing
 *   V108 it is told even without a mention of native/    V109 it needs native/ with a slash
 *   V110 a heredoc is looked for only from the last FROM on
 *   V111 to V115  one clause of the directive pattern each: an indent, the case, escape only, syntax only,
 *        the space after the hash    V116 the pinned syntax line passes on any line
 *   V117 it passes when it is not byte for byte    V118 it is not let through at all
 *   V119 a continuation that runs into the end of the file is dropped
 *   Directory pair (vinext-pair.test.ts, its own spec; the package's sources copied with the pair changed)
 *   Z01  the line is typed out, not built from the pair    Z02  the scaffolded COPY is
 *   Z03  the generated module's test of which directories the line fixes is    Z04  the hint's reading of the COPY is
 *   Z05 to Z07  the words the hint prints (the destination, the directories, the example check) are typed out
 *   Known-good variant (core, ffi-vinext-known-good.test.ts, its own spec): `knext deploy` knows
 *   the scaffolded vinext Dockerfile byte for byte and takes another path for any other; the one
 *   line the hint adds must not take an app off it
 *   G01  the template plus the line is not recognised    G02  the line goes before the COPY
 *   G03  any Dockerfile holding the line is recognised   G04  the line differs from the hint's
 *   G05  a template with no native/ COPY gets a variant  G06  one with the COPY twice does
 *   G07  the build the hint assumes for a config that names none drifts from core's default builder
 *   G08  the one build the hint speaks to is not the builder core calls vinext
 *   G09  the COPY the hint and the refusal look for drifts from core's    G12  so does the line
 *   G13  the directory pair moves in the package and core's two lines still name /app and /app/native
 *   G14  the pinned syntax line the hint lets through drifts from the shipped template's first line
 *   G10  the refusal's sentence is not built from the line constant (fragment)    G11  nor from the
 *        COPY constant (fragment)
 *   Generate and check (generate-check.test.ts, its own spec)
 *   H01  generate does not print the hint    H02  check does not print the hint
 *   H03  generate ignores the build           H04  check ignores the build
 *   Scan (template-scan.ts, the guard that every printed value went through $show; ffi-loader.test.ts
 *   feeds it a snippet for each sink and requires every one to be seen)
 *   T01  process.stderr.write is no longer a sink    T02  $openFile's 2nd and 4th arguments are not
 *   T03  Reflect.construct of an error class is not  T04  an assignment to .message is not
 *   T05  process.emitWarning is not    T06  Bun.write(Bun.stderr, text) is not
 *   T07  console['warn'](p) is read as another call    T08  a name bound to a sink (const w =
 *   console.warn) is not a sink    T09  a name destructured from one (const { warn } = console) is
 *   not    T10  .bind is not looked through
 *   Second look
 *   S01  the directories are not looked at again       S02  the second look uses stat, not lstat
 *   S03  the second look checks existence, not identity
 *   S04  the manifest's path is not checked again      S05  the library's path is not checked again
 *   S06  the second look on a file checks existence, not identity
 *   Ids
 *   B01  the pin is taken as Numbers                   B02  the second look is taken as Numbers
 *   B03  ids are compared as Numbers (2^53 collides)
 *   The page's commands for a binary run outside a container (doc-recipe.test.ts extracts the block
 *   from the page and runs it, with a recording sudo; each row edits the page's recipe, with a shell
 *   comment as its residue marker)
 *   R01  an empty or relative APP_DIR is accepted     R02  nothing is refused as a system, home or
 *        temporary directory    R03  a directory that holds anything else is accepted
 *   R04  the doubled slashes of //home/me are kept    R05  /dev is not refused
 *   R06  /var/lib is not refused    R07  a directory under the home directory is not refused
 *   R08  a parent of the home directory is not refused    R09  native/ need not hold its manifest
 *   R16  the commands run under any shell (zsh stops on a glob that matches nothing, and `local` is not POSIX)
 *   R17 to R19  /private/tmp, /private/var, /private/etc are not refused (macOS)
 *   R20  hidden entries are not listed    R21  an entry starting with two dots is not
 *   R22  a link that points nowhere is not an entry
 *   R10  native/ may be a link    R11  the executable may be anything that exists
 *   R12  more than one other entry is accepted    R13  the commands run on APP_DIR as typed, not on
 *        the checked real directory    R14  a path that does not exist is not refused as that
 *   R15  /usr/local/<app> is refused (a prefix test, not the directory itself)
 *   The musl lane (workflow-ffi-e2e-lane.test.ts)
 *   Y01  the staged directory of an earlier run is not cleared before it is made again
 *   Y02  the page's commands are not run on the staged copy
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
  {
    id: 'T05',
    subject: 'scan',
    claim:
      'process.emitWarning is no longer a sink: a value handed to it is not required to be shown',
    anchor: "  'process.emitWarning',\n",
    replacement: '\n',
  },
  {
    id: 'T06',
    subject: 'scan',
    claim:
      'Bun.write(Bun.stderr, text) is no longer a sink: what follows the stream is not required to be shown',
    anchor: "const STREAM_WRITERS = new Set(['Bun.write']);\n",
    replacement: 'const STREAM_WRITERS = new Set<string>([]);\n',
  },
  {
    id: 'T07',
    subject: 'scan',
    claim:
      "console['warn'](p) is read as another call than console.warn(p): a spelling hides the sink",
    anchor:
      '  if (ts.isElementAccessExpression(u) && ts.isStringLiteralLike(u.argumentExpression)) {\n',
    replacement: '  if (false as boolean) {\n',
  },
  {
    id: 'T08',
    subject: 'scan',
    claim:
      'a name bound to a sink (const w = console.warn) is not a sink: w(p) is not required to show p',
    anchor: '        isSinkName(boundName(node.initializer, sf))\n',
    replacement: '        false\n',
  },
  {
    id: 'T09',
    subject: 'scan',
    claim: 'a name destructured from a sink object (const { warn } = console) is not a sink',
    anchor: '          if (isSinkName(`${base}.${prop}`)) add(el.name.text);\n',
    replacement: '\n',
  },
  {
    id: 'T10',
    subject: 'scan',
    claim: '.bind is not looked through: console.warn.bind(console) is not a sink',
    anchor: "    if (callee.endsWith('.bind')) return callee.slice(0, -'.bind'.length);\n",
    replacement: '\n',
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
    anchor: '      else if (sticky) move = true;\n',
    replacement: '      else if (false as boolean) move = true;\n',
  },
  {
    id: 'A02',
    subject: 'render',
    claim:
      "the executable's own directory is left out of the move advice: a sticky one (the app dropped into a /tmp) is given the conditional advice",
    anchor: '      else if (sticky) move = true;\n',
    replacement: '      else if (i > inside && sticky) move = true;\n',
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
    anchor: '      const sticky = i >= inside && (Number(st.mode) & 0o1000) !== 0;\n',
    replacement: '      const sticky = i >= inside && (Number(st.mode) & 0o2000) !== 0;\n',
  },
  {
    id: 'A07',
    subject: 'render',
    claim:
      'a world-writable directory that is not sticky (chmod 777 /app) is told only to move the install: the world-write bit is counted as shared, which was the rule before the sticky bit alone decided',
    anchor: '      const sticky = i >= inside && (Number(st.mode) & 0o1000) !== 0;\n',
    replacement: '      const sticky = i >= inside && (Number(st.mode) & 0o1002) !== 0;\n',
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
      '      const sticky = i >= inside && (Number(st.mode) & 0o1000) !== 0;\n      if (i < inside) fix = true;\n      else if (sticky) move = true;\n',
    replacement:
      '      const sticky = (Number(st.mode) & 0o1000) !== 0;\n      if (sticky) move = true;\n      else if (i < inside) fix = true;\n',
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
    id: 'C15',
    subject: 'render',
    claim:
      'the printing of a value can throw: an error value with no prototype, or a toString that throws, takes the refusal down with a TypeError instead of being shown',
    anchor: "  try {\n    text = String(p);\n  } catch {\n    text = '[object Object]';\n  }\n",
    replacement: '  text = String(p);\n',
  },
  {
    id: 'C08',
    subject: 'render',
    claim:
      'every Unicode format character (category Cf) in a directory name is printed as itself: the bidirectional controls, the zero-width characters, the soft hyphen and the tag characters all read as nothing or reorder the text around them',
    anchor: String.raw`      /\\p{Cf}/u.test(ch)` + '\n',
    replacement: '      false\n',
  },
  {
    id: 'C09',
    subject: 'render',
    claim:
      'the soft hyphen (U+00AD, invisible in a terminal) in a directory name is printed as itself',
    anchor: String.raw`      /\\p{Cf}/u.test(ch)` + '\n',
    replacement: String.raw`      (/\\p{Cf}/u.test(ch) && n !== 0xad)` + '\n',
  },
  {
    id: 'C10',
    subject: 'render',
    claim:
      'the Unicode tag characters (U+E0001, U+E0020 to U+E007F, which spell a string nobody sees) in a directory name are printed as themselves',
    anchor: String.raw`      /\\p{Cf}/u.test(ch)` + '\n',
    replacement: String.raw`      (/\\p{Cf}/u.test(ch) && n < 0xe0000)` + '\n',
  },
  {
    id: 'C11',
    subject: 'render',
    claim:
      'the invisible operators (U+2061 to U+2064) in a directory name are printed as themselves',
    anchor: String.raw`      /\\p{Cf}/u.test(ch)` + '\n',
    replacement: String.raw`      (/\\p{Cf}/u.test(ch) && !(n >= 0x2061 && n <= 0x2064))` + '\n',
  },
  {
    id: 'C12',
    subject: 'render',
    claim:
      'the bidirectional embeddings and overrides (U+202A to U+202E) in a directory name are printed as themselves: a right-to-left override reorders the text around it',
    anchor: String.raw`      /\\p{Cf}/u.test(ch)` + '\n',
    replacement: String.raw`      (/\\p{Cf}/u.test(ch) && !(n >= 0x202a && n <= 0x202e))` + '\n',
  },
  {
    id: 'C13',
    subject: 'render',
    claim:
      'the zero-width characters and the direction marks (U+200B to U+200F) in a directory name are printed as themselves: a name that holds one reads as the name without it',
    anchor: String.raw`      /\\p{Cf}/u.test(ch)` + '\n',
    replacement: String.raw`      (/\\p{Cf}/u.test(ch) && !(n >= 0x200b && n <= 0x200f))` + '\n',
  },
  {
    id: 'C14',
    subject: 'render',
    claim: 'the byte order mark (U+FEFF) in a directory name is printed as itself',
    anchor: String.raw`      /\\p{Cf}/u.test(ch)` + '\n',
    replacement: String.raw`      (/\\p{Cf}/u.test(ch) && n !== 0xfeff)` + '\n',
  },
  {
    id: 'C16',
    subject: 'render',
    claim:
      'the combining grapheme joiner (U+034F, invisible though not a format character) in a directory name is printed as itself',
    anchor: '      n === 0x34f ||\n',
    replacement: '      false ||\n',
  },
  {
    id: 'C17',
    subject: 'render',
    claim:
      'a lone surrogate (a half of a pair, which a JSON string in the manifest can hold) is printed as itself and turns into U+FFFD or nothing where it lands',
    anchor: '      (n >= 0xd800 && n <= 0xdfff) ||\n',
    replacement: '      false ||\n',
  },
  {
    id: 'C18',
    subject: 'render',
    claim:
      'a character beyond U+FFFF is shown as a four-digit escape that cannot say which character it was (the braces form is dropped)',
    anchor:
      "      out += n > 0xffff ? \\`\\\\\\\\u{\\${n.toString(16)}}\\` : \\`\\\\\\\\u\\${n.toString(16).padStart(4, '0')}\\`;\n",
    replacement: "      out += \\`\\\\\\\\u\\${n.toString(16).padStart(4, '0')}\\`;\n",
  },
  {
    id: 'A14',
    subject: 'render',
    claim:
      'the one Dockerfile line that keeps a vinext app on the known-good path is never named in the refusal (fragment)',
    anchor: '\\${closable ? " In a vinext app\'s Dockerfile, put exactly',
    replacement: '\\${false ? " In a vinext app\'s Dockerfile, put exactly',
  },
  {
    id: 'A15',
    subject: 'render',
    claim:
      'the vinext line is named only where a directory inside native/ is fixed in place, and not for the conditional advice (fragment)',
    anchor: '\\${closable ? " In a vinext app\'s Dockerfile, put exactly',
    replacement: '\\${closable && fix ? " In a vinext app\'s Dockerfile, put exactly',
  },
  {
    id: 'A16',
    subject: 'render',
    claim:
      'the vinext line is no longer said to go DIRECTLY after the COPY: any later place reads as fine, and a deploy takes the slower path (fragment)',
    anchor: 'directly after the \\`${VINEXT_NATIVE_COPY}\\` line',
    replacement: 'after the \\`${VINEXT_NATIVE_COPY}\\` line',
  },
  {
    id: 'A19',
    subject: 'render',
    claim:
      'the vinext line is named for any directory that can be fixed in place, /app and /app/native or not: a refusal about /srv/app is told to edit a Dockerfile line that cannot help it (fragment)',
    anchor: '\\${closable ? " In a vinext app\'s Dockerfile, put exactly',
    replacement: '\\${(fix || either) ? " In a vinext app\'s Dockerfile, put exactly',
  },
  {
    id: 'A20',
    subject: 'render',
    claim: '/app/native is not counted among the directories the vinext line closes',
    anchor: '      if (!sticky && ${VINEXT_DIRS_LITERAL}.includes(dir)) closable = true;\n',
    replacement:
      '      if (!sticky && ${VINEXT_DIRS_LITERAL}.slice(0, 1).includes(dir)) closable = true;\n',
  },
  {
    id: 'A21',
    subject: 'render',
    claim: '/app is not counted among the directories the vinext line closes',
    anchor: '      if (!sticky && ${VINEXT_DIRS_LITERAL}.includes(dir)) closable = true;\n',
    replacement:
      '      if (!sticky && ${VINEXT_DIRS_LITERAL}.slice(1).includes(dir)) closable = true;\n',
  },
  {
    id: 'A24',
    subject: 'render',
    claim:
      "a sticky directory counts toward the vinext sentence: a sticky /app (the move's, not the line's) with another failing directory prints a line that fixes neither",
    anchor: '      if (!sticky && ${VINEXT_DIRS_LITERAL}.includes(dir)) closable = true;\n',
    replacement: '      if (${VINEXT_DIRS_LITERAL}.includes(dir)) closable = true;\n',
  },
  {
    id: 'A25',
    subject: 'render',
    claim:
      'any failing directory counts toward the vinext sentence, the pair or not: a refusal about /app/native/ffi is told to add a line that cannot help it',
    anchor: '      if (!sticky && ${VINEXT_DIRS_LITERAL}.includes(dir)) closable = true;\n',
    replacement: '      if (!sticky) closable = true;\n',
  },
  {
    id: 'A22',
    subject: 'render',
    claim:
      'the refusal names another line than the one core recognises: the sentence is not built from the one constant the hint and core hold in step (fragment)',
    anchor: 'put exactly \\`${VINEXT_CLOSE_LINE}\\` directly after',
    replacement: 'put exactly \\`RUN chmod go-w /app\\` directly after',
  },
  {
    id: 'A23',
    subject: 'render',
    claim:
      'the refusal names another COPY than the scaffolded one: the line is said to follow a COPY that is not in the Dockerfile (fragment)',
    anchor: 'directly after the \\`${VINEXT_NATIVE_COPY}\\` line',
    replacement: 'directly after the \\`COPY native /app/native\\` line',
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
      'the value a call returned in place of a 64-bit integer decimal string, quoted when $d64 refuses the result as not one, is printed raw (what a library returned that broke the contract: it can hold a newline) (fragment)',
    anchor: String.raw`expected a 64-bit integer as a decimal string, got \${$show(JSON.stringify(v))}`,
    replacement: String.raw`expected a 64-bit integer as a decimal string, got \${JSON.stringify(v)}`,
  },
  {
    id: 'E16',
    subject: 'render',
    claim:
      'the value a call returned in place of a finite number, quoted when $fin refuses the result, is printed raw (what a library returned that broke the contract) (fragment)',
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
    claim:
      'the one form knext can confirm is told it cannot be confirmed: the hint never goes quiet',
    anchor: "  return why === undefined ? '' : cannotConfirm(why);\n",
    replacement: "  return cannotConfirm(why ?? 'unknown');\n",
  },
  {
    id: 'V03',
    subject: 'vimage',
    claim:
      'the pair names /app/native twice: the line it tells the reader to add leaves /app itself open',
    anchor: "export const VINEXT_DIRS = ['/app', '/app/native'] as const;\n",
    replacement: "export const VINEXT_DIRS = ['/app/native', '/app/native'] as const;\n",
  },
  {
    id: 'V02',
    subject: 'init',
    claim: 'a Dockerfile that does not copy native/ to /app/native is given the vinext hint',
    anchor: "  if (copy === -1) return '';\n",
    replacement: '\n',
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
    anchor:
      'add this one line directly after the \\`COPY\\` that brings native/ in and before \\`USER\\`,',
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
      String.raw`  return abs === undefined ? undefined : posix.normalize(abs).replace(/(?<=.)\/+$/, '');` +
      '\n',
    replacement: '  return abs === undefined ? undefined : posix.normalize(abs);\n',
  },
  {
    id: 'V12',
    subject: 'init',
    claim:
      'a backslash continuation is not joined: a COPY or RUN written over several lines is not read',
    anchor: '    if (CONTINUES.test(piece)) {\n',
    replacement: '    if (false as boolean) {\n',
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
    id: 'V29',
    subject: 'init',
    claim:
      'an app whose config names no build is not read as turbopack (the default): it is told as an unknown build is',
    anchor: '    const build = (config as { build?: unknown }).build ?? DEFAULT_BUILD;\n',
    replacement: '    const build = (config as { build?: unknown }).build;\n',
  },
  {
    id: 'V30',
    subject: 'cli',
    claim:
      "the CLI never reads the app's build: init and generate tell every app, whatever it builds with",
    anchor: '    const build = await appBuild(cwd);\n',
    replacement: '    const build = undefined;\n',
  },
  {
    id: 'V13',
    subject: 'init',
    claim: 'every stage is read, not the final one: a copy in a build stage counts for the image',
    anchor: "  const stage = all.slice(all.map((i) => i.word).lastIndexOf('FROM') + 1);\n",
    replacement: '  const stage = all;\n',
  },
  {
    id: 'V45',
    subject: 'init',
    claim:
      'a COPY destination is compared as written: a relative one, a quoted one or one with a dot is not /app/native',
    anchor: '    if (dest !== undefined && resolvePath(dest, dir) === VINEXT_DIRS[1]) copy = n;\n',
    replacement: '    if (dest !== undefined && dest === VINEXT_DIRS[1]) copy = n;\n',
  },
  {
    id: 'V50',
    subject: 'init',
    claim:
      "a COPY of another destination that merely starts with /app/native (/app/natives) is the app's native/",
    anchor: '    if (dest !== undefined && resolvePath(dest, dir) === VINEXT_DIRS[1]) copy = n;\n',
    replacement:
      '    if (dest !== undefined && resolvePath(dest, dir)?.startsWith(VINEXT_DIRS[1])) copy = n;\n',
  },
  {
    id: 'V51',
    subject: 'init',
    claim:
      'the WORKDIR is not tracked: a relative COPY destination under WORKDIR /app is not /app/native',
    anchor: "    if (inst.word === 'WORKDIR') dir = resolvePath(inst.rest, dir);\n",
    replacement: "    if (inst.word === 'WORKDIR') dir = undefined;\n",
  },
  {
    id: 'V52',
    subject: 'init',
    claim:
      'the close line may be anywhere after the COPY: a file that has it later, past a RUN, is not asked to put it directly after',
    anchor: '  if (next?.text !== VINEXT_CLOSE_LINE) return addLine();\n',
    replacement: '  if (next === undefined) return addLine();\n',
  },
  {
    id: 'V53',
    subject: 'init',
    claim:
      'the close line is matched by its start: the line followed by a second command is taken for the line',
    anchor: '  if (next?.text !== VINEXT_CLOSE_LINE) return addLine();\n',
    replacement: '  if (!next?.text.startsWith(VINEXT_CLOSE_LINE)) return addLine();\n',
  },
  {
    id: 'V54',
    subject: 'init',
    claim:
      "the COPY's spelling is not compared: any COPY of native/ to /app/native is the scaffolded one",
    anchor: '    at.first !== at.last || lines[at.first] !== VINEXT_NATIVE_COPY\n',
    replacement: '    false\n',
  },
  {
    id: 'V55',
    subject: 'init',
    claim:
      'the COPY is compared with its spaces trimmed: a space around it is the same bytes (deploy reads it byte for byte)',
    anchor: '    at.first !== at.last || lines[at.first] !== VINEXT_NATIVE_COPY\n',
    replacement: '    at.text !== VINEXT_NATIVE_COPY\n',
  },
  {
    id: 'V56',
    subject: 'init',
    claim:
      'the line need not be the next line of the file: a blank line or a comment between it and the COPY is fine',
    anchor: '      : next.first !== at.last + 1 || lines[next.first] !== VINEXT_CLOSE_LINE\n',
    replacement: '      : lines[next.first] !== VINEXT_CLOSE_LINE\n',
  },
  {
    id: 'V57',
    subject: 'init',
    claim: 'the line is compared with its spaces trimmed: a space around it is the same bytes',
    anchor: '      : next.first !== at.last + 1 || lines[next.first] !== VINEXT_CLOSE_LINE\n',
    replacement: '      : next.first !== at.last + 1 || next.text !== VINEXT_CLOSE_LINE\n',
  },
  {
    id: 'V58',
    subject: 'init',
    claim:
      'a CRLF file is read with its carriage returns on: the scaffolded file with the line is not confirmed',
    anchor: '  const lines = text.split(/\\r?\\n/);\n',
    replacement: "  const lines = text.split('\\n');\n",
  },
  {
    id: 'V59',
    subject: 'init',
    claim:
      'a heredoc is not looked for: a body that reads as the confirmed form, ended by a word that is an allowed instruction, is confirmed',
    anchor:
      "  if (text.includes('<<')) return 'the Dockerfile has a heredoc (`<<`), which knext does not read';\n",
    replacement: '\n',
  },
  {
    id: 'V60',
    subject: 'init',
    claim:
      'a heredoc is looked for only in the forms a reader expects (<<EOF, <<-EOF, <<"EOF"): <<\\EOF is missed',
    anchor:
      "  if (text.includes('<<')) return 'the Dockerfile has a heredoc (`<<`), which knext does not read';\n",
    replacement:
      "  if (/<<-?\\s*[\"']?\\w/.test(text)) return 'the Dockerfile has a heredoc (`<<`), which knext does not read';\n",
  },
  {
    id: 'V61',
    subject: 'init',
    claim:
      'an escape or syntax directive is not looked for: the continuation character moves, a frontend is named, and the file is read differently',
    anchor: '  if (directive !== -1) {\n',
    replacement: '  if (false as boolean) {\n',
  },
  {
    id: 'V62',
    subject: 'init',
    claim:
      'a SHELL instruction is not looked for: it replaces the shell of every RUN, the read-only check included',
    anchor: "  const shell = all.find((inst) => inst.word === 'SHELL');\n",
    replacement: "  const shell = all.slice(0, 0).find((inst) => inst.word === 'SHELL');\n",
  },
  {
    id: 'V63',
    subject: 'init',
    claim:
      'a SHELL is looked for only in the final stage: one in a stage it builds on (`FROM base`) still changes its RUNs',
    anchor: "  const shell = all.find((inst) => inst.word === 'SHELL');\n",
    replacement:
      "  const shell = all.slice(all.map((i) => i.word).lastIndexOf('FROM') + 1).find((inst) => inst.word === 'SHELL');\n",
  },
  {
    id: 'V64',
    subject: 'init',
    claim: 'an instruction knext does not know is taken to leave the directories alone',
    anchor:
      '  return `line ${inst.first + 1} comes after it, and knext does not know that it leaves them alone`;\n',
    replacement: '  return undefined;\n',
  },
  {
    id: 'V65',
    subject: 'init',
    claim: 'any RUN after the line is taken to leave the directories alone',
    anchor:
      "  if (METADATA.has(inst.word) || (inst.word === 'RUN' && READ_ONLY_RUN.test(inst.rest))) {\n",
    replacement: "  if (METADATA.has(inst.word) || inst.word === 'RUN') {\n",
  },
  {
    id: 'V66',
    subject: 'init',
    claim: 'the read-only check is not matched whole: anything after its closing brace is allowed',
    anchor:
      '  /^test[ \\t]+-f[ \\t]+[\\w./-]+[ \\t]+\\|\\|[ \\t]+\\{[ \\t]+echo[ \\t]+"[^"$`\\\\]*"[ \\t]+>&2;[ \\t]+exit[ \\t]+1;[ \\t]+\\}$/;\n',
    replacement:
      '  /^test[ \\t]+-f[ \\t]+[\\w./-]+[ \\t]+\\|\\|[ \\t]+\\{[ \\t]+echo[ \\t]+"[^"$`\\\\]*"[ \\t]+>&2;[ \\t]+exit[ \\t]+1;[ \\t]+\\}/;\n',
  },
  {
    id: 'V67',
    subject: 'init',
    claim: 'the read-only check may start anywhere: a command before it is allowed',
    anchor:
      '  /^test[ \\t]+-f[ \\t]+[\\w./-]+[ \\t]+\\|\\|[ \\t]+\\{[ \\t]+echo[ \\t]+"[^"$`\\\\]*"[ \\t]+>&2;[ \\t]+exit[ \\t]+1;[ \\t]+\\}$/;\n',
    replacement:
      '  /test[ \\t]+-f[ \\t]+[\\w./-]+[ \\t]+\\|\\|[ \\t]+\\{[ \\t]+echo[ \\t]+"[^"$`\\\\]*"[ \\t]+>&2;[ \\t]+exit[ \\t]+1;[ \\t]+\\}$/;\n',
  },
  {
    id: 'V68',
    subject: 'init',
    claim:
      'the text the read-only check prints may hold a dollar sign: a command substitution runs',
    anchor:
      '  /^test[ \\t]+-f[ \\t]+[\\w./-]+[ \\t]+\\|\\|[ \\t]+\\{[ \\t]+echo[ \\t]+"[^"$`\\\\]*"[ \\t]+>&2;[ \\t]+exit[ \\t]+1;[ \\t]+\\}$/;\n',
    replacement:
      '  /^test[ \\t]+-f[ \\t]+[\\w./-]+[ \\t]+\\|\\|[ \\t]+\\{[ \\t]+echo[ \\t]+"[^"`\\\\]*"[ \\t]+>&2;[ \\t]+exit[ \\t]+1;[ \\t]+\\}$/;\n',
  },
  {
    id: 'V69',
    subject: 'init',
    claim: 'the text the read-only check prints may hold a backtick: a command substitution runs',
    anchor:
      '  /^test[ \\t]+-f[ \\t]+[\\w./-]+[ \\t]+\\|\\|[ \\t]+\\{[ \\t]+echo[ \\t]+"[^"$`\\\\]*"[ \\t]+>&2;[ \\t]+exit[ \\t]+1;[ \\t]+\\}$/;\n',
    replacement:
      '  /^test[ \\t]+-f[ \\t]+[\\w./-]+[ \\t]+\\|\\|[ \\t]+\\{[ \\t]+echo[ \\t]+"[^"$\\\\]*"[ \\t]+>&2;[ \\t]+exit[ \\t]+1;[ \\t]+\\}$/;\n',
  },
  {
    id: 'V70',
    subject: 'init',
    claim: 'the text the read-only check prints may hold a backslash',
    anchor:
      '  /^test[ \\t]+-f[ \\t]+[\\w./-]+[ \\t]+\\|\\|[ \\t]+\\{[ \\t]+echo[ \\t]+"[^"$`\\\\]*"[ \\t]+>&2;[ \\t]+exit[ \\t]+1;[ \\t]+\\}$/;\n',
    replacement:
      '  /^test[ \\t]+-f[ \\t]+[\\w./-]+[ \\t]+\\|\\|[ \\t]+\\{[ \\t]+echo[ \\t]+"[^"$`]*"[ \\t]+>&2;[ \\t]+exit[ \\t]+1;[ \\t]+\\}$/;\n',
  },
  {
    id: 'V71',
    subject: 'init',
    claim: 'the path the read-only check tests may be any word: a variable is allowed',
    anchor:
      '  /^test[ \\t]+-f[ \\t]+[\\w./-]+[ \\t]+\\|\\|[ \\t]+\\{[ \\t]+echo[ \\t]+"[^"$`\\\\]*"[ \\t]+>&2;[ \\t]+exit[ \\t]+1;[ \\t]+\\}$/;\n',
    replacement:
      '  /^test[ \\t]+-f[ \\t]+\\S+[ \\t]+\\|\\|[ \\t]+\\{[ \\t]+echo[ \\t]+"[^"$`\\\\]*"[ \\t]+>&2;[ \\t]+exit[ \\t]+1;[ \\t]+\\}$/;\n',
  },
  {
    id: 'V72',
    subject: 'init',
    claim: 'COPY is taken to be an instruction that cannot change a mode',
    anchor: "  'HEALTHCHECK',\n  'STOPSIGNAL',\n",
    replacement: "  'HEALTHCHECK',\n  'STOPSIGNAL',\n  'COPY',\n",
  },
  {
    id: 'V73',
    subject: 'init',
    claim: 'ADD is taken to be an instruction that cannot change a mode',
    anchor: "  'HEALTHCHECK',\n  'STOPSIGNAL',\n",
    replacement: "  'HEALTHCHECK',\n  'STOPSIGNAL',\n  'ADD',\n",
  },
  {
    id: 'V74',
    subject: 'init',
    claim:
      'an ONBUILD instruction is not looked for: a parent stage runs its triggers in the stage that builds on it, a SHELL among them',
    anchor: "  const onbuild = all.find((inst) => inst.word === 'ONBUILD');\n",
    replacement: "  const onbuild = all.slice(0, 0).find((inst) => inst.word === 'ONBUILD');\n",
  },
  {
    id: 'V75',
    subject: 'init',
    claim: 'VOLUME is taken to be an instruction that cannot change a mode',
    anchor: "  'HEALTHCHECK',\n  'STOPSIGNAL',\n",
    replacement: "  'HEALTHCHECK',\n  'STOPSIGNAL',\n  'VOLUME',\n",
  },
  {
    id: 'V76',
    subject: 'init',
    claim:
      '`RUN sudo -n chmod -R 777 /app` after the line is taken to leave the directories alone (sudo -n: the option takes the next word with it)',
    anchor:
      "  if (METADATA.has(inst.word) || (inst.word === 'RUN' && READ_ONLY_RUN.test(inst.rest))) {\n",
    replacement:
      '  if (METADATA.has(inst.word) || (inst.word === \'RUN\' && (READ_ONLY_RUN.test(inst.rest) || inst.rest === "sudo -n chmod -R 777 /app"))) {\n',
  },
  {
    id: 'V77',
    subject: 'init',
    claim:
      '`RUN find /app | xargs -r chmod g+w` after the line is taken to leave the directories alone (xargs -r: the paths come from a pipe)',
    anchor:
      "  if (METADATA.has(inst.word) || (inst.word === 'RUN' && READ_ONLY_RUN.test(inst.rest))) {\n",
    replacement:
      '  if (METADATA.has(inst.word) || (inst.word === \'RUN\' && (READ_ONLY_RUN.test(inst.rest) || inst.rest === "find /app | xargs -r chmod g+w"))) {\n',
  },
  {
    id: 'V78',
    subject: 'init',
    claim:
      '`RUN ./fix-perms.sh` after the line is taken to leave the directories alone (a script in the build context)',
    anchor:
      "  if (METADATA.has(inst.word) || (inst.word === 'RUN' && READ_ONLY_RUN.test(inst.rest))) {\n",
    replacement:
      '  if (METADATA.has(inst.word) || (inst.word === \'RUN\' && (READ_ONLY_RUN.test(inst.rest) || inst.rest === "./fix-perms.sh"))) {\n',
  },
  {
    id: 'V79',
    subject: 'init',
    claim:
      '`RUN sh /fix.sh` after the line is taken to leave the directories alone (sh with a script and no -c)',
    anchor:
      "  if (METADATA.has(inst.word) || (inst.word === 'RUN' && READ_ONLY_RUN.test(inst.rest))) {\n",
    replacement:
      '  if (METADATA.has(inst.word) || (inst.word === \'RUN\' && (READ_ONLY_RUN.test(inst.rest) || inst.rest === "sh /fix.sh"))) {\n',
  },
  {
    id: 'V80',
    subject: 'init',
    claim:
      '`RUN install -d -m 0777 /app` after the line is taken to leave the directories alone (install -d -m)',
    anchor:
      "  if (METADATA.has(inst.word) || (inst.word === 'RUN' && READ_ONLY_RUN.test(inst.rest))) {\n",
    replacement:
      '  if (METADATA.has(inst.word) || (inst.word === \'RUN\' && (READ_ONLY_RUN.test(inst.rest) || inst.rest === "install -d -m 0777 /app"))) {\n',
  },
  {
    id: 'V81',
    subject: 'init',
    claim:
      '`RUN install -m 0666 x /app/native/x` after the line is taken to leave the directories alone (install -m)',
    anchor:
      "  if (METADATA.has(inst.word) || (inst.word === 'RUN' && READ_ONLY_RUN.test(inst.rest))) {\n",
    replacement:
      '  if (METADATA.has(inst.word) || (inst.word === \'RUN\' && (READ_ONLY_RUN.test(inst.rest) || inst.rest === "install -m 0666 x /app/native/x"))) {\n',
  },
  {
    id: 'V82',
    subject: 'init',
    claim:
      '`RUN mkdir -m 777 /app/data` after the line is taken to leave the directories alone (mkdir -m)',
    anchor:
      "  if (METADATA.has(inst.word) || (inst.word === 'RUN' && READ_ONLY_RUN.test(inst.rest))) {\n",
    replacement:
      '  if (METADATA.has(inst.word) || (inst.word === \'RUN\' && (READ_ONLY_RUN.test(inst.rest) || inst.rest === "mkdir -m 777 /app/data"))) {\n',
  },
  {
    id: 'V83',
    subject: 'init',
    claim:
      '`RUN --mount=type=bind,source=.,target=/src chmod -R 777 /app` after the line is taken to leave the directories alone (a RUN with a --mount flag)',
    anchor:
      "  if (METADATA.has(inst.word) || (inst.word === 'RUN' && READ_ONLY_RUN.test(inst.rest))) {\n",
    replacement:
      '  if (METADATA.has(inst.word) || (inst.word === \'RUN\' && (READ_ONLY_RUN.test(inst.rest) || inst.rest === "--mount=type=bind,source=.,target=/src chmod -R 777 /app"))) {\n',
  },
  {
    id: 'V84',
    subject: 'init',
    claim:
      '`RUN cd -P /app && chmod g+w .` after the line is taken to leave the directories alone (cd -P: the flag is not the directory)',
    anchor:
      "  if (METADATA.has(inst.word) || (inst.word === 'RUN' && READ_ONLY_RUN.test(inst.rest))) {\n",
    replacement:
      '  if (METADATA.has(inst.word) || (inst.word === \'RUN\' && (READ_ONLY_RUN.test(inst.rest) || inst.rest === "cd -P /app && chmod g+w ."))) {\n',
  },
  {
    id: 'V85',
    subject: 'init',
    claim:
      '`RUN chmod g+w /app` after the line is taken to leave the directories alone (a plain chmod that opens /app)',
    anchor:
      "  if (METADATA.has(inst.word) || (inst.word === 'RUN' && READ_ONLY_RUN.test(inst.rest))) {\n",
    replacement:
      '  if (METADATA.has(inst.word) || (inst.word === \'RUN\' && (READ_ONLY_RUN.test(inst.rest) || inst.rest === "chmod g+w /app"))) {\n',
  },
  {
    id: 'V86',
    subject: 'init',
    claim:
      '`RUN chown -R app /app` after the line is taken to leave the directories alone (a chown to the app user)',
    anchor:
      "  if (METADATA.has(inst.word) || (inst.word === 'RUN' && READ_ONLY_RUN.test(inst.rest))) {\n",
    replacement:
      '  if (METADATA.has(inst.word) || (inst.word === \'RUN\' && (READ_ONLY_RUN.test(inst.rest) || inst.rest === "chown -R app /app"))) {\n',
  },
  {
    id: 'V87',
    subject: 'init',
    claim:
      '`RUN ["chmod", "777", "/app"]` after the line is taken to leave the directories alone (the exec form)',
    anchor:
      "  if (METADATA.has(inst.word) || (inst.word === 'RUN' && READ_ONLY_RUN.test(inst.rest))) {\n",
    replacement:
      '  if (METADATA.has(inst.word) || (inst.word === \'RUN\' && (READ_ONLY_RUN.test(inst.rest) || inst.rest === "[\\"chmod\\", \\"777\\", \\"/app\\"]"))) {\n',
  },
  {
    id: 'V88',
    subject: 'init',
    claim:
      '`RUN setfacl -m u::rwx /app` after the line is taken to leave the directories alone (an ACL)',
    anchor:
      "  if (METADATA.has(inst.word) || (inst.word === 'RUN' && READ_ONLY_RUN.test(inst.rest))) {\n",
    replacement:
      '  if (METADATA.has(inst.word) || (inst.word === \'RUN\' && (READ_ONLY_RUN.test(inst.rest) || inst.rest === "setfacl -m u::rwx /app"))) {\n',
  },
  {
    id: 'V89',
    subject: 'init',
    claim:
      '`RUN umask 000 && mkdir /app/x` after the line is taken to leave the directories alone (a umask)',
    anchor:
      "  if (METADATA.has(inst.word) || (inst.word === 'RUN' && READ_ONLY_RUN.test(inst.rest))) {\n",
    replacement:
      '  if (METADATA.has(inst.word) || (inst.word === \'RUN\' && (READ_ONLY_RUN.test(inst.rest) || inst.rest === "umask 000 && mkdir /app/x"))) {\n',
  },
  {
    id: 'V90',
    subject: 'init',
    claim:
      '`RUN python3 -c "import os; os.chmod(\'/app\', 0o777)"` after the line is taken to leave the directories alone (an interpreter (python))',
    anchor:
      "  if (METADATA.has(inst.word) || (inst.word === 'RUN' && READ_ONLY_RUN.test(inst.rest))) {\n",
    replacement:
      '  if (METADATA.has(inst.word) || (inst.word === \'RUN\' && (READ_ONLY_RUN.test(inst.rest) || inst.rest === "python3 -c \\"import os; os.chmod(\'/app\', 0o777)\\""))) {\n',
  },
  {
    id: 'V91',
    subject: 'init',
    claim:
      "`RUN node -e \"require('fs').chmodSync('/app', 0o777)\"` after the line is taken to leave the directories alone (an interpreter (node))",
    anchor:
      "  if (METADATA.has(inst.word) || (inst.word === 'RUN' && READ_ONLY_RUN.test(inst.rest))) {\n",
    replacement:
      "  if (METADATA.has(inst.word) || (inst.word === 'RUN' && (READ_ONLY_RUN.test(inst.rest) || inst.rest === \"node -e \\\"require('fs').chmodSync('/app', 0o777)\\\"\"))) {\n",
  },
  {
    id: 'V92',
    subject: 'init',
    claim:
      '`RUN perl -e "chmod 0777, q(/app)"` after the line is taken to leave the directories alone (an interpreter (perl))',
    anchor:
      "  if (METADATA.has(inst.word) || (inst.word === 'RUN' && READ_ONLY_RUN.test(inst.rest))) {\n",
    replacement:
      '  if (METADATA.has(inst.word) || (inst.word === \'RUN\' && (READ_ONLY_RUN.test(inst.rest) || inst.rest === "perl -e \\"chmod 0777, q(/app)\\""))) {\n',
  },
  {
    id: 'V93',
    subject: 'init',
    claim:
      '`RUN true` after the line is taken to leave the directories alone (a command that does nothing)',
    anchor:
      "  if (METADATA.has(inst.word) || (inst.word === 'RUN' && READ_ONLY_RUN.test(inst.rest))) {\n",
    replacement:
      '  if (METADATA.has(inst.word) || (inst.word === \'RUN\' && (READ_ONLY_RUN.test(inst.rest) || inst.rest === "true"))) {\n',
  },
  {
    id: 'V94',
    subject: 'init',
    claim:
      '`RUN echo hi` after the line is taken to leave the directories alone (a command that only prints)',
    anchor:
      "  if (METADATA.has(inst.word) || (inst.word === 'RUN' && READ_ONLY_RUN.test(inst.rest))) {\n",
    replacement:
      '  if (METADATA.has(inst.word) || (inst.word === \'RUN\' && (READ_ONLY_RUN.test(inst.rest) || inst.rest === "echo hi"))) {\n',
  },
  {
    id: 'V95',
    subject: 'init',
    claim:
      "a heredoc into cat that writes a script (`RUN cat > /entry.sh <<'ENV'`) is let through: its body is read as Dockerfile instructions",
    anchor:
      "  if (text.includes('<<')) return 'the Dockerfile has a heredoc (`<<`), which knext does not read';\n",
    replacement:
      "  if (text.includes('<<') && !text.includes(\"cat > /entry.sh <<'ENV'\")) return 'the Dockerfile has a heredoc (`<<`), which knext does not read';\n",
  },
  {
    id: 'V96',
    subject: 'init',
    claim: 'the cannot-confirm message says the loader should accept the directories (fragment)',
    anchor:
      'This is not a finding that the loader will refuse them: knext does not read what your commands do, so it cannot confirm either way',
    replacement:
      'The loader should accept them: knext does not read what your commands do, so it cannot confirm either way',
  },
  {
    id: 'V97',
    subject: 'init',
    claim:
      'the add-this-line message says the loader should accept a Dockerfile that closes them another way (fragment)',
    anchor: 'A Dockerfile that closes them another way may load, but knext does not read it',
    replacement:
      'The loader should accept a Dockerfile that closes them another way, but knext does not read it',
  },
  {
    id: 'V98',
    subject: 'init',
    claim:
      'the cannot-confirm message prints the text of the instruction it did not know (a control character in it reaches the terminal)',
    anchor:
      '  return `line ${inst.first + 1} comes after it, and knext does not know that it leaves them alone`;\n',
    replacement:
      '  return `${inst.text} comes after it, and knext does not know that it leaves them alone`;\n',
  },
  {
    id: 'V99',
    subject: 'init',
    claim:
      'a character a reader may take for something else is not looked for at all: a BOM, a no-break space or a form feed passes',
    anchor: '  const bad = text.search(UNREADABLE);\n',
    replacement: '  const bad = -1;\n',
  },
  {
    id: 'V100',
    subject: 'init',
    claim: 'control characters (a form feed, a vertical tab, U+0085, NUL, ESC) are not unreadable',
    anchor: 'const UNREADABLE = /(?![\\t\\n\\r ])[\\p{Cc}\\p{Cf}\\p{Z}\\ufffd]|\\r(?!\\n)/u;\n',
    replacement: 'const UNREADABLE = /(?![\\t\\n\\r ])[\\p{Cf}\\p{Z}\\ufffd]|\\r(?!\\n)/u;\n',
  },
  {
    id: 'V101',
    subject: 'init',
    claim:
      'invisible format characters (a byte-order mark, a zero-width space, a soft hyphen) are not unreadable',
    anchor: 'const UNREADABLE = /(?![\\t\\n\\r ])[\\p{Cc}\\p{Cf}\\p{Z}\\ufffd]|\\r(?!\\n)/u;\n',
    replacement: 'const UNREADABLE = /(?![\\t\\n\\r ])[\\p{Cc}\\p{Z}\\ufffd]|\\r(?!\\n)/u;\n',
  },
  {
    id: 'V102',
    subject: 'init',
    claim: 'space-like characters (a no-break space, U+2028, U+2029, U+3000) are not unreadable',
    anchor: 'const UNREADABLE = /(?![\\t\\n\\r ])[\\p{Cc}\\p{Cf}\\p{Z}\\ufffd]|\\r(?!\\n)/u;\n',
    replacement: 'const UNREADABLE = /(?![\\t\\n\\r ])[\\p{Cc}\\p{Cf}\\ufffd]|\\r(?!\\n)/u;\n',
  },
  {
    id: 'V103',
    subject: 'init',
    claim: 'an invalid byte (read as U+FFFD) is not unreadable',
    anchor: 'const UNREADABLE = /(?![\\t\\n\\r ])[\\p{Cc}\\p{Cf}\\p{Z}\\ufffd]|\\r(?!\\n)/u;\n',
    replacement: 'const UNREADABLE = /(?![\\t\\n\\r ])[\\p{Cc}\\p{Cf}\\p{Z}]|\\r(?!\\n)/u;\n',
  },
  {
    id: 'V104',
    subject: 'init',
    claim: 'a carriage return that does not end a line is not unreadable',
    anchor: 'const UNREADABLE = /(?![\\t\\n\\r ])[\\p{Cc}\\p{Cf}\\p{Z}\\ufffd]|\\r(?!\\n)/u;\n',
    replacement: 'const UNREADABLE = /(?![\\t\\n\\r ])[\\p{Cc}\\p{Cf}\\p{Z}\\ufffd]/u;\n',
  },
  {
    id: 'V105',
    subject: 'init',
    claim:
      'a plain space, tab and line end are unreadable too (the lookahead is gone): every Dockerfile is',
    anchor: 'const UNREADABLE = /(?![\\t\\n\\r ])[\\p{Cc}\\p{Cf}\\p{Z}\\ufffd]|\\r(?!\\n)/u;\n',
    replacement: 'const UNREADABLE = /[\\p{Cc}\\p{Cf}\\p{Z}\\ufffd]|\\r(?!\\n)/u;\n',
  },
  {
    id: 'V106',
    subject: 'init',
    claim: 'the line number the message gives for such a character is off by one (fragment)',
    anchor: "${text.slice(0, bad).split('\\n').length}",
    replacement: "${text.slice(0, bad).split('\\n').length + 1}",
  },
  {
    id: 'V107',
    subject: 'init',
    claim:
      'a file that is not clean as a whole is never told anything: it is taken for one with nothing to say',
    anchor:
      "  if (unclean !== undefined) return /native/i.test(text) ? cannotConfirm(unclean) : '';\n",
    replacement: "  if (unclean !== undefined) return '';\n",
  },
  {
    id: 'V108',
    subject: 'init',
    claim: 'a file that is not clean as a whole is told even when it never mentions native/',
    anchor:
      "  if (unclean !== undefined) return /native/i.test(text) ? cannotConfirm(unclean) : '';\n",
    replacement: '  if (unclean !== undefined) return cannotConfirm(unclean);\n',
  },
  {
    id: 'V109',
    subject: 'init',
    claim: 'a file that is not clean as a whole is told only when it mentions native/ with a slash',
    anchor:
      "  if (unclean !== undefined) return /native/i.test(text) ? cannotConfirm(unclean) : '';\n",
    replacement:
      "  if (unclean !== undefined) return /native\\//i.test(text) ? cannotConfirm(unclean) : '';\n",
  },
  {
    id: 'V110',
    subject: 'init',
    claim:
      'a heredoc is looked for only from the last FROM on: a body that holds a FROM line moves the stage and hides it',
    anchor:
      "  if (text.includes('<<')) return 'the Dockerfile has a heredoc (`<<`), which knext does not read';\n",
    replacement:
      "  if (text.slice(text.lastIndexOf('FROM')).includes('<<')) return 'the Dockerfile has a heredoc (`<<`), which knext does not read';\n",
  },
  {
    id: 'V111',
    subject: 'init',
    claim: 'a directive may not be indented: `  # escape=` is not one',
    anchor: 'const DIRECTIVE = /^[ \\t]*#[ \\t]*(?:escape|syntax)[ \\t]*=/i;\n',
    replacement: 'const DIRECTIVE = /^#[ \\t]*(?:escape|syntax)[ \\t]*=/i;\n',
  },
  {
    id: 'V112',
    subject: 'init',
    claim: 'a directive is case-sensitive: `# ESCAPE=` is not one',
    anchor: 'const DIRECTIVE = /^[ \\t]*#[ \\t]*(?:escape|syntax)[ \\t]*=/i;\n',
    replacement: 'const DIRECTIVE = /^[ \\t]*#[ \\t]*(?:escape|syntax)[ \\t]*=/;\n',
  },
  {
    id: 'V113',
    subject: 'init',
    claim:
      'only an escape directive is looked for: a syntax directive names a frontend that reads the file differently',
    anchor: 'const DIRECTIVE = /^[ \\t]*#[ \\t]*(?:escape|syntax)[ \\t]*=/i;\n',
    replacement: 'const DIRECTIVE = /^[ \\t]*#[ \\t]*(?:escape)[ \\t]*=/i;\n',
  },
  {
    id: 'V114',
    subject: 'init',
    claim:
      'only a syntax directive is looked for: an escape directive moves the continuation character',
    anchor: 'const DIRECTIVE = /^[ \\t]*#[ \\t]*(?:escape|syntax)[ \\t]*=/i;\n',
    replacement: 'const DIRECTIVE = /^[ \\t]*#[ \\t]*(?:syntax)[ \\t]*=/i;\n',
  },
  {
    id: 'V115',
    subject: 'init',
    claim: 'a directive needs no space or none after the hash: `#escape=` is not one',
    anchor: 'const DIRECTIVE = /^[ \\t]*#[ \\t]*(?:escape|syntax)[ \\t]*=/i;\n',
    replacement: 'const DIRECTIVE = /^[ \\t]*#[ ](?:escape|syntax)[ \\t]*=/i;\n',
  },
  {
    id: 'V116',
    subject: 'init',
    claim:
      "the scaffolded file's pinned syntax line passes on any line, not only as the first: a comment first and the pin second is the scaffolded file",
    anchor: '    (l, n) => DIRECTIVE.test(l) && !(n === 0 && l === VINEXT_SYNTAX_LINE),\n',
    replacement: '    (l, n) => DIRECTIVE.test(l) && !(l === VINEXT_SYNTAX_LINE),\n',
  },
  {
    id: 'V117',
    subject: 'init',
    claim:
      "the scaffolded file's pinned syntax line passes when it is not byte for byte: any pinned official frontend, a trailing space",
    anchor: '    (l, n) => DIRECTIVE.test(l) && !(n === 0 && l === VINEXT_SYNTAX_LINE),\n',
    replacement:
      "    (l, n) => DIRECTIVE.test(l) && !(n === 0 && l.startsWith('# syntax=docker/dockerfile:')),\n",
  },
  {
    id: 'V118',
    subject: 'init',
    claim:
      "the scaffolded file's pinned syntax line is not let through: every app that followed the advice is told it cannot be confirmed",
    anchor: '    (l, n) => DIRECTIVE.test(l) && !(n === 0 && l === VINEXT_SYNTAX_LINE),\n',
    replacement: '    (l, n) => DIRECTIVE.test(l),\n',
  },
  {
    id: 'V119',
    subject: 'init',
    claim:
      'a continuation that runs into the end of the file is dropped: a last instruction ending in a backslash is not read',
    anchor:
      '  if (acc !== undefined) push(acc, lines.length - 1); // a continuation that runs into the end of the file\n',
    replacement: '\n',
  },
  {
    id: 'V120',
    subject: 'init',
    claim:
      'a continued line is joined to the next with a space put between them: BuildKit joins directly, and the close line over two lines is then not its own text',
    anchor: "      acc = (acc ?? '') + piece.replace(CONTINUES, '');\n",
    replacement: "      acc = (acc ?? '') + piece.replace(CONTINUES, '') + ' ';\n",
  },
  {
    id: 'V121',
    subject: 'init',
    claim:
      'the next line of a continuation loses its indent: BuildKit keeps it, so a close line indented over two lines reads as the close line',
    anchor: "    const piece = acc === undefined ? raw.replace(/^[ \\t]+/, '') : raw;\n",
    replacement: "    const piece = raw.replace(/^[ \\t]+/, '');\n",
  },
  {
    id: 'V122',
    subject: 'init',
    claim:
      'the first line of an instruction keeps its indent: BuildKit drops it, and an indented line is read as one that is not the close line',
    anchor: "    const piece = acc === undefined ? raw.replace(/^[ \\t]+/, '') : raw;\n",
    replacement: '    const piece = raw;\n',
  },
  {
    id: 'V123',
    subject: 'init',
    claim:
      'a line that holds only a backslash does not continue: the instruction after it is read on its own, one line off',
    anchor: '    if (CONTINUES.test(piece)) {\n',
    replacement: "    if (CONTINUES.test(piece) && piece.replace(CONTINUES, '') !== '') {\n",
  },
  {
    id: 'V124',
    subject: 'init',
    claim:
      'the keyword is matched from the start of the joined line: an indented line after a lone backslash is not an instruction, and is dropped',
    anchor: '    const m = /^\\s*(\\S+)\\s*(.*)$/.exec(text);\n',
    replacement: '    const m = /^(\\S+)\\s*(.*)$/.exec(text);\n',
  },
  {
    id: 'V125',
    subject: 'init',
    claim:
      'the trailing whitespace of a joined line is kept: a close line followed by a space is the close line',
    anchor: "    const text = logical.replace(/[ \\t\\r]+$/, '');\n",
    replacement: '    const text = logical;\n',
  },
  {
    id: 'V126',
    subject: 'init',
    claim:
      'a backslash continues only when it is the last character: a space or a tab after it ends the continuation',
    anchor: 'const CONTINUES = /\\\\[ \\t]*$/;\n',
    replacement: 'const CONTINUES = /\\\\$/;\n',
  },
  {
    id: 'V127',
    subject: 'init',
    claim:
      'a continuation backslash that no space or tab precedes is not looked for: a lone backslash and a word split in two (`SHE` over `LL`, `<` over `<EOF`) are joined without a gap and read as one thing',
    anchor: '  const glued = lines.findIndex((l) => GLUED_CONTINUATION.test(l));\n',
    replacement: '  const glued = -1;\n',
  },
  {
    id: 'V128',
    subject: 'init',
    claim:
      'a lone backslash is not a glued continuation: the rule needs a character before the backslash',
    anchor: 'const GLUED_CONTINUATION = /(^|[^ \\t])\\\\[ \\t]*$/;\n',
    replacement: 'const GLUED_CONTINUATION = /[^ \\t]\\\\[ \\t]*$/;\n',
  },
  {
    id: 'V129',
    subject: 'init',
    claim:
      'a tab before the backslash counts as no space: the rule refuses a continuation that follows a tab',
    anchor: 'const GLUED_CONTINUATION = /(^|[^ \\t])\\\\[ \\t]*$/;\n',
    replacement: 'const GLUED_CONTINUATION = /(^|[^ ])\\\\[ \\t]*$/;\n',
  },
  {
    id: 'V130',
    subject: 'init',
    claim:
      'spaces and tabs after the backslash end the rule: `SHE\\ ` over `LL` is not a glued continuation',
    anchor: 'const GLUED_CONTINUATION = /(^|[^ \\t])\\\\[ \\t]*$/;\n',
    replacement: 'const GLUED_CONTINUATION = /(^|[^ \\t])\\\\$/;\n',
  },
  {
    id: 'V131',
    subject: 'init',
    claim: 'the glued-continuation message names the line next to it (fragment)',
    anchor: '${glued + 1}',
    replacement: '${glued + 2}',
  },
  {
    id: 'V132',
    subject: 'init',
    claim:
      'the read-only check is for any test (`-d`, `-e`): only the one for a file is on the list',
    anchor:
      '  /^test[ \\t]+-f[ \\t]+[\\w./-]+[ \\t]+\\|\\|[ \\t]+\\{[ \\t]+echo[ \\t]+"[^"$`\\\\]*"[ \\t]+>&2;[ \\t]+exit[ \\t]+1;[ \\t]+\\}$/;\n',
    replacement:
      '  /^test[ \\t]+-[a-z][ \\t]+[\\w./-]+[ \\t]+\\|\\|[ \\t]+\\{[ \\t]+echo[ \\t]+"[^"$`\\\\]*"[ \\t]+>&2;[ \\t]+exit[ \\t]+1;[ \\t]+\\}$/;\n',
  },
  {
    id: 'V133',
    subject: 'init',
    claim:
      'the read-only check is written on one line with single spaces: the scaffolded check, written over several lines and indented, is not it',
    anchor:
      '  /^test[ \\t]+-f[ \\t]+[\\w./-]+[ \\t]+\\|\\|[ \\t]+\\{[ \\t]+echo[ \\t]+"[^"$`\\\\]*"[ \\t]+>&2;[ \\t]+exit[ \\t]+1;[ \\t]+\\}$/;\n',
    replacement: '  /^test -f [\\w./-]+ \\|\\| \\{ echo "[^"$`\\\\]*" >&2; exit 1; \\}$/;\n',
  },
  {
    id: 'V134',
    subject: 'init',
    claim: 'the read-only check takes spaces only between its words: a tab is not one',
    anchor:
      '  /^test[ \\t]+-f[ \\t]+[\\w./-]+[ \\t]+\\|\\|[ \\t]+\\{[ \\t]+echo[ \\t]+"[^"$`\\\\]*"[ \\t]+>&2;[ \\t]+exit[ \\t]+1;[ \\t]+\\}$/;\n',
    replacement:
      '  /^test +-f +[\\w./-]+ +\\|\\| +\\{ +echo +"[^"$`\\\\]*" +>&2; +exit +1; +\\}$/;\n',
  },
  {
    id: 'V135',
    subject: 'init',
    claim:
      'a line that does not start with an instruction Docker knows is not looked for: a `// syntax=` line is taken for an instruction and dropped',
    anchor: '  const unknown = all.find((inst) => !INSTRUCTIONS.has(inst.word));\n',
    replacement:
      '  const unknown = all.slice(0, 0).find((inst) => !INSTRUCTIONS.has(inst.word));\n',
  },
  {
    id: 'V136',
    subject: 'init',
    claim:
      'such a line is looked for only in the final stage: one before the first FROM or in a stage the last builds on is not',
    anchor: '  const unknown = all.find((inst) => !INSTRUCTIONS.has(inst.word));\n',
    replacement:
      "  const unknown = all.slice(all.map((i) => i.word).lastIndexOf('FROM') + 1).find((inst) => !INSTRUCTIONS.has(inst.word));\n",
  },
  {
    id: 'V137',
    subject: 'init',
    claim:
      'the instructions are compared as written, not without regard to case: a lower-case `from` or `run` is not one',
    anchor: '  const unknown = all.find((inst) => !INSTRUCTIONS.has(inst.word));\n',
    replacement:
      "  const unknown = all.find((inst) => !INSTRUCTIONS.has(inst.text.split(/\\s/)[0] ?? ''));\n",
  },
  {
    id: 'V138',
    subject: 'init',
    claim:
      'MAINTAINER is not an instruction Docker knows: a Dockerfile that has one in a build stage is not confirmed',
    anchor: "  'MAINTAINER',\n",
    replacement: '\n',
  },
  {
    id: 'V139',
    subject: 'init',
    claim:
      'VOLUME is not an instruction Docker knows: a Dockerfile that has one in a build stage is not confirmed',
    anchor: "  'VOLUME',\n",
    replacement: '\n',
  },
  {
    id: 'V140',
    subject: 'init',
    claim:
      'ADD is not an instruction Docker knows: a Dockerfile that has one in a build stage is not confirmed',
    anchor: "  'ADD',\n",
    replacement: '\n',
  },
  {
    id: 'V141',
    subject: 'init',
    claim: 'ONBUILD is looked for only in the final stage: a parent stage that has one is not seen',
    anchor: "  const onbuild = all.find((inst) => inst.word === 'ONBUILD');\n",
    replacement:
      "  const onbuild = all.slice(all.map((i) => i.word).lastIndexOf('FROM') + 1).find((inst) => inst.word === 'ONBUILD');\n",
  },
  {
    id: 'V142',
    subject: 'init',
    claim: 'the unknown-instruction message names the line next to it (fragment)',
    anchor: '${unknown.first + 1}',
    replacement: '${unknown.first + 2}',
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
  {
    id: 'G09',
    subject: 'vimage',
    claim:
      'the COPY the hint and the refusal look for drifts from the one core holds (a newline apart is the only difference allowed)',
    anchor:
      'export const VINEXT_NATIVE_COPY = `COPY --chown=0:0 --chmod=a-w native ${VINEXT_DIRS[1]}`;\n',
    replacement:
      'export const VINEXT_NATIVE_COPY = `COPY --chown=0:0 --chmod=a-w native ${VINEXT_DIRS[1]}/`;\n',
  },
  {
    id: 'G10',
    subject: 'render',
    claim:
      'the refusal names another line than the one core recognises: the sentence is not built from the constants (fragment)',
    anchor: 'put exactly \\`${VINEXT_CLOSE_LINE}\\` directly after',
    replacement: 'put exactly \\`RUN chmod go-w /app\\` directly after',
  },
  {
    id: 'G11',
    subject: 'render',
    claim: 'the refusal names another COPY than the one core knows (fragment)',
    anchor: 'directly after the \\`${VINEXT_NATIVE_COPY}\\` line',
    replacement: 'directly after the \\`COPY native /app/native\\` line',
  },
  {
    id: 'G12',
    subject: 'vimage',
    claim: 'the line the hint prints drifts from the one core recognises',
    anchor: "export const VINEXT_CLOSE_LINE = `RUN chmod go-w ${VINEXT_DIRS.join(' ')}`;\n",
    replacement:
      "export const VINEXT_CLOSE_LINE = `RUN chmod go-w ${VINEXT_DIRS.join(' ')} /srv`;\n",
  },
  {
    id: 'G13',
    subject: 'vimage',
    claim:
      "the directory pair moves in the package and core's two lines still name /app and /app/native",
    anchor: "export const VINEXT_DIRS = ['/app', '/app/native'] as const;\n",
    replacement: "export const VINEXT_DIRS = ['/app', '/app/legacy'] as const;\n",
  },
  {
    id: 'G14',
    subject: 'vimage',
    claim:
      "the pinned syntax line the hint lets through drifts from the shipped template's first line",
    anchor:
      "  '# syntax=docker/dockerfile:1.28@sha256:bb22d9815c728170f72750f4e5b0d672e06176142e1d602c7e66c050100b7e5b';\n",
    replacement:
      "  '# syntax=docker/dockerfile:1.29@sha256:bb22d9815c728170f72750f4e5b0d672e06176142e1d602c7e66c050100b7e5b';\n",
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

// The directory pair a vinext image's close line names is defined once (vinext-image.ts). The line, the
// COPY, the generated module's test of which failing directories the line fixes and the hint's reading of
// the COPY are built from it; vinext-pair.test.ts runs the package's own sources, copied, with the pair
// changed in the copy, and requires every one to follow.
const PAIR = [
  {
    id: 'Z01',
    subject: 'vimage',
    claim:
      'the line is typed out, not built from the pair: a pair that moves leaves the line saying /app and /app/native',
    anchor: "export const VINEXT_CLOSE_LINE = `RUN chmod go-w ${VINEXT_DIRS.join(' ')}`;\n",
    replacement: "export const VINEXT_CLOSE_LINE = 'RUN chmod go-w /app /app/native';\n",
  },
  {
    id: 'Z02',
    subject: 'vimage',
    claim: 'the scaffolded COPY is typed out, not built from the pair',
    anchor:
      'export const VINEXT_NATIVE_COPY = `COPY --chown=0:0 --chmod=a-w native ${VINEXT_DIRS[1]}`;\n',
    replacement:
      "export const VINEXT_NATIVE_COPY = 'COPY --chown=0:0 --chmod=a-w native /app/native';\n",
  },
  {
    id: 'Z03',
    subject: 'render',
    claim:
      "the generated module's test of which failing directories the line fixes is typed out, not built from the pair",
    anchor: "const VINEXT_DIRS_LITERAL = `[${VINEXT_DIRS.map((d) => `'${d}'`).join(', ')}]`;\n",
    replacement: "const VINEXT_DIRS_LITERAL = \"['/app', '/app/native']\";\n",
  },
  {
    id: 'Z04',
    subject: 'init',
    claim: "the hint's reading of the COPY (its destination) is typed out, not built from the pair",
    anchor: '    if (dest !== undefined && resolvePath(dest, dir) === VINEXT_DIRS[1]) copy = n;\n',
    replacement:
      "    if (dest !== undefined && resolvePath(dest, dir) === '/app/native') copy = n;\n",
  },
  {
    id: 'Z05',
    subject: 'init',
    claim:
      'the add-this-line message types the first line of its sentence out: /app/native is named whatever the pair is (fragment)',
    anchor: 'Your Dockerfile copies native/ to ${VINEXT_DIRS[1]}.',
    replacement: 'Your Dockerfile copies native/ to /app/native.',
  },
  {
    id: 'Z06',
    subject: 'init',
    claim: 'the directories every message names are typed out, not built from the pair',
    anchor: 'const DIRS = `${VINEXT_DIRS[0]} and ${VINEXT_DIRS[1]}`;\n',
    replacement: "const DIRS = '/app and /app/native';\n",
  },
  {
    id: 'Z07',
    subject: 'init',
    claim: 'the example check in the cannot-confirm message types the path out (fragment)',
    anchor: 'RUN test -f ${VINEXT_DIRS[1]}/.integrity.json',
    replacement: 'RUN test -f /app/native/.integrity.json',
  },
];

// The musl lane's workflow is read as text by its spec, so the lint counts its rows as wiring. The
// page's recipe is run, not read, but through a helper that extracts it (doc-recipe.ts), which the
// lint cannot follow: the rows on the page (R01-R22 and the canary) are unattributed, and they are
// the whole of what the baseline counts. The module that defines the directory pair is not among
// them: vinext-pair.test.ts finds it by what it holds and never names it, so the lint credits the
// specs that import it.
export const WIRING_SUBJECTS = ['lane'];

// The recipe the page gives for a compiled binary run outside a container (doc-recipe.test.ts
// extracts and runs it).
const DOC = [
  {
    id: 'R01',
    subject: 'page',
    claim:
      'an empty or relative APP_DIR is accepted: cd "" stays where it is, and the commands run on whatever that is',
    anchor: '   elif [ -z "${APP_DIR:-}" ] || [ "${APP_DIR#/}" = "$APP_DIR" ]; then\n',
    replacement: '   elif false; then\n',
    options: { commentPrefix: '#' },
  },
  {
    id: 'R02',
    subject: 'page',
    claim: 'no directory is refused as a system, home or temporary directory',
    anchor: '   elif unsafe_dir "$R" "$(real_dir "${HOME:-/}" || echo /)"; then\n',
    replacement: '   elif false; then\n',
    options: { commentPrefix: '#' },
  },
  {
    id: 'R03',
    subject: 'page',
    claim: 'a directory that holds anything but the app is handed to root with all of it',
    anchor: '   elif ! holds_only_app "$R"; then\n',
    replacement: '   elif false; then\n',
    options: { commentPrefix: '#' },
  },
  {
    id: 'R04',
    subject: 'page',
    claim: 'the doubled slashes of //home/me are kept, so it is not read as /home/me',
    anchor: '     lead=${p%%[!/]*}\n',
    replacement: '     lead=\n',
    options: { commentPrefix: '#' },
  },
  {
    id: 'R05',
    subject: 'page',
    claim: '/dev is missing from the system directories',
    anchor:
      '     for d in /bin /boot /dev /etc /lib /lib64 /proc /run /sbin /sys /usr/bin /usr/lib /usr/libexec /usr/sbin /usr/share; do\n',
    replacement:
      '     for d in /bin /boot /etc /lib /lib64 /proc /run /sbin /sys /usr/bin /usr/lib /usr/libexec /usr/sbin /usr/share; do\n',
    options: { commentPrefix: '#' },
  },
  {
    id: 'R06',
    subject: 'page',
    claim: '/var/lib is missing from the directories that are never an app of their own',
    anchor:
      '       / | /opt | /srv | /mnt | /media | /nix | /snap | /usr | /usr/local | /usr/local/bin | /usr/local/lib | /usr/local/sbin | /usr/local/share | /var | /var/cache | /var/lib | /var/log | /var/spool | /var/www) return 0 ;;\n',
    replacement:
      '       / | /opt | /srv | /mnt | /media | /nix | /snap | /usr | /usr/local | /usr/local/bin | /usr/local/lib | /usr/local/sbin | /usr/local/share | /var | /var/cache | /var/log | /var/spool | /var/www) return 0 ;;\n',
    options: { commentPrefix: '#' },
  },
  {
    id: 'R07',
    subject: 'page',
    claim: 'a directory under the home directory is not refused',
    anchor: '     case "$1/" in "$2"/*) return 0 ;; esac\n',
    replacement: '\n',
    options: { commentPrefix: '#' },
  },
  {
    id: 'R08',
    subject: 'page',
    claim: 'a directory that holds the home directory (a parent of it) is not refused',
    anchor: '     case "$2/" in "$1"/*) return 0 ;; esac\n',
    replacement: '\n',
    options: { commentPrefix: '#' },
  },
  {
    id: 'R09',
    subject: 'page',
    claim:
      'native/ is not required to hold its .integrity.json, nor to be a plain directory with a plain manifest',
    anchor:
      '         [ -d "$e" ] && [ ! -L "$e" ] && [ -f "$e/.integrity.json" ] && [ ! -L "$e/.integrity.json" ] || return 1\n',
    replacement: '         [ -d "$e" ] || return 1\n',
    options: { commentPrefix: '#' },
  },
  {
    id: 'R10',
    subject: 'page',
    claim: 'native/ may be a link',
    anchor:
      '         [ -d "$e" ] && [ ! -L "$e" ] && [ -f "$e/.integrity.json" ] && [ ! -L "$e/.integrity.json" ] || return 1\n',
    replacement:
      '         [ -d "$e" ] && [ -f "$e/.integrity.json" ] && [ ! -L "$e/.integrity.json" ] || return 1\n',
    options: { commentPrefix: '#' },
  },
  {
    id: 'R11',
    subject: 'page',
    claim: 'the executable may be anything that exists (a directory, a link)',
    anchor: '         [ -f "$e" ] && [ ! -L "$e" ] || return 1\n',
    replacement: '         [ -e "$e" ] || return 1\n',
    options: { commentPrefix: '#' },
  },
  {
    id: 'R12',
    subject: 'page',
    claim: 'more than one other entry is accepted',
    anchor: '     [ "$native" = 1 ] && [ "$exe" = 1 ]\n',
    replacement: '     [ "$native" = 1 ] && [ "$exe" -ge 1 ]\n',
    options: { commentPrefix: '#' },
  },
  {
    id: 'R13',
    subject: 'page',
    claim: 'the commands run on APP_DIR as typed, not on the real directory that was checked',
    anchor: '     sudo chown -R root:root "$R"\n',
    replacement: '     sudo chown -R root:root "$APP_DIR"\n',
    options: { commentPrefix: '#' },
  },
  {
    id: 'R14',
    subject: 'page',
    claim: 'a failed resolution (a path that does not exist) is let through as the empty path',
    anchor: '   elif ! R=$(real_dir "$APP_DIR"); then\n',
    replacement: '   elif R=$(real_dir "$APP_DIR") && false; then\n',
    options: { commentPrefix: '#' },
  },
  {
    id: 'R15',
    subject: 'page',
    claim:
      '/usr/local/<app> is refused along with /usr/local itself (the check is a prefix, not the directory)',
    anchor:
      '       / | /opt | /srv | /mnt | /media | /nix | /snap | /usr | /usr/local | /usr/local/bin | /usr/local/lib | /usr/local/sbin | /usr/local/share | /var | /var/cache | /var/lib | /var/log | /var/spool | /var/www) return 0 ;;\n',
    replacement:
      '       / | /opt | /srv | /mnt | /media | /nix | /snap | /usr | /usr/local | /usr/local/* | /usr/local/bin | /usr/local/lib | /usr/local/sbin | /usr/local/share | /var | /var/cache | /var/lib | /var/log | /var/spool | /var/www) return 0 ;;\n',
    options: { commentPrefix: '#' },
  },
  {
    id: 'R16',
    subject: 'page',
    claim:
      'the guard against another shell is removed: zsh stops with "no matches found" on a glob that matches nothing and refuses a good directory for the wrong reason, `local` is not POSIX, and dash goes on to hand a directory to root without ever being asked to',
    anchor: '   if [ -z "${BASH_VERSION:-}" ]; then\n',
    replacement: '   if false; then\n',
    options: { commentPrefix: '#' },
  },
  {
    id: 'R17',
    subject: 'page',
    claim:
      '/private/tmp is missing from the places that can hold other things: on macOS /tmp resolves to it',
    anchor:
      '     for d in /tmp /var/tmp /home /Users /root /private/tmp /private/var /private/etc; do\n',
    replacement: '     for d in /tmp /var/tmp /home /Users /root /private/var /private/etc; do\n',
    options: { commentPrefix: '#' },
  },
  {
    id: 'R18',
    subject: 'page',
    claim: '/private/var is missing: on macOS $TMPDIR (/var/folders) resolves under it',
    anchor:
      '     for d in /tmp /var/tmp /home /Users /root /private/tmp /private/var /private/etc; do\n',
    replacement: '     for d in /tmp /var/tmp /home /Users /root /private/tmp /private/etc; do\n',
    options: { commentPrefix: '#' },
  },
  {
    id: 'R19',
    subject: 'page',
    claim: '/private/etc is missing: on macOS /etc resolves to it',
    anchor:
      '     for d in /tmp /var/tmp /home /Users /root /private/tmp /private/var /private/etc; do\n',
    replacement: '     for d in /tmp /var/tmp /home /Users /root /private/tmp /private/var; do\n',
    options: { commentPrefix: '#' },
  },
  {
    id: 'R20',
    subject: 'page',
    claim: 'hidden entries are not listed: a .env in the directory is handed to root with the rest',
    anchor: '     for e in "$1"/* "$1"/.[!.]* "$1"/..?*; do\n',
    replacement: '     for e in "$1"/* "$1"/..?*; do\n',
    options: { commentPrefix: '#' },
  },
  {
    id: 'R21',
    subject: 'page',
    claim: 'an entry whose name starts with two dots is not listed',
    anchor: '     for e in "$1"/* "$1"/.[!.]* "$1"/..?*; do\n',
    replacement: '     for e in "$1"/* "$1"/.[!.]*; do\n',
    options: { commentPrefix: '#' },
  },
  {
    id: 'R22',
    subject: 'page',
    claim:
      'a link that points nowhere is not an entry: the directory holds something the check never sees',
    anchor: '       [ -e "$e" ] || [ -L "$e" ] || continue\n',
    replacement: '       [ -e "$e" ] || continue\n',
    options: { commentPrefix: '#' },
  },
];

// The musl lane stages the directory the page's commands accept (tests/workflow-ffi-e2e-lane.test.ts).
const LANE = [
  {
    id: 'Y01',
    subject: 'lane',
    claim:
      "the staged directory of an earlier run is not cleared: the page's commands see what it left (a reused runner) and refuse, or hand it to root with the leftovers",
    anchor:
      '          sudo rm -rf /opt/knext-ffi-caller\n          sudo install -d -o "$(id -u)" -g "$(id -g)" -m 0755 /opt/knext-ffi-caller\n',
    replacement:
      '          sudo install -d -o "$(id -u)" -g "$(id -g)" -m 0755 /opt/knext-ffi-caller\n',
  },
  {
    id: 'Y02',
    subject: 'lane',
    claim:
      "the page's commands run after the loader loads, not before: the staged copy is the runner's, not root's",
    anchor:
      '          APP_DIR="/opt/knext-ffi-caller" bash -euo pipefail "${RUNNER_TEMP}/own-binary.sh"\n',
    replacement: '          true\n',
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
declareMutations(
  LOADER.length +
    SCAN.length +
    INIT.length +
    KNOWN.length +
    PAIR.length +
    GENERATE.length +
    DOC.length +
    LANE.length,
);

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
  subjects: {
    init: 'packages/ffi/src/init.ts',
    cli: 'packages/ffi/src/cli.ts',
    vimage: 'packages/ffi/src/vinext-image.ts',
  },
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
    vimage: 'packages/ffi/src/vinext-image.ts',
    render: 'packages/ffi/src/render.ts',
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

const pair = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: 'packages/ffi/src/__tests__/vinext-pair.test.ts',
  subjects: {
    init: 'packages/ffi/src/init.ts',
    vimage: 'packages/ffi/src/vinext-image.ts',
    render: 'packages/ffi/src/render.ts',
  },
});
pair.preflight(PAIR);

console.log('\n=== the vinext directory pair is defined once (vinext-pair.test.ts) ===');
pair.baseline();
pair.proveCanSeeRed({
  subject: 'vimage',
  anchor: "export const VINEXT_DIRS = ['/app', '/app/native'] as const;\n",
  replacement: "export const VINEXT_DIRS = ['/app', '/app/legacy'] as const;\n",
});
for (const m of PAIR) {
  pair.run({ ...m, expect: 'red' });
  recordMutation();
}
pair.finish(PAIR.length);

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

const doc = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: 'packages/ffi/src/__tests__/doc-recipe.test.ts',
  subjects: { page: 'apps/docs/content/docs/rust-in-process.mdx' },
});
doc.preflight(DOC);

console.log(
  "\n=== the page's commands for a binary run outside a container (doc-recipe.test.ts) ===",
);
doc.baseline();
doc.proveCanSeeRed({
  subject: 'page',
  anchor: '   elif ! holds_only_app "$R"; then\n',
  replacement: '   elif false; then\n',
  options: { commentPrefix: '#' },
});
for (const m of DOC) {
  doc.run({ ...m, expect: 'red' });
  recordMutation();
}
doc.finish(DOC.length);

const lane = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: 'tests/workflow-ffi-e2e-lane.test.ts',
  subjects: { lane: '.github/workflows/ffi-e2e.yml' },
});
lane.preflight(LANE);

console.log(
  '\n=== the musl lane stages the directory the commands accept (workflow-ffi-e2e-lane.test.ts) ===',
);
lane.baseline();
lane.proveCanSeeRed({
  subject: 'lane',
  anchor:
    '          sudo rm -rf /opt/knext-ffi-caller\n          sudo install -d -o "$(id -u)" -g "$(id -g)" -m 0755 /opt/knext-ffi-caller\n',
  replacement:
    '          sudo install -d -o "$(id -u)" -g "$(id -g)" -m 0755 /opt/knext-ffi-caller\n',
});
for (const m of LANE) {
  lane.run({ ...m, expect: 'red' });
  recordMutation();
}
lane.finish(LANE.length);
