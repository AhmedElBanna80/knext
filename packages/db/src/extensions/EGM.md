# extensions

## Overview

Migration-SQL string builders for the two Postgres extensions the platform
supports, TimescaleDB and pgvector. Drizzle does not model these, so each helper
returns the exact SQL statement an app adds to its own migration. No helper opens
a connection. Both modules are re-exported from the `@getknext/db/schema` subpath
(`../schema.ts`, `export * from './extensions/pgvector'` and
`export * from './extensions/timescaledb'`).

## Interface

`timescaledb.ts`:

- `TableRef` (type): `PgTable | string`. The table is a drizzle table, resolved
  with `getTableName`, or a bare name (`timescaledb.ts:tableName`).
- `CREATE_TIMESCALEDB_EXTENSION`: the constant
  `'CREATE EXTENSION IF NOT EXISTS timescaledb;'`.
- `createTimescaleExtension(): string`: returns that constant.
- `HypertableOptions`: `by` (required), `chunkInterval?`, `ifNotExists?`
  (default `true`), `migrateData?` (default `false`).
- `hypertable(table, options): string`: returns
  `SELECT create_hypertable('<table>', by_range('<by>'[, INTERVAL '<chunkInterval>'])[, migrate_data => TRUE][, if_not_exists => TRUE]);`.
- `DropChunksOptions`: `olderThan` (required).
- `dropChunks(table, options): string`: returns
  `SELECT drop_chunks('<table>', INTERVAL '<olderThan>');`.

`pgvector.ts`:

- `cosineDistance`, `innerProduct`, `l2Distance`: re-exported unchanged from
  `drizzle-orm`.
- `VectorOpClass` (type): `'vector_cosine_ops' | 'vector_l2_ops' | 'vector_ip_ops' | 'vector_l1_ops'`,
  plus any other string.
- `CREATE_VECTOR_EXTENSION`: the constant `'CREATE EXTENSION IF NOT EXISTS vector;'`.
- `createVectorExtension(): string`: returns that constant.
- `HnswIndexOptions`: `ops?` (default `vector_cosine_ops`), `m?`,
  `efConstruction?`, `ifNotExists?` (default `true`), `concurrently?` (default `false`).
- `hnsw(name, column: PgColumn, options): string`: returns
  `CREATE INDEX [CONCURRENTLY] [IF NOT EXISTS] "<name>" ON "<table>" USING hnsw ("<column>" <ops>)[ WITH (m = …, ef_construction = …)];`.
- `IvfflatIndexOptions`: `ops?` (default `vector_cosine_ops`), `lists?`,
  `ifNotExists?` (default `true`), `concurrently?` (default `false`).
- `ivfflat(name, column: PgColumn, options): string`: the same statement shape
  with `USING ivfflat` and `WITH (lists = …)`.

## Invariants

- Every developer-supplied name and interval goes through `../sql.ts`.
  TimescaleDB passes table, column and interval values to `quoteLiteral`, because
  `create_hypertable`, `by_range` and `drop_chunks` take TEXT arguments
  (`timescaledb.ts:hypertable`, `timescaledb.ts:dropChunks`), so they are emitted
  as `'…'` or, when they contain a backslash, `E'…'`. pgvector passes the index
  name, table and column to `quoteIdent`
  (`pgvector.ts:createIndexPrefix`, `pgvector.ts:hnsw`, `pgvector.ts:ivfflat`).
- Two pgvector values are not quoted. The `ops` operator class is inserted as is
  (`pgvector.ts:hnsw` comment: "ops is an opclass keyword"), so it must be a
  valid operator-class name. The numeric build parameters `m`,
  `efConstruction` and `lists` are interpolated with a template string
  (`pgvector.ts:withClause`).
- `hypertable` omits the `INTERVAL` argument when `chunkInterval` is falsy, so
  an empty string behaves like leaving it unset (`timescaledb.ts:hypertable`).
- `hypertable` only emits the `by_range(...)` dimension-builder form. There is no
  legacy `create_hypertable(regclass, name, ...)` path, so the minimum
  TimescaleDB version is 2.13 (`timescaledb.ts:hypertable` doc comment).
- Retention is a one-shot `drop_chunks()`. The module does not emit
  `add_retention_policy()`, compression or continuous aggregates, because those
  need background jobs that never run on a compute scaled to zero
  (`timescaledb.ts` module comment, `dropChunks` doc comment).
- `withClause` leaves out parameters that are `undefined`, and leaves out the
  whole `WITH (...)` clause when none are set (`pgvector.ts:withClause`).
  `CONCURRENTLY` comes before `IF NOT EXISTS` when both are set
  (`pgvector.ts:createIndexPrefix`).
- The pgvector index helpers take a drizzle column and read the table name with
  `getTableName(column.table)` and the column name with `column.name`
  (`pgvector.ts:ref`).

## Side Effects

- None. Every export is a pure string builder or a re-export. Nothing opens a
  connection or touches disk.
- Errors: `quoteIdent` and `quoteLiteral` throw on a NUL byte, and `quoteIdent`
  also throws on an empty name (`../sql.ts`). The helpers here pass those errors
  through.

## Verification

- Run: `node scripts/bun-test.mjs packages/db` (from the repo root). The unit
  tests for this directory are `../__tests__/extensions-pgvector.test.ts` and
  `../__tests__/extensions-timescaledb.test.ts`.
