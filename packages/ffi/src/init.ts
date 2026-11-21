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
import { VINEXT_CLOSE_LINE, VINEXT_NATIVE_COPY } from './vinext-image';

// The two lines are `vinext-image.ts`'s, read by the generator too; re-exported for the callers
// (and the drift test in core's test directory) that have always imported them from here.
export { VINEXT_CLOSE_LINE, VINEXT_NATIVE_COPY };

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

/** One instruction of a Dockerfile: its keyword, upper-cased, the rest of the logical line, and its heredoc lines. */
interface Instruction {
  readonly word: string;
  readonly rest: string;
  /** The lines of the heredocs a RUN, COPY or ADD opens, in order. A RUN's are commands; a COPY's or ADD's are data. */
  readonly body: string[];
}

/** A heredoc an instruction opens: the line that ends it, and whether `<<-` lets tabs come before it. */
interface Heredoc {
  readonly terminator: string;
  readonly stripTabs: boolean;
}

/** The instructions that can open a heredoc (the others, a `LABEL x="<<EOF"` among them, only hold the text). */
const HEREDOC_WORDS = new Set(['RUN', 'COPY', 'ADD']);

/** The heredocs an instruction opens, in order: `<<EOT`, `<<-EOT`, `<<'EOT'` and `<<"EOT"` (not a `<<<` here-string). */
function heredocsOf(rest: string): Heredoc[] {
  return [...rest.matchAll(/(?<!<)<<(?!<)(-?)(?:'([^']+)'|"([^"]+)"|([A-Za-z_]\w*))/g)].map(
    (m) => ({
      terminator: (m[2] ?? m[3] ?? m[4]) as string,
      stripTabs: m[1] === '-',
    }),
  );
}

/**
 * The instructions of a Dockerfile's FINAL stage (everything after the last FROM, which is the image
 * the app ships), with `\` continuations joined and blank and comment lines dropped. A heredoc's body
 * (`RUN <<EOT` ... `EOT`) is never read as instructions: a line in it that looks like a FROM, a COPY
 * or a chmod is the body's own text. It is kept on the instruction that opened it, for a RUN to be
 * read as the commands it holds. Only a RUN, COPY or ADD opens one: a `LABEL x="<<EOF"` does not,
 * or the rest of the file would be taken for its body. Not a parser: just enough to look at COPY,
 * RUN and WORKDIR the way the builder reads them.
 */
function finalStage(text: string): Instruction[] {
  const all: Instruction[] = [];
  let acc = '';
  let open: Heredoc[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const inside = open[0];
    if (inside !== undefined) {
      // The body, whatever it holds (blank lines and `#` included), up to its terminator.
      if ((inside.stripTabs ? raw.replace(/^\t+/, '') : raw).trimEnd() === inside.terminator) {
        open = open.slice(1);
      } else {
        all[all.length - 1]?.body.push(raw);
      }
      continue;
    }
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue; // between instructions or inside a continuation
    if (line.endsWith('\\')) {
      acc += `${line.slice(0, -1).trimEnd()} `;
      continue;
    }
    const logical = `${acc}${line}`;
    acc = '';
    const m = /^(\S+)\s*(.*)$/.exec(logical);
    if (m) {
      const word = (m[1] as string).toUpperCase();
      all.push({ word, rest: m[2] as string, body: [] });
      open = HEREDOC_WORDS.has(word) ? heredocsOf(m[2] as string) : [];
    }
  }
  const from = all.map((i) => i.word).lastIndexOf('FROM');
  return all.slice(from + 1);
}

