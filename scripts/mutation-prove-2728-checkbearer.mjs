#!/usr/bin/env node
/**
 * Mutation proof for the checkBearer timingSafeEqual guards (#2728).
 *
 * For each mutation: assert the anchor occurs EXACTLY ONCE (abort otherwise),
 * apply it, run the named test file, require a NON-ZERO exit code, then restore
 * the file byte-for-byte from the pre-mutation content (never from git, so a
 * legitimately modified tree is not clobbered). Exit codes only, never output
 * grep. Exits 0 only when every mutation reddened its guard.
 *
 *   node scripts/mutation-prove-2728-checkbearer.mjs
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const COMPARE = '!timingSafeEqual(provided, expected)';

const MUTATIONS = [
  {
    name: 'always-true compare (auth bypass) is caught by the behavioural tests',
    file: 'examples/bun-exec/runtime-contract.mjs',
    anchor: COMPARE,
    replacement: 'false',
    cwd: 'examples/bun-exec',
    test: 'test/runtime-contract.test.ts',
    // The srvx e2e block fails without installed deps regardless of mutation;
    // narrow to the checkBearer block so only its verdict is read.
    filter: 'checkBearer',
  },
  {
    name: 'a hand-rolled helper reintroduced in a template is caught by the scan guard',
    file: 'packages/kn-next/templates/app/runtime-contract.mjs.hbs',
    anchor: COMPARE,
    replacement: '!constantTimeEqual(provided, expected)',
    cwd: '.',
    test: 'tests/runtime-contract-bearer-timingsafe.test.ts',
  },
  {
    name: 'dropping the length check in an app copy is caught by the scan guard',
    file: 'apps/docs/runtime-contract.mjs',
    anchor: 'provided.length !== expected.length || ',
    replacement: '',
    cwd: '.',
    test: 'tests/runtime-contract-bearer-timingsafe.test.ts',
  },
  {
    name: 'dropping the import in an app copy is caught by the scan guard',
    file: 'apps/file-manager/runtime-contract.mjs',
    anchor: "import { timingSafeEqual } from 'node:crypto';\n",
    replacement: '',
    cwd: '.',
    test: 'tests/runtime-contract-bearer-timingsafe.test.ts',
  },
];

let failures = 0;
for (const m of MUTATIONS) {
  const path = resolve(ROOT, m.file);
  const original = readFileSync(path, 'utf8');
  const hits = original.split(m.anchor).length - 1;
  if (hits !== 1) {
    console.error(`ABORT ${m.file}: anchor occurs ${hits}x, need exactly 1`);
    process.exit(2);
  }
  writeFileSync(
    path,
    original.replace(m.anchor, () => m.replacement),
  );
  let status;
  try {
    const args = ['test', m.test];
    if (m.filter) args.push('-t', m.filter);
    status = spawnSync('bun', args, {
      cwd: resolve(ROOT, m.cwd),
      stdio: 'ignore',
    }).status;
  } finally {
    writeFileSync(path, original);
  }
  const red = status !== 0;
  console.log(`${red ? 'RED (guard live)' : 'GREEN (DECORATIVE)'}  ${m.name}`);
  if (!red) failures++;
}
process.exit(failures === 0 ? 0 : 1);
