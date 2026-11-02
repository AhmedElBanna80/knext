/**
 * Self-contained vinext executable: which of the APP'S OWN data files go INTO
 * the binary (build time; the runtime half is `app-data-alias.mjs`).
 *
 * The module graph carries code. Files an app reads at request time are not in
 * it, and a binary run from an empty directory has nothing to read them from:
 *
 *   - `outputFileTracingIncludes` (next.config) DECLARES them;
 *   - an app also names project files by literal path,
 *     `join(process.cwd(), "app/x/data.json")` or
 *     `new URL("../../my-data.json", import.meta.url)`. `next build` finds
 *     those with a file tracer; the vinext/Nitro output has no such trace, so
 *     the compile reads the server output for the same two literal shapes.
 *
 * Declared files are a contract: one that cannot be embedded FAILS the build
 * (no match, outside the app root, secret-looking, native addon, or inside a
 * package Nitro traced into the `.output/server/node_modules` sidecar, which a
 * binary with no sidecar cannot resolve). Literal-path files are discovered,
 * not declared, so a name that does not exist, is not a regular file, or is
 * not embeddable is skipped (and logged), never fatal: it may be written at
 * runtime.
 *
 * Only these literal shapes are recognised. A path computed at runtime, or
 * handed to `Bun.file`, is not found — declare it in `outputFileTracingIncludes`.
 *
 * Dependency-free over node builtins (+ `Bun.Glob` at build time).
 *
 * What upstream would replace: the `new URL(…, import.meta.url)` scan is the
 * build-time half of Bun embedding those files itself (registered as
 * bun-new-url-asset below). The declared-include embed is what Bun's
 * `--compile --include` / `--asset` would do (oven-sh/bun#44059), and
 * cloudflare/vinext's `outputFileTracingIncludes` support (cloudflare/vinext#3436)
 * copies only matches inside `node_modules`. The `process.cwd()` path alias in
 * app-data-alias.mjs has no upstream counterpart: Bun maps no real directory
 * onto `$bunfs`.
 */
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

const CONFIG_NAMES = [
  'next.config.js',
  'next.config.mjs',
  'next.config.ts',
  'next.config.mts',
  'next.config.cjs',
  'next.config.cts',
];
const GLOB_META = /[*?[\]{}]/;
/** `.env*`, `*.pem`, `*.key`, `id_*`: named exactly or not embedded (same rule as compile.include). */
const SECRET_NAME = /^(?:\.env(?:\..*)?|id_.*|.*\.(?:pem|key))$/i;
/** A native addon dlopens a real file; `$bunfs` cannot provide one. */
const NATIVE_ADDON = /\.(?:node|so|dylib|dll)$/i;
const WARN_BYTES = 64 * 1024 * 1024;

const toPosix = (p) => p.split(sep).join('/');

/**
 * The app's `outputFileTracingIncludes` globs (every route's, flattened — a
 * binary has one filesystem, so the per-route scoping cannot be kept), read the
 * way Next.js reads them: top-level, replaced by the legacy `experimental` key
 * when that is present. No next.config → `[]`. A config that exists but cannot
 * be loaded or has a malformed value THROWS: embedding nothing would be the
 * silent drop this exists to prevent.
 *
 * @param {string} root the app root
 * @returns {Promise<string[]>}
 */
