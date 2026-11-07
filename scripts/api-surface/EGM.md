# api-surface

## Overview
This directory generates and checks the public API type-surface reports for the publishable `@getknext/*` packages. It uses the TypeScript compiler API to write the exported type text of every public subpath to `api-surface/<reportName>.d.ts.report` at the repo root (`core.d.ts.report`, `lib.d.ts.report`, `db.d.ts.report`). A CI check fails when a committed report no longer matches the source.

## Interface
- `lib.mjs`:
  - `REPO_ROOT`
  - `PACKAGES`: `@getknext/core` → `packages/kn-next`, `@getknext/lib` → `packages/lib`, `@getknext/db` → `packages/db`
  - `publicEntries(pkgDir)`
  - `generatePackageReport(pkg)`
  - `assertNoAbsolutePaths(text, label)`
  - `reportPath(pkg)`
  - `extractSurfaceForFiles(rootNames, entryAbsPath, compilerOptions)`
- `generate.mjs`: CLI `node scripts/api-surface/generate.mjs`. It writes every package's report.
- `check.mjs`: CLI `node scripts/api-surface/check.mjs`. Exit 0 means every report matches the source. Exit 1 means a report is missing or stale, and the script prints a line diff of at most 60 lines.

## Invariants
- `publicEntries` derives the entries from each package's `knext.publicApi.public` subpaths and its `exports` map. It throws when `knext.publicApi.public` is missing or empty. A subpath with no `types` field is reported as `typed: false` with no surface.
- The surface comes from `checker.getExportsOfModule`, so `export *` and `export { X } from` re-exports are tracked where they are declared (header of `lib.mjs`).
- `generatePackageReport` calls `assertNoAbsolutePaths`, which throws on `/Users/`, `/home/`, a Windows drive path, or `REPO_ROOT` in the report.
- Sections are sorted by subpath (`localeCompare`), so the output is deterministic.

## Side Effects
- `generate.mjs`: `mkdirSync` of `<repo>/api-surface` and `writeFileSync` of each report.
- `check.mjs` and `lib.mjs`: read-only disk access, with no network.

## Verification
- Run: `node scripts/bun-test.mjs tests/api-surface-guard.test.ts tests/api-surface-no-absolute-paths.test.ts tests/api-surface-transitive-resolution.test.ts` (from the repo root)
