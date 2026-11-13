/**
 * vendored-builtins.mjs — find the React builds that other packages VENDOR,
 * so the pre-compile closure SBOM names them (#61).
 *
 * syft catalogues a package by its package.json. Two packages in our closure
 * ship React Server Components under a package.json syft cannot use:
 *
 *   - `next` vendors React under `dist/compiled/<name>/`. Those package.json
 *     files are renamed (`react-server-dom-webpack-builtin`) and carry NO
 *     version, so the SBOM records them as UNKNOWN and grype cannot match an
 *     advisory. The version lives only as a string literal in the cjs builds.
 *   - `@vitejs/plugin-rsc` vendors `react-server-dom-webpack` under
 *     `dist/vendor/react-server-dom/`. That package.json is complete, but the
 *     copy is not a closure member, so projecting the SBOM onto the app's
 *     closure drops it.
 *
 * Both copies are the code that actually serves RSC requests, so a scan that
 * cannot see them reads clean while shipping an affected build. This module
 * reports each copy as a CycloneDX npm component under its UPSTREAM name, so
 * grype matches the upstream package's advisories.
 *
 * A copy whose version cannot be read is returned in `unresolved`, never
 * skipped: the caller fails on it. A detector that goes quiet when the vendored
 * layout changes would report "nothing vendored" and "could not look" the same.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The vendored React directories `next` ships under `dist/compiled/`. */
export const NEXT_VENDORED_REACT = [
  'react',
  'react-dom',
  'react-server-dom-webpack',
  'react-server-dom-turbopack',
];

/**
 * A React release string as React embeds it in its builds:
 * `19.3.0`, `19.3.0-canary-cbb046ab-20260731`, `19.3.0-experimental-…`.
 */
const REACT_VERSION_LITERAL =
  /["'](\d+\.\d+\.\d+(?:-(?:canary|experimental|rc|beta|next)-[0-9a-f]{6,}-\d{8})?)["']/g;

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * The single React version a vendored directory embeds, or null.
 *
 * A declared package.json version wins. Otherwise the cjs builds are read; more
 * than one distinct version means the directory is not one build, so it is
 * reported as unresolved rather than guessed.
 */
export function vendoredVersion(dir) {
  const declared = readJson(join(dir, 'package.json'))?.version;
  if (typeof declared === 'string' && declared.length > 0) return declared;
  const cjs = join(dir, 'cjs');
  if (!existsSync(cjs)) return null;
  const found = new Set();
  for (const file of readdirSync(cjs)) {
    if (!file.endsWith('.js')) continue;
    const text = readFileSync(join(cjs, file), 'utf8');
    for (const match of text.matchAll(REACT_VERSION_LITERAL)) found.add(match[1]);
  }
  return found.size === 1 ? [...found][0] : null;
}

function component(name, version, host, path) {
  return {
    type: 'library',
    name,
    version,
    purl: `pkg:npm/${name}@${version}`,
    properties: [{ name: 'knext:vendored-in', value: `${host} ${path}` }],
  };
}

/**
 * Every vendored React copy inside the given package directories.
 *
 * `packageDirs` is an iterable of installed package roots (each with its own
 * package.json). Hosts other than `next` and `@vitejs/plugin-rsc` are ignored.
 */
export function vendoredBuiltins(packageDirs) {
  const components = [];
  const unresolved = [];
  const seen = new Set();
  for (const dir of packageDirs) {
    const pkg = readJson(join(dir, 'package.json'));
    if (pkg === null) continue;
    const host = `${pkg.name}@${pkg.version}`;
    const copies = [];
    if (pkg.name === 'next') {
      for (const name of NEXT_VENDORED_REACT) {
        for (const variant of [name, `${name}-experimental`]) {
          copies.push({ name, path: `dist/compiled/${variant}` });
        }
      }
    } else if (pkg.name === '@vitejs/plugin-rsc') {
      copies.push({ name: 'react-server-dom-webpack', path: 'dist/vendor/react-server-dom' });
    } else {
      continue;
    }
    for (const copy of copies) {
      const copyDir = join(dir, copy.path);
      if (!existsSync(copyDir)) continue;
      const version = vendoredVersion(copyDir);
      if (version === null) {
        unresolved.push(`${host} ${copy.path}`);
        continue;
      }
      const key = `${copy.name}@${version} ${host} ${copy.path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      components.push(component(copy.name, version, host, copy.path));
    }
  }
  return { components, unresolved };
}

const PRERELEASE_SUFFIX =
  /^(\d+\.\d+\.\d+)-(?:canary|experimental|rc|beta|next)-[0-9a-f]{6,}-\d{8}$/;

/**
 * The release a React prerelease build belongs to — `19.3.0` for
 * `19.3.0-canary-cbb046ab-20260731` — or null for a plain release.
 *
 * Needed because semver ranks a prerelease BELOW its release, so grype never
 * matches an advisory that names `19.3.0` against the canary Next vendors
 * (measured: GHSA-xqc2-xf4c-x3h3 matches 19.3.0 and 19.2.8, not the canary).
 */
export function releaseLine(version) {
  const match = PRERELEASE_SUFFIX.exec(version);
  return match === null ? null : match[1];
}

/**
 * The vendored prereleases re-stated at their release line, for a SECOND scan.
 *
 * The attested SBOM keeps the exact shipped version; this view exists only so
 * grype evaluates the release line's advisories against the build. It is
 * conservative by design: a canary cut after a fix landed is still read as the
 * unfixed release, and clearing that takes a dated, justified allowlist entry —
 * a false red, never a false green.
 */
export function advisoryView(components) {
  const view = [];
  for (const c of components) {
    const line = releaseLine(c.version);
    if (line === null) continue;
    view.push({
      ...c,
      version: line,
      purl: `pkg:npm/${c.name}@${line}`,
      properties: [...(c.properties ?? []), { name: 'knext:ships-build', value: c.version }],
    });
  }
  return view;
}
