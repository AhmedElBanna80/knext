#!/usr/bin/env node
/**
 * `node scripts/prepush-lib-drift.mjs --other <ref>` — fail when this checkout's copy of the
 * pre-push check has drifted from the copy on the other long-lived branch.
 *
 * `integration/v2` and `main` carry the same code and differ only in which gates and
 * `security/` files they register. That block sits between `// BEGIN branch-specific` and
 * `// END branch-specific` in `scripts/lib/prepush-check.mjs`. The script is symmetric: run it on
 * either branch with `--other` set to the other one. It fails on:
 *
 *  1. any difference in `scripts/lib/prepush-check.mjs` outside the branch-specific block;
 *  2. any difference at all in the CLI, this script, the test file, the prover and the two
 *     workflows (`WHOLE_FILES`);
 *  3. a branch-specific block (either copy) that is not plain data (`branchBlockProblems`);
 *  4. an input that exists on BOTH branches and is `exempt` on only one (the set of exempt
 *     input names must agree wherever the file is present on both);
 *  5. the other ref having no copy of a compared file yet, or a missing or doubled marker.
 *
 * `.github/workflows/prepush-lib-drift.yml` runs it on every pull request and push to either
 * branch, so drift introduced from EITHER side reds on that side's own PR.
 *
 * Exit 0 identical; 1 drift (first differing line printed); 2 usage.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  branchBlockProblems,
  driftBetween,
  evalBranchBlock,
  exemptInputs,
} from './lib/prepush-check.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const LIB = 'scripts/lib/prepush-check.mjs';
/** Compared byte for byte; only the lib has a branch-specific block. */
export const WHOLE_FILES = [
  'scripts/prepush-check.mjs',
  'scripts/prepush-lib-drift.mjs',
  'scripts/mutation-prove-prepush-check.mjs',
  'tests/prepush-check.test.ts',
  '.github/workflows/prepush-check.yml',
  '.github/workflows/prepush-lib-drift.yml',
];

function git(root, args) {
  return spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 1 << 26 });
}
const show = (root, ref, file) => {
  const r = git(root, ['show', `${ref}:${file}`]);
  return r.status === 0 ? r.stdout : null;
};

const whole = (a, b) => {
  const x = a.split('\n');
  const y = b.split('\n');
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if (x[i] !== y[i]) return { same: false, line: i + 1, a: x[i], b: y[i] };
  }
  return { same: true };
};

/**
 * @param {string[]} argv
 * @param {string} [root] the checkout to compare (tests pass a fixture)
 * @returns {number} the exit code
 */
export function main(argv, root = ROOT) {
  const i = argv.indexOf('--other');
  if (i < 0 || !argv[i + 1]) {
    console.error('usage: prepush-lib-drift.mjs --other <ref>');
    return 2;
  }
  const other = argv[i + 1];
  let bad = 0;
  const fail = (msg) => {
    console.log(`FAIL ${msg}`);
    bad++;
  };
  const mineLib = existsSync(resolve(root, LIB)) ? readFileSync(resolve(root, LIB), 'utf8') : null;
  const theirsLib = show(root, other, LIB);

  for (const f of [LIB, ...WHOLE_FILES]) {
    const theirs = f === LIB ? theirsLib : show(root, other, f);
    if (theirs === null) {
      fail(`${f}: not present on ${other} (the counterpart has not landed)`);
      continue;
    }
    const mine = f === LIB ? mineLib : readFileSync(resolve(root, f), 'utf8');
    let d;
    try {
      d = f === LIB ? driftBetween(mine, theirs) : whole(mine, theirs);
    } catch (e) {
      fail(`${f}: ${e.message}`);
      continue;
    }
    if (d.same) {
      console.log(
        `ok   ${f}: identical to ${other}${f === LIB ? ' outside the branch-specific block' : ''}`,
      );
    } else {
      fail(`${f}: drift from ${other} at line ${d.line}\n  here:  ${d.a}\n  there: ${d.b}`);
    }
  }

  // The branch-specific block must be data, and the exempt set must agree where files overlap.
  if (mineLib !== null && theirsLib !== null) {
    const copies = { here: mineLib, [other]: theirsLib };
    const regs = {};
    for (const [name, text] of Object.entries(copies)) {
      try {
        const problems = branchBlockProblems(text);
        if (problems.length > 0)
          fail(`${LIB} on ${name}: branch-specific block is not data: ${problems.join('; ')}`);
        else regs[name] = evalBranchBlock(text).GATE_INPUT_REGISTRY;
      } catch (e) {
        fail(`${LIB} on ${name}: ${e.message}`);
      }
    }
    if (regs.here && regs[other]) {
      const a = new Set(exemptInputs(regs.here));
      const b = new Set(exemptInputs(regs[other]));
      for (const input of new Set([...a, ...b])) {
        if (a.has(input) === b.has(input)) continue;
        const onBoth =
          existsSync(resolve(root, input)) &&
          git(root, ['cat-file', '-e', `${other}:${input}`]).status === 0;
        if (onBoth)
          fail(
            `${input} is exempt on ${a.has(input) ? 'here' : other} only, though the file exists on both`,
          );
      }
      console.log(
        `ok   exempt sets compared (${a.size} here, ${b.size} on ${other}); ${bad === 0 ? 'no drift' : 'see above'}`,
      );
    }
  }
  return bad === 0 ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
