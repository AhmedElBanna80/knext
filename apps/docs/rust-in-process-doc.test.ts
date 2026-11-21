/**
 * The in-process Rust page (rust-in-process.mdx) and the `knext ffi` section
 * of the CLI reference quote error messages, file names, defaults and install
 * commands a user acts on. Each quote is compared against the string the code
 * itself produces, never against a copy kept in this file:
 *
 * - the generated module's runtime messages (Node refusal, prerender refusal,
 *   integrity refusal, development-build notice, argument TypeError, the
 *   `invalid input:` prefix) are read out of a module rendered by
 *   `renderModule`, and each must match a whole code block (the TypeError, a
 *   whole inline code span) with only the interpolated values left free;
 * - the build-time refusals (`FFI_NODE_REFUSAL`, `FFI_SELF_CONTAINED_REFUSAL`)
 *   must each equal a whole code block, every line of it;
 * - the reserved-name error is the message `scanManifest` throws for a
 *   function named `process`, and the reserved name lists are the generator's
 *   own `RESERVED` and `RESERVED_TYPES` sets;
 * - the toolchain install commands are `INSTALL_HINTS` and
 *   `cargoInstallCommand`, the strings the build's toolchain checks print,
 *   for every pinned cargo tool in `CARGO_TOOL_PINS`; the zig version, its
 *   download hosts, cache directories and timeout are `ZIG_PIN`,
 *   `zigCacheDir` and `ZIG_DOWNLOAD_TIMEOUT_MS`;
 * - the supply-chain file names and the allowed git source are the
 *   constants the build uses, the advisory allowlist example is parsed by
 *   `loadAdvisoryAllowlist`, and the provenance field list is the set of
 *   keys the build writes (scanned from build.ts and supply-chain.ts);
 * - the Rust messages (the `char` compile error, the "could not be decoded"
 *   input error) are the string literals in the crates' source, and the
 *   compile error is cross-checked against the compiler output its trybuild
 *   case pins.
 *
 * Measurements (per-call costs, the hardware they were taken on) and prose
 * claims have no code behind them, so they are checked for presence and
 * wording only.
 *
 * The general rules (no ADR/issue/PR references, no unpublished-package
 * hedging) are content-hygiene.test.ts's; this file checks this page's
 * load-bearing content.
 */

import { describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { blob, D, fn } from '../../packages/ffi/src/__tests__/helpers';
import { INSTALL_HINTS, PROVENANCE_FILE, SUPPORTED_TARGETS } from '../../packages/ffi/src/build';
import { BETA_NOTICE } from '../../packages/ffi/src/cli';
import { DEFAULT_CONFIG, serializeConfig } from '../../packages/ffi/src/config';
import { TEMPLATE_DIR } from '../../packages/ffi/src/init';
import { RESERVED, RESERVED_TYPES, scanManifest } from '../../packages/ffi/src/manifest';
import { renderModule } from '../../packages/ffi/src/render';
import {
  ADVISORY_ALLOWLIST_FILE,
  ALLOWED_GIT_SOURCE,
  CARGO_TOOL_PINS,
  type CargoTool,
  cargoInstallCommand,
  DENY_FILE,
  loadAdvisoryAllowlist,
  SBOM_FILE,
  ZIG_DOWNLOAD_TIMEOUT_MS,
  ZIG_PIN,
  zigCacheDir,
} from '../../packages/ffi/src/supply-chain';
import {
  FFI_NODE_REFUSAL,
  FFI_SELF_CONTAINED_REFUSAL,
} from '../../packages/kn-next/src/cli/ffi-preflight';

const REPO = resolve(import.meta.dirname, '../..');
const DOCS_DIR = resolve(import.meta.dirname, 'content/docs');
const page = readFileSync(join(DOCS_DIR, 'rust-in-process.mdx'), 'utf-8');
const cli = readFileSync(join(DOCS_DIR, 'cli.mdx'), 'utf-8');
const meta = JSON.parse(readFileSync(join(DOCS_DIR, 'meta.json'), 'utf-8')) as {
  pages: string[];
};
const repoFile = (rel: string) => readFileSync(join(REPO, rel), 'utf-8');

/** The body of the `## ` section whose heading matches, up to the next `## `. */
function section(text: string, heading: RegExp): string {
  const lines = text.split('\n');
  const start = lines.findIndex((l) => l.startsWith('## ') && heading.test(l));
  if (start === -1) return '';
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((l) => l.startsWith('## '));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n');
}

/** A section that must exist: an empty body would let every assertion below pass vacuously. */
function must(text: string, heading: RegExp): string {
  const body = section(text, heading);
  expect(body.trim().length, `no "## " section matching ${heading}`).toBeGreaterThan(200);
  return body;
}

/** Every fenced code block in `text`, dedented by its fence's own indentation. */
function codeBlocks(text: string): string[] {
  const lines = text.split('\n');
  const blocks: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const open = /^( *)```/.exec(lines[i] as string);
    if (!open) continue;
    const indent = open[1] as string;
    const body: string[] = [];
    for (i++; i < lines.length && !(lines[i] as string).startsWith(`${indent}\`\`\``); i++) {
      const line = lines[i] as string;
      body.push(line.startsWith(indent) ? line.slice(indent.length) : line);
    }
    blocks.push(body.join('\n'));
  }
  return blocks;
}

/** Every inline code span in `text`. */
const inlineCode = (text: string) => [...text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1] as string);

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A literal run of a message, or `null` for an interpolated value. */
type Part = string | null;

/** One interpolated value: anything on one line. */
const VALUE = '[^\\n]+?';

/** A regex source for the message, each interpolation free (or the matching `fills` entry). */
function pattern(parts: readonly Part[], fills: readonly string[] = []): string {
  let hole = 0;
  return parts.map((p) => (p === null ? (fills[hole++] ?? VALUE) : escapeRe(p))).join('');
}

/** Exactly one match of `re` in `text`; the regex must not carry flags of its own. */
function only(text: string, re: RegExp, where: string): RegExpExecArray {
  const hits = [...text.matchAll(new RegExp(re.source, 'g'))];
  expect(hits.length, `${re} must match ${where} exactly once`).toBe(1);
  return hits[0] as RegExpExecArray;
}

/**
 * The template literal in `source` that opens where `anchor` ends (the anchor
 * ends with the opening backtick), split into literal runs and interpolations.
 */
function templateAfter(source: string, anchor: RegExp): Part[] {
  const hit = only(source, anchor, 'the rendered module');
  let i = hit.index + hit[0].length;
  const parts: Part[] = [];
  let lit = '';
  for (;;) {
    const c = source[i];
    if (c === undefined) throw new Error(`unterminated template after ${anchor}`);
    if (c === '`') break;
    if (c === '\\') {
      const next = source[i + 1] as string;
      lit += next === 'n' ? '\n' : next;
      i += 2;
    } else if (c === '$' && source[i + 1] === '{') {
      let depth = 1;
      for (i += 2; depth > 0; i++) {
        if (source[i] === undefined) throw new Error(`unterminated \${…} after ${anchor}`);
        if (source[i] === '{') depth++;
        if (source[i] === '}') depth--;
      }
      parts.push(lit, null);
      lit = '';
    } else {
      lit += c;
      i++;
    }
  }
  parts.push(lit);
  return parts;
}

/** The Rust string literal in the crate file `rel` that opens where `before` ends. */
function rustLiteral(rel: string, before: RegExp): string {
  const hit = only(repoFile(rel), new RegExp(`${before.source}"((?:[^"\\\\]|\\\\.)*)"`), rel);
  return (hit[1] as string).replace(/\\(.)/g, '$1');
}

/** A Rust format string split into literal runs and `{…}` arguments. */
function rustFormat(fmt: string): Part[] {
  return fmt.split(/(\{[a-z_]*\})/).map((p) => (/^\{[a-z_]*\}$/.test(p) ? null : p));
}

/**
 * The top-level keys of the object literal that opens where `anchor` ends (the
 * anchor ends with its `{`), in `source`. A spread is returned as `...name`.
 * Any depth-1 line that is not `key:`, `key,` or a spread fails, so a literal
 * this scan cannot read reds the test rather than shrinking the key set.
 */
