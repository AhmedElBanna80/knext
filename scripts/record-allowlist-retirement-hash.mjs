#!/usr/bin/env node
/**
 * Re-record the content hash that keeps main's and integration/v2's copies of the
 * allowlist retirement probe identical. Run after ANY edit to the probe, then commit
 * the result on BOTH branches (the same two files, the same hash).
 *
 * Usage:  node scripts/record-allowlist-retirement-hash.mjs
 */
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const PROBE_FILES = [
  'scripts/lib/allowlist-retirement.mjs',
  'scripts/verify-allowlist-retirement.mjs',
];
export const HASH_FILE = 'scripts/lib/allowlist-retirement.sha256';

export function probeHash(root) {
  const h = createHash('sha256');
  for (const f of PROBE_FILES) {
    h.update(`${f}\n`);
    h.update(readFileSync(resolve(root, f)));
    h.update('\n');
  }
  return h.digest('hex');
}

if (process.argv[1] && resolve(process.argv[1]) === import.meta.filename) {
  const root = resolve(import.meta.dirname, '..');
  writeFileSync(resolve(root, HASH_FILE), `${probeHash(root)}\n`);
  console.log(`recorded ${HASH_FILE}`);
}
