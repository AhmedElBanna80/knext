/**
 * `knext ffi init` (ADR-0069 D11, D12): opt a zone into in-process Rust.
 *
 * Writes `knext.ffi.json` and a starter `rust/` crate from `templates/init/`
 * (every file there, with `.tmpl` stripped and placeholders filled), and
 * refuses to overwrite anything. The crate depends on `knext-ffi` by git at
 * the full commit THIS package records (D3), so the macro that writes the
 * manifest and the generator that reads it always agree on the ABI.
 */

import { lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
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
      `the typed wrapper to ${DEFAULT_CONFIG.out}/.\n${dockerfileHint(cwd)}`,
  );
  return 0;
}

/** The line that closes the two directories a vinext image's library sits under. */
export const VINEXT_CLOSE_LINE = 'RUN chmod go-w /app /app/native';

/** One instruction of a Dockerfile: its keyword, upper-cased, and the rest of the logical line. */
interface Instruction {
  readonly word: string;
  readonly rest: string;
}

/**
 * The instructions of a Dockerfile's FINAL stage (everything after the last FROM, which is the image
 * the app ships), with `\` continuations joined and blank and comment lines dropped. Not a parser:
 * just enough to look at COPY and RUN the way the builder reads them.
 */
function finalStage(text: string): Instruction[] {
  const all: Instruction[] = [];
  let acc = '';
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue; // between instructions or inside a continuation
    if (line.endsWith('\\')) {
      acc += `${line.slice(0, -1).trimEnd()} `;
      continue;
    }
    const logical = `${acc}${line}`;
    acc = '';
    const m = /^(\S+)\s*(.*)$/.exec(logical);
    if (m) all.push({ word: (m[1] as string).toUpperCase(), rest: m[2] as string });
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

/** Whether a chmod mode (symbolic or octal) leaves group and other unable to write. */
function closesGroupAndOther(mode: string): boolean {
  if (/^[0-7]{3,4}$/.test(mode)) return (Number.parseInt(mode, 8) & 0o022) === 0;
  const closed = new Set<string>();
  for (const clause of mode.split(',')) {
    const m = /^([ugoa]*)([-+=])([rwxXst]*)$/.exec(clause);
    if (!m) return false;
    const who = m[1] as string;
    const writes = (m[3] as string).includes('w');
    const classes = who === '' || who.includes('a') ? ['u', 'g', 'o'] : [...who];
    for (const c of classes) {
      if ((m[2] === '-' && writes) || (m[2] === '=' && !writes)) closed.add(c);
      else if (writes) closed.delete(c);
    }
  }
  return closed.has('g') && closed.has('o');
}

/** The directories a RUN line closes to group and other: every chmod in it that does, and what it names. */
function closedBy(run: string): Set<string> {
  const closed = new Set<string>();
  for (const command of run.split(/&&|\|\||;/)) {
    const [tool, ...args] = command.trim().split(/\s+/);
    if (tool !== 'chmod') continue;
    const recursive = args.some((a) => a === '-R' || a === '--recursive');
    const words = args.filter((a) => !/^-(?:-[a-z-]+|[cfvR]+)$/.test(a));
    const [mode, ...paths] = words;
    if (mode === undefined || !closesGroupAndOther(mode)) continue;
    for (const p of paths.map((x) => x.replace(/(?<=.)\/+$/, ''))) {
      closed.add(p);
      if (recursive && p === '/app') closed.add('/app/native');
    }
  }
  return closed;
}

/**
 * What to add to the app's own Dockerfile, or '' when nothing is needed. A vinext x bun app is built
 * from the `Dockerfile` it was scaffolded with, a file the app owns and the build does not stage, so
 * unlike the standalone image (whose staged Dockerfile gets the line from knext) it can only say what
 * to add. It is the vinext Dockerfile when its final stage copies native/ to /app/native (in any
 * spelling of the COPY); it is told until BOTH /app and /app/native are closed to group and other by a
 * chmod after that copy in the same stage. The file is never edited. Printed by `init`, and by
 * `generate` and `check` for an app that already has its knext.ffi.json.
 */
export function dockerfileHint(cwd: string): string {
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
  for (const i of stage.slice(copy + 1)) {
    if (i.word === 'RUN') for (const d of closedBy(i.rest)) closed.add(d);
  }
  if (closed.has('/app') && closed.has('/app/native')) return '';
  return (
    "\nYour Dockerfile copies native/ to /app/native. The loader refuses a library unless every directory above the library is owned by root and closed to group and other, and that includes /app and /app/native. BuildKit leaves them that way, but a builder may give a COPY's destination the mode of your build machine, so close them yourself: add this one line directly after the `COPY` that brings native/ in and before `USER`, and change nothing else in the file (knext recognises the scaffolded Dockerfile with just this line, so the app keeps the build and asset upload it has):\n" +
    `\n  ${VINEXT_CLOSE_LINE}\n`
  );
}
