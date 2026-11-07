# src

## Overview
The source of `@getknext/lib`. `index.ts` re-exports `./clients`, `./context`, `./health`,
`./logger`, `./redis/client` and `./redis/quiet`. `clients.ts` holds lazily created client
singletons: a Postgres writer, a Postgres reader, Cerbos and MinIO. The writer pool is wrapped
in scale-to-zero layers: wake retry, wake single-flight, activity tracking and slow-dependency
timing. Tracing and correlation hooks are injected through `globalThis`-anchored seams, so the
package has no OTel dependency.

## Interface
- `index.ts`: re-exports the modules listed in the overview (not `slow-dep`, `runtime-anchor` or `db/*`).
- `clients.ts:getDbPool()`: the writer `Pool` singleton. Its driver is `selectDbDriver()`: `bun`
  gives `createBunSqlPool`, `pg` gives `new Pool`.
- `clients.ts:getDbPoolRO()`: returns a `Pool`, or `null` when `DATABASE_URL_RO` is unset. It
  always builds a `pg` `Pool` (`new Pool`); `selectDbDriver()` applies to the writer only.
- `clients.ts:closeDbPool()`, `clients.ts:closeDbPoolRO()`: end the pool and reset its
  singleton. Each does nothing if its pool was never created.
- `clients.ts:selectDbDriver()`: returns `KNEXT_DB_DRIVER` when it is `pg` or `bun`,
  otherwise `bunSqlAvailable() ? 'bun' : 'pg'`.
- `clients.ts:getCerbosClient()`: returns a `GRPC` client for `CERBOS_URL` (default
  `cerbos.default.svc.cluster.local:3593`) with `tls: false`.
- `clients.ts:getMinioClient()`: returns a `Minio.Client` built from `MINIO_ENDPOINT` (default
  `minio.default.svc.cluster.local`), `MINIO_PORT` (default `9000`), `MINIO_USE_SSL` (`'true'`
  enables it), `MINIO_ACCESS_KEY` and `MINIO_SECRET_KEY`.
- `clients.ts:setPoolInstrumentor(fn)`, `clients.ts:resetPoolInstrumentor()` (back to a no-op),
  `clients.ts:PoolInstrumentor` (`(pool, role) => void`, called once per pool at creation),
  `clients.ts:PoolRole` (`'writer' | 'reader'`).
- `clients.ts:DB_ACTIVITY_BUDGET_MS` (default 45000, `DB_ACTIVITY_BUDGET_MS` env),
  `clients.ts:getLastDbActivityAt()`, `clients.ts:isDbRecentlyActive(budgetMs?)`,
  `clients.ts:resetDbActivity()`.
- `clients.ts:isDbWoken()`: true once the writer's wake single-flight has latched `woken`.
- `clients.ts:resetDbWakeSingleflight()`, `clients.ts:resetClients()` (tests). `resetClients`
  drops the Cerbos/MinIO instances and both pool singletons (without ending them) and resets
  the instrumentor, activity stamp and wake single-flight.
- `clients.ts:dbWakeRetryBudgetMs()` (`DB_WAKE_RETRY_BUDGET_MS`, default 8000),
  `dbWakeRetryBaseMs()` (`DB_WAKE_RETRY_BASE_MS`, default 100), `dbWakeRetryMaxMs()`
  (`DB_WAKE_RETRY_MAX_MS`, default 1000). Each reads its env var on every call; a value that
  is not a positive integer falls back to the default.
- `slow-dep.ts:logSlowDep(dep, op, durationMs, extra?)`: returns whether it logged.
  `slow-dep.ts:slowDepThresholdMs()` (`SLOW_DEP_LOG_MS` read on each call, default 500 for an
  unset or non-positive value), `slow-dep.ts:SLOW_DEP_PREFIX` (`'[slow-dep]'`),
  `slow-dep.ts:SlowDepName` (`'pg' | 'redis-connect' | 'redis-ready'`). Internal: not
  re-exported from `index.ts`.
- `runtime-anchor.ts:runtimeAnchor()`: this module's own file name taken from the V8 call
  site when it is a real location (a `file://` URL, a POSIX absolute path or a Windows drive
  path, and not `$bunfs`/`~BUN`). Otherwise it returns `${process.cwd()}/`.
- `lazy-sdk-loaders.mjs:loadCerbosSdk()`, `lazy-sdk-loaders.mjs:loadMinioSdk()` (typed by
  `lazy-sdk-loaders.d.mts` as `unknown`). Each calls the ambient `require` when
  `typeof require === 'function'`, otherwise `createRequire(runtimeAnchor())`.
