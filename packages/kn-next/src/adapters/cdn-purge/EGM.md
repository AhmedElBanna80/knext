# cdn-purge

## Overview

Purges the CDN by tag (surrogate key) after ISR and cache invalidations. It is
process-wide, never throws, and is off unless `KNEXT_CDN_PROVIDER` is set. Tags
are batched, rate-limited by a token bucket, and retried. When the backlog gets
too big, it is replaced by one whole-app purge. A one-time "first ready" purge
runs once per build ID, and Redis decides which process does it. The
ISR/data-cache handler (`../cache-handler.js`) is the only module that imports
it.

## Interface

- `index.js:getCdnPurger()` returns the process-wide purger. It is created on
  the first call and stored on `globalThis[Symbol.for('knext.core.cdn.purger')]`.
- `index.js:enqueuePurge(tags, ctx)` is synchronous and returns
  `{queued, skipped?}`. On any error it returns `{queued: 0, skipped: 'error'}`.
- `index.js:enqueueAppPurge(ctx)` is synchronous and queues one purge of the
  app tag.
- `index.js:firstReadyPurge(buildId, ctx)` is async and returns
  `{purged, reason?}`. `ctx.redis` can be a client or an async getter.
- All three take an optional `ctx.purger`, used in place of the process-wide
  purger (`ctx.purger ?? getCdnPurger()`); tests inject one this way.
- `index.js` also re-exports `createMetricsRegistry`, `defaultMetricsRegistry`,
  `renderCdnPurgeMetrics`, `createCdnPurger`, `PURGE_ROWS`,
  `validateEmulatorEndpoint`, `appTag`, `buildTag` and `nextTag`.
- `purger.js:createCdnPurger(options)` takes injectable `env`, `fetch`, `now`,
  `sleep`, `log`, `metrics`, `flushIntervalMs` and `requestTimeoutMs`. It
  returns `{enqueue, enqueueApp, firstReady, flush, status}`.
- `purger.js:resolveConfig` reads `KNEXT_CDN_PROVIDER`, `KNEXT_CDN_TAG_PREFIX`,
  `KNEXT_CDN_PURGE_TARGET`, `KNEXT_CDN_PURGE_TOKEN` and `KNEXT_CDN_PURGE_RPM`.
  The resulting state is one of `disabled`, `unknown`, `unsupported`,
  `invalid`, `no_credential` or `ready`.
- `rows.js:PURGE_ROWS` is the provider table. `cloudflare` and `emulator` can
  purge. `google-cloud-cdn`, `cloudfront` and `azure-front-door` have
  `purge: null`, so they are unsupported.
- `rows.js:validateEmulatorEndpoint` checks `KNEXT_CDN_EMULATOR_ENDPOINT`. It
  accepts only `http(s)://<dns>.svc.cluster.local[:port]` with no userinfo and
  no path. `rows.js:EMULATOR_DUMMY_TOKEN` is the emulator's fixed token.
- `tags.js:appTag`, `buildTag` and `nextTag` build the tags `kn-<p>`,
  `kn-<p>-b<12 hex of sha256>` and `kn-<p>-t<16 hex of sha256>`.
- `metrics.js:PURGE_METRIC` is the counter `knext_cdn_purge_total` with the
  labels `{provider, result}`. `renderCdnPurgeMetrics()` returns it as
  Prometheus text. `metrics.d.ts` declares the types, including the registry type
  `CdnMetricsRegistry`.

## Invariants

- `enqueue`, `enqueueApp` and `firstReady` never throw, because each is
  wrapped in `try/catch`. When `KNEXT_CDN_PROVIDER` is empty, the module does
  nothing.
- Config fails closed. The tag prefix must match `/^[0-9a-f]{12}$/`, a
  Cloudflare target must be 32 hex characters, and the token must be printable
  ASCII (`/^[\x21-\x7e]+$/`). A bad emulator endpoint makes the state
  `invalid`.
- Tags are batched for `DEFAULT_FLUSH_INTERVAL_MS` (1000 ms). Once a full batch
  is pending, it is flushed right away.
- The `PURGE_ROWS` defaults are a batch size of 100, 5 requests per minute and
  a token bucket of 25. `KNEXT_CDN_PURGE_RPM` replaces the rate only when it is
  an integer from 1 to 6000.
- Each batch gets at most `MAX_ATTEMPTS` (3) attempts:
  - On a 429, it waits for `Retry-After`, capped at `RETRY_AFTER_CAP_MS`
    (60000).
  - On a 5xx or network error, it backs off by `BACKOFF_MS`.
  - Any other non-2xx response is final.
- Each request is aborted after `DEFAULT_REQUEST_TIMEOUT_MS` (10000 ms).
- `purger.js:overBudget` checks two limits: more than `MAX_PENDING` (1000)
  pending tags, or a projected drain time over `MAX_DRAIN_MS` (300000 ms). If
  either is exceeded, the backlog is replaced by a single `appTag` purge.
- Redirects are never followed (`redirect: 'manual'`). The token goes only in
  the `Authorization` header, and errors are logged by name only.
- `firstReady` runs at most once per process per build ID. Only a Redis reply,
  won or lost, uses up that attempt. A Redis error returns
  `reason: 'redis_error'`.
- Pending purge work is registered with the SIGTERM drain through
  `trackWrite` from [`../cache-write-registry.js`](../cache-write-registry.js).
- Metric results are `ok`, `ratelimited`, `failed`, `skipped_no_credential`,
  `skipped_unsupported` and `skipped_invalid_target`. Each skip reason is
  logged only once.

## Side Effects

- Network: `POST https://api.cloudflare.com/client/v4/zones/<target>/purge_cache`
  with the body `{tags}`. The emulator gets the same path on its
  `*.svc.cluster.local` origin, sent with the dummy token.
- Redis: `SET knext:cdn:purged:<p>:<buildId> 1 NX EX 604800`
  (`FIRST_READY_TTL_SECONDS`).
- Globals: `Symbol.for('knext.core.cdn.purger')` and
  `Symbol.for('knext.core.cdn.metrics')`. `../cdn-edge.cjs` reads the metrics
  registry from that global key to render the counter.
- Logs to the console, or to the injected `log`, with the prefix `[CdnPurge]`.
  Uses `setTimeout` timers. Does no disk I/O.

## Verification

- Run from `packages/kn-next`: `node ../../scripts/bun-test.mjs packages/kn-next`
