#!/usr/bin/env node
// Mutation prover for scripts/verify-publish-environments.mjs (#2035).
// Each mutation asserts its anchor occurs EXACTLY once (aborts otherwise),
// judges by test exit code only, and always restores the file byte-for-byte.
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';

const FILE = 'scripts/verify-publish-environments.mjs';
const TEST = 'tests/publish-environments-verify.test.ts';
const MUTATIONS = [
  ['reviewer rule no longer required', "name === 'npm-publish-latest' &&", 'false &&'],
  [
    'custom-policy check dropped',
    'custom_branch_policies !== true',
    'custom_branch_policies === 7',
  ],
  [
    'glob not flagged',
    'if (/[*?[\\]]/.test(p.name)) problems.push(`${name}: glob',
    'if (false) problems.push(`${name}: glob',
  ],
  ['missing lane not flagged', 'if (!names.includes(want))', 'if (false)'],
  ['extra branch not flagged', 'if (!EXPECTED.includes(got) &&', 'if (false &&'],
  ['non-branch type not flagged', "p.type && p.type !== 'branch'", 'false'],
  ['absent env not flagged', 'if (!e) {', 'if (false) {'],
];

const original = readFileSync(FILE, 'utf8');
const run = () => spawnSync('bun', ['test', TEST], { encoding: 'utf8' }).status;
let bad = 0;
try {
  if (run() !== 0) throw new Error('baseline not green');
  for (const [label, from, to] of MUTATIONS) {
    const n = original.split(from).length - 1;
    if (n !== 1) throw new Error(`anchor for "${label}" occurs ${n}x, need exactly 1`);
    writeFileSync(
      FILE,
      original.replace(from, () => to),
    );
    const code = run();
    writeFileSync(FILE, original);
    const ok = code !== 0;
    if (!ok) bad++;
    console.log(`${ok ? 'ok ' : 'BAD'} exit=${code} — ${label}`);
  }
} finally {
  writeFileSync(FILE, original);
}
console.log(`${MUTATIONS.length - bad} of ${MUTATIONS.length} graded as expected`);
process.exitCode = bad ? 1 : 0;
