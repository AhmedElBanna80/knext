# health

## Overview
Health probes, published as the `@getknext/lib/health` subpath. A shallow probe that never
dials a dependency backs liveness and readiness. A deep probe that understands scale-to-zero
wakes classifies Postgres (hard dependency) and Redis (soft dependency) for observability.

## Interface
- `index.ts:checkShallowHealth()`: returns a `ShallowHealthStatus`
  (`{ status: 'ok', timestamp, check: 'shallow' }`) without any I/O.
- `index.ts:checkDeepHealth()`: returns `Promise<HealthStatus>`, which has the shape
  `{ status: 'ok'|'degraded'|'down'|'waking', timestamp, checks: { postgres, redis } }`, where
  `postgres` is `'up'|'down'|'unconfigured'|'waking'` and `redis` is `'up'|'down'|'unconfigured'`.
- `index.ts:HealthStatus`, `index.ts:ShallowHealthStatus`.
- `index.ts:resetHealthRedisCache()` (tests): drops the cached Redis client without quitting it.

## Invariants
- `checkShallowHealth` never touches Postgres or Redis.
- Initial sub-check states: `postgres` is `waking` when `DATABASE_URL` is set, otherwise
  `unconfigured`. `redis` is `down` when `REDIS_URL` is set, otherwise `unconfigured`. A
  sub-check that times out keeps its initial state (`index.ts:checkDeepHealth`).
- How the overall status is derived (`index.ts:checkDeepHealth`): `postgres === 'down'` gives
  `down`; `postgres === 'waking'` gives `waking`; `redis === 'down'` gives `degraded`; anything
  else gives `ok`.
- How Postgres errors are classified: a wake signal (`WAKE_ERROR_CODES`: `ECONNREFUSED`,
  `ECONNRESET`, `ETIMEDOUT`, `EHOSTUNREACH`, `ENETUNREACH`, `EAI_AGAIN` as the `code`, or a
  message that, upper-cased, contains one of those codes or `CONNECT`) gives `waking`. The exception is a connection refusal on a database for which
  `isScaleToZeroDatabase` is false; that gives `down`. Every other error gives `down`
  (`index.ts:isWakeSignal`).
- On a database for which `isScaleToZeroDatabase` is false, the probe subscribes through
  `observeAcquireFailures`. The first refused connect attempt resolves the race as `down`
  without waiting for the pool's retry budget. The observer is always unsubscribed in `finally`.
- The `SELECT 1 as healthy` probe runs inside `runWithoutDbActivity`, so it never counts as DB
  activity.
- All deep checks share one timeout: `HEALTH_DEEP_TIMEOUT_MS` when `parseInt` reads a positive integer from it (so `12abc` is 12),
  otherwise `DEFAULT_DEEP_TIMEOUT_MS = 8000` (`index.ts:deepTimeoutMs`).
- The Redis client comes from `createRedisClient(REDIS_URL, 'deep-health')`. It is cached for
  the life of the module, and `ensureDialable` runs before each `ping()`.

## Side Effects
- Queries Postgres through `getDbPool()` (`../clients`), which builds the writer pool singleton
  on first use.
- Builds a Redis client on first use and pings it.
- Arms a `setTimeout` for the deep-check timeout on each `checkDeepHealth` call and never
  clears it, so the timer stays pending after the checks settle.
- Logs through `logger` (`../logger`): `info` for waking or a timeout, `error` for a failure.
- Reads `DATABASE_URL`, `REDIS_URL` and `HEALTH_DEEP_TIMEOUT_MS` on each call, and
  `KNEXT_DB_SCALE_TO_ZERO` (through `isScaleToZeroDatabase`) only when `DATABASE_URL` is set.
- When `DATABASE_URL` is set, the call to `isScaleToZeroDatabase` means an unrecognised
  `KNEXT_DB_SCALE_TO_ZERO` value writes one JSON `console.warn` line per distinct value per
  process, tracked in a `globalThis` once-set.

## Verification
- Run: `node scripts/bun-test.mjs packages/lib` (from repo root)