/** `text` without one pair of matching quotes around it. */
function unquote(text: string): string {
  const m = /^(["'])(.*)\1$/.exec(text.trim());
  return m ? (m[2] as string) : text.trim();
}

/**
 * `raw` as an absolute, normalised path (`/app/.`, `/app//native/` and `/app/../app` all read as they
 * are), a relative one taken from `cwd`, the working directory. `undefined` when it cannot be told: a
 * variable, a glob, a command substitution, a `~`, or a relative path with no working directory known.
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

/**
 * What a chmod mode (symbolic or octal) does to the write bit of group and other: it `closes` both,
 * it `opens` at least one, or neither. A clause with no who-letter (`-w`, `=rx`) is subject to the
 * umask, so it never closes anything; one that gives write (`+w`, `=rwx`) may open it, and is taken to.
 * A mode this cannot read opens: not knowing is a reason to say so.
 */
function modeEffect(mode: string): 'closes' | 'opens' | 'neither' {
  if (/^[0-7]{3,4}$/.test(mode))
    return (Number.parseInt(mode, 8) & 0o022) === 0 ? 'closes' : 'opens';
  const last = new Map<string, 'closed' | 'open'>();
  for (const clause of mode.split(',')) {
    const m = /^([ugoa]*)([-+=])([rwxXst]*)$/.exec(clause);
    if (!m) return 'opens';
    const who = m[1] as string;
    const writes = (m[3] as string).includes('w');
    if (who === '') {
      if (writes && m[2] !== '-') for (const c of ['g', 'o']) last.set(c, 'open');
      continue;
    }
    for (const c of who.includes('a') ? ['u', 'g', 'o'] : [...who]) {
      if (m[2] === '-' ? writes : m[2] === '=' && !writes) last.set(c, 'closed');
      else if (writes) last.set(c, 'open');
    }
  }
  if (last.get('g') === 'closed' && last.get('o') === 'closed') return 'closes';
  return last.get('g') === 'open' || last.get('o') === 'open' ? 'opens' : 'neither';
}

/** The two directories the loader needs closed. */
const CLOSED_DIRS = ['/app', '/app/native'];

/** The ones of them a (normalised) path names: itself, and for `-R` every one under it (`-R` on `/app` or `/` names both). */
function reached(path: string, recursive: boolean): string[] {
  return CLOSED_DIRS.filter(
    (d) => d === path || (recursive && (path === '/' || d.startsWith(`${path}/`))),
  );
}

/** Whether a `chown` owner spec (`user`, `user:group`, `:group`) leaves root the owner. */
function staysRootOwned(owner: string): boolean {
  const user = owner.split(/[:.]/)[0];
  return user === '' || user === 'root' || user === '0';
}

/**
 * A shell command line as the commands it holds, each a list of words with the quotes taken off: it
 * splits at `&&`, `||`, `;`, `|`, `&`, a line end and a parenthesis, none of them inside quotes, and a
 * backslash makes the next character part of the word (so `\;` is a word, as `find -exec` wants).
 * Not a shell: no expansion, no here-strings; a `$(...)` leaves a word `$` for the reader to be
 * unsure of.
 */
function shellCommands(text: string): string[][] {
  const commands: string[][] = [];
  let words: string[] = [];
  let word = '';
  let open = false; // a word is being built (an empty quoted one counts)
  let quote = '';
  const endWord = () => {
    if (open) words.push(word);
    word = '';
    open = false;
  };
  const endCommand = () => {
    endWord();
    if (words.length > 0) commands.push(words);
    words = [];
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i] as string;
    if (quote !== '') {
      if (c === quote) quote = '';
      else if (c === '\\' && quote === '"' && i + 1 < text.length) word += text[++i];
      else word += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      open = true;
    } else if (c === '\\' && i + 1 < text.length) {
      word += text[++i];
      open = true;
    } else if (c === '\n' || c === ';' || c === '&' || c === '|') endCommand();
    else if (/\s/.test(c) || c === '(' || c === ')') endWord();
    else {
      word += c;
      open = true;
    }
  }
  endCommand();
  return commands;
}

/** The commands a RUN holds: its exec form as the one command it is, or its shell text, then each heredoc line. */
function commandsOf(run: Instruction): string[][] {
  let exec: string[] | undefined;
  if (run.rest.startsWith('[')) {
    try {
      const parsed: unknown = JSON.parse(run.rest);
      if (Array.isArray(parsed) && parsed.every((p) => typeof p === 'string')) exec = parsed;
    } catch {
      // not JSON after all: a shell command that starts with a bracket
    }
  }
  return [...(exec ? [exec] : shellCommands(run.rest)), ...run.body.flatMap(shellCommands)];
}

const base = (word: string): string => word.slice(word.lastIndexOf('/') + 1);

/** Words a command may start with that run what follows them: a shell keyword, `sudo`, `env`, `xargs`... */
const WRAPPERS = new Set([
  'sudo',
  'doas',
  'env',
  'command',
  'exec',
  'time',
  'nohup',
  'nice',
  'busybox',
  'setsid',
  'xargs',
  'if',
  'then',
  'else',
  'elif',
  'do',
  'while',
  'until',
  '!',
  '{',
]);

/**
 * What a command starts with once what runs it is taken off: the assignments (`FOO=1`), the shell
 * keywords, `sudo` / `env` / `busybox` and the like with their options. `stdin` is set when a word
 * says the paths come from somewhere this cannot see (`xargs`).
 */
function strip(words: string[]): { words: string[]; stdin: boolean } {
  let i = 0;
  let stdin = false;
  while (i < words.length) {
    const word = words[i] as string;
    if (/^[A-Za-z_]\w*=/.test(word)) {
      i++;
      continue;
    }
    const name = base(word);
    if (!WRAPPERS.has(name)) break;
    if (name === 'xargs') stdin = true;
    i++;
    // Options of the wrapper, one that takes a value (`sudo -u root`) taking the next word too.
    while (i < words.length && (words[i] as string).startsWith('-')) {
      i += /^-[ugnIPdCDhpTtUr]$/.test(words[i] as string) ? 2 : 1;
    }
  }
  return { words: words.slice(i), stdin };
}

/** What the RUNs after the copy of native/ have done to the two directories. */
interface Walk {
  /** The directories a chmod has closed to group and other and nothing since has opened. */
  readonly closed: Set<string>;
  /** The directories a command opened (a chmod that gives group or other write, a chown to somebody but root). */
  readonly opened: Set<string>;
  /** Whether something that may open them ran and could not be read (a path with a variable or a glob in it). */
  maybe: boolean;
}

/**
 * Apply one command to the walk and return the working directory after it (`cd` moves it). A chmod
 * that closes adds what it names to `closed`; one that opens, or a chown to somebody who is not root,
 * takes it out and records it. What is not understood errs toward saying so: a path that cannot be
 * read opens both directories as far as the walk is concerned, a close it cannot read closes nothing.
 */
function applyCommand(command: string[], cwd: string | undefined, walk: Walk): string | undefined {
  const { words, stdin } = strip(command);
  const first = words[0];
  if (first === undefined) return cwd;
  const tool = base(first);
  if (tool === 'cd') {
    return words[1] === undefined ? undefined : resolvePath(words[1], cwd);
  }
  // `sh -c "..."` and its relatives: what is in the string is the command.
  if (/^(?:ba|da|a|z|k)?sh$/.test(tool)) {
    const at = words.findIndex((w) => /^-[a-z]*c$/.test(w));
    const script = words[at + 1];
    if (at !== -1 && script !== undefined) {
      let inner = cwd;
      for (const c of shellCommands(script)) inner = applyCommand(c, inner, walk);
    }
    return cwd;
  }
  // `find ... -exec chmod ... {} +`: the command after -exec, its paths coming from find.
  if (tool === 'find') {
    words.forEach((w, i) => {
      if (!/^-(?:exec|execdir|ok|okdir)$/.test(w)) return;
      const end = words.findIndex((x, j) => j > i && (x === ';' || x === '+'));
      applyCommand([...words.slice(i + 1, end === -1 ? undefined : end), '{}'], cwd, walk);
    });
    return cwd;
  }
  if (tool !== 'chmod' && tool !== 'chown') {
    // Something this does not know that runs a chmod or a chown (an unknown wrapper): not knowing is
    // a reason to say so. An echo or a printf only holds the words.
    if (
      tool !== 'echo' &&
      tool !== 'printf' &&
      words.some((w) => /^(?:chmod|chown)$/.test(base(w)))
    ) {
      walk.maybe = true;
      for (const d of CLOSED_DIRS) walk.closed.delete(d);
    }
    return cwd;
  }
  const args = words.slice(1);
  const recursive = args.some((a) => a === '--recursive' || /^-[A-Za-z]*R[A-Za-z]*$/.test(a));
  const [what, ...paths] = args.filter((a) => !/^-(?:-[a-z-]+(?:=.*)?|[cfvRHLPh]+)$/.test(a));
  if (what === undefined) return cwd;
  const effect = tool === 'chown' ? (staysRootOwned(what) ? 'neither' : 'opens') : modeEffect(what);
  if (effect === 'neither') return cwd;
  const named = new Set<string>();
  let unknown = stdin || args.some((a) => /^--(?:reference|from)/.test(a));
  for (const raw of paths) {
    const p = resolvePath(raw, cwd);
    if (p === undefined) unknown = true;
    else for (const d of reached(p, recursive)) named.add(d);
  }
  if (effect === 'closes') {
    for (const d of named) walk.closed.add(d);
    return cwd;
  }
  if (unknown) walk.maybe = true;
  for (const d of unknown ? CLOSED_DIRS : named) {
    walk.closed.delete(d);
    if (!unknown) walk.opened.add(d);
  }
  return cwd;
}

/** The commands of the RUNs after the copy, in order, applied to the two directories. */
function walkRuns(stage: Instruction[], from: number, cwds: (string | undefined)[]): Walk {
  const walk: Walk = { closed: new Set(), opened: new Set(), maybe: false };
  for (let n = from; n < stage.length; n++) {
    const inst = stage[n] as Instruction;
    if (inst.word !== 'RUN') continue;
    let cwd = cwds[n];
    for (const command of commandsOf(inst)) cwd = applyCommand(command, cwd, walk);
  }
  return walk;
}

/**
 * What to tell the app about its own Dockerfile, or '' when there is nothing to. A vinext x bun app is
 * built from the `Dockerfile` it was scaffolded with, a file the app owns and the build does not stage,
 * so unlike the standalone image (whose staged Dockerfile gets the line from knext) it can only say what
 * to add. It is the vinext Dockerfile when its final stage copies native/ to /app/native (in any
 * spelling of the COPY, a relative destination under a `WORKDIR` included); `build`, when the caller
 * knows it, says whether this app is built from its own Dockerfile at all (only a vinext build is: the
 * others stage theirs), and nothing is said for one that is not. Three cases:
 *
 *  - /app and /app/native are not both closed to group and other by the chmods after that copy in the
 *    same stage, and nothing after it opens them: it says to add the one line directly after the COPY.
 *  - something after the copy opens them (a chmod that gives group or other write, a chown to somebody
 *    but root, or a command whose paths cannot be read): the line directly after the COPY would not
 *    help, so it says a later RUN opens them and to close them again after the last one.
 *  - they are closed, but the Dockerfile has the scaffolded COPY and not the one line directly after
 *    it: knext deploy recognises the scaffolded file only with that line there, so it warns that deploy
 *    takes the slower, image-sourced path.
 *
 * The RUNs are read the way a shell would: quoted words, any path to chmod or chown, `sudo` and its
 * relatives, a path with a dot in it, the working directory, the exec form, `sh -c`, `cd`,
 * `find -exec`, a heredoc body. What it cannot read it counts as opening, never as closing: a wrong
 * hint to add the line is harmless, a wrong claim that the directories are closed is not. The file is
 * never edited. Printed by `init`, and by `generate` and `check` for an app that already has its
 * knext.ffi.json.
 */
export function dockerfileHint(cwd: string, build?: string): string {
  if (build !== undefined && build !== VINEXT_BUILD) return '';
  let text: string;
  try {
    text = readFileSync(join(cwd, 'Dockerfile'), 'utf8');
  } catch {
    return '';
  }
  const stage = finalStage(text);
  // The working directory each instruction runs in (a base image's own is not known), and the last
  // COPY whose destination is /app/native.
  const cwds: (string | undefined)[] = [];
  let dir: string | undefined;
  let copy = -1;
  for (const [n, inst] of stage.entries()) {
    if (inst.word === 'WORKDIR') dir = resolvePath(inst.rest, dir);
    cwds.push(dir);
    if (inst.word !== 'COPY') continue;
    const dest = copyDestination(inst.rest);
    if (dest !== undefined && resolvePath(dest, dir) === '/app/native') copy = n;
  }
  if (copy === -1) return '';
  const walk = walkRuns(stage, copy + 1, cwds);
  if (!(walk.closed.has('/app') && walk.closed.has('/app/native'))) {
    if (walk.opened.size > 0 || walk.maybe) {
      const dirs = (walk.maybe ? CLOSED_DIRS : CLOSED_DIRS.filter((d) => walk.opened.has(d))).join(
        ' and ',
      );
      return (
        `\nYour Dockerfile copies native/ to /app/native, but a RUN after that COPY ${walk.maybe ? 'opens or may open' : 'opens'} ${dirs} to group or other (a chmod that gives them write access, a chown to somebody who is not root${walk.maybe ? ', or a command with a path knext cannot read' : ''}), and the loader refuses a library under a directory they can write. Close them again after the last such RUN, before \`USER\`:\n` +
        `\n  ${VINEXT_CLOSE_LINE}\n` +
        '\nThat Dockerfile is no longer the one knext scaffolded, so knext deploy reads the assets back from the built image and checks them against it (the slower path); nothing else needs to change.\n'
      );
    }
    return (
      "\nYour Dockerfile copies native/ to /app/native. The loader refuses a library unless every directory above the library is owned by root and closed to group and other, and that includes /app and /app/native. BuildKit leaves them that way, but a builder may give a COPY's destination the mode of your build machine, so close them yourself: add this one line directly after the `COPY` that brings native/ in and before `USER`, and change nothing else in the file (knext recognises the scaffolded Dockerfile with just this line, so the app keeps the build and asset upload it has):\n" +
      `\n  ${VINEXT_CLOSE_LINE}\n`
    );
  }
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  // The scaffolded COPY, in the scaffolded spelling. A Dockerfile that spells it another way is not the
  // scaffolded one and is on the slower path already, so nothing is said; that this text is still the
  // template's is held by `ffi-vinext-known-good.test.ts`, which fails if the template moves on and
  // this finds nothing.
  const at = lines.lastIndexOf(VINEXT_NATIVE_COPY);
  if (at !== -1 && lines[at + 1] !== VINEXT_CLOSE_LINE) {
    return (
      '\nThe chmods in your Dockerfile close /app and /app/native, so the loader should accept them. But knext deploy recognises the Dockerfile scaffolded for the vinext build only with this one line directly after the `COPY` that brings native/ in, and with the closing chmod anywhere else it takes the slower path (the assets are read back from the built image and checked against it):\n' +
      `\n  ${VINEXT_CLOSE_LINE}\n` +
      '\nIf your Dockerfile has changed in other ways too, it is already on that path and nothing needs to change.\n'
    );
  }
  return '';
}
