#!/usr/bin/env node
/**
 * Lane-parity check for the CI guard files (#2170). The logic and its rules are
 * in `scripts/lib/lane-parity.mjs`; this reads the manifest and git.
 *
 * This checkout is the manifest's `self` lane (its HEAD). Every other lane is
 * read from `<remote>/<lane>` (remote: LANE_PARITY_REMOTE, default `origin`), so
 * fetch them first. A lane that cannot be read is a FAILURE, never a pass: a
 * parity check that goes green when it cannot see the other side checks nothing.
 *
 * Usage:
 *   git fetch --no-tags origin main integration/v1.3
 *   node scripts/lane-parity-check.mjs [--manifest .github/lane-parity.json]
 *
 * Exit: 0 parity holds, 1 findings, 2 a lane or the manifest could not be read.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { gitRun } from './lib/guard-prover.mjs';
import { checkLaneParity } from './lib/lane-parity.mjs';

const args = process.argv.slice(2);
const at = args.indexOf('--manifest');
const manifestPath = resolve(at >= 0 ? args[at + 1] : '.github/lane-parity.json');
const remote = process.env.LANE_PARITY_REMOTE || 'origin';
const cwd = process.cwd();

let manifest;
try {
  manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
} catch (err) {
  console.error(`lane-parity: cannot read ${manifestPath}: ${err.message}`);
  process.exit(2);
}

function refOf(lane) {
  return lane === manifest.self ? 'HEAD' : `${remote}/${lane}`;
}

// Every lane must resolve to a commit before anything is compared.
for (const lane of Array.isArray(manifest.lanes) ? manifest.lanes : []) {
  try {
    gitRun(cwd, ['rev-parse', '--verify', '--quiet', `${refOf(lane)}^{commit}`], { stdio: 'pipe' });
  } catch {
    console.error(
      `lane-parity: cannot read lane ${lane} (${refOf(lane)}). Fetch it first; this check never passes blind.`,
    );
    process.exit(2);
  }
}

function readBlob(lane, path) {
  // ls-tree names the blob without failing on a missing path (empty output).
  const line = gitRun(cwd, ['ls-tree', refOf(lane), '--', path]).trim();
  if (line === '') return null;
  const [, type, id] = line.split(/\s+/);
  return type === 'blob' ? id : null;
}

const findings = checkLaneParity({ manifest, readBlob });
if (findings.length === 0) {
  console.log(
    `lane-parity: ${manifest.files.length} guard file(s) match across ${manifest.lanes.join(', ')}, ` +
      `or differ as recorded (${manifest.divergences.length} recorded difference(s)).`,
  );
  process.exit(0);
}
for (const f of findings) {
  console.error(`::error::lane-parity [${f.kind}] ${f.message}`);
  if (f.lane) console.error(`    current blobs: here=${f.here} there=${f.there ?? 'null'}`);
}
console.error(`lane-parity: ${findings.length} finding(s).`);
process.exit(1);
