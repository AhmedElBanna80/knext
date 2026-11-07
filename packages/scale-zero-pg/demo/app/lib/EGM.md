# demo/app/lib

## Overview

The demo app's Postgres pool. Its own comment says it mirrors `getDbPool()` from `@getknext/lib` so the demo behaves like a real knext app without vendoring the workspace (`db.js` header).

## Interface

- `getDbPool()` (`db.js`, CommonJS export): a lazily built singleton `pg.Pool`.

## Invariants

- The pool is built from `process.env.DATABASE_URL` with these settings (`db.js:getDbPool`):
  - `max` = `DB_POOL_MAX` (default 5);
  - `idleTimeoutMillis` = `DB_POOL_IDLE_TIMEOUT_MS` (default 10000);
  - `connectionTimeoutMillis` = 15000.
- Non-numeric or non-positive env values fall back to the defaults (`db.js:toFinitePositiveInt`).
- The 10 s idle timeout is deliberately below the gateway's `GW_IDLE_MS`, so pooled idle connections never keep the database awake (`db.js` header).

## Side Effects

- Opens Postgres connections to `DATABASE_URL` on first query.

## Verification

- No automated test covers this directory. The live demo drill `demo/_verify.sh` exercises it.
