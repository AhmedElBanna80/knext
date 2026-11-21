// The wrapper harness's controls, shown to go red.
//
//   bun crates/harness/ffi-generated-red.ts <path-to-fixture-lib>
//
// `ffi-generated.ts wrapper` runs five controls that fail when the loader's directory walk is
// weakened. A control that stays green with its subject removed is decoration, so this runs the
// harness once per weakening in loader-weakenings.ts, each with KNEXT_FFI_HARNESS_MUTATE=<id>
// weakening the rendered loader in memory, and requires of each run:
//
//   - exit code 1 exactly (a check failed; 10 is "could not run", which proves nothing);
//   - the failing checks are labelled `control N`, and the set of controls that failed is exactly the
//     one the weakening lists: no other control, and no check without a control label.
//
//   W01  the directories above the one native/ sits in are never walked   controls 1, 3, 4
//   W02  the walk stops one short of the root directory                   control 4
//   W03  a path that is not its directory's real path is let through      controls 2, 5
//        (the assertion that the executable's directory is its own real path: control 2 sees
//        the link refused for another reason, control 5, a RELATIVE path whose walk would stop at
//        ".", sees a tree that must not load LOAD)
//   W04  a sticky, world-writable directory (a /tmp) is let through       control 1
//   W05  the owner of a directory is not judged (a walk by mode alone)    control 1
//        (only as a user that is not root: a root-owned tree has nothing to show it)
//
// The verdict is the exit code and the labels the harness itself prints on failure; nothing here
// reads the loader's own words. Like the harness it needs root or passwordless sudo, and it stops
// its child on SIGINT and SIGTERM (the child removes what it staged).
//
// Exit: 0 every weakening was caught as listed, 1 one was not, 10 it could not run, 130 and 143 it
// was stopped by SIGINT or SIGTERM (what it had running was stopped first; nothing was proved).

import { type ChildProcess, spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { judge, WEAKENINGS } from './loader-weakenings';

const HARNESS = resolve(import.meta.dir, 'ffi-generated.ts');
const HARNESS_ERROR = 10;

let current: ChildProcess | undefined;
let interrupted: number | undefined;
for (const [sig, code] of [
  ['SIGINT', 130],
  ['SIGTERM', 143],
] as const) {
  process.on(sig, () => {
    interrupted = code;
    current?.kill(sig); // the harness cleans up what it staged, then exits; the run below sees it end
  });
}

function runWeakened(id: string, lib: string): Promise<{ status: number | null; stderr: string }> {
  return new Promise((settle) => {
    const child = spawn(process.execPath, [HARNESS, 'wrapper', lib], {
      env: { ...process.env, KNEXT_FFI_HARNESS_MUTATE: id },
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    current = child;
    let stderr = '';
    child.stderr?.setEncoding('utf8').on('data', (d: string) => {
      stderr += d;
    });
    child.on('error', (e) => settle({ status: null, stderr: `${stderr}${e.message}` }));
    child.on('close', (status) => settle({ status, stderr }));
  });
}

async function main(): Promise<number> {
  const lib = process.argv[2];
  if (lib === undefined) {
    console.error('usage: bun crates/harness/ffi-generated-red.ts <path-to-fixture-lib>');
    return HARNESS_ERROR;
  }
  let missed = 0;
  const root = process.getuid?.() === 0;
  for (const [id, w] of Object.entries(WEAKENINGS)) {
    if (w.nonRoot && root) {
      console.log(`ffi-generated-red: ${id} skipped: only a user that is not root can see it`);
      continue;
    }
    const { status, stderr } = await runWeakened(id, resolve(lib));
    if (interrupted !== undefined) return interrupted;
    if (status === HARNESS_ERROR) {
      console.error(`ffi-generated-red: ${id}: the harness could not run:\n${stderr}`);
      return HARNESS_ERROR;
    }
    const problems = judge(id, status, stderr);
    if (problems.length === 0) {
      console.log(
        `ffi-generated-red: ${id} caught (${w.claim}): controls ${JSON.stringify(w.controls)} went red`,
      );
    } else {
      missed++;
      for (const p of problems) console.error(`ffi-generated-red: NOT CAUGHT: ${p}`);
      console.error(stderr);
    }
  }
  if (missed > 0) return 1;
  console.log('ffi-generated-red: every weakening was caught by exactly its controls');
  return 0;
}

if (import.meta.main) process.exit(await main());
