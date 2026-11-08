# cli

## Overview

The `knext` CLI of record. It is published as the `knext` bin (the only entry
in `package.json` `bin`), and tsup bundles it into `dist/cli/kn-next.js` from
`deploy.ts`. The CLI builds the app, pushes the image, renders a `NextApp`
custom resource (CR), and hands that CR to the operator. The Go operator
reconciles everything else on the cluster. Every CLI cluster write that
carries app state targets a knext CR, either `NextApp` or `BackendService`. The
CLI never writes raw Knative objects.

`deploy.ts` is the bin entry. It routes the first argument to a per-verb
`*Main` module, and a bare `knext` (or a first argument starting with `-`)
runs `deploy()`.

Two tools are not verbs of the bin: `preview.ts` and `loadtest.ts` are separate
tsup entries (`dist/cli/preview.js`, `dist/cli/loadtest.js`) that run only when
invoked directly (`exec.ts:isEntrypoint`). `knext preview` and `knext loadtest`
are unknown-command errors.

## Interface

### Verb surface and dispatch

- `COMMAND_GROUPS`, `CLI_HELP`, `DOCS_URL` (`help.ts`): the single command table, which also renders `--help`. The public verbs are `create`, `init-ci`, `validate`, `doctor`, `deploy`, `build`, `status`, `rollback`, `cleanup`, `gc`, `db bind`, `db migrate`, `add`, `generate`, `deploy function`, `ffi`, `ci-preflight` and `vinext-patches`.
- `INTERNAL_ONLY_VERBS` (`help.ts`): `preview` and `loadtest`, the two standalone entries that `COMMAND_GROUPS` deliberately leaves out. Because the bin's verb allowlist is derived from `COMMAND_GROUPS`, the bin does not dispatch them.
- `KNOWN_VERBS`, `resolveInvocation`, `suggestVerb`, `formatUnknownCommand`, `formatStrayPositional`, `Invocation` (`dispatch.ts`): classify the first argument as `deploy`, a known verb or unknown. `KNOWN_VERBS` is built from `COMMAND_GROUPS`.
- `CLI_CONTRACT`, `VerbContract`, `VerbExitCode` (`contract.ts`): the declarative table of verbs, flags and exit codes that the tests check against the real parsers.

### Verbs

| Verb | Module | Entry symbols |
| --- | --- | --- |
| `deploy` | `deploy.ts`, `deploy-reconcile-wait.ts` | `deploy`, `waitForOperatorReconcile`, `RECONCILE_WAIT_MS_DEFAULT` |
| `build` | `build.ts` | `build`, `buildMain`, `ACCEPTED_BUILD_FLAGS` (`--skip-next`, `--skip-smoke`, `--self-contained`, `--verbose`) |
| `create` | `create.ts`, `create-options.ts` | `createMain`, `writeScaffold`, `parseChoiceFlags` (`--runtime`, `--builder`, `--cache`, `--storage`, `--react-compiler`/`--no-react-compiler`), plus `--force` and `--dry-run`; prompt helpers `DEFAULT_CREATE_CHOICES`, `shouldPrompt`, `promptCreateChoices`, `terminalPromptIO`, `applyCreateChoices`, `choicesToFlags`, `templateBuilderFor` |
| `validate` | `validate-cmd.ts`, `validate.ts` | `validateMain`, `validateConfig`, `ConfigValidationError`, `checkPairing` |
| `doctor` | `doctor.ts` and [`./doctor/`](./doctor/EGM.md) | `runDoctor`, `doctorMain` |
| `status` | `status.ts` | `statusMain`, `runStatus` (`--json`, `--watch`), `parseStatusArgs`, `extractStatus`, `renderStatusHuman`, `statusModelToJson` |
| `rollback` | `rollback.ts` | `rollbackMain`, `runRollback` (`--to`, `--canary`) |
| `cleanup` | `cleanup.ts` | `cleanupMain`, `runCleanup` |
| `gc` | `gc.ts` | `gcMain`, `runAssetGC` (`--build-id`, `--dry-run`), `parseGcArgs`, `renderGcReport` |
| `db bind` / `db migrate` | `db-bind.ts`, `db-migrate.ts` | `dbMain`, `runDbBind`, `runDbMigrate`, `parseDbBindArgs`, `validateDbBindOptions`, `buildDbBindPatch`, `analyzeDsn`, `extractDsnFromSecretManifest` |
| `generate`, `add`, `deploy function` | `grpc-dispatch.ts` | `generateMain`, `addMain`, `deployFunctionMain`, `buildDeployHost`, `dispatchGrpcVerb`, `readValidatedBackendService`, `satisfiesRange` |
| `ffi` | `ffi-dispatch.ts`, `ffi-preflight.ts` | `ffiMain`, `dispatchFfiVerb`, `assertFfiTargetSupported`, `runFfiBuildStep`, `assertFfiLibraryStaged`, `FFI_TARGET_TRIPLES` |
| `vinext-patches` | `vinext-patches.ts` | `vinextPatchesMain`, `ensureVinextPatches` (`--check`), `applyVinextPatches`, `VINEXT_PATCHES_ENV`, and the errors `VinextPatchConflictError`, `VinextVersionMismatchError`, `VinextPatchWriteError`, `VinextPatchRollbackError` |

