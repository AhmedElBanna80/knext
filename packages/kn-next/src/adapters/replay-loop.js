/**
 * The replay loop the cache runtime runs while a backlog (tag-backlog.js) is
 * pending: one run at a time, then one probe timer until nothing is left.
 *
 * The ISR invalidation replay (cache-handler.js) and the 'use cache' tag
 * replay (use-cache-handler.js) both use it. What differs between them is
 * passed in: the run itself, when to probe again, what "unreachable" means
 * and what to do then. Like the backlog, it holds no module state; each
 * caller keeps its loop where it keeps its backlog.
 *
 * @param {object} opts
 * @param {string} opts.label  Names the replay in the "stopped" log line.
 * @param {() => boolean} opts.pending  Whether anything is left to replay.
 * @param {() => Promise<unknown>} opts.run  One replay pass. Its failure is logged, never thrown.
 * @param {() => number} opts.retryInMs  How long to wait before the next probe.
 * @param {() => boolean} opts.unreachable  True when no replay could reach the store at all.
 * @param {() => void} opts.onUnreachable  Called instead of probing when `unreachable()`.
 * @param {(p: Promise<unknown>) => Promise<unknown>} opts.track  Registers the run so a drain can await it.
 * @param {(...args: unknown[]) => void} [opts.log]  Defaults to console.error.
 */
export function createReplayLoop({
  label,
  pending,
  run,
  retryInMs,
  unreachable,
  onUnreachable,
  track,
  log = console.error,
}) {
  let running = null;
  let timer = null;

  /** Start a run unless one is running. Never awaited, never throws. */
  function start() {
    if (running || !pending()) return;
    running = track(
      run()
        .catch((err) => {
          log(`[CacheHandler] ${label} stopped:`, err?.message);
        })
        .finally(() => {
          running = null;
          probe();
        }),
    );
  }

  /**
   * Probe again later, while anything is left to replay. One timer at a time,
   * unref'd so it never holds the process open.
   */
  function probe() {
    if (unreachable()) {
      onUnreachable();
      return;
    }
    if (timer || running || !pending()) return;
    timer = setTimeout(() => {
      timer = null;
      start();
    }, retryInMs());
    timer.unref?.();
  }

  /** Forget the run and the probe. The backlog is the caller's to clear. */
  function reset() {
    running = null;
    if (timer) clearTimeout(timer);
    timer = null;
  }

  return { start, reset };
}
