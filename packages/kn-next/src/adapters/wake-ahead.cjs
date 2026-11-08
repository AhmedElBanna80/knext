/**
 * Wake-ahead primer (ADR-0066 D3, #2054): at zone start, send one
 * non-blocking `GET /healthz` to every bound function the operator listed, so
 * a cold function starts waking while the zone itself is still booting.
 *
 * Why at process start: from Next's `register()` the call lands only ~0.4 s
 * (Node) or ~0.8 s (Bun) ahead of the first request, while a cold function
 * needs ~1.4 s (docs/benchmarks/zone-functions-coldstart-kind-2026-10-09.md).
 * Process start is about one second earlier.
 *
 * Discovery is the ADR-0004 binding contract, never a scan of `process.env`:
 *   - `KNEXT_WAKE_FUNCTIONS` is the comma-separated list of binding names to
 *     wake. The operator leaves out a function that opted out
 *     (`wakeAhead: false`), so the per-function opt-out needs nothing here;
 *   - each name resolves to `<NAME>_SERVICE_URL` (upper case, `-` -> `_`).
 *     A name with no URL is logged once and skipped.
 * Both halves are asserted against the operator's own fixture
 * (`internal/controller/testdata/zone-binding-env.json`).
 *
 * Contract (process-start-primers.cjs): never throws; never blocks (the
 * calls are fire-and-forget and nothing awaits them, so the zone's first
 * `/healthz` answers whatever state they are in); every call carries a hard
 * timeout and the shared primer signal, which SIGTERM aborts; timers are
 * `unref()`d; an error is logged once per process, never retried.
 * `KNEXT_WAKE_AHEAD=0` switches the whole primer off.
 *
 * The GET is cluster-local and non-mutating, so the rule against
 * unauthenticated mutating endpoints is not engaged. A zone scaling from 0 to
 * N pods with M bindings fires N x M calls; they collapse into one activator
 * wake per function.
 */
'use strict';

const WAKE_FUNCTIONS_ENV = 'KNEXT_WAKE_FUNCTIONS';
const WAKE_AHEAD_SWITCH_ENV = 'KNEXT_WAKE_AHEAD';
const WAKE_PATH = '/healthz';
/** Below a function's ~1.4 s cold start; the activator has the request long before. */
const WAKE_TIMEOUT_MS = 1000;

/** `Symbol.for(PRIMER_ABORT_KEY_NAME)` of process-start-primers.cjs, inlined so this file needs no require. */
const PRIMER_ABORT_KEY = Symbol.for('knext.runtime.primerAbort');

function primerSignal() {
  let controller = globalThis[PRIMER_ABORT_KEY];
  if (!controller) {
    controller = new AbortController();
    globalThis[PRIMER_ABORT_KEY] = controller;
  }
  return controller.signal;
}

/** `<NAME>_SERVICE_URL` for a binding name (ADR-0004; packages/grpc `urlEnvFor`). */
function urlEnvFor(name) {
  return `${name.toUpperCase().replaceAll('-', '_')}_SERVICE_URL`;
}

/**
 * The wake targets from an env: `{ name, url }` for each listed name that has
 * a URL, and the names that have none. Pure.
 *
 * @param {Record<string, string | undefined>} env
 * @returns {{ targets: Array<{ name: string, url: string }>, missing: string[] }}
 */
function wakeTargets(env) {
  const raw = env[WAKE_FUNCTIONS_ENV];
  const targets = [];
  const missing = [];
  if (typeof raw !== 'string') return { targets, missing };
  const seen = new Set();
  for (const part of raw.split(',')) {
    const name = part.trim();
    if (name === '' || seen.has(name)) continue;
    seen.add(name);
    const url = env[urlEnvFor(name)];
    if (typeof url === 'string' && url !== '') targets.push({ name, url });
    else missing.push(name);
  }
  return { targets, missing };
}

/** The URL the wake GET goes to: the binding's base URL plus `/healthz`. */
function wakeUrl(base) {
  return `${base.replace(/\/+$/, '')}${WAKE_PATH}`;
}

/**
 * Fire the wake calls. Returns synchronously; the calls run detached.
 *
 * @param {{
 *   env?: Record<string, string | undefined>,
 *   fetch?: (url: string, init: { method: string, signal: AbortSignal }) => Promise<unknown>,
 *   warn?: (message: string) => void,
 *   signal?: AbortSignal,
 *   timeoutMs?: number,
 * }} [deps]
 * @returns {Promise<void>[]} one settled-never-rejecting promise per call, for tests
 */
function wakeAheadNow(deps) {
  const calls = [];
  try {
    const env = (deps && deps.env) || process.env;
    if (env[WAKE_AHEAD_SWITCH_ENV] === '0') return calls;
    const warn =
      (deps && deps.warn) ||
      ((message) => {
        // biome-ignore lint/suspicious/noConsole: dependency-free preload, no logger available
        console.warn(message);
      });
    const doFetch = (deps && deps.fetch) || globalThis.fetch;
    const shared = (deps && deps.signal) || primerSignal();
    const timeoutMs = (deps && deps.timeoutMs) || WAKE_TIMEOUT_MS;

    const { targets, missing } = wakeTargets(env);
    for (const name of missing) {
      warn(`[knext] wake-ahead: no ${urlEnvFor(name)} for bound function "${name}"; skipped`);
    }
    if (targets.length === 0 || typeof doFetch !== 'function' || shared.aborted) return calls;

    let warned = false;
    for (const t of targets) {
      const controller = new AbortController();
      const onAbort = () => controller.abort();
      shared.addEventListener('abort', onAbort, { once: true });
      const timer = setTimeout(onAbort, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      const call = Promise.resolve()
        .then(() =>
          // Aborted before the call left (a SIGTERM during boot): send nothing.
          controller.signal.aborted ? undefined : doFetch(wakeUrl(t.url), { method: 'GET', signal: controller.signal }),
        )
        .then(
          (res) => {
            // Release the connection; the body is empty and nothing reads it.
            try {
              res && res.body && typeof res.body.cancel === 'function' && res.body.cancel();
            } catch {
              // never throw from the primer
            }
          },
          (err) => {
            // A timeout or a shutdown abort is the expected common case: the
            // activator has the request, and that is the point.
            if (controller.signal.aborted || warned) return;
            warned = true;
            try {
              warn(`[knext] wake-ahead: GET ${wakeUrl(t.url)} failed: ${err && err.message ? err.message : String(err)}`);
            } catch {
              // never throw from the primer
            }
          },
        )
        .finally(() => {
          clearTimeout(timer);
          shared.removeEventListener('abort', onAbort);
        });
      calls.push(call);
    }
  } catch {
    // never throw from the primer
  }
  return calls;
}

// Preload side effect: requiring this file fires the wake calls immediately.
wakeAheadNow();

module.exports = {
  WAKE_FUNCTIONS_ENV,
  WAKE_AHEAD_SWITCH_ENV,
  WAKE_PATH,
  WAKE_TIMEOUT_MS,
  PRIMER_ABORT_KEY,
  urlEnvFor,
  wakeTargets,
  wakeUrl,
  wakeAheadNow,
};
