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
import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
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
/**
 * File names that look like credentials. A SAFEGUARD AGAINST ACCIDENTS (a broad
 * glob, a link with an innocent name), not a guarantee: it matches names, so a
 * secret stored under an ordinary name is not recognised.
 */
const SECRET_BASENAME = [
  /^\.env/i, // .env .envrc .env-local .env_prod .env.local
  /^\.(?:npmrc|yarnrc(?:\.yml)?|netrc|pypirc|pgpass|htpasswd|git-credentials|gitconfig|dockercfg|my\.cnf|boto|s3cfg)$/i,
  /^(?:_netrc|htpasswd)$/i,
  /^id_/i,
  /\.(?:pem|key|p12|pfx|jks|keystore|p8|crt|cer|der|ppk|kdbx|gpg)$/i,
  /^service[-_]?account.*\.json$/i,
  /\.(?:tfvars|tfstate)(?:\..*)?$/i,
  /^kubeconfig/i,
];
/** A credential word anywhere in a name: `clientSecret.json`, `apitoken.txt`, `mysecrets.json`, `db-password.txt`. */
const SECRET_WORD = /secret|credential|passw(?:or)?d|token|api[-_]?key|private[-_]?key/i;
/** Ordinary words that contain one of the above; removed before the test (`tokenizer.json`, `secretary.txt`). */
const BENIGN_WORD = /tokeniz\w*|secretar\w*/gi;
/** Directories whose contents are credentials or configuration for them, compared case-insensitively. */
const SECRET_DIRS = new Set(['.ssh', '.aws', '.kube', '.gnupg', '.gcloud', '.azure', '.docker']);

const hasSecretWord = (name) => SECRET_WORD.test(name.replace(BENIGN_WORD, ''));

/**
 * Does this app-root-relative path (posix) look like a credential: its file name
 * by pattern or credential word, or any directory above it (case-insensitive)
 * that is a known credential directory or carries a credential word. Directories
 * below a `node_modules` are not judged (a package's own folder layout is not the
 * app's); its file name still is.
 */
function looksSecret(rel) {
  const parts = rel.split('/');
  const name = parts[parts.length - 1];
  const nm = parts.indexOf('node_modules');
  const dirs = nm === -1 ? parts.slice(0, -1) : parts.slice(0, Math.min(nm, parts.length - 1));
  return (
    dirs.some((d) => SECRET_DIRS.has(d.toLowerCase()) || /^\.env/i.test(d) || hasSecretWord(d)) ||
    SECRET_BASENAME.some((re) => re.test(name)) ||
    hasSecretWord(name)
  );
}
const hasGitSegment = (rel) => rel.split('/').includes('.git');
/** A native addon dlopens a real file; `$bunfs` cannot provide one. */
const NATIVE_ADDON = /\.(?:node|so|dylib|dll)$/i;
const WARN_BYTES = 64 * 1024 * 1024;

const toPosix = (p) => p.split(sep).join('/');

