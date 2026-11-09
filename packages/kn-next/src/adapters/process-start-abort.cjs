/**
 * The one AbortController every process-start primer shares (ADR-0066 D3).
 *
 * This module owns it: a primer passes `primerSignal()` to its outbound calls,
 * and each entry's SIGTERM handler calls `abortPrimers()` before it drains
 * (`node-server.ts` onSignal, `standalone-self-contained-supervisor.cjs`). In
 * the plain compiled exec (not self-contained) there is no handler of knext's:
 * Next's own SIGTERM handler exits the process, which ends any call with it.
 *
 * The controller lives on `globalThis` under a `Symbol.for` key, never in a
 * module-level `let` (ADR-0027): a bundler that duplicates this file would
 * otherwise give each copy its own controller, and the abort would miss the
 * primer holding the other one.
 *
 * Kept apart from `process-start-primers.cjs` on purpose: the list is imported
 * into `standalone-compile.mjs`'s own closure, which may hold no global access
 * (`bun-base-exe-seam.test.ts`). This file is only ever required at runtime.
 */
'use strict';

const PRIMER_ABORT_KEY = Symbol.for('knext.runtime.primerAbort');

function primerController() {
  let controller = globalThis[PRIMER_ABORT_KEY];
  if (!controller) {
    controller = new AbortController();
    globalThis[PRIMER_ABORT_KEY] = controller;
  }
  return controller;
}

/** The signal every primer passes to its outbound calls. */
function primerSignal() {
  return primerController().signal;
}

/** Cancel every primer's outstanding work. Idempotent; never throws. */
function abortPrimers() {
  try {
    primerController().abort();
  } catch {
    // never throw from the shutdown path
  }
}

module.exports = { PRIMER_ABORT_KEY, primerSignal, abortPrimers };