### Standalone entries (not bin verbs)

| Entry | Module | Entry symbols |
| --- | --- | --- |
| `dist/cli/preview.js deploy\|destroy` | `preview.ts` | `runPreviewDeploy`, `runPreviewDestroy`, `derivePreviewName`, `validatePreviewName`, `parsePreviewArgs`, `defaultBuildAndPush` |
| `dist/cli/loadtest.js` | `loadtest.ts` | `runLoadTestCli`, `runLoadTest` |
| `init-ci`, `ci-preflight` | [`./ci/`](./ci/EGM.md) | `initCiMain`, `ciPreflightMain` |

### CR rendering

- `buildNextAppCRObject`, `renderNextAppCR`, `validateTaggedRef`, `validateCRImageRef`, `resolveDigest`, `resolveDigestFromMetadataFile`, `dryRunDeploy`, `DEPLOYMENT_ID_ENV` (`cr-builder.ts`).
- `NEXTAPP_API_VERSION` (`crd-api-version.ts`): `apps.kn-next.dev/v1alpha1`.
- Schema preflight: [`./schema/`](./schema/EGM.md).

### Build pipeline

- `runProjectBuild`, `preflightEsmPackage` (`project-build.ts`): the single seam that runs the app build.
- `resolveBuildArtifact`, `compileArtifactForDeploy`, `assertCompiledArtifactFresh`, `hashBuildIdentity` (`build-artifact.ts`).
- `buildVinextExecutable`, `bunMeetsFloor`, `stageSharpNative`, `stageSharpForStandalone`, `fetchImgPackage` (`vinext-build.ts`).
- `assertNodePresetOutput` (`vinext-node-build.ts`).
- `buildStandaloneExecutable` (`standalone-exec-build.ts`).
- `resolveStandaloneLayout` (`standalone-layout.ts`).
- `resolveTracingRoot`, `requireBuildContext` (`tracing-root.ts`).
- `selectRuntimeImage`, `dockerBuildxArgs`, `stageStandaloneBuildContext`, `stageVinextNodeDockerfile` (`runtime-image.ts`), plus its Dockerfile helpers `runtimeStandaloneTemplateDir`, `STANDALONE_DOCKERFILE_NAME`, `VINEXT_NODE_DOCKERFILE_NAME`, `isKnownGoodTemplateDockerfile`, `standaloneDockerignore`, `dockerignoreExcludes`, `nestStandaloneDockerfile`, `FFI_NATIVE_COPY` and `insertFfiNativeCopy`.
- `runPostCompileSmoke`, `PostCompileSmokeError`, `STARTUP_LINE` (`postcompile-smoke.ts`).
- `ensurePatchedBun`, `resolveCompileBun`, `PATCHED_BUN` (`bun-toolchain.ts`).
- `validateCompileConfig` (`compile-config.ts`).
- `writeNativeIntegrityManifest` (`native-integrity.ts`).
- `exportBuildIdEnv`, `checkStandaloneBuildId`, `buildIdMismatchError`, `KNEXT_BUILD_ID_ENV`, `NEXT_DEPLOYMENT_ID_ENV`, `NEXT_CONSTANT_BUILD_ID` (`build-id-env.ts`).
- `DEPLOY_SHIP_ARCH`, `resolveSelfContained` (`build-target.ts`).
- `readImageCacheRouted` (`write-free.ts`).

