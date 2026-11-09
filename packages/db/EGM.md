# @getknext/db

## Overview

`@getknext/db` is the knext data SDK. It is a thin drizzle-orm wrapper over the
scale-to-zero Postgres pools that `@getknext/lib` owns (`src/index.ts` module
comment). It is one of the three publishable `@getknext/*` packages, published
with `access: public` and `provenance: true` (`package.json` `publishConfig`).

## Interface

- Public subpaths, all under semver (`package.json` `exports` and
  `knext.publicApi.public`):
  - `.` → `dist/index.js`: `getDb`, `getDbRO`, `resetDbClients` and the
    re-exported `drizzle-orm` root.
  - `./schema` → `dist/schema.js`: drizzle `pg-core` builders, `relations`,
    `sql`, and the TimescaleDB and pgvector helpers.
  - `./migrate` → `dist/migrate.js`: `defineDrizzleConfig`, `resolveWriterDsn`,
    `runMigrations`, `defaultMigrateDeps`, `DEFAULT_SCHEMA_PATH`,
    `DEFAULT_MIGRATIONS_DIR`, `RO_GATEWAY_PORT`.
- The public API document is `docs/PUBLIC_API.md` (`package.json` `knext.publicApi.doc`).
- `tsup.config.ts`: builds the three entries `index`, `schema` and `migrate` from
  `src/` as ESM with `.d.ts` output into `dist`, targeting `node20`.
  Dependencies stay external (module comment).
- Subdirectories:
  - [src](./src/EGM.md): the entry-point sources and the internal SQL quoting
    helpers.
  - [src/extensions](./src/extensions/EGM.md): the TimescaleDB and pgvector
    migration-SQL builders.

## Invariants

- The package publishes ESM only. `package.json` sets `"type": "module"`,
  `tsup.config.ts` sets `format: ['esm']`, and every `exports` condition points
  at `dist/*.js`.
- Only `dist` is published (`package.json` `files`).
- Runtime dependencies are `@getknext/lib` (`workspace:^`), `drizzle-orm` and
  `pg`. `drizzle-kit` is an optional peer (`peerDependenciesMeta.drizzle-kit.optional: true`).
  Only `defineDrizzleConfig` needs it (`src/migrate.ts:assertDrizzleKitPresent`).
- Every public subpath in `knext.publicApi.public` must have a heading in
  `docs/PUBLIC_API.md`. `apps/docs/stability-doc.test.ts` enforces this per
  subpath, so a removed section turns the guard red.
- The SDK never closes the `@getknext/lib` pools. The migration runner opens its
  own single-connection pool and only targets the writer
  (`src/migrate.ts:defaultMigrateDeps`, `src/migrate.ts:resolveWriterDsn`).

## Side Effects

- Building writes to `dist/` (`tsup.config.ts` `outDir: 'dist'`, `clean: true`).
- At runtime, the package uses the `DATABASE_URL` and `DATABASE_URL_RO` pools
  through `@getknext/lib`. The migration runner opens a Postgres connection and
  applies the migrations. See [src](./src/EGM.md) for the details.

## Verification

- Run: `node scripts/bun-test.mjs packages/db` (from the repo root).
