# redis

## Overview
Selects and constructs the Redis client used for secondary, non-critical uses (deep health,
cache events). It prefers Bun's native `Bun.RedisClient` when one is present and falls back to
ioredis, which is resolved at runtime through a computed specifier. Every client is built with
quiet, bounded options and gets an error listener. `client.ts` and `quiet.ts` are re-exported
from the package root (`src/index.ts`). `ioredis-ctor.ts` is internal.

## Interface
- `client.ts:createRedisClient(url, tag, overrides?, ctorOverride?, scope?)`: returns a
  `KnextRedisClient`. It uses `Bun.RedisClient` with `toBunRedisOptions(quiet)` when
  `bunRedisAvailable(scope)` is true and no `ctorOverride` is given. Otherwise it uses
  `ctorOverride ?? loadRedisCtor()` with `quietRedisOptions(overrides)`.
- `client.ts:bunRedisAvailable(scope = globalThis)`: true iff `scope.Bun.RedisClient` is a function.
- `client.ts:toBunRedisOptions(quiet)`: maps `connectTimeout` to `connectionTimeout`. It always
  sets `maxRetries: 5` (`MAX_RECONNECT_ATTEMPTS`) and `autoReconnect: true`, and drops every other key.
- `client.ts:BunRedisScope`, `client.ts:RedisCommands` (`lrange`, `del`, `ping`),
  `client.ts:KnextRedisClient` (`QuietRedisClient & RedisCommands`).
- `quiet.ts:quietRedisOptions(overrides?)`: the defaults are `lazyConnect: true`,
  `maxRetriesPerRequest: 1` and `connectTimeout: 2000`. Its `retryStrategy` returns `null` after
  5 attempts and otherwise `min(times*200, 2000)` ms. `overrides` are spread last.
- `quiet.ts:attachQuietErrorListener(client, tag)`: attaches through `client.on('error')`
  when `on` is a function (ioredis), otherwise sets `client.onclose` when the client has an
  `onclose` property (Bun shape). A client with neither gets no listener.
- `quiet.ts:ensureDialable(client)`: calls `client.connect()` when `status` is `end` or `close`.
- `quiet.ts:QuietRedisClient`: a structural client type (`status?`, `on?`, `onclose?`, `connect()`).
- `ioredis-ctor.ts:loadRedisCtor()` (internal): returns the ioredis constructor through
  `createRequire(runtimeAnchor())` and the computed `IOREDIS_SPECIFIER` (`['io','redis'].join('')`),
  preferring the module's `default` export when it has one.
- `ioredis-ctor.ts:RedisCtor`: the constructor type.

## Invariants
- ioredis is never imported statically. The specifier is assembled at runtime
  (`ioredis-ctor.ts:IOREDIS_SPECIFIER`), and the only static ioredis import is `import type`.
- The `require` anchor is `runtimeAnchor()`, never `import.meta.url` (`ioredis-ctor.ts:loadRedisCtor`).
- The Bun branch avoids optional chaining on the path to `new` (`client.ts:createRedisClient`).
- Both branches call `attachQuietErrorListener` before returning (`client.ts:createRedisClient`).
- ioredis options are never forwarded verbatim to Bun. Only the mapped keys are set
  (`client.ts:toBunRedisOptions`).
- The error listener logs each error class (`code`, then `name`, then `Error`) once per client
  and removes tokens containing `://` or `@` from the message, truncated to 200 chars
  (`quiet.ts:attachQuietErrorListener`, `quiet.ts:sanitize`).
- `attachQuietErrorListener` and `ensureDialable` never throw (both use try/catch, fail-open).

## Side Effects
- `createRedisClient` constructs a client. Under `lazyConnect`, ioredis does not dial at construction.
- `attachQuietErrorListener` writes `console.error` lines of the form
  `[redis:<tag>] connection error (<class>): <message> — further <class> errors suppressed`.
- `ensureDialable` starts a reconnect (`client.connect()`) and swallows its rejection.
- `loadRedisCtor` loads the `ioredis` module through `require`.

## Verification
- Run: `node scripts/bun-test.mjs packages/lib` (from repo root)
