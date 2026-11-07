# utils

## Overview

Shared CLI and runtime helpers for `@getknext/core`, in two groups:

1. **Static-asset storage.** Staging, uploading, verifying, and garbage-collecting
   a build's `_next/static` assets in the configured object store (GCS, S3,
   MinIO, Azure) through each provider's CLI. Includes build-id retention for
   skew protection (ADR-0011): `asset-upload.ts`, `asset-gc.ts`,
   `reserved-static-dirs.ts`.
2. **Logging.** A lazily loaded Pino logger and its process-local output
   destination: `logger.ts`, `logger.public.ts`, `log-destination.ts`.

Consumers include `src/cli/{deploy,build,gc,preview,rollback,cleanup,doctor/...}`
and `src/adapters/node-server.ts` (logger).

## Interface

### `asset-upload.ts`

- `appKeyPrefix(config): string` - returns `<name>/`, the app-scoped key namespace
  for every uploaded object. It must stay in lock-step with the operator's
  `appStoragePrefix`.
- `type StorageBackedConfig = KnativeNextConfig & { storage: StorageConfig }`.
- `hasStorage(config): config is StorageBackedConfig` - type guard.
- `NO_STORAGE_DOCS_URL`, `NO_STORAGE_MODE_NOTICE` - the announced no-storage
  (image-served assets) mode message (ADR-0047).
- `getAssetPrefix(config): string` - `<publicUrl without trailing slash>/<name>`,
  used as Next.js `assetPrefix`.
- `stageStandaloneAssets(cwd?, buildId?): string` - copies `.next/static` to
  `<cwd>/.output/public/_next/static` and `public/` to `<cwd>/.output/public`,
  then returns that directory.
- `stageNitroPublicAssets(cwd?, buildId?): string` - copies `.output/public`
  (vinext shape) into a fresh `mkdtemp` dir (`knext-upload-*`) and returns it.
- `type VinextPrefixCheck`, `verifyVinextStaticPrefix(cwd, expectedId)` - checks
  that `.output/public/_next/static/<expectedId>/` exists. Failure reasons:
  `no-static-root`, `prefix-missing`. `siblings` is diagnostic only.
- `type ImageLockstepCheck`, `verifyBuiltImageLockstep({ taggedRef, expectedId, assetPrefix? })`
  - extracts `/app` from the pushed image. It then checks the static prefix and,
  when `assetPrefix` is set, that `/app/server` or any file under
  `/app/.output/server` contains it (UTF-8 or UTF-16LE). Reasons add
  `image-extract-failed` and `asset-prefix-not-embedded`.
- `type ChunkReferenceCheck`, `verifyAssetsCoverServerReferences(appDir)` -
  checks that every `chunks/<file>.{js,mjs,css}` the server artifact references
  exists in `.output/public/_next/static/chunks`. Reasons:
  `server-artifact-missing`, `no-chunk-references`, `chunk-missing`.
- `uploadAssetsFromImage(config, buildId, imageRef, { verify?, upload? }): Promise<void>`
  - extracts `/app` from the image, runs the chunk-coverage guard unless
  `verify: false`, then uploads from the extracted tree.
- `uploadAssets(config, buildId?, { cwd? }): Promise<void>` - picks the staging
  shape (vinext when `config.build ?? DEFAULT_BUILDER_ID` is `"vinext"`), runs a
  provider bulk upload, then verify-and-retry.
- `BUILD_MARKER_FILENAME = ".knext-build"` - the per-build marker object.
- `reclaimBuildPrefix(config, buildId): void` - failure-path delete of exactly
  this run's `<app>/_next/static/<buildId>/`.
- `interface PruneSummary { reaped, keptUnmarked, keptWindow, keptLive, reservedExcluded, dryRun }`.
- `pruneOldBuilds(config, liveBuildIds, newBuildId, { dryRun? }): PruneSummary` -
  deploy-time retention GC. `knext gc --dry-run` uses the same code path.

### `asset-gc.ts` (pure)

- `DEFAULT_RETAIN = 3`.
- `interface SelectBuildsInput { remoteBuildIds, timestamps, liveBuildIds, retain }`.
- `interface BuildClassification { reap, keptWindow, keptLive }`.
- `classifyBuilds(input): BuildClassification` - the single selection authority.
- `selectBuildsToDelete(input): string[]` - a thin wrapper that returns
  `classifyBuilds(input).reap`.
- `parseLiveRevisionNames(currentTrafficJson): string[]` - reads `revisionName`
  values from `NextApp.status.currentTraffic` JSON.
- `type RevisionBuildIdResolver = (revisionName) => string`.
- `type ResolveLiveResult = { ok: true; buildIds } | { ok: false }`.
- `resolveLiveBuildIds(revisionNames, resolve): ResolveLiveResult`.

### `reserved-static-dirs.ts`

- `RESERVED_STATIC_DIRS: ReadonlySet<string>` - `chunks`, `css`, `media`,
  `webpack`, `development`, `_vinext_fonts`. It has its own tsup entry
  (`dist/utils/reserved-static-dirs.js`), so plain-`node` scripts can import it.

