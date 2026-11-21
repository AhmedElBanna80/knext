/**
 * `knext ffi init` (ADR-0069 D11, D12): opt a zone into in-process Rust.
 *
 * Writes `knext.ffi.json` and a starter `rust/` crate from `templates/init/`
 * (every file there, with `.tmpl` stripped and placeholders filled), and
 * refuses to overwrite anything. The crate depends on `knext-ffi` by git at
 * the full commit THIS package records (D3), so the macro that writes the
 * manifest and the generator that reads it always agree on the ABI.
 */

import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, posix, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CONFIG_FILE, DEFAULT_CONFIG, serializeConfig } from './config';
import type { Io } from './generate';
import {
  VINEXT_CLOSE_LINE,
  VINEXT_DIRS,
  VINEXT_NATIVE_COPY,
  VINEXT_SYNTAX_LINE,
} from './vinext-image';

// The two lines are `vinext-image.ts`'s, read by the generator too; re-exported for the callers
// (and the drift test in core's test directory) that have always imported them from here.
export { VINEXT_CLOSE_LINE, VINEXT_DIRS, VINEXT_NATIVE_COPY };

/** The repository the knext-ffi crates are fetched from until they are on crates.io. */
export const CRATE_GIT = 'https://github.com/getknext-dev/knext';

/** `templates/init`, beside `src/` and `dist/` alike. */
export const TEMPLATE_DIR = fileURLToPath(new URL('../templates/init', import.meta.url));

/**
 * The knext-ffi commit this build records (`package.json` `knextFfi.crateRev`),
 * or `null` before any crate revision has been released with it.
 */
export function recordedCrateRev(): string | null {
  const pkg = createRequire(import.meta.url)('../package.json') as {
    knextFfi?: { crateRev?: unknown };
  };
  const rev = pkg.knextFfi?.crateRev;
  return typeof rev === 'string' ? rev : null;
}

function templateFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...templateFiles(p));
    else out.push(p);
  }
  return out.sort();
}

export interface RunInitOptions {
  readonly cwd: string;
  readonly io: Io;
  /** Override the recorded revision (tests); `null` means none is recorded. */
  readonly crateRev?: string | null;
  /** The app's build target (`appBuild`), when known: only a vinext build is told about its Dockerfile. */
  readonly build?: string;
}

/** The `init` verb. Returns the process exit code. */
export function runInit(opts: RunInitOptions): number {
  const { cwd, io } = opts;
  const rev = 'crateRev' in opts ? (opts.crateRev ?? null) : recordedCrateRev();
  if (rev === null) {
    io.stderr(
      'knext ffi init: this build of @getknext/ffi records no knext-ffi crate revision yet, so it cannot write a ' +
        'Cargo.toml cargo can resolve. Use a release of @getknext/ffi that ships one; nothing was written.\n',
    );
    return 1;
  }
  if (!/^[0-9a-f]{40}$/.test(rev)) {
    io.stderr(
      `knext ffi init: the recorded knext-ffi revision "${rev}" is not a full 40-hex commit; nothing was written.\n`,
    );
    return 1;
  }

  const templates = templateFiles(TEMPLATE_DIR).map((src) => ({
    src,
    dest: relative(TEMPLATE_DIR, src).replace(/\.tmpl$/, ''),
  }));
  const tops = [CONFIG_FILE, ...new Set(templates.map((t) => t.dest.split(/[\\/]/)[0] as string))];
  const existing = tops.filter(
    (p) => lstatSync(join(cwd, p), { throwIfNoEntry: false }) !== undefined,
  );
  if (existing.length > 0) {
    io.stderr(
      `knext ffi init: ${existing.map((p) => `${p} already exists`).join(', ')}; nothing was written. ` +
        'Remove it or move it aside to start over.\n',
    );
    return 1;
  }

  for (const t of templates) {
    const target = join(cwd, t.dest);
    mkdirSync(dirname(target), { recursive: true });
    const text = readFileSync(t.src, 'utf8')
      .replaceAll('{{KNEXT_FFI_GIT}}', CRATE_GIT)
      .replaceAll('{{KNEXT_FFI_REV}}', rev);
    writeFileSync(target, text);
  }
  writeFileSync(join(cwd, CONFIG_FILE), serializeConfig(DEFAULT_CONFIG));

  io.stdout(
    `wrote ${CONFIG_FILE} and ${DEFAULT_CONFIG.crate}/ (${templates.length} files).\n` +
      'Next: install Rust (https://rustup.rs), then run `knext ffi generate` to build the crate and write ' +
      `the typed wrapper to ${DEFAULT_CONFIG.out}/.\n${dockerfileHint(cwd, opts.build)}`,
  );
  return 0;
}