### Guards

- `assertNoPlaceholders` (`placeholder-preflight.ts`).
- `assertNotStaticExport`, `assertVinextNotStaticExport`, `assertDefaultDistDir`, plus the helpers `classifyStaticExport` and `configuredDistDir` (`static-export-guard.ts`).
- `assertNoBunTurbopackFragments` (`turbopack-fragments-guard.ts`).
- `assertVisibilityDowngradeIsExplicit` (`visibility-guard.ts`).
- `keyPrefixProblem`, `KEY_PREFIX_PATTERN`, `KEY_PREFIX_MAX_LENGTH` (`redis-key-prefix.ts`).
- `checkNodeFloor` (`node-floor.ts` and `node-floor-guard.cjs`).
- `warnOnVulnerableNext` (`next-advisory-warning.ts`).
- `checkPinsPublished` (`scaffold-registry.ts`).

### Shared utilities

- `loadConfig`, `CONFIG_FILE` (`knext.config.ts`), `LEGACY_CONFIG_FILE` (the pre-rename config filename), `UsageError`, `ConfigNotFoundError`, `LegacyConfigFileError`, `withKubeContext`, `resolveKubeContext` (`shared.ts`). It also exports the error codes `USAGE_ERROR_CODE`, `CONFIG_NOT_FOUND_CODE` and `LEGACY_CONFIG_FILE_CODE`, and the handlers `handleUsageError`, `handleConfigNotFound`, `formatConfigNotFound` and `formatLegacyConfigFile`.
- The message builders `invalidSpecMessage`, `heldChangeMessage`, `noReconcileMessage` and `operatorPodCheckCommand` (`deploy-reconcile-wait.ts`).
- Published subpaths: `./internal/cli-validate` (`validate.ts`) and `./internal/cli-shared` (`shared.ts`).
- `runCapture`, `runInherit`, `runQuiet`, `runQuietAllowFail`, `isEntrypoint` (`exec.ts`).
- `coreVersion`, `readCoreVersion` (`core-version.ts`).

### Subdirectories

- [`./ci/EGM.md`](./ci/EGM.md): CI workflow generation and the deploy-credential preflight.
- [`./doctor/EGM.md`](./doctor/EGM.md): the doctor engine and its [checks](./doctor/checks/EGM.md).
- [`./schema/EGM.md`](./schema/EGM.md): the CRD field-skew preflight and the generated emitted-field list.

## Invariants

- An unrecognised first argument is an error (exit 1) and never a silent deploy. The verb allowlist comes from the same `COMMAND_GROUPS` that renders help [`dispatch.ts:resolveInvocation`, `KNOWN_VERBS`].
- Every app-state cluster write targets a knext CR:
  - `kubectl apply` of the NextApp in `deploy.ts` and `preview.ts`.
  - `kubectl patch nextapp` in `rollback.ts` and `db-bind.ts`.
  - `kubectl delete nextapp` in `cleanup.ts` and `preview.ts`.
  - `kubectl apply` of the BackendService in `grpc-dispatch.ts:buildDeployHost`.
  - The one non-CR exception is `loadtest.ts`, which applies a manifest pair: a `ConfigMap` holding the k6 script and a `batch/v1` `Job` that runs it (`../generators/loadtest-job.ts`).
