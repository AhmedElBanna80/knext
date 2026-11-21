/**
 * The `compile.include` planner: expand the user's globs into the exact set of
 * modules a compiled vinext executable embeds, and refuse what must not be
 * embedded (escapes through symlinks, secrets, native addons, non-modules).
 *
 * RUNTIME-NEUTRAL by contract: node builtins only (`node:fs`, `node:path`) -- no
 * `Bun` global, no `bun` import -- so the SAME code runs inside the compile
 * script (under Bun) and inside the CLI (under Node), and the CLI can derive the
 * planned module count independently of the script's claim. Globbing is
 * `fs.globSync` / `path.matchesGlob`, which Node >=24 and Bun both ship. The
 * parity test (`include-plan-runtime-parity.test.ts`) runs one fixture under
 * both runtimes and demands identical plans and identical refusals.
 */
import { existsSync, globSync, lstatSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { basename, isAbsolute, join, matchesGlob, relative, resolve, sep } from 'node:path';

const MODULE_EXT = /\.(?:[cm]?[jt]s|[jt]sx)$/;
const GLOB_META = /[*?[\]{}]/;

/** Files (not directories) under `cwd` matching `pattern`, as `fs.globSync` reports them. */
function scanFiles(pattern, cwd) {
  return globSync(pattern, { cwd }).filter((rel) => {
    try {
      // lstat: a symlinked FILE is never returned by a glob scan (as Bun's own glob
      // file scan never did); only a literal path can name one, and the
      // real-path guard in planIncludes then checks where it lands.
      return lstatSync(resolve(cwd, rel)).isFile();
    } catch {
      return false;
    }
  });
}

/**
 * `compile.include` on stock Bun: the embed plan for the user's globs, rooted at
 * the app root, so each matched module lands at `$bunfs/root/<path relative to
 * the app root>` (embedded unexecuted — loaded on its first import). Fails
 * instead of embedding something it should not, or less than was asked for —
 * each error names the offending pattern or path:
 *
 *   - an absolute pattern, or one with a `..` segment (refused up front);
 *   - a match whose REAL path (symlinks resolved, for glob and literal matches
 *     alike) is outside the app root's real path — planEmbed's own outside-root
 *     check is textual and covers literals only, so this is the guard for
 *     `compile.include`;
 *   - a match that looks like a secret (`.env*`, `*.pem`, `*.key`, `id_*`)
 *     unless the pattern names that exact file;
 *   - a native addon (`.node`, `.so`, `.dylib`, `.dll`) — named exactly or
 *     matched by a glob. An included addon compiles cleanly (patched Bun's
 *     native `--include` takes it without a word) and then fails at runtime
 *     with "Cannot find module", so it is refused here, in both modes;
 *   - a pattern that matches nothing, and a non-module match (stock Bun embeds
 *     extra entrypoints only for JS/TS modules).
 *
 * A directory pattern expands to every file below it EXCEPT under
 * `node_modules`, which is never descended into (planEmbed). The plan's file
 * list — not the user's globs — is what either toolchain embeds, so the set
 * checked here is exactly the set embedded.
 *
 * The guards live here, not in planEmbed, which the self-contained build modes
 * share for knext's own trees.
 *
 * @param {string} root the app root
 * @param {string[]} include the globs, relative to `root`
 */
export function planIncludes(root, include) {
  for (const pattern of include) {
    const posix = pattern.split('\\').join('/');
    if (isAbsolute(pattern) || posix.startsWith('/') || /^[A-Za-z]:/.test(posix)) {
      throw new Error(
        `compile.include: '${pattern}' is absolute — patterns are relative to the app root (${root})`,
      );
    }
    if (posix.split('/').includes('..')) {
      throw new Error(
        `compile.include: '${pattern}' contains '..' — patterns cannot reach outside the app root (${root})`,
      );
    }
  }
  const plan = planEmbed({ root, include });
  if (plan.report.unmatched.length > 0) {
    throw new Error(
      `compile.include: no file matches ${plan.report.unmatched.map((p) => `'${p}'`).join(', ')} under ${root}`,
    );
  }
  const backslashed = [...plan.relpaths, ...plan.report.nonModule].filter((rel) => rel.includes('\\'));
  if (backslashed.length > 0) {
    throw new Error(
      `compile.include: file names containing a backslash cannot be included: ${backslashed.join(', ')} — rename the file`,
    );
  }
  const realRoot = realpathSync(resolve(root));
  const matched = [
    ...plan.entrypoints,
    ...plan.report.nonModule.map((rel) => resolve(plan.root, rel)),
  ];
  const escaped = matched.filter((abs) => !insideRoot(realRoot, realpathSync(abs)));
  if (escaped.length > 0) {
    throw new Error(
      `compile.include: these matches resolve (through a symlink) outside the app root ${realRoot}: ` +
        escaped.map((abs) => toPosix(relative(plan.root, abs))).join(', '),
    );
  }
  const literals = new Set(include.map((p) => p.split('\\').join('/').replace(/^\.\//, '')));
  const secrets = matched
    .map((abs) => toPosix(relative(plan.root, abs)))
    .filter((rel) => SECRET_NAME.test(basename(rel)) && !literals.has(rel));
  if (secrets.length > 0) {
    throw new Error(
      `compile.include: refusing to embed files that look like secrets: ${secrets.join(', ')} — ` +
        'list a file by its exact path if it really belongs in the executable',
    );
  }
  const addons = plan.report.nonModule.filter((rel) => NATIVE_ADDON.test(rel));
  if (addons.length > 0) {
    throw new Error(
      `compile.include: native addons cannot be included: ${addons.join(', ')} — an included ` +
        'addon is embedded as a file the executable cannot dlopen(), so it fails at runtime with ' +
        '"Cannot find module". Load it with a static require (`require("./path/x.node")`), which ' +
        'Bun embeds and loads itself, and remove it from compile.include',
    );
  }
  if (plan.report.nonModule.length > 0) {
    throw new Error(
      'compile.include embeds JavaScript/TypeScript modules only (.js .mjs .cjs .ts .mts .cts .jsx .tsx); ' +
        `these matches are not: ${plan.report.nonModule.join(', ')}`,
    );
  }
  return plan;
}

/** Native addons: `compile.include` refuses them outright (see planIncludes). */
const NATIVE_ADDON = /\.(?:node|so|dylib|dll)$/i;

/** File names `compile.include` refuses to embed unless named exactly: `.env*`, `*.pem`, `*.key`, `id_*`. */
const SECRET_NAME = /^(?:\.env(?:\..*)?|id_.*|.*\.(?:pem|key))$/i;

/** Is `real` the root itself or strictly inside it (both already realpath'd)? */
function insideRoot(realRoot, real) {
  const rel = relative(realRoot, real);
  return rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
}

/** Where Bun embeds a JS/TS source compiled as an entrypoint: `[dir]/[name].js`. */
export function embeddedPath(rel) {
  return rel.replace(MODULE_EXT, '.js');
}

export const toPosix = (p) => p.split(sep).join('/');

export function walkFiles(dir, root, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules') continue;
    const path = join(dir, entry.name);
    if (entry.isDirectory()) walkFiles(path, root, out);
    else if (entry.isFile()) out.push(toPosix(relative(root, path)));
  }
}

/**
 * Expand `include` (literal files, directories — recursive — or globs, all
 * relative to `root`) minus `exclude` globs into the set to embed.
 * `node_modules` is never descended into: packages are the sidecar's business.
 *
 * @param {{ root: string, include: string[], exclude?: string[] }} input
 * @returns {{
 *   root: string,
 *   entrypoints: string[],
 *   relpaths: string[],
 *   report: { excluded: string[], nonModule: string[], unmatched: string[] },
 * }}
 */
export function planEmbed({ root, include, exclude = [] }) {
  const base = resolve(root);
  const found = new Set();
  const unmatched = [];
  for (const pattern of include) {
    const before = found.size;
    // A path that exists is a literal even when it holds glob metacharacters:
    // Next names files `[id]/page.js`, `[root-of-the-server]__x.js`,
    // `[turbopack]_runtime.js` — read as globs, they match nothing.
    if (GLOB_META.test(pattern) && !existsSync(resolve(base, pattern))) {
      for (const rel of scanFiles(pattern, base)) {
        const posix = toPosix(rel);
        if (!posix.split('/').includes('node_modules')) found.add(posix);
      }
    } else {
      const abs = resolve(base, pattern);
      const rel = relative(base, abs);
      if (rel.startsWith('..') || isAbsolute(rel)) {
        throw new Error(`compile-embed: '${pattern}' is outside the embed root ${base}`);
      }
      if (!existsSync(abs))
        throw new Error(`compile-embed: '${pattern}' does not exist under ${base}`);
      if (statSync(abs).isDirectory()) {
        if (!rel.split(sep).includes('node_modules')) {
          const files = [];
          walkFiles(abs, base, files);
          for (const f of files) found.add(f);
        }
      } else {
        found.add(toPosix(rel));
      }
    }
    if (found.size === before && ![...found].some((f) => f === toPosix(pattern)))
      unmatched.push(pattern);
  }

  const excluded = [];
  const nonModule = [];
  const byEmbedded = new Map();
  for (const rel of [...found].sort()) {
    if (exclude.some((g) => matchesGlob(rel, g))) {
      excluded.push(rel);
      continue;
    }
    if (!MODULE_EXT.test(rel)) {
      nonModule.push(rel);
      continue;
    }
    const target = embeddedPath(rel);
    const other = byEmbedded.get(target);
    if (other) {
      throw new Error(
        `compile-embed: '${other}' and '${rel}' would both embed at $bunfs/root/${target}`,
      );
    }
    byEmbedded.set(target, rel);
  }
  const relpaths = [...byEmbedded.keys()].sort();
  return {
    root: base,
    entrypoints: relpaths.map((r) => join(base, byEmbedded.get(r))),
    relpaths,
    report: { excluded, nonModule, unmatched },
  };
}