- Subdirectories:
  - [context](./context/EGM.md): request correlation id, kept in an ALS and set by injected providers.
  - [db](./db/EGM.md): internal `Bun.SQL` pg facade, activity scope and reachability classifiers.
  - [health](./health/EGM.md): shallow probe and wake-aware deep probe.
  - [logger](./logger/EGM.md): pino logger with correlation `mixin` and redaction.
  - [redis](./redis/EGM.md): picks Bun or ioredis, with quiet, bounded options.

## Invariants
- Writer-pool wrap order inside `getDbPool`, innermost first: `instrumentPool`, `retryWake`,
  `singleflightWake`, `trackPoolActivity`, `timePoolOps`. The reader gets only `instrumentPool`
  and `timePoolOps` (`clients.ts:getDbPoolRO`).
- Each wrapper fails open and returns the pool unchanged if patching throws
  (`trackPoolActivity`, `singleflightWake`, `retryWake`, `timePoolOps`). `instrumentPool`
  swallows a throw from the installed instrumentor.
- Single-flight: the first cold acquisition publishes `inflight`, and concurrent callers await
  it. A success sets `woken = true`. A rejection clears `inflight` without setting `woken`
  (`clients.ts:singleflightWake`).
- Retry: before each retry decision the failure is reported through `reportAcquireFailure`. A
  permanent error (SQLSTATE `28*`, or an auth or missing role/database message) or an expired
  budget rethrows the last error. Backoff is `min(max, base * 2^n)`, clamped to the remaining
  budget. If the budget runs out during the sleep, one final attempt runs with no further
  retry. A synchronous throw or a non-promise result passes straight through
  (`clients.ts:retryWake`, `clients.ts:isPermanentAcquireError`).
- An activity stamp is skipped inside `runWithoutDbActivity` (`clients.ts:markDbActivity`).
  `isDbRecentlyActive` returns false for a pool that has never been used.
- Writer pool max is `min(DB_POOL_MAX or 5, KNEXT_DB_POOL_MAX)` when `KNEXT_DB_POOL_MAX` is a
  positive integer, otherwise `DB_POOL_MAX` or 5 (`clients.ts:resolveDbPoolMax`). The reader max
  is `DB_POOL_RO_MAX` or 5 and is not capped by `KNEXT_DB_POOL_MAX`. The idle timeout defaults
  to 10000 ms (`DB_POOL_IDLE_TIMEOUT_MS`, `DB_POOL_RO_IDLE_TIMEOUT_MS`) and the connect timeout
  to 15000 ms (`DB_POOL_CONNECT_TIMEOUT_MS`, `DB_POOL_RO_CONNECT_TIMEOUT_MS`). A value that is
  not a positive integer falls back to the default (`clients.ts:toFinitePositiveInt`).
- The instrumentor, activity timestamp, wake single-flight and Cerbos/MinIO instances live on
  `globalThis` under `Symbol.for('knext.lib.clients.*')` keys. `pgPool` and `pgPoolRO` are
  module-level variables.
- A `build()` call that throws for a lazy SDK client is not cached, so the next call tries
  again (`clients.ts:getOrCreateClient`).
- `@cerbos/grpc` and `minio` are loaded on first getter call, through literal `require(...)`
  calls in the unbundled `lazy-sdk-loaders.mjs`. `clients.ts` imports them as types only.
- `logSlowDep` logs only when `durationMs > threshold`. The line carries `dep`, `op`,
  `durationMs` (rounded) and `thresholdMs`, then the filtered `extra`. The filter drops
  `undefined`, string values that contain `://` or `@`, and values that are not strings,
  numbers or booleans, and it truncates strings to 120 chars. `logSlowDep` never throws.
- `runtimeAnchor` restores `Error.prepareStackTrace` and `Error.stackTraceLimit` in `finally`.
  `lazy-sdk-loaders.mjs` contains a hand-kept copy of it.

## Side Effects
- `getDbPool` and `getDbPoolRO` build Postgres pools on first call. `close*` clears the
  singleton first and then awaits `pool.end()`.
- Writer-pool connect/query failures are passed to `reportAcquireFailure`, which notifies the
  observers registered in `db/reachability.ts`.
- `getCerbosClient` and `getMinioClient` load SDK modules synchronously and construct network
  clients. When the env vars are unset they fall back to in-cluster hostnames and the MinIO
  credentials `minio`/`minio123`.
- Writer-pool calls write `Date.now()` to the activity slot on `globalThis`. A slow pool
  operation produces a `console.warn` line `[slow-dep] {...}` with `role`, `cold` (writer only)
  and `outcome`.
- `timePoolOps` attaches a handler to each returned promise, which marks rejections as handled.
- `DB_ACTIVITY_BUDGET_MS` is read once, when the module loads.

## Verification
- Run: `node scripts/bun-test.mjs packages/lib` (from repo root)
