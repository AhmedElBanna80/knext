#!/usr/bin/env node
// Byte-compares the retirement probe files of a checked-out branch (TARGET_ROOT,
// treated as DATA ONLY: read, never imported or executed) against this tree's
// copies. Any divergence, missing file or symlink exits 1 and names the file.
import { lstatSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { PROBE_FILES } from './record-allowlist-retirement-hash.mjs';

export function compareProbeFiles(mainRoot, targetRoot, files = PROBE_FILES) {
  const problems = [];
  for (const f of files) {
    const t = resolve(targetRoot, f);
    let st;
    try {
      st = lstatSync(t);
    } catch {
      problems.push(`${f}: missing on the target branch`);
      continue;
    }
    if (!st.isFile()) {
      problems.push(`${f}: not a regular file on the target branch`);
      continue;
    }
    if (!readFileSync(resolve(mainRoot, f)).equals(readFileSync(t))) {
      problems.push(`${f}: differs from main's copy`);
    }
  }
  return problems;
}

if (import.meta.main) {
  const target = process.env.PROBE_SYNC_TARGET;
  if (!target) {
    console.error('PROBE_SYNC_TARGET is required');
    process.exit(1);
  }
  const problems = compareProbeFiles(process.cwd(), target);
  for (const p of problems) console.error(`DIVERGED: ${p}`);
  if (problems.length) {
    console.error(
      "The retirement probe must be one program on both branches: copy main's files and re-record the hash.",
    );
    process.exit(1);
  }
  console.log(`probe files identical to main (${PROBE_FILES.join(', ')})`);
}