/** Every module specifier a config source imports, requires or re-exports (literal ones). */
const SPECIFIER = /\b(?:from|import|require)\s*\(?\s*["']([^"'\n]+)["']/g;
const BUILTIN_SPECIFIER = /^(?:node:|next(?:\/|$)|(?:fs|path|url|os|module)(?:\/|$))/;
/**
 * Anything that lets a config get its includes from somewhere else: a require or
 * dynamic import (literal or not), reading a file, parsing JSON, a promise, the
 * word "tracing" in any case (so a key assembled from pieces still counts).
 */
const INDIRECTION =
  /tracing|\brequire\b|\bimport\s*\(|createRequire|readFile|JSON\.parse|\bPromise\b|\beval\b|\bFunction\s*\(/i;

const specifiersOf = (text) => [...text.matchAll(SPECIFIER)].map((m) => m[1]);

/**
 * Could this config source declare `outputFileTracingIncludes`, directly or
 * through something it loads? Only a config that provably cannot is left unrun:
 * no indirection token, and every import is a Node built-in or a Next type.
 */
function canDeclareIncludes(text) {
  return (
    INDIRECTION.test(text) ||
    specifiersOf(text).some((spec) => spec.startsWith('.') || !BUILTIN_SPECIFIER.test(spec))
  );
}

/** Route-key match as Next's picomatch `contains` reads it: the key matches the route or any leading part of it. */
function routeMatches(key, route) {
  if (key === route) return true;
  const glob = new Bun.Glob(key);
  const segments = route.split('/').filter(Boolean);
  if (glob.match(route)) return true;
  for (let n = 1; n < segments.length; n++) {
    if (glob.match(`/${segments.slice(0, n).join('/')}`)) return true;
  }
  return false;
}

/**
 * One rule per include route key: the globs of every include key that matches
 * that route (a key matches itself), and the excludes of every exclude key that
 * matches it. Next applies excludes per route to the files traced for that
 * route; a binary serves every route from one filesystem, so a file is embedded
 * if SOME include rule selects it and that rule's excludes do not remove it. The
 * include keys stand in for routes (the compile has no route list). Identical
 * rules are merged.
 *
 * @param {Record<string, string[]>} includes
 * @param {Record<string, string[]>} excludes
 * @returns {{ includes: string[], excludes: string[] }[]}
 */
export function deriveTraceRules(includes, excludes) {
  const rules = new Map();
  for (const route of Object.keys(includes)) {
    const globs = new Set();
    for (const [key, list] of Object.entries(includes)) {
      if (routeMatches(key, route)) for (const g of list) globs.add(g);
    }
    const drops = new Set();
    for (const [key, list] of Object.entries(excludes)) {
      if (routeMatches(key, route)) for (const g of list) drops.add(g);
    }
    const rule = { includes: [...globs], excludes: [...drops] };
    rules.set(JSON.stringify([rule.includes.slice().sort(), rule.excludes.slice().sort()]), rule);
  }
  return [...rules.values()];
}

function readTraceMap(config, key, name) {
  const experimental = config.experimental;
  const map =
    experimental && typeof experimental === 'object' && key in experimental
      ? experimental[key]
      : config[key];
  if (map === undefined || map === null) return {};
  if (typeof map !== 'object' || Array.isArray(map)) {
    throw new Error(`${name}: ${key} must be an object of route → glob[]`);
  }
  const out = {};
  for (const [route, value] of Object.entries(map)) {
    if (!Array.isArray(value) || !value.every((g) => typeof g === 'string')) {
      throw new Error(`${name}: ${key}['${route}'] must be an array of glob strings`);
    }
    out[route] = value.map((g) => g.replace(/\\/g, '/'));
  }
  return out;
}

/**
 * The app's `outputFileTracingIncludes` / `outputFileTracingExcludes`, as rules
 * (see deriveTraceRules), read the way Next.js reads them: top level, replaced
 * by the legacy `experimental` key when that is present; the config may be a
 * function and its value (or a default export that is a promise) is awaited.
 *
 * No next.config → no rules. A config that provably cannot declare them (no
 * indirection, only built-in imports) is not run at all. Any other config is
 * loaded; if it cannot be loaded THIS THROWS, whatever the file says: it might
 * have declared includes, and embedding nothing would be the silent drop this
 * exists to prevent. A malformed value always throws.
 *
 * @param {string} root the app root
 * @returns {Promise<{ includes: string[], excludes: string[] }[]>}
 */
export async function readTraceRules(root) {
  const name = CONFIG_NAMES.find((n) => existsSync(join(root, n)));
  if (name === undefined) return [];
  const text = readFileSync(join(root, name), 'utf8');
  // A config that cannot declare includes is not run: this is a separate process
  // from the one that loaded it for the build, so loading it here would be a
  // second execution of the user's config code.
  if (!canDeclareIncludes(text)) return [];
  let config;
  try {
    const loaded = await import(pathToFileURL(join(root, name)).href);
    config = loaded.default ?? loaded;
    if (typeof config === 'function') {
      config = await config('phase-production-build', { defaultConfig: {} });
    }
    config = await config; // `export default Promise.resolve({...})`, as Next awaits it
  } catch (err) {
    throw new Error(
      `could not load ${name} to read outputFileTracingIncludes: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  config = config ?? {};
  return deriveTraceRules(
    readTraceMap(config, 'outputFileTracingIncludes', name),
    readTraceMap(config, 'outputFileTracingExcludes', name),
  );
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

/**
 * Every file under `dir` as absolute paths, following symlinked directories (a
 * directory already on the current path is not entered again, so a link loop
 * ends). A link whose target does not exist goes to `dangling`. Never descends
 * into `.git`. Special files (a FIFO) are returned: the planner refuses them.
 *
 * Directory patterns and glob patterns both list through this, so what a
 * declared directory embeds and what a glob over it embeds are the same files.
 */
function walkTree(dir, out, dangling, chain, skipNodeModules) {
  let realDir;
  try {
    realDir = realpathSync(dir);
  } catch {
    return;
  }
  if (chain.has(realDir)) return;
  const here = new Set(chain).add(realDir);
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git') continue;
    if (skipNodeModules && entry.name === 'node_modules') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkTree(path, out, dangling, here, skipNodeModules);
    } else if (entry.isSymbolicLink()) {
      let target;
      try {
        target = statSync(path);
      } catch {
        dangling.push(path);
        continue;
      }
      if (target.isDirectory()) walkTree(path, out, dangling, here, skipNodeModules);
      else out.push(path);
    } else {
      out.push(path);
    }
  }
}

function normalisePattern(root, pattern, what = 'outputFileTracingIncludes') {
  const posix = pattern.split('\\').join('/');
  let rel;
  if (isAbsolute(pattern) || /^[A-Za-z]:\//.test(posix)) {
    rel = toPosix(relative(root, resolve(pattern)));
    if (rel.startsWith('..') || isAbsolute(rel) || rel === '') {
      throw new Error(
        `${what}: '${pattern}' is outside the app root (${root}) — a binary can only carry the app's own files`,
      );
    }
  } else {
    rel = posix.replace(/^\.\//, '');
  }
  if (rel.split('/').includes('..')) {
    throw new Error(`${what}: '${pattern}' contains '..' — it is outside the app root (${root})`);
  }
  if (what === 'outputFileTracingIncludes' && hasGitSegment(rel)) {
    throw new Error(
      `${what}: .git is never embedded, but '${pattern}' names it — a repository's history and config are not app data`,
    );
  }
  return rel;
}

/**
 * The files `rel` selects, and the dangling links it reaches.
 *
 * A literal path that exists wins over glob reading (Next names files
 * `[id]/page.js`); a directory is walked. Otherwise the glob is matched against
 * the same walk of its literal prefix directory, so a symlinked directory is
 * entered by a glob exactly as by a directory pattern, and a dangling link that
 * matches is reported, not skipped.
 */
function expandPattern(root, rel) {
  const abs = resolve(root, rel);
  const names = rel.split('/');
  const skipNodeModules = !names.includes('node_modules');
  const files = [];
  const dangling = [];
  if (existsSync(abs)) {
    if (statSync(abs).isDirectory()) walkTree(abs, files, dangling, new Set(), skipNodeModules);
    else files.push(abs);
    return { files, dangling };
  }
  if (!GLOB_META.test(rel)) {
    try {
      lstatSync(abs);
      dangling.push(abs); // exists as a link, but its target does not
    } catch {}
    return { files, dangling };
  }
  const firstMeta = names.findIndex((seg) => GLOB_META.test(seg));
  const start = resolve(root, ...names.slice(0, firstMeta));
  if (!existsSync(start) || !statSync(start).isDirectory()) return { files, dangling };
  const glob = new Bun.Glob(rel);
  const walked = [];
  const walkedDangling = [];
  walkTree(start, walked, walkedDangling, new Set(), skipNodeModules);
  const matches = (p) => glob.match(toPosix(relative(root, p)));
  return { files: walked.filter(matches), dangling: walkedDangling.filter(matches) };
}

/** An exclude, compiled: matches a path or any directory above it, as Next's `contains` match does. */
function compileExcludes(root, excludes) {
  const globs = excludes.flatMap((pattern) => {
    try {
      return [new Bun.Glob(normalisePattern(root, pattern, 'outputFileTracingExcludes'))];
    } catch {
      return []; // outside the app root: it cannot match anything we embed
    }
  });
  return (rel) => {
    if (globs.length === 0) return false;
    const parts = rel.split('/');
    for (let n = 1; n <= parts.length; n++) {
      const prefix = parts.slice(0, n).join('/');
      if (globs.some((g) => g.match(prefix))) return true;
    }
    return false;
  };
}

// @upstream-shim bun-declared-include-assets
/**
 * The files to embed: every declared include plus every literal-path
 * candidate that is embeddable. Throws for a declared include that cannot be
 * embedded (see the module doc).
 *
 * Every match is judged by its REAL path (symlinks resolved): it must stay
 * inside the app root, must not sit under `.git`, and neither its own name nor
 * its target's may look like a credential. A link is embedded once, under its
 * target's path, and answers to its own name through `aliases`.
 *
 * The one opt-out for the credential-name check: a pattern that is an exact
 * file path (no glob, no directory) which is not a link. That is deliberate and
 * visible in the config, and it cannot be reached by a broad glob or a link.
 *
 * @param {{
 *   root: string,
 *   includes?: string[],
 *   rules?: { includes: string[], excludes: string[] }[],
 *   candidates?: string[],
 *   sidecarPackages?: Iterable<string>,
 * }} input
 * @returns {{
 *   files: { rel: string, abs: string, size: number, declared: boolean, aliases: string[] }[],
 *   totalBytes: number,
 *   skipped: { rel: string, reason: string }[],
 *   warnings: string[],
 * }}
 */
export function planAppData({ root, includes = [], rules = [], candidates = [], sidecarPackages = [] }) {
  const base = resolve(root);
  const realRoot = realpathSync(base);
  const sidecar = new Set(sidecarPackages);
  const byRel = new Map();
  const skipped = [];
  const allRules = [...rules, ...(includes.length > 0 ? [{ includes, excludes: [] }] : [])];

  const relOf = (abs) => toPosix(relative(base, abs));
  const packageOf = (rel, prefix) => {
    const parts = rel.slice(prefix.length).split('/');
    return parts[0]?.startsWith('@') ? `${parts[0]}/${parts[1]}` : parts[0];
  };
  /** Record `logical` (a path under the app root) as embedded from `real`, once per real file. */
  const record = (logical, realRel, real, declared) => {
    const have = byRel.get(realRel);
    if (have) {
      if (logical !== realRel && !have.aliases.includes(logical)) have.aliases.push(logical);
      have.declared = have.declared || declared;
      return;
    }
    byRel.set(realRel, {
      rel: realRel,
      abs: real,
      size: statSync(real).size,
      declared,
      aliases: logical === realRel ? [] : [logical],
    });
  };
  const via = (logical, realRel) => (logical === realRel ? logical : `${logical} -> ${realRel}`);

  const escaped = [];
  const gitHits = [];
  const secrets = [];
  const addons = [];
  const special = [];
  const danglingLinks = [];
  const inSidecar = new Map();
  const unmatched = [];
  const exactFiles = new Set();
  for (const rule of allRules) {
    for (const p of rule.includes) {
      exactFiles.add(
        isAbsolute(p) ? toPosix(relative(base, resolve(p))) : p.split('\\').join('/').replace(/^\.\//, ''),
      );
    }
  }

  for (const rule of allRules) {
    const isExcluded = compileExcludes(base, rule.excludes);
    for (const pattern of rule.includes) {
      const rel = normalisePattern(base, pattern);
      const { files: matches, dangling } = expandPattern(base, rel);
      for (const abs of dangling) {
        const linkRel = relOf(abs);
        if (!isExcluded(linkRel)) danglingLinks.push(linkRel);
      }
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
        // outputFileTracingExcludes: not traced, so not judged either.
        if (isExcluded(fileRel)) continue;
        // Dangling links never get here (the walk reports them); if the file vanished since,
        // the error propagates and the build fails rather than skipping it.
        const real = realpathSync(abs);
        const inside = relative(realRoot, real);
        if (inside === '' || inside.startsWith('..') || isAbsolute(inside)) {
          escaped.push(fileRel);
          continue;
        }
        const realRel = toPosix(inside);
        if (isExcluded(realRel)) continue;
        if (hasGitSegment(fileRel) || hasGitSegment(realRel)) {
          gitHits.push(via(fileRel, realRel));
          continue;
        }
        if (!statSync(real).isFile()) {
          special.push(via(fileRel, realRel));
          continue;
        }
        const optedOut = fileRel === realRel && exactFiles.has(fileRel);
        if ((looksSecret(fileRel) || looksSecret(realRel)) && !optedOut) {
          secrets.push(via(fileRel, realRel));
          continue;
        }
        if (NATIVE_ADDON.test(fileRel) || NATIVE_ADDON.test(realRel)) {
          addons.push(via(fileRel, realRel));
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
        record(fileRel, realRel, real, true);
      }
      if (matches.length === 0 && dangling.length === 0) unmatched.push(pattern);
    }
  }

  if (danglingLinks.length > 0) {
    throw new Error(
      `outputFileTracingIncludes: these matches are dangling symlinks (their target does not exist): ${[...new Set(danglingLinks)].sort().join(', ')}`,
    );
  }
  if (special.length > 0) {
    throw new Error(
      `outputFileTracingIncludes: these matches are not a regular file (a pipe, socket or device): ${special.sort().join(', ')}`,
    );
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
  if (gitHits.length > 0) {
    throw new Error(
      `outputFileTracingIncludes: .git is never embedded, but these matches are under it: ${gitHits.sort().join(', ')}`,
    );
  }
  if (secrets.length > 0) {
    throw new Error(
      `outputFileTracingIncludes: refusing to embed files that look like secrets: ${secrets.sort().join(', ')} — ` +
        'this check matches names and is a safeguard, not a guarantee. If a file really belongs in the ' +
        'executable, list it by its exact path (no glob, not through a link)',
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
    const skip = (reason, what = rel) => skipped.push({ rel: what, reason });
    if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) continue;
    const parts = rel.split('/');
    if (parts[0] === '.output' || hasGitSegment(rel) || parts.includes('node_modules')) {
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
    const realRel = toPosix(inside);
    if (!statSync(real).isFile()) continue;
    if (hasGitSegment(realRel)) {
      skip(`points into .git (${realRel}), which is never embedded`);
      continue;
    }
    if (looksSecret(rel) || looksSecret(realRel)) {
      skip(
        'looks like a secret: declare it in outputFileTracingIncludes by its exact path to embed it',
      );
      continue;
    }
    if (NATIVE_ADDON.test(rel) || NATIVE_ADDON.test(realRel)) {
      skip('a native addon cannot be embedded');
      continue;
    }
    record(rel, realRel, real, false);
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
 * Which planned files the compiled executable does NOT carry as an embedded
 * file. A bundler that dropped one would otherwise ship a binary that answers
 * 500 for it.
 *
 * The check is for the EXACT embedded name, `\0/$bunfs/root/<rel>\0`: the name
 * as the executable's own file table stores it, delimited by NULs. A substring
 * scan is not enough — the same path also appears as a quoted string in the
 * bundled JavaScript (the constant the file import yields), and as the prefix of
 * a longer name — and either would pass a binary whose file was dropped. Bun
 * names a root-level file `/$bunfs/root/./x.json` and gives an extensionless
 * file a trailing dot (`LICENSE.`).
 *
 * @param {Uint8Array} binary
 * @param {{ rel: string }[]} files
 */
export function dataPathsMissing(binary, files) {
  const buf = Buffer.from(binary.buffer, binary.byteOffset, binary.byteLength);
  const hasName = (name) => {
    const needle = Buffer.from(name);
    for (let at = buf.indexOf(needle); at !== -1; at = buf.indexOf(needle, at + 1)) {
      if (at > 0 && buf[at - 1] === 0 && buf[at + needle.length] === 0) return true;
    }
    return false;
  };
  return files
    .filter((f) => {
      const rels = [f.rel, `${f.rel}.`];
      return !rels.some((r) => hasName(`/$bunfs/root/${r}`) || hasName(`/$bunfs/root/./${r}`));
    })
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
