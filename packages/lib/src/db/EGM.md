# db

## Overview
Internal Postgres support modules used by `../clients.ts` and `../health`. This directory has
no package entry point (`package.json` `exports` has no `db` subpath). It provides:

- a `pg.Pool`-shaped facade over `Bun.SQL`;
- a per-async-context scope that suppresses activity tracking;
- the shared rules for when a connect failure counts as a refusal and when a database counts
  as scale-to-zero.

## Interface
- `bun-sql-pool.ts:createBunSqlPool(config, sqlFactory = defaultSqlFactory)`: returns a
  `PgLikePool` exposing `query` (runs `sql.unsafe(text, values)`), `connect` (awaits
  `sql.reserve()` and returns a `PgLikeClient` with `query` and `release`) and `end`.
- `bun-sql-pool.ts:defaultSqlFactory(config, scope?)`: builds `new Bun.SQL({ url, max,
  idleTimeout, connectionTimeout })`. It throws when `Bun.SQL` is absent.
- `bun-sql-pool.ts:bunSqlAvailable(scope?)`: true iff `scope.Bun.SQL` is a function.
- `bun-sql-pool.ts:PgLikeQueryResult`, `PgLikeQuery`, `PgLikeClient`, `PgLikePool`,
  `BunSqlPoolConfig`, `BunScope`.
- `activity-scope.ts:runWithoutDbActivity(fn)`, `activity-scope.ts:isDbActivityUntracked()`.
- `reachability.ts:observeAcquireFailures(observer)`: returns an unsubscribe function.
- `reachability.ts:reportAcquireFailure(error)`, `reachability.ts:acquireFailureObserverCount()`.
- `reachability.ts:isConnectionRefused(error)`, `reachability.ts:isScaleToZeroDatabase(dsn,
  declared = KNEXT_DB_SCALE_TO_ZERO)`, `reachability.ts:AcquireFailureObserver`.

## Invariants
- The facade imports no Bun module. It reads `Bun.SQL` from `globalThis` (`defaultSqlFactory`).
- Millisecond timeouts are converted to seconds (`Math.round(ms / 1000)`) before they are
  passed to `Bun.SQL` (`defaultSqlFactory`).
- Results are reshaped to `{ rows, rowCount }` with `rowCount = rows.length`. A non-array
  result becomes `rows: []` (`toPgResult`).
- A `rowMode: 'array'` query config runs through Bun's `.values()` (`runQuery`).
- The activity scope is an `AsyncLocalStorage<true>` stored on `globalThis` under
  `Symbol.for('knext.lib.db.activityScope')`. It applies per async context and is not a global flag.
- Observers live in a `globalThis` `Set` under `Symbol.for('knext.lib.db.acquireFailureObservers')`.
  An observer that throws is caught and never affects the pool (`reportAcquireFailure`).
- `isConnectionRefused` returns true only for code `ECONNREFUSED` or
  `ERR_POSTGRES_CONNECTION_REFUSED` (compared upper-cased) with no `severity` field, or for a
  non-empty `errors` array in which every entry is a refusal. Message text is never matched.
- `isScaleToZeroDatabase`: an explicit `KNEXT_DB_SCALE_TO_ZERO` (trimmed, case-insensitive,
  read on each call as the default of `declared`) decides first (`true`/`1`/`yes` or
  `false`/`0`/`no`); any other non-empty value falls through to the DSN, and warns once per process
  per distinct value (`console.warn`, value truncated to 64 characters). The once-set lives on
  `globalThis` under `Symbol.for('knext.lib.db.unrecognisedScaleToZeroWarned')`. Otherwise the DSN
  hostname decides: true if it has a `scale-zero-pg` label, or if it is exactly `pggw` or
  `pggw-apps`. It returns false for an unparseable or missing DSN.

## Side Effects
- `createBunSqlPool` builds a `Bun.SQL` client, which opens database connections as queries need
  them. `end()` calls `sql.close()`.
- `runWithoutDbActivity`, the first `isDbActivityUntracked` call and the first
  `observeAcquireFailures` call each install their state on `globalThis`.
- `observeAcquireFailures` adds to a process-wide observer set.

## Verification
- Run: `node scripts/bun-test.mjs packages/lib` (from repo root)
