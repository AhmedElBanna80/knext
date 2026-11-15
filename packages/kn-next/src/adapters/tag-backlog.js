/**
 * The bounded backlog the cache runtime keeps while Redis is unreachable.
 *
 * The ISR invalidation replay (`cache-handler.js`) and the `'use cache'` tag
 * replay (`use-cache-handler.js`) each remember what an outage kept from Redis
 * and replay it once the breaker closes. They share the same rules, and those
 * rules live here once, so a fix to one is a fix to both:
 *
 *  - DEDUPLICATED. One entry per name in a namespace; recording a name again
 *    updates its value in place (a Map keeps first-insertion order).
 *  - BOUNDED. At most `max` entries across every namespace together. Recording
 *    one more NEW name drops every entry for a COLLAPSE: the caller then replays
 *    a whole-app action instead (wider than needed, never stale).
 *  - GENERATIONAL. Every record call bumps a generation, and each entry carries
 *    the generation it was last recorded at. A replay that wrote an entry
 *    removes it only if it was not recorded again while the write was in flight
 *    (`settle`), and a collapse sweep clears the collapse only if nothing was
 *    recorded during the sweep (`endSweep`).
 *
 * Scheduling (the run, the probe timer, the exit report) stays with each
 * caller: it differs per caller and is not part of the bound.
 *
 * The CDN purge queue (`cdn-purge/purger.js`) collapses at the same size, so it
 * takes its cap from here too (`BACKLOG_MAX_ENTRIES`). Its queue is a plain Set
 * with no generation and it also collapses on drain time, so it does not use
 * the backlog itself.
 *
 * One backlog per owner: `cache-handler.js` holds one for the process, and
 * `use-cache-handler.js` holds one per core object. Nothing here is module
 * state.
 */

/** Entries a backlog holds before it collapses (ADR-0066, ADR-0068 D6.4). */
export const BACKLOG_MAX_ENTRIES = 1000;

/** The generation an entry was recorded at: the value itself, or its `generation`. */
function generationOf(value) {
  return typeof value === 'number' ? value : value?.generation;
}

/**
 * @param {object} [opts]
 * @param {string[]} [opts.namespaces]  Names that share the bound (default `['tags']`).
 * @param {number} [opts.max]  The bound (default `BACKLOG_MAX_ENTRIES`).
 * @param {(namespace: string) => void} [opts.onCollapse]  Called once, when a
 *   record collapses the backlog; given the namespace that overflowed.
 */
export function createTagBacklog({ namespaces = ['tags'], max = BACKLOG_MAX_ENTRIES, onCollapse } = {}) {
  const lists = new Map(namespaces.map((ns) => [ns, new Map()]));
  let generation = 0;
  let collapsed = false;

  function list(ns) {
    const m = lists.get(ns);
    if (!m) throw new Error(`tag backlog: unknown namespace ${ns}`);
    return m;
  }

  function size() {
    let n = 0;
    for (const m of lists.values()) n += m.size;
    return n;
  }

  function clearEntries() {
    for (const m of lists.values()) m.clear();
  }

  return {
    max,
    /** A copy of one namespace's entries, as [name, value] pairs in record order. */
    snapshot(ns) {
      return [...list(ns)];
    },
    /** Entries in one namespace. */
    sizeOf(ns) {
      return list(ns).size;
    },
    /** Entries across every namespace. */
    size,
    get collapsed() {
      return collapsed;
    },
    get generation() {
      return generation;
    },
    /** True while anything is left to replay: entries, or a collapse. */
    pending() {
      return collapsed || size() > 0;
    },
    /**
     * Record names that did not reach Redis, as one call: the generation moves on
     * ONCE (even while collapsed, so a sweep in flight keeps the collapse), then
     * each name is stored at it. `value(prev, generation)` gives what is stored
     * (default: the generation itself). The first NEW name past the bound
     * collapses the backlog and stops. Returns false when it is collapsed.
     */
    record(ns, names, value) {
      generation += 1;
      if (collapsed) return false;
      const m = list(ns);
      for (const name of names) {
        const prev = m.get(name);
        if (prev === undefined && size() >= max) {
          clearEntries();
          collapsed = true;
          onCollapse?.(ns);
          return false;
        }
        m.set(name, value ? value(prev, generation) : generation);
      }
      return true;
    },
    /**
     * A replay wrote `name` as recorded at `recordedAt`: remove it unless it was
     * recorded again since. Returns true when it was removed.
     */
    settle(ns, name, recordedAt) {
      const m = list(ns);
      if (generationOf(m.get(name)) !== recordedAt) return false;
      m.delete(name);
      return true;
    },
    /** A collapse sweep starts: returns the generation to hand to `endSweep`. */
    beginSweep() {
      return generation;
    },
    /** The sweep finished: clear the collapse unless a record landed during it. */
    endSweep(startedAt) {
      if (generation === startedAt) collapsed = false;
    },
    /** Drop the collapse without a sweep (a sweep that is refused for good). */
    dropCollapse() {
      collapsed = false;
    },
    /** Forget everything (the caller's reset). */
    clear() {
      clearEntries();
      generation = 0;
      collapsed = false;
    },
  };
}
