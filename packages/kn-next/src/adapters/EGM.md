# adapters

## Overview

This is the runtime and build layer of `@getknext/core`. It contains:

- the official Next.js Deployment Adapter (`next-adapter.ts`);
- the standalone-server supervisor (`node-server.ts`), which spawns
  `.next/standalone/server.js` (or, with `STANDALONE_SERVER_EXEC`, the compiled
  executable) next to a metrics sidecar;
- the Redis-backed ISR/data-cache and `"use cache"` handlers;
- preloads that patch `node:http` and `Bun.serve` for cache-control, CDN edge
  headers, body caps, public origins and keep-alive;
- observability: Prometheus metrics, OpenTelemetry tracing and deep health;
- the opt-in single-executable compile pipeline (`vinext-compile.mjs`,
  `standalone-compile.mjs`) and its static analyzers;
- image optimization and the image-cache sync.

Many files are loaded with `--require` or as `import` side effects, so loading
them changes process globals. The Side Effects section lists each one.

## Interface

### Published subpaths

These are the `exports` entries in `packages/kn-next/package.json`:

- `./adapter` resolves to `next-adapter.ts:default`, the `NextAdapter` named
  `knext-adapter`. It provides `modifyConfig` and `onBuildComplete`.
- `./adapters/otel-config` resolves to `otel-config.ts:resolveOtelOptions`.
- `./adapters/tracing` is `tracing.ts`. It exports `TRACER_NAME`,
  `COLD_START_SPAN_NAME`, `DB_WAKE_SPAN_NAME`, `CORRELATION_ATTRIBUTE`,
  `ColdStartSpanProcessor`, `CorrelationSpanProcessor`,
  `CorrelationContextPropagator`, `instrumentPoolForDbWake`,
  `withColdStartSpan`, `withDbWakeSpan`, `activeTraceId`,
  `installTraceIdProvider`, `activeCorrelationId`,
  `installCorrelationIdProvider`, `correlationIdFromContext` and
  `withCorrelationId`.
- `./adapters/metrics` is `metrics.ts`. It exports `createMetricsRegistry`,
  `initRuntimeMetrics`, `getRuntimeMetrics`, `resetRuntimeMetrics`,
  `GoldenSignalMetricsProcessor`, `makeDeepHealthScrapeHook`,
  `refreshDeepHealthGauge`, `startChildMetricsServer`, `fetchChildMetrics`,
  `createSupervisorMetricsHandler`, `mergeExposition`, `statusClass`,
  `recordColdStart`, `recordDbWake`, `DEEP_HEALTH_PROBE_TTL_MS`,
  `CHILD_METRICS_PORT` and the metric-name constants. `CHILD_METRICS_PORT` is
  read from `KN_CHILD_METRICS_PORT` (default 9092) when the module loads. The metric names are `knext_http_requests_total`,
  `knext_http_request_duration_seconds`, `knext_http_inflight_requests`,
  `knext_coldstart_*`, `knext_db_wake_*` and `knext_deep_health_state`.
- `./adapters/correlation-response` resolves to
  `correlation-response.ts:installCorrelationResponseEcho`.
- `./adapters/cache-handler` resolves to `cache-handler.public.js`. It exports
  `default` (`CacheHandler`), `CacheHandler`, `ioredisClient` and
  `nativeRedisClient`. It does not use `export *`, so the test seams are not
  exposed.
- The `./internal/*` subpaths are wiring for generated code and preloads:
  - adapter: `next-adapter.ts` (`next-adapter`, the same module as
    `./adapter`);
  - cache: `cache-write-registry.js` (`cache-drain`),
    `cache-handler-{node,bun}.js`, `use-cache-handler{,-remote}-{node,bun}.js`
    and `vinext-cache-adapter{,-node,-bun}.mjs`;
  - preloads (`--require`d into the child): `cache-control-normalize.cjs`,
    `bun-keepalive-guard.cjs` and `request-body-cap.cjs`; `public-origin.cjs`
    is one too, but has no subpath. Loaded in-process, never `--require`d:
    the process-start primers (`arp-primer.cjs`, `wake-ahead.cjs`), and the vinext/Bun runtime modules
    `bun-serve-keepalive-guard` and `response-cache-control` (dist `.js`);
  - health: `deep-health-lite.ts`;
  - images: `vinext-image-optimizer.ts` (`vinext-image-optimizer`);
  - debug: `sandbox-fetch-debug.cjs` and `sandbox-fetch-realm-debug.cjs`;
  - standalone tooling: `standalone-bun-exports.ts`,
    `standalone-adapter-path.ts` and `node-server.ts`.

### Cache

- `cache-handler.js:default` is the `CacheHandler` class. Its methods are
  `get`, `set`, `revalidateTag` and `resetRequestCache`. It also has
  `static redisClient` and `static forUseCache(kind)`.
- The Redis keys are:
  - `<prefix>:cache:<key>`
  - `<prefix>:tag:<tag>` (a SET)
  - `<prefix>:build-live:<buildId>`
  - `<prefix>:cache-events` (a LIST)
  - `<prefix>:uc:<kind>:<key>`
  - `<prefix>:uc:tags` (a HASH)
- `cache-handler-node.js` default-exports `KnextNodeCacheHandler`, which uses
  ioredis, loaded with a literal `import('ioredis')`. `cache-handler-bun.js`
  default-exports `KnextBunCacheHandler`, which uses
  `globalThis.Bun.RedisClient`. Both extend `CacheHandler`.
- `cache-write-registry.js` exports `trackWrite`,
  `drainCacheWrites(timeoutMs = 5000)`, `inFlightCacheWriteCount`,
  `onProcessExit(report)`, `runExitReports`, `clearExitReportsForTests` and
  `exitReportCountForTests`.
- `use-cache-handler.js:createUseCacheHandler({kind, core})` returns
  `{get, set, refreshTags, getExpiration, updateTags}`. The metric is
  `USE_CACHE_METRIC = 'knext_use_cache_events_total'`, rendered by
  `renderUseCacheMetrics`. The module also exports `USE_CACHE_EVENTS`,
  `USE_CACHE_METRICS_SEAM_KEY`, `LEGACY_SHARED_KEY_PREFIX`,
  `collapseSweepAllowed`, `collapseRefusedMessage`, `escapeGlob`,
  `PRUNE_STAMPS_SCRIPT`, `REPLAY_STAMPS_SCRIPT` and `resetUseCacheTagReplay`.
