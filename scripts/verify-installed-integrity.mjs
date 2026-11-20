#!/usr/bin/env node
/**
 * Fail-closed integrity gate for a scratch `npm install` of lockfile-pinned packages.
 *
 * A job that installs packages with npm (no bun) into a temp prefix trusts the registry for the
 * bytes. npm records the integrity of what it actually installed in
 * `<prefix>/node_modules/.package-lock.json` (written even with `--no-package-lock`); this script
 * compares each named package's installed version and integrity with its top-level entry in the
 * repo's `bun.lock`. A missing hidden lockfile, an unparseable file, a package with no lockfile
 * entry, a missing install entry, a version or an integrity mismatch all exit nonzero.
 *
 * Generalises `scripts/verify-installed-yaml-integrity.mjs` on main (yaml only, version passed in):
 * here the expected version IS the lockfile's, so the workflow cannot drift from it silently.
 *
 * Usage: node scripts/verify-installed-integrity.mjs --prefix <dir> [--lock <bun.lock>] <pkg>...
 */
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/** `{version, integrity}` of the top-level `"<pkg>"` entry of a bun.lock text; throws if absent. */
export function lockedPackage(lockText, pkg) {
  const n = escapeRe(pkg);
  const m = lockText.match(
    new RegExp(`^\\s*"${n}": \\["${n}@([^"]+)", "", \\{[^\\n]*?\\}, "(sha512-[^"]+)"\\]`, 'm'),
  );
  if (!m) throw new Error(`no top-level ${pkg} entry with a sha512 integrity in the lockfile`);
  return { version: m[1], integrity: m[2] };
}

/** Throws unless every package's installed version and integrity match the lockfile entry. */
export function verifyInstalledIntegrity({ lockText, installedLockText, packages }) {
  if (!Array.isArray(packages) || packages.length === 0) throw new Error('no packages to verify');
  const installed = JSON.parse(installedLockText).packages;
  for (const pkg of packages) {
    const locked = lockedPackage(lockText, pkg);
    const entry = installed?.[`node_modules/${pkg}`];
    if (!entry) throw new Error(`${pkg} is not in the installed lockfile`);
    if (entry.version !== locked.version) {
      throw new Error(`installed ${pkg} is ${entry.version}, lockfile pins ${locked.version}`);
    }
    if (entry.integrity !== locked.integrity) {
      throw new Error(
        `${pkg}@${locked.version} integrity mismatch: installed ${entry.integrity} != lockfile ${locked.integrity}`,
      );
    }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const take = (flag) => {
    const i = args.indexOf(flag);
    if (i === -1) return undefined;
    const [, v] = args.splice(i, 2);
    return v;
  };
  try {
    const prefix = take('--prefix');
    const lock =
      take('--lock') ?? resolve(dirname(fileURLToPath(import.meta.url)), '..', 'bun.lock');
    if (!prefix || args.length === 0 || args.some((a) => a.startsWith('--'))) {
      throw new Error('usage: --prefix <dir> [--lock <bun.lock>] <pkg>...');
    }
    verifyInstalledIntegrity({
      lockText: readFileSync(lock, 'utf8'),
      installedLockText: readFileSync(resolve(prefix, 'node_modules/.package-lock.json'), 'utf8'),
      packages: args,
    });
    console.log(`${args.join(', ')}: installed integrity matches the repo lockfile`);
  } catch (e) {
    console.error(`installed-integrity check FAILED: ${e.message}`);
    process.exit(1);
  }
}
