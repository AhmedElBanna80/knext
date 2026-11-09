/**
 * The process-start primer list (ADR-0066 D3).
 *
 * A primer is a dependency-free CommonJS file that fires one bounded,
 * best-effort action the moment it is required, before the server boots.
 * The list is defined here and only here:
 *
 *   - disk mode: `node-server.ts`, right after its boot-trace mark, calls
 *     `runProcessStartPrimers` (`process-start-run.ts`), which requires each
 *     primer in list order before metrics bind and before the spawn;
 *   - compiled single-exec: `standalone-compile.mjs` spreads this list at the
 *     front of `PRELOAD_NAMES`, so the primers stay the earliest preloads.
 *
 * Neither consumer names a primer directly. Later process-start work appends
 * here rather than adding another inline block to either entry.
 *
 * Primer contract (every entry):
 *   - CommonJS, no dependencies;
 *   - never throws, never awaited, never on the readiness path;
 *   - bounds its own work (hard per-call timeout, errors logged once, no retry);
 *   - switched off by its own env variable;
 *   - cancelled on SIGTERM if it holds any outbound work: it passes the shared
 *     signal from `process-start-abort.cjs` to that work and `unref()`s its
 *     timers (the ARP primer's single UDP send holds nothing to cancel).
 *
 * This file is data only. `standalone-compile.mjs` imports it into its own
 * closure, which may hold no global access (`bun-base-exe-seam.test.ts`).
 */
'use strict';

/** Ordered. The ARP primer stays first: its packet must leave before anything else. */
const PROCESS_START_PRIMERS = Object.freeze(['arp-primer.cjs', 'wake-ahead.cjs']);

module.exports = { PROCESS_START_PRIMERS };