- `vinext-cache-adapter*.mjs` provides the factory
  `createKnextVinextDataCacheAdapter` and a named `KnextCacheHandler` export:
  `CacheHandler` in `vinext-cache-adapter.mjs`, `KnextNodeCacheHandler` in
  `-node.mjs` and `KnextBunCacheHandler` in `-bun.mjs`.
- `cache-control-normalize.cjs` exports `normalizeCacheControl`, `install` and
  `DEPLOY_CACHE_CONTROL`.
- `response-cache-control.mjs` exports `normalizeResponse`,
  `applyVinextDeployDefault` and `cacheControlMiddleware`.
- `bun-serve-cache-control.mjs` exports `shouldInstall`, `wrapFetch`,
  `wrapServeOptions` and `install`.
- Environment variables:
  - `REDIS_URL`, `REDIS_KEY_PREFIX`
  - `REDIS_CONNECT_TIMEOUT_MS` (5000), `REDIS_COMMAND_TIMEOUT_MS` (2000),
    `REDIS_RETRY_COOLDOWN_MS` (5000)
  - `KNEXT_CACHE_REDIS_CLIENT`, `KNEXT_IMAGE_CACHE_MEMORY_BYTES`
  - `KNEXT_BUILD_ID`, `NEXT_DEPLOYMENT_ID`
  - `KNEXT_USE_CACHE_MAX_ENTRY_BYTES` (2 MiB),
    `KNEXT_USE_CACHE_MAX_TTL_SECONDS` (86400)
  - `KNEXT_CACHE_CONTROL_NORMALIZE`, `KNEXT_TEST_SEAMS`
  - `KNEXT_IMAGE_CACHE_HANDLER` (build time, read by
    `next-adapter.ts:modifyConfig`; `"0"` keeps Next's disk image cache)

### CDN

- `cdn-edge.cjs` exports (`module.exports`):
  - config and decision: `loadCdnConfig`, `decideEdge`, `edgeHeaders`,
    `EDGE_ONLY_HEADERS`, `stripForeignEdgeHeaders`, `encodeTags`, `tagsFit`,
    `PROVIDER_ROWS`, `STATE` and `ORIGIN_CC`;
  - paths and routing: `rawPathOf`, `isCanonicalRawPath`, `underPrefix`,
    `parseRoutingArtifact`, `middlewareMatches` and `ROUTING_ARTIFACT_NAME`;
  - wiring: `createController`, `ensureSeam`, `captureRequest`, `SEAM_KEY` and
    `DECISIONS_KEY`;
  - metrics: `renderCdnMetrics`, `edgeDecisionSnapshot`,
    `renderEdgeDecisionMetrics`, `publishMetricsSeam`, `CDN_METRICS_SEAM_KEY`,
    `countDecision`, `countForeignEdgeStrip` and `foreignEdgeStripCount`.
- Its environment variables are `KNEXT_CDN_PROVIDER`, `KNEXT_CDN_TAG_PREFIX`,
  `KNEXT_CDN_HTML_TTL_SECONDS` (default 30), `KNEXT_CDN_SWR_SECONDS`,
  `KNEXT_CDN_EXCLUDE_PATHS` and `KNEXT_CDN_INCLUDE_PATHS`.
- `cdn-routing-artifact.ts` exports `buildCdnRoutingArtifact`,
  `writeCdnRoutingArtifact`, `stageCdnRoutingArtifact` and
  `CDN_ROUTING_ARTIFACT_NAME`. The artifact file is `knext-cdn-routing.json`.
- `cdn-purge/`: see [`./cdn-purge/EGM.md`](./cdn-purge/EGM.md). It does
  tag-based CDN purges with batching, a rate limit and retries. Its only
  importer is `cache-handler.js`.

### Runtime, supervisor and preloads

- `node-server.ts` is the supervisor entry and has no exports. Its environment
  variables are:
  - `METRICS_PORT` (9464)
  - `SHUTDOWN_GRACE_MS` (25000)
  - `STANDALONE_SERVER_PATH` (`.next/standalone/server.js`)
  - `IMAGE_CACHE_DIR`
  - `PORT` (3000)
- `shutdown.ts` exports `gracefulShutdown`, `isShuttingDown`,
  `registerShutdownDrain`, `clearShutdownDrains` and `graceCapWarning`. `db-drain.ts` exports
  `drainDbPools` and `registerDbPoolDrain`.
- `env.ts` exports `buildChildEnv` and `deriveBunTranspilerCachePath`.
  `runtime-env.ts` exports `KNEXT_RUNTIME_ENV = "KNEXT_RUNTIME"`.
- `deferred-supervisor-init.ts` exports `createDeferredSupervisorInit`,
  `createLazyMetricsEndpoint`, `isSupervisorInitDeferred` and
  `DEFER_SUPERVISOR_INIT_ENV` (`KNEXT_DEFER_SUPERVISOR_INIT`), which it reads.
- `self-warm.ts` exports `parseWarmPaths`, `selfWarm`, `isListening`,
  `SELF_WARM_HEADER` (`x-knext-warm`) and `DEFAULT_WARM_TIMEOUT_MS`; it reads
  `KNEXT_WARM_PATH` and `KNEXT_EAGER_WARM`.
- `deferred-default-metrics.ts` exports `createDeferredDefaultMetrics`,
  `waitForChildServing`, `probeTcp`, `probeIntervalMs`, `readyDeadlineMs`,
  `CHILD_READY_INTERVAL_ENV` (`KNEXT_CHILD_READY_PROBE_MS`),
  `CHILD_READY_DEADLINE_ENV` (`KNEXT_DEFAULT_METRICS_DEADLINE_MS`),
  `DEFAULT_PROBE_INTERVAL_MS` (250) and `DEFAULT_READY_DEADLINE_MS` (60000).
  It reads both env vars.
- `standalone-exec.ts` exports `childSpawnPlan` and reads
  `STANDALONE_SERVER_EXEC`. `standalone-exec-entry.mjs` exports
  `standaloneExecEntrySource`, `standaloneCacheHandlerFiles`,
  `STANDALONE_DIR_BINDING`, `DEV_ONLY_STUB_SOURCE`, `splitBareSpecifier`,
  `resolveExportsUnderNode` and `resolveRequireLike`. The entry source it
  generates reads `KNEXT_STANDALONE_DIR` (falling back to the executable's
  directory) and is anchored on Next's
  `process.env.__NEXT_PRIVATE_STANDALONE_CONFIG = ...` line.
  `standalone-self-contained-supervisor.cjs` exports `install`,
  `installDrainHandler`, `installExitNormalizer`, `drainHardcapMs`,
  `hardcapWarning`, `metricsPort`, `metricsBody` and `startMetricsServer`.
- `standalone-adapter-path.ts` exports `blankStandaloneAdapterPath`,
  `nextCarriesAdapter404Bug`, `resolveStandaloneNextVersion` and
  `ADAPTER_PATH_404_FIXED_IN` (`"16.4.0"`). `standalone-bun-exports.ts` exports
  `healBunExportTargets` and `collectBunConditionTargets`.
- `request-body-cap.cjs` exports `resolveRequestByteCap`, `gateRequest`,
  `install`, `DEFAULT_MAX_REQUEST_BYTES` and `MAX_REQUEST_BYTES_ENV`. It reads
  `KNEXT_MAX_REQUEST_BYTES`, and skips its load-time `install` when
  `KNEXT_REQUEST_BODY_CAP_NO_AUTOINSTALL=1`.
- `public-origin.cjs` exports `parsePublicOrigins`, `resolvePublicOrigin`,
  `rewriteLocation`, `install` and `PUBLIC_ORIGINS_ENV`. It reads
  `KNEXT_PUBLIC_ORIGINS`, and skips its load-time `install` when
  `KNEXT_PUBLIC_ORIGIN_NO_AUTOINSTALL=1`.
- `arp-primer.cjs` exports `primeArpNow`, `parseDefaultGatewayFromRouteTable`,
  `hexRouteFieldToIp`, `readDefaultGateway` and `ARP_PRIMER_TARGET_PORT`, and
  reads `KNEXT_ARP_PRIMER`.
- Process-start primers (ADR-0066 D3): `process-start-primers.cjs` is data only,
  `PROCESS_START_PRIMERS` (frozen, in order: `arp-primer.cjs`, `wake-ahead.cjs`).
  `process-start-abort.cjs` owns the shared abort: `PRIMER_ABORT_KEY`
  (`Symbol.for('knext.runtime.primerAbort')`), `primerSignal()` and
  `abortPrimers()`. `process-start-run.ts` exports `runProcessStartPrimers(deps)`
  (requires each listed primer, skipping missing or broken files with one stderr
  line each, and returns the abort function), `describeError`,
  `PRIMER_LIST_FILE` and `PRIMER_ABORT_FILE`.
- `wake-ahead.cjs` exports `WAKE_FUNCTIONS_ENV` (`KNEXT_WAKE_FUNCTIONS`),
  `WAKE_AHEAD_SWITCH_ENV` (`KNEXT_WAKE_AHEAD`; `0` turns it off), `WAKE_PATH`
  (`/healthz`), `WAKE_TIMEOUT_MS` (1000), `callSignal`, `urlEnvFor`,
  `wakeTargets`, `wakeUrl` and `wakeAheadNow`, which it calls when required.
- The keep-alive guards are `bun-keepalive-guard.cjs` (exports
  `shouldInstall`, `isAffectedBunVersion`, `guardServer` and `install`) and
  `bun-serve-keepalive-guard.mjs` (exports `shouldInstall`,
  `stampConnectionClose`, `wrapFetch`, `wrapServeOptions` and `install`). Both
  read `KNEXT_BUN_KEEPALIVE_GUARD`.
- `sandbox-fetch-debug.cjs` exports `shouldInstall`, `createInstrumentation`,
  `install`, `CHANNELS` and `STALL_MS`. When
  `KNEXT_SANDBOX_FETCH_DEBUG_SERVER_JS` is set, it `require`s that path.
  `sandbox-fetch-realm-debug.cjs` exports `shouldInstall`, `acquire`,
  `createTracker`, `patchSandboxContext`, `instrumentSocketConnects`,
  `subscribeDiagnostics`, `CHANNELS`, `STALL_MS` and `MARKER`. The code it
  writes into Next's `sandbox/context.js` `require`s
  `KNEXT_SANDBOX_FETCH_REALM_DEBUG_MODULE`.
- `sidecar-runtime.mjs` exports `resolveSidecar`, `installSidecarResolution`,
  `sidecarRoot`, `sidecarHas`, `sidecarEntryFile`, `resolveInPackage`,
  `findPackageDir`, `exportsTargets`, `isBareRequest`, `splitRequest`,
  `isInside`, `REQUIRE_CONDITIONS` and `SIDECAR_GLOBAL` (`"knext.sidecar"`).
  `sidecar-install.mjs` only has side effects.
- `db-clients-probe.ts` exports `warnIfDbClientsUnavailable`.
- `artifact-contract.ts` exports `isCompatible`, `explainIncompatibility`,
  `BUILDERS`, `AVAILABLE_BUILDERS`, `RUNTIMES`, the builders
  `turbopackBuilder`, `webpackBuilder` and `vinextBuilder`, and the runtimes
  `nodeRuntime` and `bunRuntime`. Its types are `ArtifactShape`, `BuilderId`,
  `RuntimeId`, `ExecutionMode`, `BuildArtifact`, `ArtifactLayout`,
  `BuilderAdapter` and `RuntimeAdapter`. Its defaults are
  `DEFAULT_BUILDER_ID = "turbopack"` and `DEFAULT_RUNTIME_ID = "bun"`.

### Observability and health

- `otel-config.ts:resolveOtelOptions` reads `OTEL_TRACING_ENABLED`,
  `OTEL_SERVICE_NAME` (falling back to `KN_APP_NAME`),
  `OTEL_EXPORTER_OTLP_ENDPOINT` (default
  `http://otel-collector.monitoring:4317`) and `OTEL_TRACES_SAMPLER_ARG`.
- `deep-health-lite.ts` exports `createDeepHealthLite`, `startDeepHealthLite`,
  `resolveLitePort`, `DEEP_HEALTH_LITE_TTL_MS`, `appendExposition` and the seam
  readers `readCdnMetrics`, `readUseCacheMetrics`, `readFfiMetrics` and
  `readSeamMetrics`. It reads `DB_ACTIVITY_BUDGET_MS` (45000) and
  `KN_CHILD_METRICS_PORT` (9092).
- `boot-trace.ts` exports `createBootTracer`, `bootTrace`,
  `isBootTraceEnabled` and `BOOT_TRACE_ENV` (`KNEXT_BOOT_TRACE`), which it
  reads.
- `compile-cache-health.ts` exports `evaluateCompileCacheStatus`,
  `runtimeHonoursCompileCache` and `warnOnDegradedCompileCache`, and checks
  `NODE_COMPILE_CACHE` and `NODE_DISABLE_COMPILE_CACHE`.
  `compile-cache-shadow.ts` exports `isSameDirectory`,
  `isCompileCacheShadowed`, `detectCompileCacheShadow` and
  `warnOnCompileCacheShadow`, and checks `NODE_COMPILE_CACHE`.
- `slow-dep-log.js` exports `logSlowDep`, `instrumentConnectTiming`,
  `SLOW_DEP_PREFIX` and `slowDepThresholdMs`. It reads `SLOW_DEP_LOG_MS` (500).
- `correlation-response.ts` also exports `CORRELATION_RESPONSE_INSTALLED`.
- `metric-contract.ts`, `dashboard-metrics.ts` and `alert-reachability.ts` are
  static scanners. The tests use them to check that metric names, dashboards
  and alerts agree. Their exports:
  - `metric-contract.ts`: `expandFamily`, `scanBunexecMetrics`,
    `parseExposition`, `parseOperatorMetricGolden`, `scanNameConstants`,
    `scanPromClientMetrics`, `seriesNames`, `extractDocMetricTokens`,
    `docTokenResolves`, `fencedDocSection`, `extractMetricNames`,
    `dashboardExprs` and `parsePrometheusRules`;
  - `dashboard-metrics.ts`: `EXPORTED_KNEXT_METRICS`,
    `extractKnextMetricTokens` and `findDanglingKnextMetrics`;
  - `alert-reachability.ts`: `scanScrapedPorts`, `scanEntryMetricsPort`,
    `scanAppMetricFamilies`, `bridgeIsWired` and `unreachableAlerts`.

### Images

- `image-cache-sync.ts` exports `startImageCacheSync`, `restoreImageCache`,
  `pushVariant` and `watchAndPushImageCache`. It reads `STORAGE_BUCKET`,
  `IMAGE_CACHE_DIR` and `IMAGE_CACHE_PREFIX`.
- `vinext-image-optimizer.ts` exports `handleImageRequest`,
  `knextImageOptimizer`, `negotiateFormat` and `isImageRequest`.
- `sharp-addon-dlopen.mjs` reads `KNEXT_SHARP_ADDON` and
  `KNEXT_REQUIRE_NATIVE_INTEGRITY`. The entry `vinext-compile.mjs` generates
  also reads `KNEXT_SHARP_ADDON`.
- `sharp-native-extract.mjs` exports `extractEmbeddedNative`, `lazySharp` and
  `NATIVE_ROOT_KEY`. It reads `KNEXT_NATIVE_TMPDIR` as the base directory for
  extraction, ahead of the system temp directory.
- `og-harfbuzz.mjs` exports `resolvePinnedHarfbuzzWasm`, `HARFBUZZ_NOTICE_FILE`
  (`knext-third-party-notices.txt`), `harfbuzzNoticeText`,
  `vinextOgPackageJson` and `ogHarfbuzzWarning`.

### Single-executable compile pipeline

- `vinext-compile.mjs` and `standalone-compile.mjs` are CLI scripts, not
  modules.
  - `vinext-compile.mjs` takes `--entry`, `--outfile`, `--target`,
    `--self-contained`, `--native-dir`, `--include-json` and
    `--include-native`. It reads `KNEXT_COMPILE_STRICT_REQUIRES`.
  - `standalone-compile.mjs` takes `--server` and `--outfile` (both required),
    plus `--root`, `--target`, `--marker` and `--self-contained`. It reads
    `KNEXT_STANDALONE_DIR` (written into the compiled banner),
    `KNEXT_VERBOSE` and `KNEXT_STANDALONE_COMPILE_VERBOSE` (either `=1` prints
    the compile notes), and the test-only
    `KNEXT_STANDALONE_COMPILE_NO_BYTECODE_FOR_VERIFIER_TEST=1`, which compiles
    without bytecode so the verifier can be shown to fail.
- `compile-embed.mjs` exports `planIncludes`, `planEmbed`, `embedBuildOptions`,
  `detectCompileInclude`, `parseIncludeJson`, `nativeIncludePaths`,
  `embeddedPathsMissing`, `embeddedPath`, `runEmbedProbe`,
  `assertPathFidelity`, `unembeddedDynamicReport`, `foldedRuntimeSummary` and
  `EMBED_PROBE_ENV`.
- `standalone-embed.mjs` exports `installDistDirAlias`,
  `installEmbeddedJsonRequire`, `EMBED_ROOT_GLOBAL` (`"__knextEmbedRoot"`),
  `classifyDistFiles`, `middlewareManifestFiles`, `relativeSpecifier`,
  `rebindDirnameSource` and `rewriteExternalAliases`.
- `bun-base-exe.mjs` exports `assertBunBaseExe`, `sealCompile`, `sealBuild`,
  `bunBaseExeCompileOptions`, `BunBaseExeError` and `BUN_BASE_EXE_ENV`. It
  reads `KNEXT_BUN_BASE_EXE`.
- `bytecode-exec-verify.mjs` exports `verifyBytecodeExec`,
  `verifyBytecodeModules`, `verifyBytecodeEmbedded` and `routeMarker`.
- The static analyzers are:
  - `create-require-analyze.mjs`: `analyzeCreateRequire` and
    `FOLDED_RUNTIME_PACKAGE = "ioredis"`;
  - `entry-require-staticize.mjs`: `analyzeServerModule`,
    `importedRequireEscapes` and `wrapRequireBindings`;
  - `entry-asset-anchor.mjs`: `rewriteAssetAnchors`,
    `rewriteImportMetaUses`, `assetAnchorPackageRoot`, `findAssetAnchors`,
    `hasAssetAnchorCandidate`, `rewriteVinextHarfbuzzAnchors` and
    `rewriteEntryHarfbuzzAnchors`;
  - `asset-anchor-analyze.mjs`: `analyzeAssetAnchors` and
    `findImportMetaUses`;
  - `computed-require-scan.mjs`: `computedRequireSites`,
    `literalRequireClosure`, `computedRequireInventory` and
    `moduleDisposition`;
  - `js-source-lexer.mjs`: `stripComments`;
  - `entry-external-sidecar.mjs`: `NEVER_SIDECAR = ["sharp"]`,
    `BUNDLED_PREFIX`, `packageNameOf`, `isSidecarCandidate`,
    `isCommonJsEntry`, `sidecarShimSource` and `hasNativeAddon`;
  - `app-data-embed.mjs`: `planAppData`, `readTraceRules`, `loadRouteMatcher`,
    `deriveTraceRules`, `globalExcludes`, `scanDataLiterals`,
    `dataPathsMissing`, `rewriteFsImports` and `discoverDataLiterals`;
  - `app-data-alias.mjs`: `installEmbeddedDataAlias` and `ALIASED_FS`.

### Hand-maintained declaration files

The `.js`, `.mjs` and `.cjs` modules that TypeScript code imports have
hand-written declarations beside them, which must be kept in step with the
module by hand: `cache-handler.d.ts`, `cache-handler.public.d.ts`,
`use-cache-handler.d.ts`, `slow-dep-log.d.ts`, and 19 `*.d.mts` files
(`app-data-alias`, `app-data-embed`, `asset-anchor-analyze`, `bun-base-exe`,
`bun-serve-cache-control`, `bun-serve-keepalive-guard`,
`bytecode-exec-verify`, `compile-embed`, `computed-require-scan`,
`entry-asset-anchor`, `entry-external-sidecar`, `entry-require-staticize`,
`js-source-lexer`, `og-harfbuzz`, `response-cache-control`,
`sharp-native-extract`, `sidecar-runtime`, `standalone-embed` and
`standalone-exec-entry`).

## Invariants

### Adapter config

- `next-adapter.ts:modifyConfig` sets `output: 'standalone'` only during
  `phase-production-build`, and never overrides an explicit `output: 'export'`.
- It swaps in the per-runtime cache handlers only when `KNEXT_RUNTIME` is
  `node` or `bun` and the configured handler is knext's own. An app's own
  `cacheHandlers.default` or `cacheHandlers.remote` takes precedence.
- `modifyConfig` also sets `images.customCacheHandler: true`
  (`imageCacheThroughHandler`), so Next stores optimized-image variants
  through knext's cache handler instead of `.next/cache/images` and the pod
  needs no writable path for images. It applies only when the resolved config
  carries `images.customCacheHandler` as the boolean `false`, the configured
  `cacheHandler` is knext's own, and `KNEXT_IMAGE_CACHE_HANDLER` is not `"0"`
  at build time.
- `modifyConfig` replaces `webpack` with a wrapper that calls the app's own
  hook first. If that hook returns `undefined`, the wrapper throws a named
  `[knext-adapter]` error. For `nextRuntime === "edge"` it then appends an
  `IgnorePlugin` that fences `instrumentation-node` and `deep-health-lite` out
  of the edge bundle.
- `onBuildComplete` logs a failed CDN-artifact write and does not throw. It
  skips the upload when `STORAGE_BUCKET` is unset.

### Cache

- Redis faults fail open. A fault in `cache-handler.js:redisCall` (every cache
  command, including the `del` in `set(key, null)`; the best-effort event-log
  batch is outside it and drops a failure silently), an ioredis connect that
  fails (`waitForReady`), or a native connect that throws or resolves with the
  client still disconnected (`waitForNativeReady`) calls `markUnhealthy`, which
  opens a circuit breaker for `REDIS_RETRY_COOLDOWN_MS` and closes the current
  client. A fault on a client that is no longer current (a connect, or a command
  through `redisCall(fn, client)`) closes only that client and leaves the
  breaker alone. Concurrent callers for the
  same client share one in-flight connect on both clients (`connectClient`'s
  `connectInFlight`, keyed by client), so a burst of first requests dials that
  client once; a connect settling for a client that was dropped meanwhile hands
  out nothing. Until the breaker closes, ISR `get`
  misses and Next renders from the origin, and `set` writes nothing locally: the
  per-process memory store serves only when Redis is not in use (no `REDIS_URL`,
  or a client that could not be loaded). `use-cache-handler.js` has no
  in-process fallback: while Redis is down, `get` is a miss and `set` is
  dropped. Its `get`, `getExpiration` and `updateTags` never throw.
- `cache-handler.js:execAtomic` writes the entry and its tag index together in
  `MULTI`/`EXEC`, not a pipeline. It assumes a single-node Redis topology.
- `cache-handler.js:__redisTtlSeconds` uses `expire` if given. Otherwise the
  TTL is `max(revalidate * 2, 3600)`, and 3600 when neither is set.
- Entries from a foreign build:
  - `isForeignPostponedEntry` returns a MISS for an `APP_PAGE` entry that
    carries a `postponed` value from another build.
  - Foreign page and route entries are returned with `revalidate: 1`.
  - `isBuildLive` fails closed.
  - `fileBuildId` treats Next's constant build ID `build-TfctsWXpff2fKS` as no
    ID at all.
- Mutating test seams (`assertTestSeamEnabled`) always throw when
  `NODE_ENV=production`. Otherwise they need `KNEXT_TEST_SEAMS=1`.
- A `set(key, null)` delete that could not reach Redis (breaker open, or the
  delete faulted) is remembered and replayed, before the tags, once the breaker
  closes. Like the tag list it is per process: a restart or scale to zero first
  drops it, and the entry lives to its TTL. The replayed `DEL` has no generation
  check, so it can also remove an entry a later `set` wrote meanwhile; the next
  request re-renders it.
- The invalidation replay backlog is capped at 1000 tags and deletes together. Past that, it
  collapses to a prefix sweep. `collapseSweepAllowed` refuses the empty prefix
  and the shared legacy default key prefix (bare, or with a `:*` wildcard). A CDN purge is sent only for tags whose Redis
  invalidation completed.
- `cache-write-registry.js:drainCacheWrites` never rejects and is bounded by
  `timeoutMs`.
- `onProcessExit` keeps its reporters in one `globalThis` set
  (`Symbol.for('knext.core.cache.exitReports')`) and installs one
  `process.once('exit', …)` per process (the first copy's `runExitReports`,
  kept under `Symbol.for('knext.core.cache.exitReportsListener')`). Each call
  checks the live listeners, so a removed listener is put back by the next
  `onProcessExit` call. Reporters run synchronously and a throwing one is swallowed.
- A process that exits with a replay backlog logs one
  `[CacheHandler] exiting with … not yet replayed to Redis` line per handler (#2384).
  The ISR handler calls `onProcessExit` on every recorded skip (the set dedups
  the reporter, and the call restores a removed listener); the `'use cache'`
  handler arms once per core, so it does not restore one. The ISR line names the edge purge
  only when tags (or a collapse) are lost; deletes hold none back. No counter.
  A backlog already replayed reports nothing.
- `cache-control-normalize.cjs:normalizeCacheControl` applies only to GET and
  HEAD and leaves `immutable` responses alone. The CDN edge decision fails
  closed: on any error the edge is skipped and foreign edge headers are
  stripped.
- `collapseSweepAllowed` lives in `use-cache-handler.js` and is the one guard
  both collapse sweeps share (the ISR handler's and the `"use cache"`
  handler's).

### CDN

- `cdn-edge.cjs:loadCdnConfig` returns `null` unless the provider is a known
  row and the prefix matches `/^[0-9a-f]{12}$/`.
- `decideEdge` caches at the edge only for GET/HEAD responses with status 200
  and an `s-maxage`, and only when the request has no private, no-store,
  no-cache, set-cookie, authorization or draft-mode marker.
- `decideEdge` returns `result: 'immutable'` (no edge headers, Next's own
  `Cache-Control` kept) for an `immutable` response, separately from a skip.
- `decideEdge` fails closed (skips the edge) in all of these cases:
  - a non-canonical or undecodable path, `/api/cache`, or a path under
    `KNEXT_CDN_EXCLUDE_PATHS` (`excluded_path`);
  - a missing routing artifact;
  - a middleware-matched path, unless it is under `KNEXT_CDN_INCLUDE_PATHS`
    (`includePaths` overrides only the middleware rule);
  - the RSC rules: `rsc_without_rsc_param`, `rsc_param_without_rsc_header`,
    `rsc_content_type_mismatch` and `rsc_not_query_keyed`;
  - an unresolved or foreign build;
  - no `_N_T_` tag among the request's own tags (`tags_missing`);
  - tag overflow, or a zero TTL.
- The edge max-age is `min(s-maxage, htmlTtlSeconds)`.

### Supervisor and preloads

- Once the child is serving, the supervisor's first deferred step (`self-warm`, in
  `node-server.ts`, before the metrics collector) requests each `KNEXT_WARM_PATH`
  path (opt-in: none unless set; `KNEXT_EAGER_WARM=0` off; at most 8; logs
  `WARMED:` lines) on `127.0.0.1:$PORT` with
  `x-knext-warm: 1`, one at a time, never following a redirect, and never
  throwing; it skips the warm-up if nothing listens yet, shares one 5 s
  budget across all paths, and stops on shutdown. It runs wherever this
  supervisor runs: disk mode, and exec mode where the supervisor spawns the
  compiled executable. The self-contained executable image has no supervisor;
  it warms through its own entry (`knext-bun-entry.mjs`, on by default with
  `/api/health`, ADR-0042).
- What each runtime path loads before the server:
  - **Disk mode** (`node-server.ts` supervisor, a Node or Bun `server.js` child):
    the supervisor runs every `PROCESS_START_PRIMERS` entry in-process
    (`runProcessStartPrimers`) before it spawns the child. The child gets `--require` `cache-control-normalize.cjs`,
    `request-body-cap.cjs` and `public-origin.cjs` on both runtimes, plus
    `bun-keepalive-guard.cjs` only when the supervisor runs under Bun
    (`process.versions.bun`). Each is added only if its file exists.
  - **Compiled standalone** (`standalone-compile.mjs` `PRELOAD_NAMES`): the
    executable bakes in, in order, `arp-primer.cjs`, `wake-ahead.cjs` (the
    `PROCESS_START_PRIMERS` list), `cache-control-normalize.cjs`,
    `bun-keepalive-guard.cjs`, `public-origin.cjs` and `request-body-cap.cjs`, plus
    `standalone-self-contained-supervisor.cjs` for a self-contained build. A
    missing file aborts the compile. In the disk-compiled image the
    `node-server.ts` supervisor still runs (`STANDALONE_SERVER_EXEC`): it primes
    ARP itself and drops its own `--require` list, since the executable already
    carries the preloads (`standalone-exec.ts`). A self-contained build has no
    `node-server.ts` supervisor process; `standalone-self-contained-supervisor.cjs`
    takes its place inside the executable.
  - **vinext** (`vinext-compile.mjs`): the single executable imports
    `arp-primer.cjs`, `bun-serve-keepalive-guard`, the sidecar installer (not in a
    self-contained build) and `bun-serve-cache-control-install`, each fail-closed.
    It does not load `cache-control-normalize.cjs`, `request-body-cap.cjs`,
    `public-origin.cjs` or `bun-keepalive-guard.cjs`. The vinext-on-Node entry
    (`templates/app/knext-node-entry.mjs.hbs`) imports `arp-primer.cjs` and
    `response-cache-control`.
- `node-server.ts` installs `registerDbPoolDrain` and the SIGTERM/SIGINT
  handlers before it spawns the child. A spawn `error` exits with code 1.
- `shutdown.ts:gracefulShutdown` guards against re-entry. It closes the
  closables, sends `child.kill('SIGTERM')`, then awaits the drains after the
  child exits. Drains run concurrently and their rejections are swallowed.
  When the grace cap is hit, it exits 0 with a warning.
- `env.ts:buildChildEnv` forces `HOSTNAME` to `""`. It never sets
  `KNEXT_POD_NAME` to a bind or loopback address, and never overwrites an
  explicit value.
- `request-body-cap.cjs`:
  - The default cap is 8 MiB, and `0` means no cap.
  - A declared `Content-Length` over the cap gets a 413 before the handler
    runs. Streamed bytes are counted.
  - After a 413, the rest of the body is discarded for up to 2000 ms or
    16 MiB.
- `public-origin.cjs:rewriteLocation` rewrites only a `Location` that points at
  a wildcard bind address. The host comes from the allowlist only, and
  `X-Forwarded-Proto` is never read. With an empty allowlist, nothing is
  installed.
- `sidecar-runtime.mjs:installSidecarResolution` fails closed with
  `MODULE_NOT_FOUND`. A resolved real path must stay inside the sidecar root.
- `arp-primer.cjs:primeArpNow` never throws or blocks, and runs only on Linux.
- `wake-ahead.cjs:wakeAheadNow` never throws or blocks the server start; each call
  is bounded by `WAKE_TIMEOUT_MS` and by the shared primer abort.
- On SIGTERM, `node-server.ts` and `standalone-self-contained-supervisor.cjs` call
  `abortPrimers()` first, so no wake-ahead request outlives the drain.
- `bun-keepalive-guard.cjs` is never active on Node. By default it applies
  only to Bun versions below 1.4.

### Observability

- `otel-config.ts:resolveOtelOptions` returns `null` unless
  `OTEL_TRACING_ENABLED === 'true'`.
- `metrics.ts:statusClass` emits only the labels `1xx` to `5xx` or `other`,
  never a raw status code or path.
- `initRuntimeMetrics` is idempotent.
- `deep-health-lite.ts:startDeepHealthLite`'s listener appends the CDN,
  `"use cache"` and in-process FFI metric expositions (`readSeamMetrics`) to
  the deep-health body on every `GET /metrics`, even when the gate gives an
  empty body. A seam that is absent or throws contributes `""`.
- The deep-health scrape hook only probes after recent DB activity, runs one
  probe at a time, caches results for 10 s, and fails open.
- `deep-health-lite.ts:gateOpen` fails closed: with no activity slot, it does
  not probe and returns an empty body.
- `correlation-response.ts` never overrides an app's own `x-request-id`.

### Images

- `vinext-image-optimizer.ts:handleImageRequest` handles only `/_next/image`
  with a same-origin `url` and a finite `w > 0`. Any other request passes
  through. Output formats are limited to webp, avif, jpeg and png.
- `vinext-image-optimizer.ts:knextImageOptimizer` fails open: any transform
  error returns the original bytes, labelled with their real `sourceFormat`
  rather than the requested format, instead of an error status.
- `sharp-addon-dlopen.mjs` checks every native payload the integrity manifest
  lists against its sha256 and throws on a mismatch, or on a manifest version
  it does not know. A missing manifest is only a warning and the addon loads
  unverified, unless `KNEXT_REQUIRE_NATIVE_INTEGRITY` is set to an "on" value,
  which makes the absence fatal. An unrecognised value for that variable
  throws.
- `sharp-native-extract.mjs` extracts into a directory private to the user and
  rejects path escapes.
- `image-cache-sync.ts:startImageCacheSync` does nothing in these cases:
  `STORAGE_BUCKET` is unset, `images.customCacheHandler === true`, or the
  cache directory is not writable.

### Compile pipeline

The compile pipeline fails closed.

- `assertBunBaseExe` runs first. `KNEXT_BUN_BASE_EXE` is refused unless
  `GITHUB_ACTIONS === 'true'`, and it needs a matching `.sha256` file.
- A missing preload or analyzer file makes the script exit 1.
- Under `KNEXT_COMPILE_STRICT_REQUIRES` (forced on by `--self-contained`), any
  unresolved or dynamic require exits 1. `ioredis` is the only exemption.
- When a post-build bytecode check fails, `OUTFILE` is deleted and the script
  exits 1:
  - `standalone-compile.mjs` always runs the check.
  - `vinext-compile.mjs` runs it only in self-contained or include mode.
- `compile-embed.mjs:planIncludes` and `app-data-embed.mjs:planAppData` reject
  paths outside the app root and secret-looking names (`.env*`, `*.pem`,
  `*.key`, `id_*`) unless they are named exactly. They also reject native
  addons.
- The analyzers fail closed. A parse error yields `parseError` and no results,
  never a clean result. `asset-anchor-analyze.mjs` excludes a whole binding as
  soon as one use is excluded.

## Side Effects

### Loading a module patches the process

- `cache-control-normalize.cjs` patches `http.ServerResponse.prototype`
  `setHeader`/`writeHead`. In CDN mode it also patches
  `http.Server.prototype.emit`. Importing `response-cache-control.mjs` or
  `bun-serve-cache-control.mjs` also loads it.
- `request-body-cap.cjs` and `public-origin.cjs` patch
  `http.Server.prototype.emit`. `public-origin.cjs` also patches the
  `ServerResponse` header methods.
- `bun-keepalive-guard.cjs` patches `http.createServer`.
  `bun-serve-keepalive-guard.mjs`, `bun-serve-cache-control.mjs:install` and
  `bun-serve-cache-control-install.mjs` replace `Bun.serve`.
- `standalone-self-contained-supervisor.cjs` patches `http.createServer` and
  `process.exit`, binds `0.0.0.0:METRICS_PORT`, and installs signal handlers.
- `correlation-response.ts` patches `ServerResponse` `writeHead` and
  `setHeader`. `tracing.ts:instrumentPoolForDbWake` patches `pool.connect` and
  `pool.query`.
- Module-resolution and fs patches:
  - `sidecar-install.mjs` patches `Module._resolveFilename`.
  - `standalone-embed.mjs` and `app-data-alias.mjs` patch the `fs` and
    `fs/promises` read APIs.
  - `standalone-embed.mjs` also patches `Module.prototype.require`.
- `arp-primer.cjs` reads `/proc/net/route` and sends one UDP datagram to the
  default gateway on port 9.
- `wake-ahead.cjs` sends one fire-and-forget `GET <url>/healthz` (1 s timeout) to
  each function named in `KNEXT_WAKE_FUNCTIONS`, resolved through its
  `<NAME>_SERVICE_URL`, and logs `[knext] wake-ahead:` lines to stderr.
  `process-start-run.ts` logs `[knext] process-start` lines for a missing or broken
  primer.
- `sandbox-fetch-debug.cjs` and `sandbox-fetch-realm-debug.cjs` are gated by
  `KNEXT_SANDBOX_FETCH_DEBUG=1`. They subscribe to undici diagnostics channels,
  and the realm variant patches `net` and `tls` connects and rewrites Next's
  `sandbox/context.js` on disk.

### Processes and listeners

- `node-server.ts` spawns the Next child with `--require` preloads (script mode),
  or, when `STANDALONE_SERVER_EXEC` is set, the compiled executable with no
  arguments (`standalone-exec.ts`), and binds the metrics listener on
  `METRICS_PORT`. It calls `process.exit` when the child
  exits.
- `metrics.ts:startChildMetricsServer` and `deep-health-lite.ts` listen on
  `127.0.0.1:9092`, and `fetchChildMetrics` scrapes that address.
- The compile scripts spawn `bun` and the analyzers with `spawnSync`, and write
  `OUTFILE` plus temporary entry files, which are removed in `finally`.
  `compile-embed.mjs` creates and deletes `mkdtemp` directories.

### Network and storage

- Redis is used by the cache and `"use cache"` handlers. `cache-handler.js`
  refreshes `<prefix>:build-live:<id>` with `EX 90` every 30 s or less.
- `cache-handler.js` starts the first-ready CDN purge once per build per
  process (`startCdnFirstReady` → `cdn-purge/index.js:firstReadyPurge`). The
  purger claims a cluster-wide key with Redis `SET … NX EX`, and only the pod
  that wins the claim evicts the app's whole edge presence. A Redis fault
  forgets the attempt, so a later handler construction retries.
- The CDN provider APIs are called through `cdn-purge/`.
- MinIO is used by `image-cache-sync.ts` (through `@getknext/lib/clients`) and
  by the `next-adapter.ts:onBuildComplete` upload.
- Postgres is reached through a lazy `@getknext/lib/health` probe in
  `deep-health-lite.ts`.

### Disk

- `next-adapter.ts:onBuildComplete` writes `knext-cdn-routing.json` and heals
  Bun export targets in the standalone `node_modules`.
- `standalone-adapter-path.ts` rewrites `server.js` and
  `required-server-files.json` in place.
- `image-cache-sync.ts` runs a recursive `fs.watch` on the cache directory.
- `vinext-compile.mjs` always writes a third-party notices file,
  `HARFBUZZ_NOTICE_FILE` (`knext-third-party-notices.txt`), next to `OUTFILE`.
  It carries the HarfBuzz licence text only when `hb.wasm` was embedded.
- `sharp-native-extract.mjs` writes native files under
  `<tmp>/knext-native-<uid>-<hash>`.

### Globals

These keys are set on `globalThis` with `Symbol.for`:

- CDN: `knext.core.cdn.requestTags`, `knext.core.cdn.renderMetrics`,
  `knext.core.cdn.purger`, `knext.core.cdn.metrics`,
  `knext.core.cdn.edgeDecisions` and `knext.core.cdn.foreignEdgeStrips`
- cache: `knext.core.cache.inflight`, `knext.core.useCache.renderMetrics` and
  `knext.cache.useCache.counters`
- `knext.sidecar` (`sidecar-install.mjs`)
- `knext.sharp.nativeRoot` (`sharp-native-extract.mjs:NATIVE_ROOT_KEY`), set by
  the entry `vinext-compile.mjs` generates and read by `sharp-addon-dlopen.mjs`
- `knext.sandboxFetchDebug.installed`, `knext.sandboxFetchRealmDebug.dc` and
  `knext.sandboxFetchRealmDebug.sockets`

`deep-health-lite.ts` reads, but does not set,
`knext.lib.clients.lastDbActivityAt` and `knext.ffi.renderMetrics`.

These `Symbol.for` keys are stamped on other shared objects, not on
`globalThis`:

- install markers: `knext.requestBodyCap.installed` (on
  `http.Server.prototype`), `knext.cacheControlNormalize.installed` and
  `knext.publicOrigin.installed` (on `http.ServerResponse.prototype`),
  `knext.bunKeepaliveGuard.installed` and
  `knext.selfContainedSupervisor.installed` (on the `http` module),
  `knext.bunServeKeepaliveGuard.installed` and
  `knext.bunServeCacheControl.installed` (on the `Bun` object), and
  `knext.sidecarResolution.installed` (on `Module`);
- `knext.selfContainedSupervisor.server` (on `http`) and
  `knext.selfContainedSupervisor.exitState` (on `process`);
- per request or connection: `knext.core.cdn.requestState`,
  `knext.requestBodyCap.gated` and `knext.publicOrigin.arrivalHeaders` (on the
  request), `knext.core.cdn.originCacheControl` and
  `knext.publicOrigin.rewritten` (on the response), and
  `knext.requestBodyCap.linger` (on the socket).

`cache-handler.js` also sets `globalThis.cacheEvents` and
`globalThis.cacheEventCounter`.

The compiled executables carry string globals, written into the generated
entry or the bundle banner: `globalThis.__knextEmbedRoot`
(`standalone-embed.mjs:EMBED_ROOT_GLOBAL`), `__knextStandaloneRoot`,
`__knextStandaloneExecMarker` and `__knextRouteMarker`
(`standalone-compile.mjs`), and `__knextVinextExecMarker`
(`vinext-compile.mjs`).

## Verification

- Run from `packages/kn-next`: `node ../../scripts/bun-test.mjs packages/kn-next`