/** The build a `knext.config.ts` that names none gets (core's default builder), a standalone one. */
export const DEFAULT_BUILD = 'turbopack';

/** The build whose Dockerfile is the app's own: every other build stages one that already has the line. */
const VINEXT_BUILD = 'vinext';

/**
 * The build target of the app in `cwd`, read the way the CLI reads it: `knext.config.ts`, its default
 * export's `build`, which is `turbopack` when it names none. `undefined` when it cannot be told (no
 * config, one that does not load, one whose `build` is not a string): a Node process cannot import
 * the TypeScript file, for one. Loading the config runs it, as every knext command does.
 */
export async function appBuild(cwd: string): Promise<string | undefined> {
  const file = join(cwd, 'knext.config.ts');
  if (!existsSync(file)) return undefined;
  try {
    const mod = (await import(pathToFileURL(file).href)) as { default?: unknown };
    const config = mod.default;
    if (config === null || typeof config !== 'object') return undefined;
    const build = (config as { build?: unknown }).build ?? DEFAULT_BUILD;
    return typeof build === 'string' ? build : undefined;
  } catch {
    return undefined;
  }
}

/**
 * One instruction of a Dockerfile: its keyword (upper-cased), the rest of its logical line, that
 * line, and the physical lines (0-based) it starts and ends on.
 */
interface Instruction {
  readonly word: string;
  readonly rest: string;
  readonly text: string;
  readonly first: number;
  readonly last: number;
}

/** A line that continues on the next: a backslash, then at most spaces and tabs (BuildKit's `\\[ \t]*$`). */
const CONTINUES = /\\[ \t]*$/;

/**
 * The instructions of a Dockerfile, every stage, with `\` continuations joined and blank and comment
 * lines dropped. It joins as BuildKit does: a continued line loses its backslash (and any spaces and
 * tabs after it) and the next line follows it directly, with no space between and that line's leading
 * whitespace kept; the first line of an instruction loses its leading whitespace; a line that holds
 * only a backslash continues like any other. Lines are trimmed of a space, a tab and a carriage return
 * and nothing else. Not a parser, and not heredoc-aware: `dockerfileHint` never confirms a Dockerfile
 * that has one.
 */
function instructions(lines: readonly string[]): Instruction[] {
  const all: Instruction[] = [];
  let acc: string | undefined; // what has been joined so far, or undefined between instructions
  let first = -1;
  const push = (logical: string, last: number) => {
    const text = logical.replace(/[ \t\r]+$/, '');
    const m = /^\s*(\S+)\s*(.*)$/.exec(text);
    if (m)
      all.push({
        word: (m[1] as string).toUpperCase(),
        rest: m[2] as string,
        text,
        first,
        last,
      });
  };
  for (const [n, raw] of lines.entries()) {
    const line = raw.replace(/^[ \t\r]+|[ \t\r]+$/g, '');
    if (line === '' || line.startsWith('#')) continue; // between instructions or inside a continuation
    if (acc === undefined) first = n;
    const piece = acc === undefined ? raw.replace(/^[ \t]+/, '') : raw;
    if (CONTINUES.test(piece)) {
      acc = (acc ?? '') + piece.replace(CONTINUES, '');
      continue;
    }
    push((acc ?? '') + piece, n);
    acc = undefined;
  }
  if (acc !== undefined) push(acc, lines.length - 1); // a continuation that runs into the end of the file
  return all;
}