- Every `kubectl apply` the CLI issues passes `--validate=strict` [`deploy.ts`, `preview.ts`, `loadtest.ts`, `grpc-dispatch.ts`].
- `deploy` runs `assertNoPlaceholders` and the server-side schema preflight (`runPrunePreflight` → `preflightCRSchema`) before the real apply. After the apply it waits for operator reconcile and throws on a held or invalid spec [`deploy.ts`, `deploy-reconcile-wait.ts`].
- The CR image must be digest-pinned (`@sha256:`), and a tag-only ref is rejected. Image refs must match `[A-Za-z0-9._:/@-]` before they reach docker [`cr-builder.ts:validateCRImageRef`, `validateTaggedRef`].
- Every rendered CR has `apiVersion: apps.kn-next.dev/v1alpha1` and `kind: NextApp`. Nothing negotiates this version against the cluster [`crd-api-version.ts`].
- Turning a live cluster-local NextApp public needs an explicit opt-in. Read errors fail closed, and NotFound is allowed [`visibility-guard.ts:assertVisibilityDowngradeIsExplicit`].
- All process spawns use argv arrays with `shell: false`. A `--context` flag beats `KN_CONTEXT` and is inserted right after `kubectl` [`exec.ts`, `shared.ts:withKubeContext`].
- The CLI never reads the legacy config file (`LEGACY_CONFIG_FILE`); it only reports an error asking for a rename [`shared.ts:loadConfig`].
- Config validation collects every error into one `ConfigValidationError` with the code `ERR_KN_CONFIG_INVALID`. `runtime` must be `bun` or `node`, and only the `redis` cache provider is implemented [`validate.ts:validateConfig`].
- Version floors: Node must be at least 24, and the CLI exits 1 at startup otherwise. Bun must be at least 1.4 for compiled executables [`node-floor-guard.cjs`, `vinext-build.ts:bunMeetsFloor`].
- The deploy image architecture is always `linux-x64`. Self-contained mode is opt-in and defaults to `false` [`build-target.ts`].
- `deploy --skip-build` refuses a compiled executable whose build-identity stamp does not match the current sources [`build-artifact.ts:assertCompiledArtifactFresh`].
- A patched-Bun download must match the embedded sha256 pin. It never falls back to stock Bun [`bun-toolchain.ts:ensurePatchedBun`].
- An unconditional `output: 'export'` is refused, and an unreadable Next config also refuses [`static-export-guard.ts`].
- Before a Next build (not the vinext target) every `distDir` key in the config text (a quoted, bare or computed `['distDir']` property, or a dot or bracket assignment; not `==` or `=>`) must be a plain literal for the default (`.next`, `./.next`, `.next/`), else the build is refused, since the build, artifact and standalone steps assume `.next`; a computed value refuses too (fail closed). Best-effort text check (#2250). Not seen: a shorthand `{ distDir }`, `Object.defineProperty`, a value set outside the file, and builds that skip `runProjectBuild` (`build --skip-next`, `deploy --skip-build`, and `deploy --image`, which implies it) [`static-export-guard.ts:assertDefaultDistDir`, `project-build.ts:runProjectBuild`].
- `runtime=bun` with Turbopack module fragments enabled is refused [`turbopack-fragments-guard.ts`].
- vinext patches apply all-or-nothing, with rollback on failure [`vinext-patches.ts`].
- `create` refuses to overwrite files without `--force`, and requires an RFC 1123 app name of at most 63 characters [`create.ts:writeScaffold`, `assertValidAppName`].
- `status` and `doctor` never mutate the cluster [`status.ts`, `./doctor/`].

## Side Effects

- **kubectl:**
  - `apply --validate=strict` for the NextApp, the BackendService and the k6 `ConfigMap` plus `Job`.
  - `apply --dry-run=server` for the schema preflight.
  - `patch nextapp --type merge` and `delete nextapp --ignore-not-found`.
  - Read-only `get` of NextApps and revisions.
  - `version --client`.
- **Builds:**
  - `npm run build` and `npx vite build`.
  - `bun build --compile --bytecode`, run through the shipped compile scripts.
  - `bun pack` and `tar -xzf` for native image packages.
  - `docker buildx build --push --metadata-file` and `docker inspect`.
  - `git init` / `check-ignore` in a scratch directory, from `create`.
  - The compiled binary itself, for the post-compile smoke test.
- **Network:**
  - The patched-Bun release download.
  - The npm registry pin probe, with a 3 s timeout.
  - Smoke-test HTTP requests to `127.0.0.1`.
  - Storage-bucket pruning in `gc`.
- **Filesystem writes:**
  - `.output/<cr>.yaml`.
  - Staged Dockerfiles and shims in the build context.
  - `native/.integrity.json`.
  - The build-identity stamp.
  - The patched-Bun cache.
  - Scaffold files from `create`.
  - `.kn-next/loadtest/<app>/` job manifests.
  - Rewritten files under the vinext package in `node_modules` (temporary file, then rename).
- **Environment:**
  - Reads `KN_CONTEXT`, `KN_REDIS_URL`, `KN_REGISTRY`, `KN_BUCKET`, `KN_IMAGE_TAG`, `KN_NAMESPACE`, `KN_IMAGE`, `KNEXT_VINEXT_PATCHES`, `KNEXT_VERBOSE` and `npm_config_registry`.
  - Reads `KNEXT_CACHE_DIR`, then `XDG_CACHE_HOME`, for the patched-Bun cache location (`bun-toolchain.ts`), `KNEXT_COMPILE_STRICT_REQUIRES` (`vinext-build.ts`), and `CI` to decide whether `create` prompts (`create-options.ts`).
  - The `knext.config.ts` that `create` scaffolds reads `REDIS_URL`, so loading that config reads it.
  - `runProjectBuild` sets `KNEXT_RUNTIME` (`project-build.ts:runProjectBuild`, through the constant `../adapters/runtime-env.ts:KNEXT_RUNTIME_ENV`). Its callers set `ASSET_PREFIX` from the storage config when storage is configured (`deploy.ts`; `preview.ts` only with a `storage.publicUrl`) and delete it when it is not (`build.ts`, `deploy.ts`, `preview.ts`). `deploy.ts` and `preview.ts` call `build-id-env.ts:exportBuildIdEnv`, which always sets `KNEXT_BUILD_ID`, sets `NEXT_DEPLOYMENT_ID` only for the vinext builder, and otherwise deletes an inherited `NEXT_DEPLOYMENT_ID`.
  - The `static-export-guard.ts` guards write nothing. They read `next.config.*` through `readNextConfigStrict`; `readConfigOrRefuse` turns an unreadable file into a `UsageError`. `assertDefaultDistDir` refuses a custom `distDir` before the build, `assertVinextNotStaticExport` refuses `output: 'export'` on the vinext path, and `assertNotStaticExport` checks for `<distDir>/export-detail.json` after the build.
- **Optional packages:** lazily imports `@getknext/grpc`, `@getknext/ffi` and `@getknext/db/migrate`. `db migrate` opens a database connection.
- **Exit:** `process.exit` with the code returned by each verb's `*Main` function.

## Verification

- Run from `packages/kn-next`: `node ../../scripts/bun-test.mjs packages/kn-next`. The CLI tests live in `packages/kn-next/src/__tests__/`, for example `cli-*.test.ts`, `deploy-*.test.ts` and `ci-*.test.ts`.
