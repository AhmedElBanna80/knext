#!/usr/bin/env node
/**
 * `node scripts/prepush-lib-drift.mjs --other <ref>` — fail when this checkout's copy of the
 * pre-push check has drifted from the copy on another long-lived branch.
 *
 * `integration/v2` and `main` carry the same code and differ only in which gates and
 * `security/` files they register. That block sits between `// BEGIN branch-specific` and
 * `// END branch-specific` in `scripts/lib/prepush-check.mjs`; this diffs everything outside it,
 * and the whole of `scripts/prepush-check.mjs`. Run from ONE branch (integration/v2) by
 * `.github/workflows/prepush-lib-drift-nightly.yml`.
 *
 * Exit 0 identical; 1 drift (first differing line printed) or the other ref has no copy yet.
 * A missing or doubled marker is a failure, never "identical".
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { driftBetween } from './lib/prepush-check.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FILES = ['scripts/lib/prepush-check.mjs', 'scripts/prepush-check.mjs'];

function show(ref, file) {
  const r = spawnSync('git', ['show', `${ref}:${file}`], {
    cwd: ROOT,
    encoding: 'utf8',
    maxBuffer: 1 << 26,
  });
  return r.status === 0 ? r.stdout : null;
}

/** The CLI file has no branch block, so it is compared whole. */
const whole = (a, b) => {
  const x = a.split('\n');
  const y = b.split('\n');
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if (x[i] !== y[i]) return { same: false, line: i + 1, a: x[i], b: y[i] };
  }
  return { same: true };
};

export function main(argv) {
  const i = argv.indexOf('--other');
  if (i < 0 || !argv[i + 1]) {
    console.error('usage: prepush-lib-drift.mjs --other <ref>');
    return 2;
  }
  const other = argv[i + 1];
  let bad = 0;
  for (const f of FILES) {
    const theirs = show(other, f);
    if (theirs === null) {
      console.log(`FAIL ${f}: not present on ${other} (the port has not landed)`);
      bad++;
      continue;
    }
    const mine = readFileSync(resolve(ROOT, f), 'utf8');
    let d;
    try {
      d = f.endsWith('/lib/prepush-check.mjs') ? driftBetween(mine, theirs) : whole(mine, theirs);
    } catch (e) {
      console.log(`FAIL ${f}: ${e.message}`);
      bad++;
      continue;
    }
    if (d.same) console.log(`ok   ${f}: identical to ${other} outside the branch-specific block`);
    else {
      console.log(
        `FAIL ${f}: drift from ${other} at line ${d.line}\n  here:  ${d.a}\n  there: ${d.b}`,
      );
      bad++;
    }
  }
  return bad === 0 ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
