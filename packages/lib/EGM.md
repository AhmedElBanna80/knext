# @getknext/lib

## Overview
The shared runtime library for knext apps. `package.json` `description` reads "Shared runtime
library for knext (logging, clients, health)". In practice it holds Postgres, Redis, Cerbos and
MinIO clients tuned for scale-to-zero, request correlation, structured logging and health
checks. It is published as ESM (`"type": "module"`) under Apache-2.0. The source lives
in `src/`. This directory holds the manifest and the build config (`tsup.config.ts`).

## Interface
- Public subpaths (`package.json` `exports` and `knext.publicApi.public`): `.`, `./logger`,
  `./clients`, `./context`, `./health`. Each maps to `dist/<entry>.js` and has a `.d.ts`.
- `tsup.config.ts:default`: the `defineConfig` build config. Its entries are `index`, `clients`,
  `logger/index`, `context/index` and `health/index`. It sets `format: ['esm']`, `dts: true`,
  `target: 'node20'` and `outDir: 'dist'`.
- Runtime dependencies: `@cerbos/grpc`, `ioredis`, `minio`, `pg`, `pino`. `pino-pretty` is a
  devDependency only; the logger probes for it at runtime (see [logger](./src/logger/EGM.md)).
- Scripts: `build` (`tsup`), `dev` (`tsc -w`), `typecheck` (`tsc -p tsconfig.typecheck.json`
  through the repo's `typescript-tsc7` install).
- Subdirectories:
  - [src](./src/EGM.md): the source behind every export (clients, context, health, logger, redis, db).

## Invariants
- `./lazy-sdk-loaders.mjs` is `external`, so esbuild never processes it. `onSuccess` copies
  `src/lazy-sdk-loaders.mjs` unchanged to `dist/lazy-sdk-loaders.mjs` (`tsup.config.ts`).
- Runtime `dependencies` stay external to the bundle (tsup default; the `tsup.config.ts` docblock).
- Only `dist` is published (`package.json` `files`). Publishing uses `access: public` and
  `provenance: true`.
- `knext.publicApi.stability`: every subpath is public and follows semver.

## Side Effects
- `tsup` (the `build` script) deletes and rewrites `dist/` (`clean: true`) and copies the lazy
  loader file into it.

## Verification
- Run: `node scripts/bun-test.mjs packages/lib` (from repo root)