function literalKeys(rel: string, anchor: RegExp): string[] {
  const source = repoFile(rel);
  const hit = only(source, anchor, rel);
  const keys: string[] = [];
  let depth = 1;
  for (const raw of source.slice(hit.index + hit[0].length).split('\n')) {
    const line = raw.trim();
    if (depth === 1 && line !== '' && !line.startsWith('//') && !line.startsWith('}')) {
      const m = /^(?:(\.\.\.[\w.]+),|(\w+)(?::|,$))/.exec(line);
      if (!m) throw new Error(`${rel}: cannot read the literal line \`${line}\``);
      keys.push((m[1] ?? m[2]) as string);
    }
    for (const c of line.replace(/'[^']*'|`[^`]*`/g, '')) {
      if (c === '{' || c === '[') depth++;
      if (c === '}' || c === ']') depth--;
    }
    if (depth <= 0) return keys;
  }
  throw new Error(`${rel}: unterminated literal after ${anchor}`);
}

/** Every key `provenance.json` carries: build.ts's literal, with supply-chain.ts's spread in. */
function provenanceKeys(): string[] {
  const build = literalKeys('packages/ffi/src/build.ts', /const provenance = \{/);
  const supply = literalKeys(
    'packages/ffi/src/supply-chain.ts',
    /export async function prepareSupplyChain[\s\S]*?\n {4}provenance: \{/,
  );
  expect(build).toContain('...supply.provenance');
  expect(supply.length).toBeGreaterThan(0);
  return build.flatMap((k) => (k === '...supply.provenance' ? supply : [k]));
}

/**
 * Every versioned mention of a pinned tool in `text` (`zig 0.17.0`,
 * `cargo-deny 0.20.2`, `zig/0.17.0`) names the pinned version: a scan, so a
 * stale version anywhere on the page fails, not only in the lines a test names.
 */
function expectOnlyPinnedVersions(text: string, where: string): void {
  const pins = new Map<string, string>([
    ['zig', ZIG_PIN.version],
    ...Object.values(CARGO_TOOL_PINS).map((p) => [p.crate, p.version] as [string, string]),
  ]);
  const tools = [...pins.keys()].map(escapeRe).join('|');
  const seen = [...text.matchAll(new RegExp(`\\b(${tools})[ /](\\d+\\.\\d+\\.\\d+)`, 'g'))];
  expect(seen.length, `${where}: no versioned tool mention`).toBeGreaterThan(0);
  for (const [whole, tool, version] of seen) {
    expect(version, `${where}: ${whole}`).toBe(pins.get(tool as string) as string);
  }
}

/** The message `f` throws. */
function thrown(f: () => unknown): string {
  try {
    f();
  } catch (err) {
    return (err as Error).message;
  }
  throw new Error('expected a throw');
}

/** Some code block of `body` is exactly the message `source` describes. */
function expectBlock(body: string, source: string, what: string): void {
  const re = new RegExp(`^${source}$`);
  expect(
    codeBlocks(body).some((b) => re.test(b)),
    `${what}: no code block is exactly ${re}`,
  ).toBe(true);
}

/** A module rendered for one `greet(&str) -> String` export: every message below comes from it. */
const rendered = renderModule(
  {
    fns: [
      {
        name: 'greet',
        symbol: 'knext_ffi_v1_greet_00000000',
        sig: 'greet(string)->string',
        doc: '',
        args: [{ name: 'name', type: { t: 'string' }, rust: '&str' }],
        ret: { type: { t: 'string' }, rust: 'String' },
        err: null,
      },
    ],
    records: [],
    enums: [],
  },
  { libName: 'zone', crate: 'rust' },
);

/**
 * A module rendered for a float inside a JSON argument and a JSON return: it
 * carries the finite-number TypeError and the return-side TSDoc.
 */
const floatyRendered = renderModule(
  {
    fns: [
      {
        name: 'reading',
        symbol: 'knext_ffi_v1_reading_00000000',
        sig: 'reading(Reading)->Reading',
        doc: '',
        args: [{ name: 'r', type: { t: 'record', name: 'Reading' }, rust: 'Reading' }],
        ret: { type: { t: 'record', name: 'Reading' }, rust: 'Reading' },
        err: null,
      },
    ],
    records: [
      {
        name: 'Reading',
        doc: '',
        fields: [{ name: 'samples', type: { t: 'vec', of: { t: 'f32' } }, rust: 'Vec<f32>' }],
      },
    ],
    enums: [],
  },
  { libName: 'zone', crate: 'rust' },
);

const FFI_LIB = 'crates/knext-ffi/src/lib.rs';
const WIRE = 'crates/knext-ffi/src/wire.rs';

/** The crate's "argument could not be decoded" format string. */
const decodeFormat = () =>
  rustFormat(rustLiteral(FFI_LIB, /pub unsafe fn json_arg[\s\S]*?Invalid\(format!\(\s*/));

/** The crate's "the return value cannot cross as JSON" format string. */
const returnFormat = () =>
  rustFormat(rustLiteral(FFI_LIB, /impl<T: Wire> Lower for Json<T>[\s\S]*?Invalid\(format!\(\s*/));

/** The literal a rendered module carries for `$PRERENDER` (the build-time refusal). */
function prerenderMessage(): string {
  const literal = /^const \$PRERENDER = '(.*)';$/m.exec(rendered)?.[1];
  expect(literal, 'the rendered module no longer declares $PRERENDER').toBeDefined();
  return (literal as string).replace(/\\'/g, "'");
}

describe('docs — in-process Rust page', () => {
  it('is in the sidebar', () => {
    expect(meta.pages).toContain('rust-in-process');
  });

  it('opens with the Beta callout, naming every reason it is Beta', () => {
    const callout = /<Callout[^>]*>([\s\S]*?)<\/Callout>/.exec(page)?.[1] ?? '';
    expect(page.indexOf('<Callout')).toBeLessThan(page.indexOf('\n## '));
    expect(callout).toContain('Beta, and not published yet');
    expect(callout).toMatch(/Bun only|only on Bun/i);
    expect(callout).toMatch(/experimental/i);
    expect(callout).toMatch(/compatibility credential/i);
    expect(callout).toContain('@getknext/ffi');
    expect(callout).toMatch(/not on npm/i);
    expect(callout).toMatch(/git commit/i);
  });

  it('quotes the build-time prerendering refusal exactly, with both fixes', () => {
    const body = must(page, /dynamic contexts only/i);
    expectBlock(body, escapeRe(`Error [FfiLoadError]: ${prerenderMessage()}`), 'prerender');
    expect(body).toContain("export const dynamic = 'force-dynamic'");
    expect(body).toContain('await connection()');
    expect(body).toMatch(/generateStaticParams/);
    expect(body).toMatch(/generateMetadata/);
  });

  it('says "cannot find the Rust library" is a request-time error that carries no prerender advice', () => {
    const body = must(page, /dynamic contexts only/i);
    expect(body).not.toMatch(/ends with the same advice/);
    expect(body).toMatch(/"cannot find the Rust library" error appears only at request time/);
    const at = only(rendered, /cannot find the Rust library/, 'the rendered module').index;
    const thrower = rendered.slice(at, rendered.indexOf('\n}\n', at));
    expect(thrower.length).toBeGreaterThan(0);
    expect(thrower).not.toMatch(/prerender/i);
  });

  it('quotes the build-time Node refusal whole, and the runtime one as the module throws it', () => {
    const body = must(page, /node/i);
    expect(codeBlocks(body)).toContain(FFI_NODE_REFUSAL);
    const runtime = templateAfter(
      rendered,
      /if \(!process\.versions\['bun'\]\) \{\s*throw new FfiLoadError\(\s*`/,
    );
    expectBlock(body, `FfiLoadError: ${pattern(runtime)}`, 'the runtime Node refusal');
  });

  it('quotes the self-contained refusal whole', () => {
    const body = must(page, /self-contained/i);
    expect(codeBlocks(body)).toContain(FFI_SELF_CONTAINED_REFUSAL);
  });

  it('quotes the integrity refusal and the development-build notice as the module prints them', () => {
    const body = must(page, /where the library is loaded from/i);
    const mismatch = templateAfter(
      rendered,
      /if \(actual !== expected\) \{\s*\$closeSync\(lib\.fd\);\s*throw new FfiLoadError\(\s*`/,
    );
    expectBlock(body, pattern(mismatch), 'the sha256 mismatch refusal');
    const notice = templateAfter(
      rendered,
      /console\.warn\(\s*`(?=knext ffi: loading the development build)/,
    );
    expectBlock(must(page, /quick start/i), pattern(notice), 'the development-build notice');
  });

  it('quotes the writable-library refusal as the module prints it, and says how the image avoids it', () => {
    const body = must(page, /where the library is loaded from/i);
    const refusal = templateAfter(rendered, /if \(why !== ''\) \{\s*throw new FfiLoadError\(\s*`/);
    expectBlock(body, pattern(refusal), 'the writable-library refusal');
    expect(body).toContain('COPY --chown=0:0 --chmod=a-w');
    // The supply-chain section's integrity bullet makes the same claim, and its limit.
    const chain = must(page, /supply chain/i);
    expect(chain.replace(/\s+/g, ' ')).toMatch(/root must own the library/);
    expect(chain).toMatch(/does not stop root/);
    expect(chain).not.toMatch(/does \*\*not\*\* stop anything that can write/);
  });

  it('quotes the directory refusal: both pieces of advice are on the page word for word and the module carries the same sentences, apart from the file hint', () => {
    const body = must(page, /where the library is loaded from/i).replace(/\s+/g, ' ');
    // The advice follows the situation, not the position: a directory inside native/ is fixed in place,
    // a sticky one at the executable's level or above it is only ever moved away from, and any other
    // failing directory (a world-writable one that is not sticky, and a home directory, included) is told
    // both, each with its condition.
    const fix =
      "To fix a directory inside native/: run `chmod go-w <dir>` (and `chown root <dir>` if root does not own it), as root; or, in a Dockerfile, `RUN chmod go-w <dir>` after the COPY that brought it in (a directory inside a copied tree keeps the build host's mode).";
    const either =
      "A directory that holds the executable or sits above it: if it is part of your app's install, run `chmod go-w <dir>` (and `chown root <dir>` if root does not own it), as root, or, in a Dockerfile, `RUN chmod go-w <dir>` after the COPY that brought it in. If it is shared with other software, or is a home directory such as /home/<user>, do not change its owner or mode (never give a home directory to root): move the install instead. The executable needs a directory of its own, owned by root and closed to group and other, such as /opt/<app>.";
    const move =
      'A sticky directory (a shared one such as /tmp) that holds the executable or sits above it is shared with other software, so do not change its owner or mode: move the install under a root-owned, closed directory such as /opt/<app> instead.';
    // Said wherever a directory can be fixed in place: the one Dockerfile line that keeps a vinext app
    // on the known-good path; and, with a sticky directory on the list with others, that fixing the
    // others alone is not enough.
    const vinext =
      "In a vinext app's Dockerfile, put exactly `RUN chmod go-w /app /app/native` directly after the `COPY --chown=0:0 --chmod=a-w native /app/native` line: that keeps the app on the known-good path, and a chmod anywhere else, or one per directory, takes the deploy off it (`knext ffi check` says whether the line is there).";
    const alone =
      'The other directories on this list can be fixed, but that alone will not make this install load while a sticky one is on the way: the install has to move.';
    // The module's source escapes the backticks it carries inside a template literal.
    const unescaped = rendered.replace(/\\`/g, '`');
    for (const sentence of [fix, either, move, vinext, alone]) {
      expect(unescaped).toContain(sentence);
      expect(body).toContain(sentence);
    }
    // The conditional advice names both conditions, so it is never read as an order to chmod a shared directory.
    expect(either).toContain("if it is part of your app's install");
    expect(either).toContain(
      'If it is shared with other software, or is a home directory such as /home/<user>, do not change its owner or mode (never give a home directory to root): move the install instead',
    );
    // A home directory is a move, never a chown to root.
    expect(either).not.toContain('chown root ~');
    expect(body).toContain('`/home/<user>` belongs to the account that owns it');
    expect(either).toContain('The executable needs a directory of its own');
    // A sticky directory is only told to move, and the page says so beside the example.
    expect(move).not.toContain('chmod go-w');
    expect(body).toContain('on some hosts `/opt` itself is writable by everyone');
    // The module words the count and the pronoun from the number of failing directories.
    expect(rendered).toContain('on the way to it cannot be trusted, so what is under ');
    expect(rendered).toContain(' could be renamed or replaced after it was checked:');
    expect(body).toContain(
      'directories on the way to it cannot be trusted, so what is under them could be renamed or replaced after it was checked:',
    );
    // A directory is not a file: the page does not offer the file's COPY flags as its fix.
    expect(fix).not.toContain('COPY --chown');
    expect(either).not.toContain('COPY --chown');
    // Every failing directory is listed, in the one message.
    expect(body).toContain('2 directories on the way to it');
    // The refusal the page quotes names the Dockerfile every command stages, all three of them.
    expect(body).toContain(
      'the Dockerfile that `knext build`, `knext deploy` and `knext preview` stage copies native/',
    );
    expect(body).not.toContain('the images `knext deploy` and `knext preview` build');
    expect(body).not.toContain('images built by `knext build`');
  });

  it('states the threat model of the ownership rule in user terms: who it stops, who it does not, why the directories count, and that there is no opt-out', () => {
    const flat = must(page, /where the library is loaded from/i).replace(/\s+/g, ' ');
    // Root owns it; the user the app runs as does not count, because it can chmod what it owns.
    expect(flat).toContain('Root must own the library');
    expect(flat).toContain('every directory from the library up to `/`');
    expect(flat).toContain('the directory beside the executable and each directory above that');
    expect(flat).toContain('the user the app runs as included');
    expect(flat).toContain('could change the permissions of what it owns');
    // Who it protects against, and who it does not.
    expect(flat).toContain(
      "protects against a writer that is not root, the app's own user among them",
    );
    expect(flat).toMatch(
      /does not protect against root[^.]*second writable mount[^.]*access control list/,
    );
    expect(flat).toMatch(
      /only the permission bits are read[^.]*macOS[^.]*ACL can grant write access/,
    );
    expect(flat).toContain('There is no setting that turns the check off');
    // Why a directory has to be root's too: the one sentence a user who hits the refusal needs.
    expect(flat).toContain(
      'Every directory above `native/`, up to `/`, must be owned by root too, and not writable by group or other',
    );
    expect(flat).toContain(
      'lets them rename or replace the library, or the directory itself, before the process opens it',
    );
    expect(flat).toContain('and the same is true of any directory above it');
    expect(flat).toContain('looks at every directory on the way');
    // What the module does about a swap, stated for users: links, the manifest, directories that changed.
    expect(flat).toContain(
      'The module opens the manifest and the library without following symbolic links',
    );
    expect(flat).toContain('judges each file it opened by its owner and mode');
    expect(flat).toContain(
      'refuses a tree whose directories changed while the library was being checked',
    );
    expect(flat).toContain(
      'A symbolic link where the library, `native/.integrity.json`, `native/` or any directory inside the tree should be is refused too, whatever it points at',
    );
    // The executable is judged where it really is: Bun reports its resolved path, so a link in front of
    // an install is not what is refused, and a release-directory deploy tool is refused for its owner.
    expect(flat).toContain('Bun reports `process.execPath` already resolved');
    expect(flat).toContain('an install reached through such a link loads');
    expect(flat).toContain('the directories judged are those of the real tree');
    expect(flat).not.toContain(
      'a link is never followed, so run the executable from its real path',
    );
    expect(flat).not.toContain('run the executable from its real path');
    expect(flat).toContain('A deploy tool that keeps releases in a directory it owns');
    expect(flat).toContain(
      'Put `deploy_to` under a parent where every directory from that parent up to `/` is root-owned and closed to group and other, make `deploy_to`, `releases/` and each release root-owned and closed to group and other, and never change anything above `deploy_to`. Switching `current` and `deploy:cleanup` need root too',
    );
    expect(flat).not.toContain('make the release tree root-owned');
    expect(flat).not.toContain('(run the step that puts the files in place as root)');
    expect(flat).not.toContain('the module pins only the file it has already opened');
    // What to do in your own image, and for a compiled binary outside a container.
    expect(flat).toContain('(`RUN chown -R app /app`) does not pass');
    expect(flat).toContain(
      'A compiled binary you run outside a container needs the same ownership, and so does every directory above it',
    );
    // The consequence a user installing outside a container has to know, with the line between fine and refused.
    expect(flat).toContain('a root-owned `/opt/<app>` is fine');
    expect(flat).toContain('a home directory or `/tmp` is not');
    expect(flat).toContain('the refusal names the directory');
    expect(flat).toContain('A volume mounted at `native/` or above it');
    expect(flat).toContain(
      'is refused unless root owns everything on it and group and other cannot write it',
    );
    expect(flat).toContain('is still writable through its other mounts');
    // The residual, named: the capability class, /proc/self/mem, the user namespace, and what the operator does.
    expect(flat).toContain(
      'any capability that is equivalent to root, for example `CAP_DAC_OVERRIDE`, `CAP_FOWNER`, `CAP_CHOWN`, `CAP_SETUID`, `CAP_SYS_ADMIN` (mount), `CAP_SYS_PTRACE`, `CAP_MKNOD`, `CAP_SYS_MODULE`, `CAP_SYS_RAWIO` and `CAP_BPF`',
    );
    expect(flat).toContain('`/proc/self/mem`');
    expect(flat).toContain('`hostUsers: false`');
    // A user namespace is two cases, and only one of them is fixed by running as non-root inside.
    expect(flat).toContain('is two cases');
    expect(flat).toContain(
      "Rootless Podman or Docker: the image's files belong to the host user who started the container",
    );
    expect(flat).toContain('running as a non-root user inside does not remove that writer');
    expect(flat).toContain(
      "A pod with `hostUsers: false`: the image's files belong to the pod's own root, which is host root where the filesystem supports idmapped mounts and otherwise the root of a uid range given to that pod alone (not host root); no other user on the host owns or can write them either way",
    );
    expect(flat).not.toContain('the files are owned by host root');
    expect(flat).toContain('running as a non-root user inside restores the guarantee');
    expect(flat).toContain(
      '`allowPrivilegeEscalation: false`, as the pods the knext operator creates do',
    );
    // Dropping every capability is not enough for an app that runs as root.
    expect(flat).toContain('but not `uid 0` itself');
    expect(flat).toContain('`runAsNonRoot`');
    expect(flat).toContain('`--cap-drop=ALL --security-opt no-new-privileges --user 65532`');
    // A Dockerfile that copies a whole tree keeps the build host's modes on the directories inside it.
    expect(flat).toContain('If your Dockerfile copies a whole source tree instead (`COPY . /app`)');
    expect(flat).toContain('makes them group-writable (`0775`), which the module refuses');
    expect(must(page, /where the library is loaded from/i)).toContain('RUN chmod -R go-w /app');
    expect(flat).toContain(
      'The Dockerfile that `knext build`, `knext deploy` and `knext preview` stage already has this layout',
    );
    // The old, weaker rule is gone from the page.
    expect(page).not.toMatch(/or the one the app runs\s+as/);
    expect(page).not.toMatch(/write access for the app's own user are each refused/);
    expect(page).not.toContain('a compiled binary you build yourself');
  });

  it('carries both recipes as titled blocks the e2e lane builds and runs verbatim (doc-recipe.test.ts pins what they say)', () => {
    const body = must(page, /where the library is loaded from/i);
    expect(body.match(/```dockerfile title="Dockerfile"/g)?.length).toBe(1);
    expect(body.match(/```bash title="own-binary\.sh"/g)?.length).toBe(1);
    // The recipe closes /app and /app/native itself: it does not rest on the mode a builder gives a COPY destination.
    expect(body).toContain('RUN chmod go-w /app /app/native\n');
    expect(body).toMatch(
      /COPY --chown=0:0 --chmod=a-w native \/app\/native\s+RUN chmod go-w \/app \/app\/native\s+USER 65532:65532/,
    );
    expect(body.match(/```dockerfile title="Dockerfile\.copied-tree"/g)?.length).toBe(1);
    const lane = repoFile('.github/workflows/ffi-e2e.yml');
    expect(lane).toContain('packages/ffi/scripts/doc-recipe.ts dockerfile');
    expect(lane).toContain('packages/ffi/scripts/doc-recipe.ts shell');
    // The commands hand a whole directory to root, so they refuse one that can hold other things: the
    // lane runs them on a directory of its own under /opt, as the page says, not under the temp directory.
    expect(lane).toContain('APP_DIR="/opt/knext-ffi-caller" bash -euo pipefail');
  });

  it('records the rule in the threat model: who it stops, its limits, the files it does not judge, the development path, and why the sealed copy was not used', () => {
    const model = repoFile('docs/security/threat-model.md').replace(/\s+/g, ' ');
    const at = model.indexOf('### The in-process Rust library');
    expect(at, 'no threat-model entry for the in-process Rust library').toBeGreaterThan(-1);
    const entry = model.slice(at, model.indexOf(' ### ', at + 10));
    expect(entry).toContain('owned by root');
    expect(entry).toContain('the user the app runs as');
    expect(entry).toMatch(/root or with `CAP_DAC_OVERRIDE` or `CAP_FOWNER`/);
    for (const cap of [
      'CAP_CHOWN',
      'CAP_SETUID',
      'CAP_SYS_ADMIN',
      'CAP_SYS_PTRACE',
      'CAP_MKNOD',
      'CAP_SYS_MODULE',
      'CAP_SYS_RAWIO',
      'CAP_BPF',
    ]) {
      expect(entry, cap).toContain(`\`${cap}\``);
    }
    expect(entry).toContain('any capability that is equivalent to root, for example');
    expect(entry).toContain('**What is not stopped.**');
    expect(entry).toContain('`/proc/self/mem`');
    expect(entry).toMatch(/one the attacker makes for itself gains nothing/);
    expect(entry).toContain('`hostUsers: false`');
    expect(entry).toContain('two cases');
    expect(entry).toContain('does not remove that writer');
    expect(entry).toContain('`runAsNonRoot`');
    expect(entry).toContain('`capabilities.drop: [ALL]` and `allowPrivilegeEscalation: false`');
    expect(entry).toContain('pod_hardening.go');
    // What the loader tests fake and what is real: not "faked owners, real modes".
    expect(entry).not.toContain('faked owners, real modes');
    expect(entry).toContain(
      "the **modes of the directories above the executable's directory** (reported as 0755",
    );
    expect(entry).toContain('What is real: the modes of the library, the manifest, `native/`');
    // The links claim says what the code does, and the images are named by the commands that build them.
    expect(entry).toContain('**No link is followed anywhere on the path:**');
    expect(entry).toContain('Bun reports `process.execPath` already resolved');
    expect(entry).toContain('the directory beside the executable must still be its own `realpath`');
    expect(entry).toContain('fail-closed assertion');
    expect(entry).toContain(
      'The Dockerfile that `knext build`, `knext deploy` and `knext preview` stage copies `native/`',
    );
    // The nested layout has no real-Docker CI leg: named, tracked, and not required for Accepted.
    expect(entry).toContain('model-tested only, with no real-Docker CI leg');
    expect(entry).toContain('TD-S18-1b');
    expect(entry).toMatch(/ACL/);
    expect(entry).toMatch(/macOS/);
    expect(entry).toMatch(/second mount/);
    expect(entry).toContain('no opt-out');
    expect(entry).toContain('memfd');
    // Every directory up to /: why, who it leaves out, and that the old "not judged" claims are gone.
    expect(entry).not.toContain('whoever can rename one of those can replace the whole tree');
    expect(entry).not.toContain('are not judged, and a writer there');
    expect(entry).not.toMatch(/cannot change the bytes of a file only root can write/);
    expect(entry).toContain('**Every directory above the library is judged, up to `/`.**');
    expect(entry).toMatch(/no user but root can swap any part of it/);
    expect(entry).toContain('StrictModes');
    expect(entry).toMatch(/refused too\. That is the conservative reading, not a measured hole/);
    expect(entry).not.toMatch(/the sticky bit stops deleting/);
    expect(entry).toContain('a rename is restricted like an unlink');
    expect(entry).toMatch(/covers `\/`/);
    expect(entry).toMatch(/The owner of a directory on the path is not on this list/);
    // The manifest IS judged: the first version's "not a bypass" reasoning was wrong, and says so.
    expect(entry).toContain('`native/.integrity.json` is judged like the library');
    expect(entry).toMatch(/whoever writes it chooses which bytes pass/);
    expect(entry).toMatch(/That argument was wrong/);
    expect(entry).not.toContain('is not checked for owner or mode');
    expect(entry).not.toMatch(/not a bypass\./);
    // Links, regular files, pinned directories as a tripwire, and what is still not stopped.
    expect(entry).toContain('`O_NOFOLLOW`');
    expect(entry).toContain('`O_NONBLOCK`');
    expect(entry).toMatch(/refused unless they are regular files/);
    expect(entry).toContain('**The pins are a tripwire, not the lock.**');
    expect(entry).toMatch(/checked, not locked/);
    expect(entry).toMatch(/aiming the path at another complete tree that root wrote/);
    expect(entry).not.toContain('TODO(TD-S17-close-1)');
    expect(entry).toMatch(/dangling symbolic link at the staged path counts as staged/);
    // What the lanes proved, with both runs cited as the ADR cites them, and what is still pending.
    expect(entry).toContain('**Lanes:**');
    expect(entry).toContain('actions/runs/44882665743');
    expect(entry).toContain('actions/runs/44882665667');
    expect(entry).toContain('actions/runs/44887787660');
    // The row points at the paragraphs under the table, and says how many there are.
    const raw = repoFile('docs/security/threat-model.md');
    const rawStart = raw.indexOf('### The in-process Rust library');
    const rawEntry = raw.slice(rawStart, raw.indexOf('\n### ', rawStart + 10));
    const afterTable = rawEntry.slice(rawEntry.lastIndexOf('\n| **T**amper'));
    const paragraphs = afterTable.split('\n\n').filter((p) => p.startsWith('**'));
    const words = ['zero', 'one', 'two', 'three', 'four', 'five', 'six'];
    expect(paragraphs.length).toBeGreaterThan(0);
    expect(entry).toContain(`See the ${words[paragraphs.length]} paragraphs below`);
    // The development path: an accepted, dev-only hole, and a refused staged library never reaches it.
    expect(entry).toContain('**The development build is an accepted, development-only path.**');
    expect(entry).toMatch(/`NODE_ENV` is not `production`/);
    expect(entry).toMatch(/no owner check and no hash/);
    expect(entry).toContain(
      'A staged library that is refused throws; it never falls through to the development build',
    );
    expect(entry).toContain('ffi-loader.test.ts');
    // Evidence the diff carries, not a measurement made elsewhere.
    expect(entry).not.toMatch(/image matrix/);
    expect(entry).toContain('the documented Dockerfile recipe');
  });

  it('reconciles the sharp addon tree with the Rust one: one tree, two loaders, and what protects sharp', () => {
    const model = repoFile('docs/security/threat-model.md').replace(/\s+/g, ' ');
    const at = model.indexOf('### `/app/native`');
    expect(at, 'no /app/native section').toBeGreaterThan(-1);
    const sharp = model.slice(at, model.indexOf(' ### ', at + 10));
    expect(sharp).not.toContain('That tree is the only remaining path');
    expect(sharp).toContain('**One tree, two loaders, two rules.**');
    expect(sharp).toContain('sharp-addon-dlopen.mjs');
    expect(sharp).toMatch(/hashes the file by path and then `dlopen`s by path/);
    expect(sharp).toMatch(/no owner or mode check/);
    expect(sharp).toMatch(/root-owned, read-only layout/);
    expect(sharp).toMatch(/\*\*Open debt:\*\*/);
  });

  it('amends the ADR in ADR form: a numbered Amendment with Context, Decision, Options and Consequences, and the sections it changes', () => {
    const adr = repoFile('docs/adr/0069-bun-ffi-inprocess-rust.md');
    const h2 = (re: RegExp) => {
      const lines = adr.split('\n');
      const i = lines.findIndex((l) => re.test(l));
      expect(i, `no heading ${re}`).toBeGreaterThan(-1);
      const rest = lines.slice(i + 1);
      const j = rest.findIndex((l) => /^## /.test(l));
      return (j === -1 ? rest : rest.slice(0, j)).join('\n').replace(/\s+/g, ' ');
    };
    const amendment = h2(/^## Amendment 1 \(2026-11-21\) — /);
    for (const h of ['### Context', '### Decision', '### Options considered', '### Consequences']) {
      expect(amendment, h).toContain(h);
    }
    // Decision: the rule, who is not trusted, why directories count, the unjudged manifest, the dev path.
    expect(amendment).toMatch(/owned by uid 0/);
    expect(amendment).toMatch(/not writable by group or other/);
    expect(amendment).toContain("every directory from the library's parent up to `/`");
    expect(amendment).toMatch(/the user the process runs as is not trusted/i);
    expect(amendment).toMatch(/no opt-out/i);
    expect(amendment).toMatch(
      /Renaming or replacing a directory needs write permission on its parent/,
    );
    // The manifest is judged; the first version's reasoning is named and withdrawn, not left standing.
    expect(amendment).toContain('The manifest is judged like the library.');
    expect(amendment).toMatch(/That was wrong\. The manifest is what authorises a file/);
    expect(amendment).not.toContain('is not checked for owner or mode.');
    // Links are never followed, the directories are pinned, and the limit is stated.
    expect(amendment).toContain('**Links are never followed.**');
    expect(amendment).toContain('`O_NOFOLLOW`');
    expect(amendment).toContain('**Defence in depth: the directories and files are pinned.**');
    expect(amendment).toContain('**Files must be regular files and must not block.**');
    expect(amendment).toMatch(/checked, not locked/);
    expect(amendment).toContain('/dev/fd/<n>/x');
    // The ancestor walk, argued: why it is sufficient, the StrictModes precedent, and what it costs.
    expect(amendment).toContain(
      '**Why every ancestor, and why that is sufficient against a non-root actor.**',
    );
    expect(amendment).toContain('StrictModes');
    expect(amendment).toMatch(/\| \(h\) require every directory from `native\/` up to `\/`/);
    expect(amendment).toMatch(/\(jev 0\.96;/);
    expect(amendment).toMatch(/under a root-owned `\/opt\/<app>` is fine/);
    // Option (g) is no longer argued as "not available": it works on Linux, and fails on portability.
    expect(amendment).toMatch(/the first version argued it wrongly/);
    expect(amendment).toMatch(/`\/proc\/self\/fd\/<dirfd>\/x` works there/);
    // The residual names its actors, and the old repoint residual is closed by the walk.
    expect(amendment).toContain('**What is not stopped.**');
    expect(amendment).toMatch(/`CAP_DAC_OVERRIDE` or `CAP_FOWNER`/);
    expect(amendment).toContain('any capability that is equivalent to root, for example');
    for (const cap of ['CAP_SYS_MODULE', 'CAP_SYS_RAWIO', 'CAP_BPF']) {
      expect(amendment, cap).toContain(`\`${cap}\``);
    }
    expect(amendment).toContain('`runAsNonRoot`');
    expect(amendment).toMatch(/The owner of an ancestor is no longer on this list/);
    expect(amendment).not.toContain('on files and directories it does not own');
    // The images: what was measured, the line that fixes the nested layout, and the lane pending.
    expect(amendment).toContain(
      '**The shipped images pass: the lanes are green on `6be5939` and again on `dc4eb3b`, and the musl load matrix, the kind e2e and the Rust crates lane are green on `abca3e3`, on `81753d6`, on `b4d81ae` (where `Lint & Test` was red, on a comment in core, since fixed) and on `0c07c17`, where all of them and `Lint & Test` were green; they are re-run on the final head; the nested layout is model-tested only (`TD-S18-1b`).**',
    );
    // The CI result on the previous head is recorded, with the one red and how it was fixed.
    expect(amendment).toContain('b4d81ae9b346023ddea03b5a6c5124588c8d2b3d');
    expect(amendment).toContain('actions/runs/44900618316');
    expect(amendment).toContain('the guard is not relaxed');
    // The amendment names every decision it changes and every trigger it is, and D17 and D18 carry the change.
    expect(amendment).toContain('It also amends **D17**');
    expect(amendment).toContain('and **D18**');
    expect(amendment).toContain(
      'It is an ADR trigger, a security-invariant trigger and a core-vs-app-boundary trigger',
    );
    const flatAdr = adr.replace(/\s+/g, ' ');
    expect(flatAdr).toContain('with one exception named below');
    expect(flatAdr).toContain('**The exception (Amendment 1), and why it is safe.**');
    expect(flatAdr).toContain('is a behaviour change without the opt-in');
    expect(flatAdr).toContain(
      "and the recognition of the scaffolded vinext `Dockerfile` with one extra line, `RUN chmod go-w /app /app/native`, directly after its `native/` `COPY` (`isKnownGoodTemplateDockerfile`, D17's exception)",
    );
    // The hint comes from all three verbs, for a vinext app only, and says where the line goes.
    expect(flatAdr).toContain('The hint comes from all three verbs');
    expect(flatAdr).toContain(
      'printed for an app built for vinext, and for one whose build cannot be told',
    );
    // The hint confirms one form and never claims more: the exact rule is in the ADR, stated and no stronger.
    expect(flatAdr).toContain('**The hint does not read what a command does.**');
    expect(flatAdr).toContain(
      'It confirms one form and says nothing only for it: the scaffolded `COPY` of `native/` (`VINEXT_NATIVE_COPY`), then `VINEXT_CLOSE_LINE` as the very next line of the file, byte for byte',
    );
    expect(flatAdr).toContain('in a `Dockerfile` with no `<<` anywhere in it');
    expect(flatAdr).toContain('Neither message says that the loader will accept the directories');
    expect(flatAdr).toContain(
      'knext does not read it and `knext deploy` takes the slower image-sourced path for it',
    );
    expect(flatAdr).not.toContain('read the way a shell would read them');
    expect(flatAdr).not.toContain('What cannot be read counts as opening');
    // What accepts the amendment, and what does not: three lanes on the final head; the nested leg is debt.
    expect(amendment).toContain(
      'Accepted requires three lanes green on the final head of this change: the musl load matrix (x64 and arm64), the kind e2e that calls Rust from a Server Action on a Bun zone, and the Rust crates lane',
    );
    expect(amendment).toContain(
      'is **not** required for Accepted: it is tracked as debt `TD-S18-1b`',
    );
    expect(amendment).toContain('actions/runs/44887787660');
    expect(amendment).toContain('dc4eb3b4dfe92eb4afb6059b9cb58e2c25f82b30');
    expect(amendment).toContain("`/opt`, which GitHub's `ubuntu-latest` runner has at mode 0777");
    expect(amendment).toContain('**the nested layout: model-tested only, no real-Docker CI leg**');
    expect(amendment).toContain(
      'the nested layout is model-tested only, with no real-Docker CI leg',
    );
    // The evidence is cited: the previous head and the runs that passed on it.
    expect(amendment).toContain('6be5939867e0d08d87fc952c0bd982e3f0f76d02');
    expect(amendment).toContain('actions/runs/44882665743');
    expect(amendment).toContain('actions/runs/44882665667');
    // The sticky argument is dropped, and the refusal is justified as the conservative reading.
    expect(amendment).not.toContain('the sticky bit stops deleting what someone else owns');
    expect(amendment).toContain('`rename` is restricted like `unlink`');
    expect(amendment).toContain("what OpenSSH's `StrictModes` does");
    // The residual names the capability class, /proc/self/mem and the user namespace that is the real gap.
    for (const cap of ['CAP_CHOWN', 'CAP_SETUID', 'CAP_SYS_ADMIN', 'CAP_SYS_PTRACE', 'CAP_MKNOD']) {
      expect(amendment, cap).toContain(`\`${cap}\``);
    }
    expect(amendment).toContain('`/proc/self/mem`');
    expect(amendment).toContain('One the attacker makes for itself gains nothing');
    expect(amendment).toContain('`hostUsers: false`');
    expect(amendment).toContain('does not remove that writer');
    expect(amendment).toContain('restores the guarantee');
    expect(amendment).toContain('pod_hardening.go');
    expect(amendment).toContain(
      'A volume shared with a sidecar or writable through an `fsGroup` is refused unless root owns',
    );
    expect(amendment).toMatch(/the directory beside the executable must be its own real path/i);
    // Bun resolves execPath, so the refusal is an assertion; a release-directory deploy tool is refused by ownership.
    expect(amendment).toContain('Bun reports `process.execPath` already resolved');
    expect(amendment).toContain('fail-closed assertion');
    expect(amendment).toContain(
      'put `deploy_to` under a parent where every directory from that parent up to `/` is root-owned and closed to group and other, make `deploy_to`, `releases/` and each release root-owned and closed to group and other, and never change anything above `deploy_to`. Switching `current` and `deploy:cleanup` need root too',
    );
    expect(amendment).not.toContain('make the release tree root-owned');
    expect(amendment).not.toContain('(run the step that puts the files in place as root)');
    expect(amendment).not.toContain('run the executable from its real path');
    // Option (g): the two things directory-descriptor anchoring alone never closed.
    expect(amendment).toContain('never closed the first lookup');
    expect(amendment).toContain('the old-tree repoint');
    // The numbering in the status paragraph matches the nine items of the Decision.
    expect(amendment).toContain('all nine items of the Decision');
    expect(amendment).not.toContain('items 1 to 5, 7 and 8');
    expect(amendment.match(/ \d\. \*\*/g)?.length).toBe(9);
    expect(amendment).toMatch(/nested \(monorepo\) standalone image did not/);
    expect(amendment).toContain('RUN chmod go-w');
    // Not Accepted, and why: the lane that proves the images pass has not run on this revision.
    expect(amendment).toMatch(/Status: Proposed/);
    expect(amendment).toContain('Why it stays Proposed');
    expect(amendment).toContain('never falls through to the development build');
    // Options: the three the measurement compared, with the measured reason for the one not used.
    expect(amendment).toContain('memfd_create');
    expect(amendment).toMatch(/two file descriptors of one file[^.]*one loaded library/i);
    expect(amendment).toMatch(/two sealed copies[^.]*two libraries/);
    expect(amendment).toMatch(/mode bits only/);
    // Consequences: the user-Dockerfile breakage, the wrapper regeneration, the residuals.
    expect(amendment).toMatch(/user Dockerfile[^.]*\bchown\b/);
    expect(amendment).toContain('knext ffi check');
    expect(amendment).toContain('knext ffi generate');
    expect(amendment).toMatch(/generated before this change/);
    // The amendment says it carries a pointer in D14 and D16: it has to.
    const d14 = adr.slice(adr.indexOf('### D14.'), adr.indexOf('### D15.')).replace(/\s+/g, ' ');
    expect(d14).toContain('Amendment 1');
    expect(d14).toContain('--chown=0:0 --chmod=a-w');
    expect(d14).toContain(
      'RUN chmod go-w /app /app/.next /app/.next/standalone /app/.next/standalone/native',
    );
    expect(d14).toContain('up to `/`');
    const d16 = adr.slice(adr.indexOf('### D16.'), adr.indexOf('### D17.')).replace(/\s+/g, ' ');
    expect(d16).toContain('Amendment 1');
    expect(d16).toContain('root must own');
    expect(d16).toContain('the FFI loader judges');
    expect(d16).toContain(
      'the sharp shim in the vinext image hashes by path and does not judge owner or mode',
    );
    // D18 lists the image chmod line among the Rust-specific things core contains.
    const d18 = adr.slice(adr.indexOf('### D18.'), adr.indexOf('### D19.')).replace(/\s+/g, ' ');
    expect(d18).toContain(
      'the `RUN chmod go-w` line that closes `native/` and the directories above the executable',
    );
    // D13 points at it instead of carrying a bold paragraph of its own.
    const d13 = adr.slice(adr.indexOf('### D13.'), adr.indexOf('### D14.')).replace(/\s+/g, ' ');
    expect(d13).toContain('Amendment 1');
    expect(d13).not.toContain('Options measured for binding the bytes');
    // The ADR's own Options considered and Consequences sections carry the change too.
    expect(h2(/^## Options considered$/)).toContain('Amendment 1');
    const consequences = h2(/^## Consequences$/);
    expect(consequences).toContain('Amendment 1');
    expect(consequences).toMatch(/user Dockerfile/);
  });

  it("says the vinext template is not changed: the line is the app owner's to add, `knext ffi init` prints it, and no doc claims the image gets it automatically", () => {
    const LINE = 'RUN chmod go-w /app /app/native';
    // The template is the app's own Dockerfile, compared byte for byte by `knext deploy`: it stays as it was.
    const template = repoFile('packages/kn-next/templates/app/Dockerfile.hbs');
    expect(template).not.toContain('chmod go-w');
    // The page tells a vinext app owner what to add, and that `knext ffi init` prints it.
    const flat = must(page, /where the library is loaded from/i).replace(/\s+/g, ' ');
    expect(flat).toContain('An app scaffolded for the vinext build');
    expect(flat).toContain('That file is yours and knext does not edit it');
    expect(flat).toContain(
      `put \`${LINE}\` directly after the \`COPY\` that brings \`native/\` in (and so before \`USER\`)`,
    );
    expect(flat).toContain('`knext ffi init` prints that line');
    expect(flat).toContain('and so do `knext ffi generate` and `knext ffi check`');
    // The scaffolded file with just that one line stays known-good, so following the advice keeps the build
    // and the asset upload; under BuildKit nothing changes for an existing app and another builder is told.
    expect(flat).toContain('change nothing else in the file');
    expect(flat).toContain('recognises the scaffolded `Dockerfile` byte for byte');
    expect(flat).toContain(
      'with just this one line directly after the `COPY` that brings `native/` in as well',
    );
    expect(flat).toContain('Under BuildKit nothing changes for an existing app');
    expect(flat).toContain('With another builder the first call of the module is refused');
    // Only the one line directly after the COPY is what deploy recognises: a chmod anywhere else closes
    // the directories but takes the slower path, and the hint says so for a vinext app (or one whose
    // build cannot be read) and no other.
    expect(flat).toContain('and `knext deploy` takes the slower path described next');
    expect(flat).toContain('An app built with another builder is told none of this');
    expect(flat).toContain('an app whose build cannot be read');
    expect(flat).toContain('is told as if it were vinext');
    // The hint does not read commands: one confirmed form, and no claim stronger than that.
    expect(flat).toContain('They do not read what your commands do. They confirm one form');
    expect(flat).toContain('then that line as the very next line of the file, byte for byte');
    expect(flat).toContain('in a `Dockerfile` with no heredoc');
    expect(flat).toContain('and never say that the loader will accept the directories');
    expect(flat).not.toContain('read the way a shell reads them');
    expect(flat).toContain('which one line to add');
    expect(flat).not.toContain('the message names the fix');
    // The ADR says the template is unchanged, and nothing says it gains the line or that the image is untouched.
    const adr = repoFile('docs/adr/0069-bun-ffi-inprocess-rust.md').replace(/\s+/g, ' ');
    expect(adr).toContain('The vinext template (`templates/app/Dockerfile.hbs`) is not changed');
    expect(adr).toContain('`knext ffi init` prints that line');
    expect(adr).toContain('`vinextTemplateWithCloseLine(template)`');
    expect(adr).toContain('Under BuildKit nothing changes for an existing app');
    const changeset = repoFile('.changeset/ffi-sealed-tree-swap.md');
    expect(changeset).toContain(
      "the vinext template is the app's own scaffolded `Dockerfile` and is not changed",
    );
    expect(changeset).toContain('Under BuildKit nothing changes for an existing app');
    expect(changeset).toContain(
      'with another builder the first call is refused, and the message says how to fix the directories',
    );
    const model = repoFile('docs/security/threat-model.md').replace(/\s+/g, ' ');
    expect(model).toContain(
      "the vinext template is the app's own scaffolded file and is not changed",
    );
    for (const [name, text] of [
      ['the ADR', adr],
      ['the changeset', changeset],
      ['the threat model', model],
      ['the page', flat],
    ] as const) {
      expect(text, `${name} claims the vinext template gains the line`).not.toMatch(
        /vinext template[^.]{0,40}(gains|carries) `RUN chmod/,
      );
      expect(text, `${name} claims the vinext image is unchanged by the line`).not.toContain(
        'its image is unchanged',
      );
    }
  });

  it('opens the changeset with a sentence that reads: the module `knext ffi generate` writes is the subject', () => {
    const cs = repoFile('.changeset/ffi-refuse-writable-native.md');
    expect(cs).toContain(
      'In-process Rust (Beta): the module that `knext ffi generate` writes now refuses to load a Rust library that anyone but root could change after its sha256 was checked.',
    );
    expect(cs).not.toContain('the module `knext ffi generate` writes now');
  });

  it('documents slow calls: the threshold, both metrics, the log lines as the module prints them, and that a call is not interrupted', () => {
    const body = must(page, /slow calls/i);
    for (const s of [
      'KNEXT_FFI_SLOW_CALL_MS',
      'knext_ffi_slow_calls_total',
      'knext_ffi_load_seconds',
      '50 ms',
    ]) {
      expect(body, s).toContain(s);
    }
    expect(rendered).toContain("if (raw === undefined || raw.trim() === '') return 50;");
    const log = templateAfter(rendered, /console\.warn\(\s*`(?=knext ffi: \$\{fn\}\(\) took)/);
    expectBlock(body, pattern(log), 'the slow-call log line');
    const ignoring = templateAfter(
      rendered,
      /console\.warn\(\s*`(?=knext ffi: ignoring KNEXT_FFI_SLOW_CALL_MS)/,
    );
    expectBlock(body, pattern(ignoring), 'the unusable-threshold warning');
    // Honest about the limit: counting makes a blocking call visible, not interruptible.
    expect(body).toMatch(/cannot interrupt/i);
    expect(body).toMatch(/SIGTERM/);
  });

  it('quotes the argument TypeError as the module throws it', () => {
    const body = must(page, /errors and panics/i);
    const typeError = new RegExp(
      `^${pattern(templateAfter(rendered, /function \$str\([^)]*\)[^{]*\{[^`]*`/))}$`,
    );
    expect(
      inlineCode(body).some((span) => typeError.test(span)),
      `no inline code span is exactly ${typeError}`,
    ).toBe(true);
  });

  it('quotes the "invalid input" error as the module and the crate build it', () => {
    const body = must(page, /records and enums/i);
    const prefix = templateAfter(rendered, /status === 3 \? `/);
    expectBlock(body, pattern(prefix, [pattern(decodeFormat())]), 'the invalid-input error');
  });

  it('quotes the `char` compile error as the macro words it and the compiler prints it', () => {
    const body = must(page, /type mapping/i);
    const types = 'crates/knext-ffi-macros/src/types.rs';
    const fmt = rustLiteral(
      types,
      /pub fn reject\([^)]*\)[^{]*\{\s*Error::new\(\s*span\.span\(\),\s*format!\(\s*/,
    );
    const why = rustLiteral(types, /"char" => \{\s*return Err\(reject\(\s*ty,\s*ty,\s*/);
    const hint = rustLiteral(types, /pub const TABLE_HINT: &str =\s*/);
    expect(fmt.split('{TABLE_HINT}')).toHaveLength(2);
    const quoted = `error: ${fmt.replace('{}', 'char').replace('{why}', why).replace('{TABLE_HINT}', hint)}`;
    expect(codeBlocks(body)).toContain(quoted);
    const compiler = repoFile('crates/knext-ffi/tests/ui/fail/char_arg.stderr').split('\n')[0];
    expect(compiler, 'char_arg.stderr').toBe(quoted);
  });

  it("points every compile error at this page's type-mapping table, by its real slug", () => {
    const hint = rustLiteral(
      'crates/knext-ffi-macros/src/types.rs',
      /pub const TABLE_HINT: &str =\s*/,
    );
    const url = /https:\/\/\S+/.exec(hint)?.[0] ?? '';
    const heading = page.split('\n').find((l) => /^## type mapping$/i.test(l)) ?? '';
    expect(heading, 'no "## Type mapping" heading').not.toBe('');
    const slug = heading.slice(3).toLowerCase().replace(/\s+/g, '-');
    expect(url).toBe(`https://knext-platform.dev/docs/rust-in-process#${slug}`);
  });

  it('lists every global and declared name a Rust function or argument may not take', () => {
    const body = must(page, /reserved names/i);
    // Every name the module declares or references that is not a language
    // keyword: the capitalised ones, plus the lowercase globals.
    const lowercase = ['process', 'console', 'globalThis', 'performance'];
    const globals = [...RESERVED].filter((n) => /^[A-Z]/.test(n) || lowercase.includes(n));
    expect(globals.length).toBeGreaterThan(10);
    for (const name of globals) expect(body, name).toContain(`\`${name}\``);
    for (const name of RESERVED_TYPES) expect(body, name).toContain(`\`${name}\``);
    expect(body).toContain('__proto__');
    expect(body).toMatch(/rename it in Rust/);
  });

  it('quotes the reserved-name error exactly as the generator throws it', () => {
    const body = must(page, /reserved names/i);
    const message = thrown(() => scanManifest(blob([fn('process', [], D.t('string'))])));
    expect(codeBlocks(body)).toContain(message);
  });

  it('shows knext.ffi.json exactly as `knext ffi init` writes it', () => {
    expect(page).toContain(serializeConfig(DEFAULT_CONFIG).trim());
  });

  it('names the image targets and the toolchain install commands the build prints', () => {
    const body = must(page, /building images/i);
    for (const t of SUPPORTED_TARGETS) expect(body).toContain(t);
    const lines = codeBlocks(body).flatMap((b) => b.split('\n'));
    expect(lines).toContain(`${INSTALL_HINTS.rustupTarget} ${SUPPORTED_TARGETS[0]}`);
    // Every pinned cargo tool, by the exact command its check prints.
    for (const tool of Object.keys(CARGO_TOOL_PINS) as CargoTool[]) {
      expect(INSTALL_HINTS[tool], tool).toBe(cargoInstallCommand(tool));
      expect(lines, tool).toContain(cargoInstallCommand(tool));
    }
    expect(body).toMatch(/Cargo\.lock/);
    expect(body).not.toContain('pip install ziglang');
    expectOnlyPinnedVersions(page, 'rust-in-process.mdx');
  });

  it('states the pinned zig: version, download hosts, cache, timeout and proxy', () => {
    const body = must(page, /building images/i);
    expect(body).toContain(`zig ${ZIG_PIN.version}`);
    expect(body).toMatch(/other version[^.]*refused/i);
    for (const host of Object.keys(ZIG_PIN.assets)) expect(body, host).toContain(`\`${host}\``);
    expect(body).toContain('sha256');
    expect(body).toMatch(/about 10 s/);
    expect(ZIG_DOWNLOAD_TIMEOUT_MS % 60_000).toBe(0);
    expect(body).toContain(`${ZIG_DOWNLOAD_TIMEOUT_MS / 60_000} minutes`);
    expect(body).toContain('`HTTPS_PROXY`');
    expect(repoFile('packages/ffi/src/supply-chain.ts')).toContain(
      'does not go through HTTPS_PROXY',
    );
    const v = ZIG_PIN.version;
    expect(body).toContain(`\`${zigCacheDir({ KNEXT_CACHE_DIR: '$KNEXT_CACHE_DIR' }, '~', v)}\``);
    expect(body).toContain(`\`${zigCacheDir({ XDG_CACHE_HOME: '$XDG_CACHE_HOME' }, '~', v)}\``);
    expect(body).toContain(`\`${zigCacheDir({}, '~', v)}\``);
  });

  it('says a non-finite float crosses raw at the top level and is refused in every JSON position', () => {
    const body = must(page, /type mapping/i);
    // A plain float argument or return crosses as a raw number.
    expect(body).toMatch(/`NaN`\s+and\s+`Infinity`\s+arrive\s+intact/);
    // Inside JSON, Option included, it is refused both ways and never becomes None/null.
    expect(body).toMatch(
      /refused in every JSON position,\s+`Option` included,\s+in both\s+directions/,
    );
    expect(body).toMatch(/never silently becomes `None` or `null`/);
    expect(body).not.toMatch(/silently becomes `None` on the Rust side/);
  });

  it('quotes the finite-number TypeError as the module throws it', () => {
    const body = must(page, /type mapping/i);
    const efin = new RegExp(
      `^${pattern(templateAfter(floatyRendered, /function \$efin\([^)]*\)[^{]*\{[^`]*`/))}$`,
    );
    expect(
      inlineCode(body).some((span) => efin.test(span)),
      `no inline code span is exactly ${efin}`,
    ).toBe(true);
  });

  it('quotes the return-side refusal as the module and the crate build it, and owns up to its prefix', () => {
    const body = must(page, /type mapping/i);
    const prefix = templateAfter(rendered, /status === 3 \? `/);
    const notFinite = rustFormat(
      rustLiteral(WIRE, /macro_rules! finite_float[\s\S]*?S::Error::custom\(format_args!\(\s*/),
    );
    const message = pattern(returnFormat(), [`result${VALUE}: ${pattern(notFinite)}`]);
    expectBlock(body, pattern(prefix, [message]), 'the return-side refusal');
    // The prefix says "input"; the page must say the fault is in the return value.
    expect(body).toMatch(/fault is in the value your Rust function returned/);
    // The generated TSDoc quotes the same message head.
    const [head] = returnFormat() as [string];
    expect(floatyRendered).toContain(
      `@throws {RustError} ("${prefix[0]}${head}…") when a number inside the returned value is NaN or Infinity`,
    );
  });

  it('quotes the f32 overflow refusal as the crate builds it', () => {
    const body = must(page, /type mapping/i);
    const prefix = templateAfter(rendered, /status === 3 \? `/);
    const overflow = rustFormat(
      rustLiteral(WIRE, /macro_rules! finite_float[\s\S]*?D::Error::custom\(format_args!\(\s*/),
    );
    const message = pattern(decodeFormat(), [
      VALUE,
      `${pattern(overflow, ['f32'])} at line \\d+ column \\d+`,
    ]);
    expectBlock(body, pattern(prefix, [message]), 'the f32 overflow refusal');
  });

  it('states every per-call number with the hardware and Bun version it was measured on', () => {
    const body = must(page, /blocking/i);
    expect(body).toMatch(/\bns\b/);
    expect(body).toContain('M1 Pro');
    expect(body).toContain('Bun 1.4.2');
  });

  it('says the numbers come from a prototype, with the row labels that were measured', () => {
    const body = must(page, /blocking/i);
    expect(body).toContain('a prototype of the generated wrapper');
    expect(body).toContain('`sum(Vec<u8>)`');
    expect(body).not.toContain('sum(&[u8])');
  });

  it('says Workers share one copy of the library, and with it every Rust static', () => {
    const body = must(page, /blocking/i);
    expect(body).not.toMatch(/its own copy of the library/);
    expect(body).toMatch(/one copy of the library/);
    expect(body).toContain('OnceLock');
    expect(body).toMatch(/shared/);
  });

  it('is honest that Workers inside a Next.js build do not work, and points at zone functions', () => {
    const body = must(page, /blocking/i);
    expect(body).toMatch(/Turbopack/);
    expect(body).toMatch(/webpack/);
    expect(body).toMatch(/zone function/i);
    expect(body).toContain('--conditions=react-server');
  });

  it('describes the supply-chain gates as shipped, by the names the build uses', () => {
    const body = must(page, /supply chain/i);
    expect(body).not.toMatch(/planned|not done/i);
    expect(body).toContain('`cargo deny check`');
    expect(body).toContain('`cargo auditable`');
    expect(body).toContain(`\`${DEFAULT_CONFIG.crate}/${DENY_FILE}\``);
    expect(existsSync(join(TEMPLATE_DIR, DEFAULT_CONFIG.crate, DENY_FILE))).toBe(true);
    expect(body).toContain(`\`${DEFAULT_CONFIG.crate}/${ADVISORY_ALLOWLIST_FILE}\``);
    expect(body).toContain(`\`native/ffi/<target>/${SBOM_FILE}\``);
    expect(body).toContain(`\`native/ffi/<target>/${PROVENANCE_FILE}\``);
    expect(body).toContain('.integrity.json');
    expect(body).toContain(ALLOWED_GIT_SOURCE);
    // deny.toml's own `ignore` is not an allowlist.
    expect(body).toMatch(/ignore[^.]*deny\.toml[^.]*still refused/i);
  });

  it('shows an advisory allowlist the build accepts, naming every field', () => {
    const body = must(page, /supply chain/i);
    const json = codeBlocks(body).filter((b) => b.includes('"allow"'));
    expect(json).toHaveLength(1);
    const dir = mkdtempSync(join(tmpdir(), 'knext-docs-allowlist-'));
    try {
      writeFileSync(join(dir, ADVISORY_ALLOWLIST_FILE), json[0] as string);
      const entries = loadAdvisoryAllowlist(dir, 'rust');
      expect(entries.length).toBeGreaterThan(0);
      expect(Object.keys(entries[0] as object).sort()).toEqual([
        'added',
        'expires',
        'id',
        'justification',
      ]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
    for (const field of ['id', 'justification', 'added', 'expires']) {
      expect(body, field).toContain(`\`${field}\``);
    }
    expect(body).toMatch(/`expires`[^.]*optional/);
  });

  it('lists exactly the fields provenance.json carries', () => {
    const body = must(page, /supply chain/i);
    const listed = [...body.matchAll(/^ {2}- `(\w+)`/gm)].map((m) => m[1]);
    expect(listed.sort()).toEqual(provenanceKeys().sort());
  });
});

describe('docs — the `knext ffi` CLI reference', () => {
  const body = section(cli, /^## `knext ffi`$/);

  it('has the section, with every subcommand and exit codes', () => {
    expect(body.trim().length).toBeGreaterThan(200);
    for (const sub of ['init', 'generate', 'check', 'build']) {
      expect(body).toContain(`knext ffi ${sub}`);
    }
    expect(body).toContain('Exit code');
    expect(body).toContain('--target');
    expect(body).toContain('--native-dir');
  });

  it('names every pinned build tool and the files `knext ffi init` writes', () => {
    for (const pin of Object.values(CARGO_TOOL_PINS)) {
      expect(body, pin.crate).toContain(`${pin.crate} ${pin.version}`);
    }
    expect(body).toContain(`zig ${ZIG_PIN.version}`);
    expectOnlyPinnedVersions(cli, 'cli.mdx');
    expect(body).toContain(`\`${DENY_FILE}\``);
    expect(body).toContain(`\`${SBOM_FILE}\``);
  });

  it('quotes the Beta line every run prints', () => {
    expect(body).toContain(BETA_NOTICE);
  });

  it('links the full page', () => {
    expect(body).toContain('/docs/rust-in-process');
  });
});
