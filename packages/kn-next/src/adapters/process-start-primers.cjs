/**
 * The process-start primer list (ADR-0066 D3).
 *
 * A primer is a dependency-free CommonJS file that fires one bounded,
 * best-effort action the moment it is required, before the server boots.
 * The list is defined here and only here:
 *
 *   - disk mode: `node-server.ts` requires each primer, in list order, as its
 *     first statements, before it binds metrics or spawns the Next server;
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
 *   - cancelled on SIGTERM. One AbortController is shared by every primer,
 *     anchored on `globalThis` under `Symbol.for(PRIMER_ABORT_KEY_NAME)` and
 *     never in a module-level `let` (ADR-0027: a bundler that duplicates a
 *     module would give each copy its own controller). A primer creates it on
 *     first use, passes its signal to every outbound call and `unref()`s its
 *     timers. Both entries' SIGTERM handlers abort it BEFORE they drain
 *     (`node-server.ts` onSignal, `standalone-self-contained-supervisor.cjs`).
 *
 * This file is data only. `standalone-compile.mjs` imports it into its own
 * closure, which may hold no global access (`bun-base-exe-seam.test.ts`).
 */
'use strict';

/** Ordered. The ARP primer stays first: its packet must leave before anything else. */
const PROCESS_START_PRIMERS = Object.freeze(['arp-primer.cjs', 'wake-ahead.cjs']);

/** `Symbol.for` name of the shared AbortController on `globalThis`. */
const PRIMER_ABORT_KEY_NAME = 'knext.runtime.primerAbort';

module.exports = { PROCESS_START_PRIMERS, PRIMER_ABORT_KEY_NAME };
