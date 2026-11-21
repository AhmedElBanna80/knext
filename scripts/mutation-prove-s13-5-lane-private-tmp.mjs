#!/usr/bin/env node
/**
 * Mutation proof for the lane runner's signal cleanup (TD-S12-2a), guarded by
 * `tests/lane-private-tmp-signals.test.ts`. Each mutation removes one half of the cleanup (a signal
 * not routed through process.exit, a signal dropped from the list, or the runner no longer pinning
 * its signals); the spec must go RED. Anchors occur exactly once (abort otherwise), restoration is
 * content-addressed, verdicts are by exit code. A spec that hangs counts as RED (timeout), not green.
 *
 * Usage: node scripts/mutation-prove-s13-5-lane-private-tmp.mjs
 */

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSpecRunner } from './lib/ci-blocking-gate-proof.mjs';
import { mutate, restore, snapshot } from './lib/mutation-harness.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = 'tests/lane-private-tmp-signals.test.ts';
// ROUND 2 item 6: the tree-restore test is a second spec the signal rows must also keep green.
const SPECS = [SPEC, 'tests/lane-signal-tree-restore.test.ts'];
const PROOF = {
  subjects: {
    helper: 'scripts/lib/lane-exit-signals.mjs',
    runner: 'scripts/run-mutation-provers.mjs',
    restoreSpec: 'tests/lane-signal-tree-restore.test.ts',
    laneEnv: 'tests/helpers/lane-env.ts',
  },
};
const RUNNER = resolveSpecRunner(REPO_ROOT);
const SPEC_TIMEOUT_MS = 240_000;

/**
 * Detached orphans of the spec: processes with ppid 1 whose command is one of the spec's `setInterval`
 * children. A child whose parent (the spec's runner) died is re-parented to 1 and keeps running, so the
 * prover kills the ones that APPEARED during its run and leaves every process that predates it alone.
 */
const ORPHAN_SIGNATURE = 'setInterval(() => {}, 1000)';
function orphanPids() {
  const r = spawnSync('ps', ['-eo', 'pid=,ppid=,command='], { encoding: 'utf8' });
  if (r.status !== 0) return new Set();
  const pids = new Set();
  for (const line of r.stdout.split('\n')) {
    const m = /^\s*(\d+)\s+(\d+)\s+(.*)$/.exec(line);
    if (m && m[2] === '1' && m[3].includes(ORPHAN_SIGNATURE)) pids.add(Number(m[1]));
  }
  return pids;
}
function killNewOrphans(before) {
  for (const pid of orphanPids()) {
    if (before.has(pid)) continue;
    try {
      process.kill(pid, 'SIGKILL');
    } catch {
      // already gone
    }
  }
}

function specPasses() {
  const before = orphanPids();
  let ok = true;
  for (const spec of SPECS) {
    const r = spawnSync(RUNNER.command, [...RUNNER.args, ...RUNNER.runArgs(spec)], {
      cwd: REPO_ROOT,
      encoding: 'utf8',
      timeout: SPEC_TIMEOUT_MS,
    });
    ok = ok && r.status === 0;
  }
  killNewOrphans(before);
  return ok;
}

