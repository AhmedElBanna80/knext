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
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CONFIG_FILE, DEFAULT_CONFIG, serializeConfig } from './config';
import type { Io } from './generate';

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

/** The line that closes the two directories a vinext image's library sits under. */
export const VINEXT_CLOSE_LINE = 'RUN chmod go-w /app /app/native';

/** The scaffolded vinext Dockerfile's COPY of native/, which the one close line goes directly after. */
const VINEXT_NATIVE_COPY = 'COPY --chown=0:0 --chmod=a-w native /app/native';

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

/** One instruction of a Dockerfile: its keyword, upper-cased, and the rest of the logical line. */
interface Instruction {
  readonly word: string;
  readonly rest: string;
}

/** A heredoc an instruction opens: the line that ends it, and whether `<<-` lets tabs come before it. */
interface Heredoc {
  readonly terminator: string;
  readonly stripTabs: boolean;
}

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
 * (`RUN <<EOT` ... `EOT`) is skipped, never read as instructions: a line in it that looks like a FROM,
 * a COPY or a chmod is the body's own text. Not a parser: just enough to look at COPY and RUN the way
 * the builder reads them.
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
      all.push({ word: (m[1] as string).toUpperCase(), rest: m[2] as string });
      open = heredocsOf(m[2] as string);
    }
  }
  const from = all.map((i) => i.word).lastIndexOf('FROM');
  return all.slice(from + 1);
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
  const dest = parts.length >= 2 ? (parts[parts.length - 1] as string) : undefined;
  return dest === undefined ? undefined : dest.replace(/(?<=.)\/+$/, '');
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

/** The two directories the loader needs closed, and the ones of them a command's paths name (`-R` on /app names both). */
const CLOSED_DIRS = ['/app', '/app/native'];
function named(paths: string[], recursive: boolean): string[] {
  const dirs = new Set<string>();
  for (const raw of paths) {
    const p = raw.replace(/(?<=.)\/+$/, '');
    if (CLOSED_DIRS.includes(p)) dirs.add(p);
    if (recursive && p === '/app') dirs.add('/app/native');
  }
  return [...dirs];
}

/** Whether a `chown` owner spec (`user`, `user:group`, `:group`) leaves root the owner. */
function staysRootOwned(owner: string): boolean {
  const user = owner.split(/[:.]/)[0];
  return user === '' || user === 'root' || user === '0';
}

/**
 * Apply one RUN line's chmod and chown commands, in order, to the set of directories known to be closed
 * to group and other: a chmod that closes adds what it names, one that opens group or other write, or a
 * chown to somebody who is not root, takes it out again.
 */
function applyRun(run: string, closed: Set<string>): void {
  for (const command of run.split(/&&|\|\||;/)) {
    const [tool, ...args] = command.trim().split(/\s+/);
    if (tool !== 'chmod' && tool !== 'chown') continue;
    const recursive = args.some((a) => a === '-R' || a === '--recursive');
    const [what, ...paths] = args.filter((a) => !/^-(?:-[a-z-]+|[cfvR]+)$/.test(a));
    if (what === undefined) continue;
    if (tool === 'chown') {
      if (!staysRootOwned(what)) for (const d of named(paths, recursive)) closed.delete(d);
      continue;
    }
    const effect = modeEffect(what);
    for (const d of named(paths, recursive)) {
      if (effect === 'closes') closed.add(d);
      else if (effect === 'opens') closed.delete(d);
    }
  }
}

/**
 * What to tell the app about its own Dockerfile, or '' when there is nothing to. A vinext x bun app is
 * built from the `Dockerfile` it was scaffolded with, a file the app owns and the build does not stage,
 * so unlike the standalone image (whose staged Dockerfile gets the line from knext) it can only say what
 * to add. It is the vinext Dockerfile when its final stage copies native/ to /app/native (in any
 * spelling of the COPY); `build`, when the caller knows it, says whether this app is built from its own
 * Dockerfile at all (only a vinext build is: the others stage theirs), and nothing is said for one that
 * is not. Two cases:
 *
 *  - /app and /app/native are not both closed to group and other by the chmods after that copy in the
 *    same stage (a later chmod that opens one, or a chown to somebody else, undoes an earlier close;
 *    heredoc bodies are skipped): it says to add the one line directly after the COPY.
 *  - they are closed, but the Dockerfile has the scaffolded COPY and not the one line directly after
 *    it: knext deploy recognises the scaffolded file only with that line there, so it warns that deploy
 *    takes the slower, image-sourced path.
 *
 * The file is never edited. Printed by `init`, and by `generate` and `check` for an app that already
 * has its knext.ffi.json.
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
  const copy = stage
    .map((i) => i.word === 'COPY' && copyDestination(i.rest))
    .lastIndexOf('/app/native');
  if (copy === -1) return '';
  const closed = new Set<string>();
  for (const i of stage.slice(copy + 1)) if (i.word === 'RUN') applyRun(i.rest, closed);
  if (!(closed.has('/app') && closed.has('/app/native'))) {
    return (
      "\nYour Dockerfile copies native/ to /app/native. The loader refuses a library unless every directory above the library is owned by root and closed to group and other, and that includes /app and /app/native. BuildKit leaves them that way, but a builder may give a COPY's destination the mode of your build machine, so close them yourself: add this one line directly after the `COPY` that brings native/ in and before `USER`, and change nothing else in the file (knext recognises the scaffolded Dockerfile with just this line, so the app keeps the build and asset upload it has):\n" +
      `\n  ${VINEXT_CLOSE_LINE}\n`
    );
  }
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const at = lines.lastIndexOf(VINEXT_NATIVE_COPY);
  if (at !== -1 && lines[at + 1] !== VINEXT_CLOSE_LINE) {
    return (
      '\nYour Dockerfile closes /app and /app/native, so the loader accepts them. But knext deploy recognises the Dockerfile scaffolded for the vinext build only with this one line directly after the `COPY` that brings native/ in, and with the closing chmod anywhere else it takes the slower path (the assets are read back from the built image and checked against it):\n' +
      `\n  ${VINEXT_CLOSE_LINE}\n` +
      '\nIf your Dockerfile has changed in other ways too, it is already on that path and nothing needs to change.\n'
    );
  }
  return '';
}
