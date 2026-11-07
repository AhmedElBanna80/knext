# src

## Overview

Source for the three published entry points of `@getknext/db`. Each one is built
from its own file (`../tsup.config.ts` `entry`: `index`, `schema`, `migrate`):

- `index.ts` (`.`): drizzle-orm clients over the `@getknext/lib` pools;
- `schema.ts` (`./schema`): the schema builders plus the extension helpers;
- `migrate.ts` (`./migrate`): `drizzle.config.ts` generation and the one-shot
  migration runner behind `knext db migrate`.

`sql.ts` holds internal quoting helpers. The extension emitters import it; the
subpath entries do not re-export it.

## Interface

`index.ts` (`@getknext/db`):

- `export * from 'drizzle-orm'`: the whole drizzle-orm root surface.
- `getDb(schema?)`: returns the writer `NodePgDatabase`, built once with
  `drizzle(getDbPool(), { schema })`. `getDbPool` comes from `@getknext/lib/clients`.
- `getDbRO(schema?)`: returns the reader `NodePgDatabase` over `getDbPoolRO()`.
  When `getDbPoolRO()` returns nothing it logs one warning with `logger.warn`
  (`@getknext/lib/logger`) and returns `getDb(schema)` instead. The fallback does
  not cache a reader, so each later call checks `getDbPoolRO()` again.
- `resetDbClients()`: clears the cached `writer` and `reader` clients and the
  `warnedNoReadReplica` flag.

`schema.ts` (`@getknext/db/schema`):

- `relations`, `sql`: re-exported from `drizzle-orm`.
- `export * from 'drizzle-orm/pg-core'`: tables, column types, indexes and
  constraint builders.
- `export * from './extensions/pgvector'` and
  `export * from './extensions/timescaledb'`. See
  [extensions](./extensions/EGM.md).

`migrate.ts` (`@getknext/db/migrate`):

- `DEFAULT_SCHEMA_PATH = './src/db/schema.ts'`, `DEFAULT_MIGRATIONS_DIR = './drizzle'`.
- `defineDrizzleConfig(options?, deps?)`: returns a drizzle-kit `Config`:
  `{ dialect: 'postgresql', schema, out, strict: true, verbose: true, dbCredentials: { url } }`.
  `url` defaults to `process.env.DATABASE_URL`, and to `''` when that is unset.
  Related types: `DefineDrizzleConfigOptions` (`schema?: string | string[]`,
  default `DEFAULT_SCHEMA_PATH`; `out?`, default `DEFAULT_MIGRATIONS_DIR`;
  `url?`) and `DefineDrizzleConfigDeps` (`resolveDrizzleKit(): string`, which
  defaults to `migrate.ts:defaultResolveDrizzleKit`).
- `RO_GATEWAY_PORT = '55434'`.
- `resolveWriterDsn(opts?)`: returns `opts.url ?? DATABASE_URL` after the
  writer-only guards listed under Invariants.
- `defaultMigrateDeps()`: the production `RunMigrationsDeps`. `connect` opens a
  `pg` `Pool` (`max: 1`, `connectionTimeoutMillis: 15_000`) and wraps it with
  drizzle. `migrate` calls drizzle-orm's node-postgres `migrate`.
- `runMigrations(opts?, deps?)`: resolves the DSN, connects, applies the
  migrations and always closes the connection. `migrationsFolder` defaults to
  `DEFAULT_MIGRATIONS_DIR`. It resolves to `{ migrationsFolder }`. Related types:
  `RunMigrationsOptions` (`url?`, `migrationsFolder?`, `roUrl?`),
  `RunMigrationsResult` (`migrationsFolder`), `RunMigrationsDeps`
  (`connect(url)`, `migrate(db, migrationsFolder)`) and `MigrationConnection`
  (`db: unknown`, `close(): Promise<void>`).

`sql.ts` (internal):

- `quoteIdent(name)`: wraps the name in `"…"` and doubles each embedded `"`.
- `quoteLiteral(value)`: wraps the value in `'…'` and doubles each embedded `'`.
  If the value contains a backslash, it returns an `E'…'` string with every
  backslash doubled.

## Invariants

- There is one drizzle client per module instance for each pool (the
  module-level `writer` and `reader` in `index.ts`). Only the first call's
  `schema` argument is used. Later calls return the cached client whatever
  schema they pass (`index.ts:getDb`, `index.ts:getDbRO`).
- Reads are never routed automatically. Callers pick `getDb()` (read-your-writes)
  or `getDbRO()` (bounded staleness) for each query (`index.ts:getDbRO` doc comment).
- `resetDbClients()` does not close the pools. Pool lifecycle stays with
  `@getknext/lib` (`closeDbPool` and `closeDbPoolRO`; see the
  `index.ts:resetDbClients` doc comment).
- Migrations only run against the writer. `resolveWriterDsn` throws when there
  is no DSN or it is blank, when the DSN equals `DATABASE_URL_RO` (or
  `opts.roUrl`), and when the DSN targets port `55434`. The port check first
  compares `new URL(dsn).port` with `RO_GATEWAY_PORT`; when that does not match
  or the DSN does not parse, it tests the regex `:55434(?:[/?]|$)`
  (`migrate.ts:dsnTargetsRoPort`). The regex needs a `:` before the port, so a
  libpq key=value DSN written as `port=55434` is not caught.
  `runMigrations` runs these checks before it opens a connection.
- `runMigrations` closes the connection in a `finally` block, so a failed
  migration still releases it, and the error is re-thrown to the caller
  (`migrate.ts:runMigrations`).
- `drizzle-kit` is an optional peer (`../package.json` `peerDependenciesMeta`).
  `migrate.ts` imports it only as a type (`import type { Config }`).
  `defineDrizzleConfig` checks that it resolves and otherwise throws a named
  error that tells the user to install it (`migrate.ts:assertDrizzleKitPresent`).
  `getDb*` and `runMigrations` do not need drizzle-kit.
- `quoteIdent` throws on an empty string or a NUL byte. `quoteLiteral` throws on
  a NUL byte (`sql.ts`).
- Note: the comment on `migrate.ts:defaultResolveDrizzleKit` says the compiled
  output is CommonJS, so the module-global `require` exists. But
  `../tsup.config.ts` sets `format: ['esm']` and `../package.json` sets
  `"type": "module"`. The comment does not match the current build config.

## Side Effects

- `getDb` and `getDbRO` read the `@getknext/lib` pool singletons (`getDbPool`,
  `getDbPoolRO`). They do not connect themselves.
- `getDbRO` writes a warning with `logger.warn` once per reset cycle when there
  is no RO pool.
- `defineDrizzleConfig` reads `process.env.DATABASE_URL` and runs a
  `require.resolve('drizzle-kit')` lookup.
- `resolveWriterDsn` reads `process.env.DATABASE_URL` and
  `process.env.DATABASE_URL_RO`.
- `runMigrations` (with `defaultMigrateDeps`) opens a Postgres connection, which
  can wake a writer that has scaled to zero. It applies the SQL migrations from
  `migrationsFolder`. Drizzle records the applied migrations in
  `__drizzle_migrations` (`runMigrations` doc comment). Finally it calls `pool.end()`.
- `sql.ts`, `schema.ts` and `extensions/` have no side effects.

## Verification

- Run: `node scripts/bun-test.mjs packages/db` (from the repo root).
