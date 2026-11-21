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
| `create` | `create.ts`, `create-options.ts` | `createMain`, `writeScaffold`, `parseChoiceFlags` (`--runtime`, `--builder`, `--cache`, `--storage`, `--react-compiler`/`--no-react-compiler`, `--cache-components`/`--no-cache-components`; `--cache-components` is refused with `--builder vinext`), plus `--force` and `--dry-run`; prompt helpers `DEFAULT_CREATE_CHOICES`, `shouldPrompt`, `promptCreateChoices`, `terminalPromptIO`, `applyCreateChoices`, `choicesToFlags`, `templateBuilderFor` |
| `validate` | `validate-cmd.ts`, `validate.ts` | `validateMain`, `validateConfig`, `ConfigValidationError`, `checkPairing` |
| `doctor` | `doctor.ts` and [`./doctor/`](./doctor/EGM.md) | `runDoctor`, `doctorMain` |
| `status` | `status.ts` | `statusMain`, `runStatus` (`--json`, `--watch`), `parseStatusArgs`, `extractStatus`, `renderStatusHuman`, `statusModelToJson` |
| `rollback` | `rollback.ts` | `rollbackMain`, `runRollback` (`--to`, `--canary`) |
| `cleanup` | `cleanup.ts` | `cleanupMain`, `runCleanup` |
| `gc` | `gc.ts` | `gcMain`, `runAssetGC` (`--build-id`, `--dry-run`), `parseGcArgs`, `renderGcReport` |
| `db bind` / `db migrate` | `db-bind.ts`, `db-migrate.ts` | `dbMain`, `runDbBind`, `runDbMigrate`, `parseDbBindArgs`, `validateDbBindOptions`, `buildDbBindPatch`, `analyzeDsn`, `extractDsnFromSecretManifest` |
| `generate`, `add`, `deploy function` | `grpc-dispatch.ts` | `generateMain`, `addMain`, `deployFunctionMain`, `buildDeployHost`, `buildServedVersionReader`, `dispatchGrpcVerb`, `readValidatedBackendService`, `satisfiesRange` |
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

