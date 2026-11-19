#!/usr/bin/env node
/**
 * Fail-closed integrity gate for the scratch `yaml` install in the z7-pin-skew nightly job.
 *
 * The job installs `yaml` into RUNNER_TEMP with `npm install --no-save`. npm records the
 * integrity of what the registry actually served in `node_modules/.package-lock.json`; this
 * script compares that value (and the version) with the `yaml` entry of the repo's `bun.lock`.
 * Any mismatch, missing entry, unparseable file or missing install exits nonzero.
 *
 * Usage: node scripts/verify-installed-yaml-integrity.mjs <installDir> <bun.lock> <version>
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Extract `{version, integrity}` for the top-level `"yaml"` entry of a bun.lock text. */
export function lockedYaml(lockText) {
  const m = lockText.match(/^\s*"yaml": \["yaml@([^"]+)", "", \{[^\n]*?\}, "(sha512-[^"]+)"\]/m);
  if (!m) throw new Error('no top-level yaml entry with a sha512 integrity in the lockfile');
  return { version: m[1], integrity: m[2] };
}

/** Throws unless the npm-installed yaml matches the lockfile entry and the expected version. */
export function verifyYamlIntegrity({ lockText, installedLockText, expectedVersion }) {
  const locked = lockedYaml(lockText);
  if (locked.version !== expectedVersion) {
    throw new Error(`lockfile pins yaml@${locked.version}, workflow installs ${expectedVersion}`);
  }
  const entry = JSON.parse(installedLockText).packages?.['node_modules/yaml'];
  if (entry?.version !== expectedVersion) {
    throw new Error(`installed yaml is ${entry?.version}, expected ${expectedVersion}`);
  }
  if (entry?.integrity !== locked.integrity) {
    throw new Error(
      `yaml@${expectedVersion} integrity mismatch: installed ${entry?.integrity} != lockfile ${locked.integrity}`,
    );
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [dir, lock, version] = process.argv.slice(2);
  try {
    if (!dir || !lock || !version) throw new Error('usage: <installDir> <bun.lock> <version>');
    verifyYamlIntegrity({
      lockText: readFileSync(lock, 'utf8'),
      installedLockText: readFileSync(resolve(dir, 'node_modules/.package-lock.json'), 'utf8'),
      expectedVersion: version,
    });
    console.log(`yaml@${version} integrity matches the repo lockfile`);
  } catch (e) {
    console.error(`z7-pin-skew: yaml integrity check FAILED: ${e.message}`);
    process.exit(1);
  }
}