### Logging

- `logger.ts`: `logger: Logger` (lazy Proxy over the root Pino logger),
  `createLogger(bindings): Logger` (lazy child), `__resetLoggerForTests()`
  (test-only seam).
- `logger.public.ts`: the published `@getknext/core/internal/logger` entry
  (built to `dist/utils/logger.js`). It re-exports only `createLogger` and
  `logger`, by name.
- `log-destination.ts`: `type LogDestination = "stdout" | "stderr"`,
  `setLogDestination(d)`, `getLogDestination()`.

## Invariants

- **Over-keep, never over-delete (ADR-0011).** Only prefixes that carry
  `<id>/.knext-build` as a direct child are prune candidates
  (`listRemoteBuildIds`, `pruneOldBuilds`). Unmarked prefixes are kept and
  named in `keptUnmarked`. Reserved directories are never candidates, marker or
  not.
- **GC scope.** Deletes go only to `<app>/_next/static/<id>/`.
  `deleteBuildPrefix` refuses any URI that does not contain
  `_next/static/<buildId>/`. The bare `<app>/` prefix is teardown-only (operator
  finalizer, ADR-0008) and is never a prune target.
- **Keep rules** (`classifyBuilds`): `retain` is clamped to at least 1, and the
  newest `retain` ids are kept. Any id exactly equal to a live build id is also
  kept (exact equality, never substring). Empty and duplicate ids are dropped.
  `reap` is ordered oldest-first. The only/last build is always kept.
- **Fail-safe live resolution.** `resolveLiveBuildIds` returns `{ ok: false }`
  if any revision fails to resolve or resolves to an empty id, so the caller
  skips GC. `parseLiveRevisionNames` returns `[]` on malformed input.
- **Marker key equals deploy id.** No `buildId` means no marker, plus a warning
  (the `knext build` path). With a `buildId`, staging refuses a reserved name.
  `stageStandaloneAssets` also requires `.next/BUILD_ID === buildId`;
  `stageNitroPublicAssets` requires `_next/static/<buildId>/` to exist. Every
  refusal happens before anything is copied or created.
- `stageNitroPublicAssets` treats `.output/public` as read-only, because the
  concurrent docker build copies it. `uploadAssets` removes the temp staging dir
  in `finally`, and only for the vinext shape. The standalone `.output/public` is
  never removed.
- Provider commands are passed as discrete argv tokens through
  `runQuiet` / `runCapture` / `runQuietAllowFail` (`src/cli/exec`), never as a
  shell string.
- `pruneOldBuilds` never throws on a listing failure: it logs, skips GC, and
  returns an empty summary. Deletes are best-effort, so `reaped` lists attempted
  deletes, not confirmed ones.
- `reclaimBuildPrefix` must not call `pruneOldBuilds` or the retention GC. It
  relies on this run's build id being unique. An empty `buildId` is a no-op.
- Logger: Pino is loaded only on the first emit (lazy `createRequire`), so
  importing the module or calling `createLogger` initialises nothing. A change in
  `getLogDestination()` rebuilds the root logger on the next emit. The level is
  `LOG_LEVEL`, else `info` in production and `debug` otherwise. Production writes
  JSON; non-production uses the `pino-pretty` transport.
- `logger.public.ts` must never `export *`. Test seams (`__*`) must not reach a
  published entry (`scripts/scan-published-seams.mjs`).
- The log destination is module state, not an environment variable, so child
  processes do not inherit it.

## Side Effects

- **Filesystem:**
  - Staging uses `rmSync`, `mkdirSync`, and `cpSync`, and writes the marker
    files.
  - `mkdtemp` directories `knext-upload-*`, `knext-image-lockstep-*`, and
    `knext-image-assets-*` are created under the OS temp dir and removed in
    `finally`.
  - Image and server artifacts are read for literal and chunk scans.
- **Subprocesses (object store):**
  - `gsutil` (`cp`, `ls -r`, `rm -r`, and `iam ch allUsers:objectViewer`, which
    makes the bucket publicly readable).
  - `aws s3` / `s3api` (`sync`, `cp`, `rm`, `list-objects-v2`).
  - `mc` (`cp`, `ls`, `rm --force`).
  - `az storage blob` (`upload-batch --overwrite`, `upload`, `list`,
    `delete-batch`).
  - Uploads set `Cache-Control: public, max-age=31536000, immutable` (gsutil,
    aws).
- **Subprocesses (docker):** `docker create --platform linux/amd64`,
  `docker cp <id>:/app`, `docker rm -f`.
- **Failure:** throws (fails the deploy) when an asset is still missing after
  retry, when staging is refused, or when the image/asset guard reports a
  mismatch.
- **Logging:** Pino output to stdout (default) or stderr (fd 2).
- `logger.ts` reads `NODE_ENV` and `LOG_LEVEL`, and reads `process.stderr.isTTY`
  when building the pretty transport.

## Verification

- Run (from `packages/kn-next`): `node ../../scripts/bun-test.mjs packages/kn-next`