const MUTATIONS = [
  {
    label: 'SIGHUP is no longer routed through process.exit (a closed terminal leaves the dir)',
    subject: 'helper',
    anchor: "  ['SIGHUP', 129],\n",
    replacement: '',
  },
  {
    label: 'SIGQUIT is no longer routed through process.exit',
    subject: 'helper',
    anchor: "  ['SIGQUIT', 131],\n",
    replacement: '',
  },
  {
    label: 'SIGTERM is no longer routed through process.exit (a job timeout leaves the dir)',
    subject: 'helper',
    anchor: "  ['SIGTERM', 143],\n",
    replacement: '',
  },
  {
    label: 'SIGINT is no longer routed through process.exit',
    subject: 'helper',
    anchor: "  ['SIGINT', 130],\n",
    replacement: '',
  },
  {
    label: 'a pinned signal runs a no-op handler instead of exiting (the exit cleanup never runs)',
    subject: 'helper',
    anchor: 'process.exit(code);',
    replacement: 'void code;',
  },
  {
    label:
      'a signal handler is installed with once(): removed after it fires, so a repeat signal is not caught',
    subject: 'helper',
    anchor: 'process.on(signal, () => {',
    replacement: 'process.once(signal, () => {',
  },
  {
    label:
      'a signal does not kill the tracked prover groups before it exits (an orphan prover survives)',
    subject: 'helper',
    anchor: 'killTrackedGroups();',
    replacement: 'void 0;',
  },
  {
    label: 'a registered prover group is not kept, so it is never killed',
    subject: 'helper',
    anchor: 'tracked.add(kill);',
    replacement: 'void kill;',
  },
  {
    label: 'the runner stops pinning its signals (back to the bare exit handler)',
    subject: 'runner',
    anchor: 'pinExitSignals(restoreOnSignal);',
    replacement: '',
  },
  {
    label: 'the runner stops tracking its prover groups (a signal leaves them running)',
    subject: 'runner',
    anchor: 'const untrack = trackProverGroup(killGroup);',
    replacement: 'const untrack = () => {};',
  },
  {
    label: 'the runner never untracks a prover at close (a finished group would be signalled)',
    subject: 'runner',
    anchor: 'untrack();',
    replacement: 'void 0;',
  },
  {
    label:
      'ROUND 2 item 6: a signal does not restore the tree its killed prover left (the restore never runs)',
    subject: 'helper',
    anchor: '      beforeExit(signal);',
    replacement: '',
  },
  {
    label:
      'ROUND 2 item 6: the signal restore is a no-op (the killed prover leaves the tree dirty)',
    subject: 'runner',
    anchor: '  if (!activeProver) return;',
    replacement: '  return;',
  },
  {
    label:
      'ROUND 2 item 6: the active prover is never recorded, so a signal has nothing to restore',
    subject: 'runner',
    anchor: '  activeProver = { relPath: prover.relPath, untrackedBefore, modifiedBefore };',
    replacement: '',
  },
  {
    label:
      'ROUND 3 item 2: a SIGKILLed runner leaves its prover running (the test does not kill the prover group)',
    subject: 'restoreSpec',
    anchor: 'killFixtureGroups(dir);',
    replacement: 'void 0;',
  },
  {
    label:
      'the fixture runner spawn leaks the lane env again (PROVER_LANE_SHA reaches the fixture runner)',
    subject: 'laneEnv',
    anchor: '    env: runnerEnv(),\n',
    replacement:
      "    env: { ...process.env, KNEXT_LANE_RESTORE_AFTER_KILL: '1', GITHUB_ACTIONS: '' },\n",
  },
];

const DECLARED = 16;
declareMutations(DECLARED);
if (MUTATIONS.length !== DECLARED) {
  console.error(`FATAL: declared ${DECLARED} mutations, table has ${MUTATIONS.length}`);
  process.exit(1);
}
if (!specPasses()) {
  console.error('FATAL: baseline is not green to begin with');
  process.exit(1);
}
const decorative = [];
for (const m of MUTATIONS) {
  console.log(`── mutation: ${m.label}`);
  const snap = snapshot(resolve(REPO_ROOT, PROOF.subjects[m.subject]));
  try {
    mutate(snap, m.anchor, m.replacement);
    if (specPasses()) {
      console.log('   x DECORATION: the spec stayed GREEN with the behaviour removed');
      decorative.push(m.label);
    } else console.log('   ok went RED as required');
    recordMutation();
  } finally {
    restore(snap);
  }
  if (!specPasses()) {
    console.error('   FATAL: spec did not go green again after restore');
    process.exit(1);
  }
}
console.log(`\n${MUTATIONS.length - decorative.length} caught, ${decorative.length} decorative.`);
if (decorative.length > 0) {
  for (const label of decorative) console.error(`DECORATIVE: ${label}`);
  process.exit(1);
}
