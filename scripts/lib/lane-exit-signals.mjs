/**
 * Route the signals that would otherwise kill a lane runner through `process.exit`, so its `exit`
 * cleanup (the removal of its private temp dir) still runs.
 *
 * Why. A signal whose default action is to terminate skips the `exit` event. The runner's private dir
 * (`knext-lane-provers-*`) was therefore left behind by SIGHUP and SIGQUIT (measured, TD-S12-2a), and
 * by SIGTERM/SIGINT before those were handled. Each signal here maps to its conventional exit code
 * (128 + signal number), so a job that is cancelled still reports how it died.
 *
 * Not covered, stated: SIGKILL cannot be caught by any process, so it can still leave a dir behind.
 * That is the one residual path, and it is a limit of the platform, not of this helper.
 */

/** [signal name, exit code]. Exported so the test and the runner share one list. */
export const EXIT_SIGNALS = Object.freeze([
  ['SIGTERM', 143],
  ['SIGINT', 130],
  ['SIGHUP', 129],
  ['SIGQUIT', 131],
]);

/** Register each signal once; the handler exits, which emits the `exit` event that cleans up. */
export function pinExitSignals() {
  for (const [signal, code] of EXIT_SIGNALS) {
    process.once(signal, () => process.exit(code));
  }
}