export async function readTraceIncludes(root) {
  const name = CONFIG_NAMES.find((n) => existsSync(join(root, n)));
  if (name === undefined) return [];
  let loaded;
  try {
    loaded = await import(pathToFileURL(join(root, name)).href);
    let config = loaded.default ?? loaded;
    if (typeof config === 'function') {
      config = await config('phase-production-build', { defaultConfig: {} });
    }
    loaded = config;
  } catch (err) {
    throw new Error(
      `could not load ${name} to read outputFileTracingIncludes: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const config = loaded ?? {};
  const experimental = config.experimental;
  const map =
    experimental && typeof experimental === 'object' && 'outputFileTracingIncludes' in experimental
      ? experimental.outputFileTracingIncludes
      : config.outputFileTracingIncludes;
  if (map === undefined || map === null) return [];
  if (typeof map !== 'object' || Array.isArray(map)) {
    throw new Error(`${name}: outputFileTracingIncludes must be an object of route → glob[]`);
  }
  const globs = [];
  for (const [route, value] of Object.entries(map)) {
    if (!Array.isArray(value) || !value.every((g) => typeof g === 'string')) {
      throw new Error(`${name}: outputFileTracingIncludes['${route}'] must be an array of glob strings`);
    }
    globs.push(...value);
  }
  return [...new Set(globs)];
}

/** Every `.js`/`.mjs`/`.cjs` file of the server output proper (never a traced `node_modules`). */
export function serverOutputFiles(serverDir) {
  const out = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.isFile() && /\.[cm]?js$/.test(entry.name)) out.push(path);
    }
  };
  if (existsSync(serverDir)) walk(serverDir);
  return out.sort();
}

const STRING_LITERAL = /^(?:"([^"\\\n]*)"|'([^'\\\n]*)'|`([^`$\\\n]*)`)/;
const literalOf = (m) => m[1] ?? m[2] ?? m[3];
const skipSpace = (src, i) => {
  while (i < src.length && /\s/.test(src[i])) i++;
  return i;
};

/**
 * The project files a server-output module names by literal path, as absolute
 * paths (unchecked — see `planAppData`). Shapes:
 *
 *   `f(process.cwd(), "a/b.json")`, `"a", "b.json"` — every argument a literal;
 *   `` `${process.cwd()}/a/b.json` `` — a complete template path;
 *   `process.cwd() + "/a/b.json"`;
 *   `new URL("../../x.json", import.meta.url)` — against the ENTRY's directory,
 *     because the compile rewrites every `import.meta.url` to the entry's.
 *
 * A literal list that stops before the path is complete (`join(cwd, "app",
 * name)`, a template with a trailing `${…}`) yields the directory prefix, which
 * is not a file and so embeds nothing: nothing is guessed.
 *
 * @param {string} source
 * @param {string} cwdRoot the directory `process.cwd()` is taken to be (the app root)
 * @param {string} entryDir the directory of the server entry
 * @returns {string[]}
 */
export function scanDataLiterals(source, cwdRoot, entryDir) {
  const found = new Set();
  const add = (base, rel) => {
    if (rel === '' || rel.includes('\0')) return;
    found.add(resolve(base, `.${rel.startsWith('/') ? '' : '/'}${rel}`));
  };
  if (source.includes('process.cwd()')) {
    const needle = 'process.cwd()';
    let at = source.indexOf(needle);
    while (at !== -1) {
      const after = skipSpace(source, at + needle.length);
      // `${process.cwd()}/a/b` inside a template literal
      if (source[at - 1] === '{' && source[at - 2] === '$' && source[at + needle.length] === '}') {
        const rest = source.slice(at + needle.length + 1);
        const m = /^([^`$\\\n]*)(`|\$\{)/.exec(rest);
        if (m) {
          add(cwdRoot, m[2] === '`' ? m[1] : m[1].slice(0, m[1].lastIndexOf('/') + 1));
        }
      } else if (source[after] === '+') {
        // process.cwd() + "/a/b.json"
        const lit = STRING_LITERAL.exec(source.slice(skipSpace(source, after + 1)));
        if (lit) {
          const end = skipSpace(source, skipSpace(source, after + 1) + lit[0].length);
          if (source[end] !== '+') add(cwdRoot, literalOf(lit));
        }
      } else if (source[after] === ',') {
        // f(process.cwd(), "a", "b.json") — process.cwd() must be the FIRST argument
        let before = at - 1;
        while (before >= 0 && /\s/.test(source[before])) before--;
        if (source[before] === '(') {
          const segments = [];
          let i = after;
          while (source[i] === ',') {
            i = skipSpace(source, i + 1);
            const lit = STRING_LITERAL.exec(source.slice(i));
            if (!lit) break;
            const next = skipSpace(source, i + lit[0].length);
            if (source[next] !== ',' && source[next] !== ')') break;
            segments.push(literalOf(lit));
            i = next;
          }
          if (segments.length > 0) add(cwdRoot, segments.join('/'));
        }
      }
      at = source.indexOf(needle, at + needle.length);
    }
  }
  // @upstream-shim bun-new-url-asset
  if (source.includes('import.meta.url')) {
    const re = /new\s+URL\(\s*(?:"([^"\\\n]*)"|'([^'\\\n]*)'|`([^`$\\\n]*)`)\s*,\s*import\.meta\.url\s*\)/g;
    for (let m = re.exec(source); m !== null; m = re.exec(source)) {
      const lit = m[1] ?? m[2] ?? m[3];
      if (lit === '' || lit.startsWith('/') || /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(lit)) continue;
      found.add(resolve(entryDir, lit));
    }
  }
  return [...found];
}

/** Every regular file under `dir`, as absolute paths (a symlink is returned, not followed). */
function walkFiles(dir, out, skipNodeModules) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (skipNodeModules && entry.name === 'node_modules') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(path, out, skipNodeModules);
    else if (entry.isFile() || entry.isSymbolicLink()) out.push(path);
  }
}

function normalisePattern(root, pattern) {
  const posix = pattern.split('\\').join('/');
  let rel;
  if (isAbsolute(pattern) || /^[A-Za-z]:\//.test(posix)) {
    rel = toPosix(relative(root, resolve(pattern)));
    if (rel.startsWith('..') || isAbsolute(rel) || rel === '') {
      throw new Error(
        `outputFileTracingIncludes: '${pattern}' is outside the app root (${root}) — a binary can only carry the app's own files`,
      );
    }
  } else {
    rel = posix.replace(/^\.\//, '');
  }
  if (rel.split('/').includes('..')) {
    throw new Error(
      `outputFileTracingIncludes: '${pattern}' contains '..' — it is outside the app root (${root})`,
    );
  }
  return rel;
}

function expandPattern(root, pattern, rel) {
  const abs = resolve(root, rel);
  const names = rel.split('/');
  // A literal path that exists wins over glob reading (Next names files `[id]/page.js`).
  if (existsSync(abs)) {
    if (statSync(abs).isDirectory()) {
      const files = [];
      walkFiles(abs, files, !names.includes('node_modules'));
      return files;
    }
    return [abs];
  }
  if (!GLOB_META.test(rel)) return [];
  const out = [];
  for (const hit of new Bun.Glob(rel).scanSync({
    cwd: root,
    dot: true,
    onlyFiles: true,
    followSymlinks: true,
  })) {
    const posix = toPosix(hit);
    // `./**/*.json` must not sweep node_modules; naming it in the pattern opts in.
    if (!names.includes('node_modules') && posix.split('/').includes('node_modules')) continue;
    out.push(resolve(root, posix));
  }
  return out;
}

/**
 * The files to embed: every declared include plus every literal-path
 * candidate that is embeddable. Throws for a declared include that cannot be
 * embedded (see the module doc).
 *
 * @param {{
 *   root: string,
 *   includes: string[],
 *   candidates?: string[],
 *   sidecarPackages?: Iterable<string>,
 * }} input
 * @returns {{
 *   files: { rel: string, abs: string, size: number, declared: boolean }[],
 *   totalBytes: number,
 *   skipped: { rel: string, reason: string }[],
 *   warnings: string[],
 * }}
 */
export function planAppData({ root, includes, candidates = [], sidecarPackages = [] }) {
  const base = resolve(root);
  const realRoot = realpathSync(base);
  const sidecar = new Set(sidecarPackages);
  const byRel = new Map();
  const skipped = [];

  const relOf = (abs) => toPosix(relative(base, abs));
  const packageOf = (rel, prefix) => {
    const parts = rel.slice(prefix.length).split('/');
    return parts[0]?.startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0];
  };

  const escaped = [];
  const secrets = [];
  const addons = [];
  const inSidecar = new Map();
  const unmatched = [];
  const literals = new Set(includes.map((p) => p.split('\\').join('/').replace(/^\.\//, '')));

  for (const pattern of includes) {
    const rel = normalisePattern(base, pattern);
    const matches = expandPattern(base, pattern, rel);
    for (const abs of matches) {
      const fileRel = relOf(abs);
      // Already carried: the public dir has its own embed, the rest of .output is code.
      if (fileRel.startsWith('.output/')) {
        const pkg = fileRel.startsWith('.output/server/node_modules/')
          ? packageOf(fileRel, '.output/server/node_modules/')
          : undefined;
        if (pkg !== undefined) {
          if (!inSidecar.has(pkg)) inSidecar.set(pkg, []);
          inSidecar.get(pkg).push(fileRel);
        }
        continue;
      }
      let real;
      try {
        real = realpathSync(abs);
      } catch {
        continue;
      }
      const inside = relative(realRoot, real);
      if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) {
        escaped.push(fileRel);
        continue;
      }
      if (!statSync(real).isFile()) continue;
      if (SECRET_NAME.test(basename(fileRel)) && !literals.has(fileRel)) {
        secrets.push(fileRel);
        continue;
      }
      if (NATIVE_ADDON.test(fileRel)) {
        addons.push(fileRel);
        continue;
      }
      if (fileRel.startsWith('node_modules/')) {
        const pkg = packageOf(fileRel, 'node_modules/');
        if (sidecar.has(pkg)) {
          if (!inSidecar.has(pkg)) inSidecar.set(pkg, []);
          inSidecar.get(pkg).push(fileRel);
          continue;
        }
      }
      byRel.set(fileRel, { rel: fileRel, abs, size: statSync(real).size, declared: true });
    }
    if (matches.length === 0) unmatched.push(pattern);
  }

  if (unmatched.length > 0) {
    throw new Error(
      `outputFileTracingIncludes: no file matches ${unmatched.map((p) => `'${p}'`).join(', ')} under ${base}`,
    );
  }
  if (escaped.length > 0) {
    throw new Error(
      `outputFileTracingIncludes: these matches resolve (through a symlink) outside the app root ${realRoot}: ${escaped.sort().join(', ')}`,
    );
  }
  if (secrets.length > 0) {
    throw new Error(
      `outputFileTracingIncludes: refusing to embed files that look like secrets: ${secrets.sort().join(', ')} — ` +
        'list a file by its exact path if it really belongs in the executable',
    );
  }
  if (addons.length > 0) {
    throw new Error(
      `outputFileTracingIncludes: native addons cannot be embedded as data: ${addons.sort().join(', ')} — a native ` +
        'addon loads from a real filesystem path, which the executable cannot provide',
    );
  }
  if (inSidecar.size > 0) {
    const names = [...inSidecar.keys()].sort();
    throw new Error(
      `outputFileTracingIncludes: ${names.join(', ')} ${names.length === 1 ? 'was' : 'were'} traced into ` +
        '.output/server/node_modules, and a self-contained executable has no such directory beside it and cannot ' +
        `resolve a package from inside itself (matched: ${[...inSidecar.values()].flat().sort().slice(0, 3).join(', ')}` +
        `${[...inSidecar.values()].flat().length > 3 ? ', …' : ''}). Bundle the package instead of listing it in ` +
        'serverExternalPackages, read its files by a path inside the app, or build without --self-contained',
    );
  }

  for (const abs of candidates) {
    const rel = relOf(abs);
    const skip = (reason) => skipped.push({ rel, reason });
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) continue;
    if (byRel.has(rel)) continue;
    const parts = rel.split('/');
    if (parts[0] === '.output' || parts[0] === '.git' || parts.includes('node_modules')) {
      skip('inside .output, .git or node_modules');
      continue;
    }
    let real;
    try {
      real = realpathSync(abs);
    } catch {
      continue; // may be written at runtime
    }
    const inside = relative(realRoot, real);
    if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) {
      skip('resolves outside the app root');
      continue;
    }
    if (!statSync(real).isFile()) continue;
    if (SECRET_NAME.test(basename(rel))) {
      skip('looks like a secret: declare it in outputFileTracingIncludes to embed it');
      continue;
    }
    if (NATIVE_ADDON.test(rel)) {
      skip('a native addon cannot be embedded');
      continue;
    }
    byRel.set(rel, { rel, abs, size: statSync(real).size, declared: false });
  }

  const files = [...byRel.values()].sort((a, b) => (a.rel < b.rel ? -1 : 1));
  const totalBytes = files.reduce((n, f) => n + f.size, 0);
  const warnings = [];
  if (totalBytes > WARN_BYTES) {
    warnings.push(
      `the app data files total ${(totalBytes / 1024 / 1024).toFixed(1)} MiB, which is added to the executable ` +
        'and held in the image; trim outputFileTracingIncludes if that is more than the app reads',
    );
  }
  return { files, totalBytes, skipped, warnings };
}

/**
 * Which planned files the compiled executable does NOT carry at
 * `/$bunfs/root/<rel>`. A bundler that dropped one would otherwise ship a
 * binary that answers 500 for it.
 *
 * @param {Uint8Array} binary
 * @param {{ rel: string }[]} files
 */
export function dataPathsMissing(binary, files) {
  const buf = Buffer.from(binary.buffer, binary.byteOffset, binary.byteLength);
  // Bun names a root-level file `/$bunfs/root/./x.json`, a nested one `/$bunfs/root/a/x.json`.
  return files
    .filter(
      (f) =>
        buf.indexOf(`/$bunfs/root/${f.rel}`) === -1 && buf.indexOf(`/$bunfs/root/./${f.rel}`) === -1,
    )
    .map((f) => f.rel);
}

const FS_IMPORT = /(\bfrom\s*|\bimport\s*\(\s*)(["'])(?:node:)?fs(\/promises)?\2/g;

/**
 * Point a server-output module's `node:fs` / `node:fs/promises` imports at the
 * facade modules `<prefix>fs-facade` / `<prefix>fs-promises-facade`, which re-export the
 * aliased read functions by name (a named import of a builtin is a snapshot a
 * patch of the module object cannot reach — see app-data-alias.mjs). Static
 * `from "…"` and dynamic `import("…")` forms; `require("fs")` is untouched
 * because it receives the patched module object.
 *
 * @returns {{ contents: string, count: number }}
 */
export function rewriteFsImports(source, prefix) {
  let count = 0;
  const contents = source.replace(FS_IMPORT, (_all, head, quote, promises) => {
    count++;
    // Not `…:fs`: a virtual module named like the builtin resolves to itself.
    return `${head}${quote}${prefix}${promises ? 'fs-promises-facade' : 'fs-facade'}${quote}`;
  });
  return { contents, count };
}

/** Read each server-output module once and gather the literal-path candidates. */
export function discoverDataLiterals({ serverDir, cwdRoot, entryDir }) {
  const found = new Set();
  for (const file of serverOutputFiles(serverDir)) {
    const source = readFileSync(file, 'utf8');
    if (!source.includes('process.cwd()') && !source.includes('import.meta.url')) continue;
    for (const abs of scanDataLiterals(source, cwdRoot, entryDir)) found.add(abs);
  }
  return [...found].sort();
}