/** `text` without one pair of matching quotes around it. */
function unquote(text: string): string {
  const m = /^(["'])(.*)\1$/.exec(text.trim());
  return m ? (m[2] as string) : text.trim();
}

/**
 * `raw` as an absolute, normalised path (`/app/.` and `/app//native/` read as they are), a relative
 * one taken from `cwd`, the working directory. `undefined` when it cannot be told: a variable, a
 * glob, a command substitution, a `~`, or a relative path with no working directory known.
 */
function resolvePath(raw: string, cwd: string | undefined): string | undefined {
  const text = unquote(raw);
  if (/[$`*?[\]{}~]/.test(text)) return undefined;
  const abs = text.startsWith('/') ? text : cwd === undefined ? undefined : `${cwd}/${text}`;
  return abs === undefined ? undefined : posix.normalize(abs).replace(/(?<=.)\/+$/, '');
}

/** The destination of a COPY, in the shell form or the JSON form, flags aside; undefined for one with no source. */
function copyDestination(rest: string): string | undefined {
  const args = rest.replace(/^(?:--\S+\s+)*/, '');
  let parts: string[];
  if (args.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(args);
      if (!Array.isArray(parsed) || !parsed.every((p) => typeof p === 'string')) return undefined;
      parts = parsed;
    } catch {
      return undefined;
    }
  } else {
    parts = args.split(/\s+/).filter((p) => p !== '');
  }
  return parts.length >= 2 ? (parts[parts.length - 1] as string) : undefined;
}

/** The instructions that only describe the image: none of them can change a mode. */
const METADATA = new Set([
  'ENV',
  'ARG',
  'LABEL',
  'EXPOSE',
  'USER',
  'WORKDIR',
  'ENTRYPOINT',
  'CMD',
  'HEALTHCHECK',
  'STOPSIGNAL',
]);

/**
 * The one `RUN` that is known to change nothing: a check that tests a path for being a file and prints
 * (the vinext template's own `test -f /app/native/.integrity.json || { echo "..." >&2; exit 1; }`). The
 * text is a plain double-quoted string, with no expansion in it, and nothing else can be said in this
 * shape. The words are separated by runs of spaces and tabs, because the template writes it over
 * several lines and a joined continuation keeps the next line's indent, as BuildKit joins it.
 */
const READ_ONLY_RUN =
  /^test[ \t]+-f[ \t]+[\w./-]+[ \t]+\|\|[ \t]+\{[ \t]+echo[ \t]+"[^"$`\\]*"[ \t]+>&2;[ \t]+exit[ \t]+1;[ \t]+\}$/;

/** Why an instruction after the close line is not known to leave the two directories closed; undefined when it is. */
function unconfirmed(inst: Instruction): string | undefined {
  if (METADATA.has(inst.word) || (inst.word === 'RUN' && READ_ONLY_RUN.test(inst.rest))) {
    return undefined;
  }
  return `line ${inst.first + 1} comes after it, and knext does not know that it leaves them alone`;
}

/**
 * Text no two readers of a Dockerfile are sure to read alike: a space-like character other than a
 * space and a tab (a byte-order mark, a no-break space, a form feed, a vertical tab, U+2028, U+3000),
 * a control or invisible format character, an invalid byte, or a carriage return that does not end a
 * line. What a reader that trims them sees, BuildKit may see differently (a continuation here, an
 * instruction there), so a Dockerfile that has one is never confirmed. Visible non-ASCII is allowed:
 * the scaffolded Dockerfile's own comments and its check's message carry an em dash, and no reader
 * takes such a character for a space, a line end or a backslash.
 */
const UNREADABLE = /(?![\t\n\r ])[\p{Cc}\p{Cf}\p{Z}\ufffd]|\r(?!\n)/u;

/** A parser directive: `escape` moves the continuation character, `syntax` names the frontend that reads the file. */
const DIRECTIVE = /^[ \t]*#[ \t]*(?:escape|syntax)[ \t]*=/i;

/**
 * A line that ends in a continuation backslash with nothing before it, or a character that is not a
 * space or a tab: a backslash alone at the start of a line, or a word split in two (`SHE\` over `LL`, `<\` over `<EOF`). Joined
 * as BuildKit joins, with nothing between, such a line makes a word the file does not show on any one
 * line. The scaffolded file's continuations all follow a space.
 */
const GLUED_CONTINUATION = /(^|[^ \t])\\[ \t]*$/;

/**
 * The instructions of a Dockerfile (BuildKit's, case-insensitive). `SHELL` and `ONBUILD` are not among
 * them on purpose: each is refused by name below, because each changes what a `RUN` that follows runs.
 */
const INSTRUCTIONS = new Set([
  'FROM',
  'RUN',
  'CMD',
  'LABEL',
  'MAINTAINER',
  'EXPOSE',
  'ENV',
  'ADD',
  'COPY',
  'ENTRYPOINT',
  'VOLUME',
  'USER',
  'WORKDIR',
  'ARG',
  'STOPSIGNAL',
  'HEALTHCHECK',
]);

/**
 * Why a Dockerfile is not one whose reading knext can be sure of, whatever else it holds (checked
 * before anything is cut out of it); undefined when it is. The scaffolded file's own pinned `syntax`
 * line, as its first line and byte for byte, is the one directive let through.
 */
function unreadable(
  text: string,
  lines: readonly string[],
  all: readonly Instruction[],
): string | undefined {
  const bad = text.search(UNREADABLE);
  if (bad !== -1) {
    return `line ${text.slice(0, bad).split('\n').length} has a character that is not plain text (a byte-order mark, a no-break space or another space-like or invisible one), which another reader may take for something else`;
  }
  const glued = lines.findIndex((l) => GLUED_CONTINUATION.test(l));
  if (glued !== -1) {
    return `line ${glued + 1} ends in a backslash that no space or tab precedes (a backslash alone at the start of a line, or a word split in two), which joins to the next line without a gap`;
  }
  if (text.includes('<<')) return 'the Dockerfile has a heredoc (`<<`), which knext does not read';
  const directive = lines.findIndex(
    (l, n) => DIRECTIVE.test(l) && !(n === 0 && l === VINEXT_SYNTAX_LINE),
  );
  if (directive !== -1) {
    return `line ${directive + 1} is a parser directive (\`escape\` or \`syntax\`), which changes how the file is read`;
  }
  const shell = all.find((inst) => inst.word === 'SHELL');
  if (shell !== undefined) {
    return 'a SHELL instruction (refused in any stage) changes how every RUN is run';
  }
  const onbuild = all.find((inst) => inst.word === 'ONBUILD');
  if (onbuild !== undefined) {
    return 'an ONBUILD instruction (refused in any stage) runs another instruction, a SHELL included, in every stage built on it';
  }
  const unknown = all.find((inst) => !INSTRUCTIONS.has(inst.word));
  return unknown === undefined
    ? undefined
    : `line ${unknown.first + 1} has an instruction whose first word is not one Docker knows (a comment starts with \`#\`, and BuildKit also reads a \`// syntax=\` line as a directive)`;
}

/**
 * The instructions of a Dockerfile, read loosely, for one question only: is `native` in one of them.
 * A backslash or a backtick ends a line that continues (BuildKit continues on a backtick under an
 * `escape` directive), the lines are joined with nothing between, a line that is blank or starts with
 * `#` once any leading space-like character is cut off is dropped (BuildKit trims with Go's
 * `unicode.IsSpace`, which JavaScript's `\s` and U+0085 cover), and every carriage return at a line
 * end goes, so a doubled one cannot hide a continuation. A loose reading can only find a word that a
 * stricter one would not, so a mistake here makes the hint speak more, never less.
 */
function looseInstructions(text: string): string[] {
  const out: string[] = [];
  let acc = '';
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r+$/, '');
    const bare = line.replace(/^[\s\u0085]+/, '');
    if (bare === '' || bare.startsWith('#')) continue;
    const continued = /[\\`][ \t]*$/.exec(line);
    if (continued === null) {
      out.push(acc + line);
      acc = '';
    } else {
      acc += line.slice(0, continued.index);
    }
  }
  if (acc !== '') out.push(acc);
  return out;
}

/**
 * Whether a Dockerfile mentions native at all, in any of three readings: its text; its instructions as
 * `instructions` joins them (a backslash continues, a space, a tab and a carriage return are trimmed);
 * and the same text read loosely (`looseInstructions`). A continuation can split the word (`nat` over
 * `ive`) with a comment line between the pieces, and a reading that is exact about one rule of
 * BuildKit's is wrong about another (an `escape` directive, a comment led by a no-break space, a
 * doubled carriage return), so no one reading is trusted to see a `COPY` of `native/` that BuildKit reads.
 */
function mentionsNative(text: string, all: readonly Instruction[]): boolean {
  return (
    /native/i.test(text) ||
    all.some((inst) => /native/i.test(inst.text)) ||
    looseInstructions(text).some((inst) => /native/i.test(inst))
  );
}

const DIRS = `${VINEXT_DIRS[0]} and ${VINEXT_DIRS[1]}`;

/** The line to add, and where: said for a Dockerfile that copies native/ in and has no close line directly after it. */
function addLine(): string {
  return (
    `\nYour Dockerfile copies native/ to ${VINEXT_DIRS[1]}. The loader refuses a library unless every directory above the library is owned by root and closed to group and other, and that includes ${DIRS}. BuildKit leaves them that way, but a builder may give a COPY's destination the mode of your build machine, so close them yourself: add this one line directly after the \`COPY\` that brings native/ in and before \`USER\`, and change nothing else in the file (knext recognises the scaffolded Dockerfile with just this line, so the app keeps the build and asset upload it has):\n` +
    `\n  ${VINEXT_CLOSE_LINE}\n` +
    '\nknext confirms only that form. A Dockerfile that closes them another way may load, but knext does not read it, and knext deploy takes the slower image-sourced path for it.\n'
  );
}

/** What knext reads, and why it cannot confirm this file: said when the one form it confirms does not hold. */
function cannotConfirm(why: string): string {
  return `\nknext cannot confirm that your Dockerfile leaves ${DIRS} closed to group and other: ${why}. The loader refuses a library under a directory they can write. knext confirms only the scaffolded \`${VINEXT_NATIVE_COPY}\` with \`${VINEXT_CLOSE_LINE}\` as the very next line, and after that line only instructions that cannot change a mode (ENV, ARG, LABEL, EXPOSE, USER, WORKDIR, ENTRYPOINT, CMD, HEALTHCHECK, STOPSIGNAL, and a read-only check such as the scaffolded \`RUN test -f ${VINEXT_DIRS[1]}/.integrity.json || { echo "..." >&2; exit 1; }\`), in a file with no heredoc, no parser directive, no SHELL or ONBUILD instruction, no instruction whose first word is not one Docker knows, no backslash at the end of a line that no space or tab precedes and no character that is not plain text: put the file in that form, or move anything else above the COPY. This is not a finding that the loader will refuse them: knext does not read what your commands do, so it cannot confirm either way, and knext deploy takes the slower image-sourced path for a Dockerfile that is not the scaffolded one with this line.\n`;
}

/**
 * What to tell the app about its own Dockerfile, or '' when there is nothing to. A vinext x bun app is
 * built from the `Dockerfile` it was scaffolded with, a file the app owns and the build does not stage,
 * so unlike the standalone image (whose staged Dockerfile gets the line from knext) it can only say what
 * to add. It is the vinext Dockerfile when its final stage copies native/ to /app/native (in any
 * spelling of the COPY that this reads: its flags, the JSON form, a quoted or relative destination under
 * a `WORKDIR`; an `ADD`, or a destination held in a variable, is not found, and nothing is said); `build`, when the caller
 * knows it, says whether this app is built from its own Dockerfile at all (only a vinext build is: the
 * others stage theirs), and nothing is said for one that is not.
 *
 * It does not read what a command does. It confirms ONE form, and says nothing only for it. Silence
 * needs a file that is clean as a whole, checked before anything is cut out of it (a stage, a line,
 * a trimmed edge): no character a reader may take for something else (`UNREADABLE`), no `<<` anywhere
 * (a heredoc's body is not Dockerfile text), no `escape` or `syntax` directive (the scaffolded
 * file's own pinned `syntax` line aside), no `SHELL` or `ONBUILD` instruction in any stage (the first
 * changes what every `RUN` runs, the read-only one included, and a stage that builds on this one runs the
 * second's trigger), no instruction whose first word is not one Docker knows (a `//` line is read by
 * BuildKit as a directive), and no continuation backslash that no space or tab precedes (a backslash
 * alone at the start of a line, a word split in two). On top of that: the scaffolded `COPY` of native/
 * with the close line (`VINEXT_CLOSE_LINE`) as the very next line, byte for byte, and after that line
 * nothing but instructions that cannot change a mode (`METADATA`, the one read-only `RUN`).
 * Anything else is not confirmed, and is told so:
 *
 *  - the file is not clean as a whole: it says it cannot confirm, and why, for any file that
 *    mentions native at all, in any case, in its text, in its instructions joined at a backslash, or
 *    in the text joined loosely (a file that cannot be read is not known to have no COPY of it);
 *  - the line is not directly after the COPY: it says to add it there, whatever else the file does;
 *  - it is, but the COPY is another spelling, or a blank line or a comment sits between them, or
 *    something after it is not on the list above: it says it cannot confirm, and why.
 *
 * Neither message claims the loader accepts the directories: that is for the loader to say when it
 * loads. The file is never edited. Printed by `init`, and by `generate` and `check` for an app that
 * already has its knext.ffi.json.
 */
export function dockerfileHint(cwd: string, build?: string): string {
  if (build !== undefined && build !== VINEXT_BUILD) return '';
  let text: string;
  try {
    text = readFileSync(join(cwd, 'Dockerfile'), 'utf8');
  } catch {
    return '';
  }
  const lines = text.split(/\r?\n/);
  const all = instructions(lines);
  const unclean = unreadable(text, lines, all);
  if (unclean !== undefined) return mentionsNative(text, all) ? cannotConfirm(unclean) : '';
  // The final stage is the image the app ships: everything after the last FROM.
  const stage = all.slice(all.map((i) => i.word).lastIndexOf('FROM') + 1);
  // The last COPY whose destination is /app/native, under the WORKDIR in force at that point.
  let dir: string | undefined;
  let copy = -1;
  for (const [n, inst] of stage.entries()) {
    if (inst.word === 'WORKDIR') dir = resolvePath(inst.rest, dir);
    if (inst.word !== 'COPY') continue;
    const dest = copyDestination(inst.rest);
    if (dest !== undefined && resolvePath(dest, dir) === VINEXT_DIRS[1]) copy = n;
  }
  if (copy === -1) return '';
  const after = stage.slice(copy + 1);
  const next = after[0];
  if (next?.text !== VINEXT_CLOSE_LINE) return addLine();
  // Byte for byte, as the file has it: one physical line each, with nothing before or after it.
  const at = stage[copy] as Instruction;
  const why =
    at.first !== at.last || lines[at.first] !== VINEXT_NATIVE_COPY
      ? `the COPY is not the scaffolded \`${VINEXT_NATIVE_COPY}\`, so a directory below native/ may keep your build machine's mode`
      : next.first !== at.last + 1 || lines[next.first] !== VINEXT_CLOSE_LINE
        ? 'a blank line or a comment sits between the COPY and that line, or the line has something before or after it, and knext deploy reads the scaffolded file byte for byte'
        : after
            .slice(1)
            .map(unconfirmed)
            .find((reason) => reason !== undefined);
  return why === undefined ? '' : cannotConfirm(why);
}
