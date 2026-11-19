/**
 * Route the signals that would otherwise kill a lane runner through `process.exit`, so its `exit`
 * cleanup (the removal of its private temp dir) still runs, and kill the prover process groups it
 * still has running first, so none outlives the runner while its TMPDIR is being deleted.
 *
 * Why. A signal whose default action is to terminate skips the `exit` event. The runner's private dir
 * (`knext-lane-provers-*`) was therefore left behind by SIGHUP and SIGQUIT (measured, TD-S12-2a), and
 * by SIGTERM/SIGINT before those were handled. Each signal here maps to its conventional exit code
 * (128 + signal number), so a job that is cancelled still reports how it died.
 *
 * Process groups. The runner spawns each prover detached, in its own group, and registers a kill for
 * it with `trackProverGroup`. The signal handler calls every registered kill BEFORE `process.exit`. A
 * prover left running would otherwise keep writing into the TMPDIR the cleanup is about to delete.
 *
 * Handlers stay installed. `process.on`, not `once`: once a `once` listener has fired, Node restores
 * the default disposition for that signal, so a second signal during the cleanup would kill the runner
 * outright and leave the dir behind. A repeat signal now lands on a live handler, which calls
 * `process.exit` again, and the exit cleanup is already in progress.
 *
 * Not covered, stated: SIGKILL cannot be caught by any process, so it can still leave a dir (and a
 * prover group) behind. That is the one residual path, and it is a limit of the platform, not of this
 * helper.
 */

/** [signal name, exit code]. Exported so the test and the runner share one list. */
export const EXIT_SIGNALS = Object.freeze([
  ['SIGTERM', 143],
  ['SIGINT', 130],
  ['SIGHUP', 129],
  ['SIGQUIT', 131],
]);

/** The kill functions of the prover groups that are running now. */
const tracked = new Set();

/**
 * Register a prover process group's kill. Returns the untrack function, which the runner calls when
 * that prover closes, so a finished prover is never signalled.
 */
export function trackProverGroup(kill) {
  tracked.add(kill);
  return () => {
    tracked.delete(kill);
  };
}

/** Kill every tracked prover group, then forget them. A group that is already gone is not an error. */
export function killTrackedGroups() {
  for (const kill of tracked) {
    try {
      kill();
    } catch {
      // already gone
    }
  }
  tracked.clear();
}

/**
 * Register each signal. The handler kills the tracked groups, then runs `beforeExit(signal)` (synchronously:
 * the runner restores the tree its killed prover left), then exits, which emits `exit` for the cleanup.
 */
export function pinExitSignals(beforeExit = () => {}) {
  for (const [signal, code] of EXIT_SIGNALS) {
    process.on(signal, () => {
      killTrackedGroups();
      beforeExit(signal);
      process.exit(code);
    });
  }
}