- `runProjectBuild`, its options type `RunProjectBuildOptions`, and `preflightEsmPackage` (`project-build.ts`): the single seam that runs the app build.
- `resolveBuildArtifact`, `compileArtifactForDeploy`, `assertCompiledArtifactFresh`, `hashBuildIdentity` (`build-artifact.ts`).
- `buildVinextExecutable`, `bunMeetsFloor`, `stageSharpNative`, `stageSharpForStandalone`, `fetchImgPackage` (`vinext-build.ts`).
- `assertNodePresetOutput` (`vinext-node-build.ts`).
- `buildStandaloneExecutable` (`standalone-exec-build.ts`).
- `enforceBytecodeVerdict` (`bytecode-enforce.ts`): the one place a failed bytecode verdict becomes a failed build. It deletes the executable and throws a `UsageError`. Every compiled target uses it.
- `resolveStandaloneLayout` (`standalone-layout.ts`).
- `resolveTracingRoot`, `requireBuildContext` (`tracing-root.ts`).
- `selectRuntimeImage`, `dockerBuildxArgs`, `stageStandaloneBuildContext`, `stageVinextNodeDockerfile` (`runtime-image.ts`), plus its Dockerfile helpers `runtimeStandaloneTemplateDir`, `STANDALONE_DOCKERFILE_NAME`, `VINEXT_NODE_DOCKERFILE_NAME`, `isKnownGoodTemplateDockerfile`, `VINEXT_FFI_CLOSE_LINE`, `vinextTemplateWithCloseLine`, `standaloneDockerignore`, `dockerignoreExcludes`, `nestStandaloneDockerfile`, `FFI_NATIVE_PERMS`, `FFI_NATIVE_COPY`, `FFI_ANCESTORS_RUN` and `insertFfiNativeCopy`. The native/ COPY (FFI line and the vinext template's) is the only COPY with `--chown=0:0 --chmod=a-w`: root-owned, non-writable for the app user. Each image also runs `RUN chmod go-w` over every directory above the executable and over `native/` itself (the standalone ones through `FFI_ANCESTORS_RUN`, only for an app with `knext.ffi.json`; the vinext template is the app's own scaffolded `Dockerfile`, compared byte for byte by `isKnownGoodTemplateDockerfile`, and carries no such line: `knext ffi init`, `generate` and `check` print `RUN chmod go-w /app /app/native` for an app that copies `native/` to `/app/native`; `isKnownGoodTemplateDockerfile` also accepts the template with exactly that line directly after its `native/` `COPY` (`vinextTemplateWithCloseLine` splices it into the template's own text and returns `undefined` unless the `COPY` occurs exactly once), so an app that follows the advice keeps the host-built path; `@getknext/ffi` hard-codes the template's shape (`/app/native`), and `ffi-vinext-known-good.test.ts` keeps `VINEXT_FFI_CLOSE_LINE` in step with the hint), so the in-process Rust loader's ancestor walk never rests on the mode a builder gives a COPY's destination.
- `runPostCompileSmoke`, `PostCompileSmokeError`, `STARTUP_LINE` (`postcompile-smoke.ts`).
- `ensurePatchedBun`, `resolveCompileBun`, `PATCHED_BUN` (`bun-toolchain.ts`).
- `validateCompileConfig` (`compile-config.ts`).
- `writeNativeIntegrityManifest` (`native-integrity.ts`).
- `exportBuildIdEnv`, `checkStandaloneBuildId`, `buildIdMismatchError`, `KNEXT_BUILD_ID_ENV`, `NEXT_DEPLOYMENT_ID_ENV`, `NEXT_CONSTANT_BUILD_ID` (`build-id-env.ts`).
- `DEPLOY_SHIP_ARCH`, `resolveSelfContained` (`build-target.ts`).
- `readImageCacheRouted` (`write-free.ts`).

### Guards

- `assertNoPlaceholders` (`placeholder-preflight.ts`).
- `assertNotStaticExport`, `assertNotStaticExportFromFacts`, `assertVinextNotStaticExport`, `assertDefaultDistDir`, plus the helpers `classifyStaticExport` (returning the type `StaticExportDeclaration`: `unconditional`, `conditional` or `none`), `configuredDistDir` and `stripCommentsStringAware` (`static-export-guard.ts`).
- `assertNoBunTurbopackFragments`, `enablesTurbopackModuleFragments` (`turbopack-fragments-guard.ts`). The text scans keep string literals, so a setting written inside a string can trip them; they decide only where no resolved config exists.
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
  - `grpc-dispatch.ts:buildServedVersionReader` (handed only to `generate`) only reads: one context-bound `kubectl get --request-timeout=30s backendservices.apps.kn-next.dev <name> -n <ns> -o jsonpath={.status.servedProtoVersion}`, after both names pass a Kubernetes-name check.
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
- Standalone self-contained builds verify bytecode with `verifyBytecodeEmbedded` (every embedded module and route chunk 0 must carry it). Other standalone builds use `verifyBytecodeExec` [`standalone-exec-build.ts:buildStandaloneExecutable`].
- `deploy --skip-build` refuses a compiled executable whose build-identity stamp does not match the current sources [`build-artifact.ts:assertCompiledArtifactFresh`].
- A patched-Bun download must match the embedded sha256 pin. It never falls back to stock Bun [`bun-toolchain.ts:ensurePatchedBun`].
- A Next build (not the vinext target) decides its refusals (a custom `distDir`; Bun + Turbopack + `turbopackModuleFragments`; a static export) from the config Next resolved. `runProjectBuild` first runs the text checks as warnings only, creates a temp facts file and sets `KNEXT_CONFIG_FACTS_OUT` and `KNEXT_BUILDER` for the build. It never sets `NEXT_ADAPTER_PATH`: any `adapterPath` changes Next's build output. After the build it decides from, in order: (1) knext's adapter record, ignored when its `projectDir` is another directory, where the adapter already refused inside the build and the CLI re-raises the recorded refusal as a `UsageError`, even when the build exited 0; (2) the resolved `config` in a `required-server-files.json` Next wrote during this build (mtime at or after the build start, with 2 s of slack; nothing is deleted beforehand), in `.next` or a top-level directory of the app; any fresh file carrying a custom `distDir` decides (it is refused), otherwise the newest does; a file that does not parse refuses; (3) neither: a warning, then the text checks below. A record that cannot be read never replaces the build's own error [`project-build.ts:runProjectBuild`, `static-export-guard.ts:assertNotStaticExportFromFacts`, `../adapters/next-config-facts.js`].
- The text checks. Before the build, `assertNoBunTurbopackFragments` and `assertDefaultDistDir` run as warnings only; after it, in case (3) only, all three run as refusals: `assertNoBunTurbopackFragments`, then `assertDefaultDistDir` (every `distDir` key must be a plain literal for `.next`, `./.next` or `.next/`; a computed value refuses, fail closed; not seen: a shorthand `{ distDir }`, `Object.defineProperty`, a value set outside the file), then `assertNotStaticExport` (text `distDir`, then `export-detail.json`). An unreadable Next config refuses. The env it set is restored and the temp facts file removed whether the build passes or fails.
- On the vinext path an unconditional `output: 'export'` is refused before the build, from the config text, and a conditional or nested one only warns [`static-export-guard.ts:assertVinextNotStaticExport`].
- `runtime=bun` with Turbopack module fragments enabled is refused: from the resolved config on a Next build, and by the text check on `build --skip-next` and in the fallback [`turbopack-fragments-guard.ts`, `build.ts`].
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
  - `bun build --compile --bytecode`, run through the shipped compile scripts. In the vinext include shape the script also writes the plan sidecar described under Filesystem writes.
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
  - `<outfile>.knext-plan.json`, the plan sidecar. `vinext-compile.mjs` writes it beside the executable in the include shape only, and never in self-contained or default-disk shapes. `readPlanSidecar` (`vinext-build.ts`) reads it and deletes it in a `finally`. A missing, symlinked, unparseable or foreign-marker sidecar fails the build. A module count that is not a positive integer is rejected (`vinext-build.ts`, the `invalid module count` check). Debt: when the executable itself cannot be read, `verifyCompiledExecutable` throws at `vinext-build.ts` (the artifact read catch) before `readPlanSidecar` runs, so the sidecar is never read or deleted and stays beside the binary, as does the binary.
  - Binary removal. A failed bytecode verdict deletes the executable (`enforceBytecodeVerdict`, `bytecode-enforce.ts`). So does a failed plan-sidecar read on the vinext include shape (the catch around `readPlanSidecar`, `vinext-build.ts`). An executable that cannot be read is not deleted: the vinext path throws a `UsageError` (`vinext-build.ts`), and the standalone path lets the read error propagate (`standalone-exec-build.ts`).
  - Rewritten files under the vinext package in `node_modules` (temporary file, then rename).
- **Environment:**
  - Reads `KN_CONTEXT`, `KN_REDIS_URL`, `KN_REGISTRY`, `KN_BUCKET`, `KN_IMAGE_TAG`, `KN_NAMESPACE`, `KN_IMAGE`, `KNEXT_VINEXT_PATCHES`, `KNEXT_VERBOSE` and `npm_config_registry`.
  - Reads `KNEXT_CACHE_DIR`, then `XDG_CACHE_HOME`, for the patched-Bun cache location (`bun-toolchain.ts`), `KNEXT_COMPILE_STRICT_REQUIRES` (`vinext-build.ts`), and `CI` to decide whether `create` prompts (`create-options.ts`).
  - The `knext.config.ts` that `create` scaffolds reads `REDIS_URL`, so loading that config reads it.
  - `runProjectBuild` sets `KNEXT_RUNTIME` (`project-build.ts:runProjectBuild`, through the constant `../adapters/runtime-env.ts:KNEXT_RUNTIME_ENV`). On a Next build it also sets `KNEXT_CONFIG_FACTS_OUT`, `KNEXT_CONFIG_FACTS_PROJECT` (the app directory) and `KNEXT_BUILDER` for the build only, restoring each afterwards, and creates then removes a `knext-config-facts-*` temp directory. It also writes warnings to stderr (a vulnerable Next.js version, and the result of the vinext patch step), and on the vinext target it re-applies knext's bundled vinext patches to the installed `vinext` (`ensureVinextPatches`), a no-op when they are already applied. Its callers set `ASSET_PREFIX` from the storage config when storage is configured (`deploy.ts`; `preview.ts` only with a `storage.publicUrl`) and delete it when it is not (`build.ts`, `deploy.ts`, `preview.ts`). `deploy.ts` and `preview.ts` call `build-id-env.ts:exportBuildIdEnv`, which always sets `KNEXT_BUILD_ID`, sets `NEXT_DEPLOYMENT_ID` only for the vinext builder, and otherwise deletes an inherited `NEXT_DEPLOYMENT_ID`.
  - The `static-export-guard.ts` guards write no files and no environment variables. They read `next.config.*` through `readNextConfigStrict`; `readConfigOrRefuse` turns an unreadable file into a `UsageError`. `assertDefaultDistDir` refuses a custom `distDir` (as a warning before the build, and as a refusal only in the post-build fallback), `assertVinextNotStaticExport` refuses an unconditional `output: 'export'` on the vinext path and, for a conditional or nested one, writes a warning to stderr and continues, and `assertNotStaticExport` checks for `<distDir>/export-detail.json` after a Next build in the fallback (never after a vinext build, which does not write it).
- **Optional packages:** lazily imports `@getknext/grpc`, `@getknext/ffi` and `@getknext/db/migrate`. `db migrate` opens a database connection.
- **Exit:** `process.exit` with the code returned by each verb's `*Main` function.

## Verification

- Run from `packages/kn-next`: `node ../../scripts/bun-test.mjs packages/kn-next`. The CLI tests live in `packages/kn-next/src/__tests__/`, for example `cli-*.test.ts`, `deploy-*.test.ts` and `ci-*.test.ts`.
