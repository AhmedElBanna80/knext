# scripts/lib

## Overview
Shared library modules for the repo's CI guards, gates and mutation provers. Most of these 81 files are pure decision logic over text, JSON, lcov, tarballs or workflow YAML. Thin CLIs in `scripts/` do the I/O and call into them, and specs in `tests/` pin them. A few shell files are sourced by the e2e deploy scripts. This contract was compiled from each file's header comment and its `export` list. It is an index, not a line-by-line reading of all ~27k lines, so treat each file's header as the authority.

## Interface
Grouped by concern. The names listed are the modules' exported symbols.

### Shell and workflow scanning
- `shell-lexer.mjs`: `scanFrames`. This is the shared shell frame-stack scanner.
- `shell-command-position.mjs`: `COMMAND_POSITION_CHARS`, `COMMAND_POSITION_KEYWORDS`, `commandPositionPrefix`, `HATCH_SHAPES`. Also exports `UNEXERCISED_TOKENS`.
- `apply-safety-scan.mjs`: `unsafeApplies`, `unsafeAppliesInWorkflow`, `applyTargets`, `lex`, `splitClauses`, `REMOTE_FETCH_ALLOWLIST`, `STATEMENT_ALLOWLIST`. It fails closed on any `kubectl apply|create|replace -f/-k` whose input is neither checksum-verified nor free of network provenance. Also exports `INTERPRETER_FETCH`, `splitPipeline`, `words`, `unquote`, `extractFunctions`, `canonical`, `commandHead`, `writeSites`, `dynamicNameWrites`, `isLoopbackUrl`, `isLoopbackHost`, `stripNonFetchText`, `hasComputedGlobalAccess`, `hasExtraNetworkShape`, `isFetchSegment`, `unclassifiedFetch`, `textIsNetwork`, `shellErrexit`, `effectiveShell`, `stepGuaranteed`, `jobsLinkedByArtifactOrOutputs`, `scanFrames`.
- `action-script-injection-scan.mjs`: `scanActionText`, `scanWorkflowText`, `scanWorkflowFile`, `scanActionFile`, `RUNNER_CONTROLLED`, `WORKFLOW_GITHUB_ALLOWED`. Also exports `isRunnerControlled`, `expressionsIn`, `workflowExpressionProblems`, `discoverWorkflowFiles`, `discoverActionFiles`.
- `nested-workflow-scan.mjs`: `scanForNestedWorkflows`, `isWorkflowShaped`, `INTENTIONAL_TEMPLATES`.
- `workflow-token-scope.mjs`: `findPrReachableWriteGrants`, `isPullRequestReachable`, `FORBIDDEN_PR_GRANTS`. Also exports `triggersOf`, `ifExcludesPullRequests`, `grantsOf`.
- `workflow-conditioning-shapes.mjs`: `ADMISSIBLE_IF`, `isAdmissibleIf`, `CONTINUE_ON_ERROR_SPELLINGS`. Also exports `INADMISSIBLE_IF_SHAPES`, `ADMISSIBLE_IF_SHAPES`.
- `cron-overlap.mjs`: `parseCron`, `cronsOverlap`, `findOverlappingPairs`.

### Source scanning
- `blank-non-code.mjs`: `blankNonCode`, the repo's single non-code blanker.
- `ts-call-scan.mjs`: `prepare`, `callArgs`, `classify`, `wrappedArgvs`, `WRAPPER_PROGRAMS`. Also exports `lineOf`, `readLiteral`, `matchClose`, `splitTopLevel`, `isIndexAccess`, `stringLiterals`, `progName`.
- `cli-cluster-write-scan.mjs`: `ALLOWED_KINDS` (`NextApp`, `BackendService`), `KIND_EXCEPTIONS`, `MANIFEST_WRITES`, `scanClusterWriteTree`, `scanClusterWriteSource`, `WRITE_SCOPE_DIRS`. Also exports `KIND_UNREADABLE_WAIVERS`, `checkManifestKinds`, `kindsOfSource`, `writeScopeFiles`.
- `cli-spawn-scan.mjs`: `scanSpawnTree`, `scanSpawnSource`, `SPAWN_SCOPE_DIRS`, `DYNAMIC_SPAWN_ALLOWLIST`. Also exports `spawnScopeFiles`, `classify`.
- `server-action-auth-scan.mjs`: `scanTree`, `scanSource`, `gateVerdict`, `AUTH_CALLS`, `ALLOWLIST`, `SCAN_ROOTS`. Also exports `ASYNC_AUTH_CALLS`, `MUTATING_METHODS`, `SENSITIVE_READS`, `listScanFiles`, `collectSurfaces`.
- `published-export-scan.mjs`: `scanPackage`, `SEAM_PREFIX`, `enumerateEntries`. Also exports `createCtx`, `readExports`, `describeFinding`. Reads CommonJS post-hoc attachment on exported bindings, including `Object.defineProperty` descriptors (`value`, shorthand `value`, getter returns); an unreadable descriptor is a finding.
- `unused-export-scan.mjs`: `scanUnusedExports`, `scanTree`. Also exports `PACKAGE_DIR`, `SCOPE_DIR`, `isScopedSource`, `declarationCompanions`, `exportedNames`, `publicSourceFiles`, `readTrackedFiles`.
- `scratch-space-scan.mjs`: `repoRootedWrites`, `unpairedTempDirs`, `countTempDirSites`. Also exports `WRITE_CALLS`, `classifyPathExpr`.
- `test-skips.mjs`: `scanSkips`, `skipCount`, `SKIP_FORMS`. Also exports `CONDITIONAL_FORMS`, `artifactGatedSkipCount`.
- `test-framework-import.mjs`: `importsFrom`.
- `bun-test-no-skip.mjs`: `skipViolation`.
- `ffi-stage-claims.mjs`: `findClaims`, `scanTree`, `adrStage`. Also exports `ADR_PATH`, `sentences`, `isCovered`, `coveredCount`.
- `retracted-figures.mjs`: `findUncorrected`, `matchesFigure`. Also exports `normalize`, `citedIssues`, `assembleSources`, `correctsFigure`.
- `request-byte-cap.mjs`: `auditRequestByteCap`, `ENV_VAR` (`KNEXT_MAX_REQUEST_BYTES`), `DEFAULT_MAX_REQUEST_BYTES` (8 MiB). Also exports `METRICS_MAX_REQUEST_BYTES`, `BUN_COUNTED_BODY_FLOOR`, `CANONICAL_CONTRACT`, `BUN_FLOOR_SOURCE`, `discoverSrvxServeSites`, `isSrvxServeSite`, `serveCalls`, `loadCapResolver`, `auditCapResolver`, `auditBunFloor`.
- `runtime-entry-copies.mjs`: `auditRuntimeEntryCopies`, `CANONICAL_TEMPLATES`. Also exports `CANONICAL_TEMPLATE_DIR`, `COPY_BASENAMES`, `GENERATED_BY_MARKER`, `DIVERGENT`, `stripGeneratedByHeader`, `discoverRuntimeEntryCopies`, `sha256`.
- `dockerfile-base-images.mjs`: `checkDockerfiles`, `discoverDockerfiles`, `parseDockerfileRefs`. Also exports `EXCLUSION_FILE`, `KNOWN_CHECKS`, `exclusionProblem`, `isExpired`, `loadExclusions`, `isExcluded`.
- `crane-pin.mjs`: `scanCranePins`, `verifyPinAgainstChecksums`, `assertLockstep`. Also exports `filenameForPin`, `scanCraneVersionComments`, `parseChecksumsTxt`.
- `crd-schema-diff.mjs`: `diffCrd`, `diffOpenApiSchema`, `applyWaivers`, `validateWaiverEntry`. Also exports `diffCrdVersionSchema`, `WAIVER_KEYS`.
- `ratchet-floors.mjs`: `RATCHET_FLOOR_MARKER`, `extractRatchetFloors`, `findLoweredFloors`.

### Coverage
- `coverage-policy.mjs`: `THRESHOLDS` (`lines: 77`, `functions: 74`), `PER_PATH_THRESHOLDS`, `HONEST_THRESHOLDS`, `COVERAGE_INCLUDE`, `COVERAGE_EXCLUDE`, `assertEveryMetricAccountedFor`. Also exports `BUN_COVERAGE_DIR`, `MERGED_LCOV`, `HONEST_PER_PATH_THRESHOLDS`, `GATED_METRICS`, `COVERAGE_METRIC_EXCEPTIONS`, `activeMetricExceptions`.
- `lcov.mjs`: `parseLcov`, `mergeLcov`, `formatLcov`, `summarize`. Also exports `normalisePath`, `isTypeOnly`, `countCodeLines`, `codeLineNumbers`, `matchesGlob`.
- `coverage-denominator.mjs`: `generateDenominator`.
- `executable-lines.mjs`: `classifyLines`, `honestCoverage`. Also exports `isExecutableClass`.
- `continuation-attribution.mjs`: `attributeContinuations`. Also exports `continuationAnchors`.
- `coverage-wiring.mjs`: `auditCoverageWiring`.
- `dated-exemptions.mjs`: `activeExemptions`, the single dated-exemption reader.

### Mutation provers
- `mutation-harness.mjs`: `snapshot`, `mutate`, `restore`, `withSnapshot`, `assertAnchorOnce`, `MUTATION_MARKER`, `MutationHarnessError`. Also exports `COMMENT_PREFIX`, `countOccurrences`, `anchorProblems`, `assertAnchorsResolved`, `saveSnapshot`, `loadSnapshot`.
- `guard-prover.mjs`: `createGuardProver({ repoRoot, spec, subjects })`, `runSpecExit`, `assertTreeClean`. Also exports `gitRun`, `runSpecCapture`, `baselineFailureReport`.
- `prover-report.mjs`: `PROVER_SUMMARY_PREFIX` (`::prover-summary::`), `declareMutations`, `recordMutation`, `parseProverSummary`.
- `prover-lane.mjs`: `PROVER_RE` (`/^mutation-prove-.*\.mjs$/`), `discoverProvers`, `auditProverSource`, `evaluateProverRun`. Also exports `RESOLVER_DEFINITION_FILE`, `NON_TEST_PACKAGE_MANAGEMENT_FILES`, `NON_JS_TEST_SUITE_PROVERS`, `NON_JS_TOOLCHAINS`, `SHARED_MUTATION_DRIVERS`, `isSharedMutationDriver`, `codeStringLiterals`, `codeWithLiterals`, `mutatesViaHarness`, `auditRunnerResolution`, `readProver`, `specFramework`, `referencedSpecs`, `auditSpecFrameworkMatch`, `proverSubjectPaths`, `auditAnchorLiveness`, `proverPathBindings`, `PROVER_AUDIT_EXEMPTIONS`, `SELF_ASSERTING_PROVERS`, `auditSelfAsserting`, `GUARD_PROVER_EXEMPTIONS`, `activeProverAuditExemptions`, `activeGuardProverExemptions`.
- `prover-shard.mjs`: `shardProvers`, `buildMatrix`, `aggregateReports`, `LANE_REFS`. Also exports `parseShardSpec`, `PROVER_WEIGHT_MINUTES`, `WEIGHTED_ON_ONE_REF_ONLY`, `proverWeight`, `ISOLATED_PROVERS`, `estimateShardMinutes`, `refSlug`, `reportFileName`, `makeReport`, `proverTimeoutMs`.
- `prover-anchor-scan.mjs`: `auditProverAnchors`. Also exports `KNOWN_STALE_PROVER_EXEMPTIONS`, `activeStaleProverExemptions`, `findProverFiles`, `scanProverFile`.
- `prover-completion.mjs`: `assessCompletion`. Also exports `evaluatePreflight`.
- `known-red-provers.mjs`: `KNOWN_RED_PROVERS` (currently `[]`), `classifyFindings`. Also exports `knownRedMarkdown`.
- `parse-validity.mjs`: `jsStillParses`.
- `ci-blocking-gate-proof.mjs`: `GATES`, `runGateTest`, `diagnoseNothingRan`. Also exports `GATE_TEST_NAME`, `CI_YML`, `jobAnchor`, `disarmReplacement`, `disarmAnchor`, `resolveTestRunner`, `resolveSpecRunner`, `declaredTestTitles`, `NOTHING_RAN_CAUSES`, `explainNothingRan`.
- `publish-markers-proof.mjs`: `MUTATIONS`. Also exports `CONCURRENCY_SPEC`, `GATE_SPEC`.
- `lane-resources.mjs`: `evaluateResources`, `readResources`. Also exports `DEFAULT_THRESHOLDS`, `thresholdsFromEnv`, `parseMeminfo`, `runawayReason`, `isSafeGroupTarget`, `countProcesses`, `sampleLine`, `describeResources`, `REGENERABLE_BUILD_DIRS`.
- `lane-branch.mjs`: `laneBranchFromEnv`.
- `kill-process-tree.mjs`: `killProcessTree`, `killAllProcessTrees`.

### Packaging, publish and release
- `pack-publishable-group.mjs`: `packPublishableGroup`, `rewriteWorkspaceRanges`, `npmPackOne`. Also exports `sha256File`, `readPackManifest`, `tarballDriftProblems`, `canonicalPublishableGroup`.
- `pack-parity-diff.mjs`: `comparePackedTarballEntries`. Also exports `formatPackParityReport`, `groupTarEntriesByName`, `compareTarballEntriesTolerant`, `formatTolerantPackParityReport`.
- `tar-entries.mjs`: `readTarEntries`, which uses node-tar.
- `ga-tarball-diff.mjs`: `compareTarEntries`, `decideGaTarballDiffGate`. Also exports `validateVersionPair`, `parseRcVersion`, `validateVersionBump`, `countVersionOccurrences`, `substituteVersion`, `diffPackageJson`, `diffFileBytes`, `assertEntrySafe`.
- `published-bytes-freeze-check.mjs`: `decidePublishedBytesScope`, `PIN_FILE`. Also exports `ROOT_BUILD_INPUT_FILES`, `OVERRIDE_MARKER_FIELD`, `PIN_FILE_V13`, `releaseLine`, `releasedBaseSupersedesRc`, `selectPinFile`, `publishScopeDirs`, `touchesPublishableScope`, `overrideMarkerValidity`, `overrideMarkerIntroducedByPr`.
- `knext-closure.mjs`: `knextDepsOf`, `assertLocalKnextResolutions`. Also exports `tarballPrefix`.
- `workspace-protocol.mjs`: `findWorkspaceProtocolDeps`.
- `workspace-globs.mjs`: `workspaceGlobs`, `workspaceRoots`.
- `manifest-restore.mjs`: `guardManifests`, `withManifestsRestored`.
- `npm-publish-drift-check.mjs`: `runDriftCheck`, `githubApi`. Also exports `evaluateReviewerProtection`, `matchesVStarGlob`, `tagRulesetCoversVStar`, `evaluateTagRulesetProtection`, `evaluateBranchPolicy`, `fetchReviewerProtection`, `fetchTagRulesetProtection`, `fetchBranchPolicy`.
- `scaffold-npm10-resolve.mjs`: `decideResolveStrategy`. Also exports `parseEtargetPackages`, `stripRangePrefix`, `isGetknextScoped`, `isReleasePrepEtarget`, `buildOverrides`, `applyLocalResolutions`.
- `merge-train.mjs`: `computePreflightVerdict`, `decidePollAction`. Also exports `isFullSha`, `resolveRemoteSha`, `headLockHolds`, `isTestFilePath`, `detectRunnerForContent`, `groupChangedTestFilesByRunner`, `extractFailingTestLines`, `failedCheckRuns`, `formatBlockedDeletionMessage`, `parseDurationSeconds`, `DEFAULT_TIMEOUT_SECONDS`, `DEFAULT_POLL_INTERVAL_SECONDS`.

### Supply chain
- `osv-gate.mjs`: `evaluate`, `parseOsv`, `loadAllowlist`, `MAX_ALLOW_DAYS`. Also exports `HIGH_SEVERITY`, `LOCKFILE_NAMES`, `selectLockfiles`, `isMalicious`, `renderReport`, `FALLBACK_BASES`, `pickBase`.
- `release-age.mjs`: `evaluateAges`, `loadExceptions`, `parseLockfile`. Also exports `readBunfig`, `parseJsonc`, `changedEntries`, `isHashlessUrlSource`, `isExcluded`, `MAX_EXCEPTION_DAYS`, `MAX_UNRESOLVED_EXCEPTION_DAYS`, `registryUrl`, `publishTime`, `renderAgeReport`, `renderUnscannable`, `ageFailed`.
- `precompile-closure.mjs`: `verifyClosureCoverage`, `evaluateFindings`. Also exports `FAILING_SEVERITIES`, `MIN_NPM_COMPONENTS`, `MIN_INSTALLED_PACKAGES`, `MIN_COVERAGE`, `ANCHOR_PACKAGES`, `STANDALONE_ANCHOR_PACKAGES`, `CLOSURE_SHAPES`, `closureShape`, `npmComponents`, `installedPackages`, `ALLOWLIST_ENTRY_KEYS`, `readAllowlistDetailed`, `readAllowlist`.
- `bun-app-closure.mjs`: `resolveAppClosure`, `filterSbomToClosure`.
- `shipped-scan.mjs`: `failingNpmFindings`, `operatorImageRefs`. Also exports `NPM_GROUP`, `TEMPLATE_IMAGES`, `parseNpmView`, `versionsToScan`, `parseNpmAudit`, `loadNpmAllowlist`, `classifyRegistryError`, `publishedTemplateImages`.
- `native-integrity-policy.mjs`: `activeNativeIntegrityExemptions`. Also exports `NATIVE_INTEGRITY_ABSENCE`, `NATIVE_INTEGRITY_EXEMPTIONS`.

### Compat credential and nightly operations
- `credential-slot-watchdog.mjs`: `decideCredentialSlotVerdicts`, `attributeRunsToLanes`. Also exports `DEFAULT_GRACE_HOURS`, `WATCHDOG_LOOKBACK_HOURS`, `WATCHDOG_MAX_WINDOW_HOURS`, `DEFAULT_CREDENTIAL_LANES`, `parseSimpleDailyCron`, `extractScheduleCrons`, `extractEnvExpressionLine`, `parseCredentialCronsFromCompatMode`, `parseLaneMapFromKnextLane`, `resolveCredentialLaneCrons`, `resolveCredentialLanes`, `parseAllDeclaredSlots`, `mostRecentSlotAtOrBefore`, `mostRecentFireAtOrBefore`, `computeExpectedSlots`, `watchdogWindow`, `dueFiresInWindow`, `detectAmbiguousAttribution`, `anyLaneNeedsAlert`.
- `dispatch-poll.mjs`: `pickDispatchedRun`, `withRetry`. Also exports `isTerminalStatus`, `isRedConclusion`, `shippedPinRef`, `SHIPPED_PIN_CELLS`.
- `soak-readiness.mjs`: `evaluateSoakReadiness`. Also exports `SOAK_REQUIRED_STREAK`, `deriveCellRunsFromWindow`, `evaluateCellReadiness`.
- `smoke-manifest.mjs`: `deriveSmokeManifest`. Also exports `SMOKE_INCLUDE`, `renderSmokeManifest`.
- `scale-suite-tolerance.mjs`: `decideScaleSuiteAction`, `reconcileScaleSuiteIssue`. Also exports `SCALE_SUITE_ISSUE_TITLE`.
- `nightly-alert-issue.mjs`: `ensureAlertIssue({ gh, repo, title, body })`.

### E2E helpers
- Sourced shell:
  - `e2e-empty-dir.sh`: `ed_stage`, `ed_assert_clean`, `ed_probe_http`, `ed_boot_probe_kill`, `ed_static_probe_path`, `ed_check_or_die`, `ed_suite_stage`, `ed_suite_hand_off`, `ed_assert_suite_isolated`, plus the `ed_own_dir`/`ed_disown_dir` ownership helpers and their exit traps.
  - `e2e-state-snapshot.sh` (sourced by `e2e-deploy.sh`): `snapshot_state` and `restore_state <dir> <tarfile> <keep-relative-dir>`, which restore the standalone tree after the compile-cache bake, keeping only the compile-cache directory.
  - `musl-lockfile-lookup.sh` (POSIX sh, side-effect-free): `lockfile_key`, `pinned_lockfile_dir_for`, `musl_lockfile_specs_for_root`, `musl_lockfile_mounts`.
- Script: `e2e-verify-intentional-500.sh`.
- Node probes: `e2e-probe-http.mjs`, `e2e-read-base-path.mjs`, `e2e-vinext-base-path.mjs`.
- `e2e-eresolve-retry.mjs`: `decideRetry(log)` and a CLI over an npm install log. Prints `retry` (exit 0) only for an npm `code ERESOLVE` refusal in which `@getknext/` (any case) appears nowhere; `e2e-deploy.sh` retries with `--legacy-peer-deps` only on that exact stdout, so a helper that never decides fails closed. Exit 1 for any other failure or a report that mentions a knext package (no retry); exit 2 if the log cannot be read. It reads the report's text, not the dependency tree: a conflict deeper in knext's tree is retried like a fixture conflict if the report names no `@getknext/` package. Reads one file; writes the verdict `retry` to stdout and any refusal reason to stderr.

### Misc
- `manifest-patch.ts`: `patchManifestJs`.
- `names.ts`: `toDns1123Label`.

## Invariants
- `prover-lane.mjs` and `prover-shard.mjs` state that nothing in them spawns, reads the tree or touches git on import. Their behaviour is testable without running mutations.
- `cli-cluster-write-scan.mjs` allows only the kinds `NextApp` and `BackendService`. Every other write must be a named entry in `KIND_EXCEPTIONS` or `MANIFEST_WRITES`.
- The scanners fail on constructs they cannot read, rather than passing them. This is stated in the headers of `cli-spawn-scan.mjs` and `apply-safety-scan.mjs`.
- `mutation-harness.assertAnchorOnce` aborts unless the anchor occurs exactly once. `prover-report` makes a prover's declared mutation count comparable with the number it ran.
- `nightly-alert-issue.mjs` never calls `gh issue pin` (header comment). Its dedup lookup uses `--limit 100`.
- `dated-exemptions.activeExemptions` is the one dated-exemption reader, shared by coverage, prover and allowlist exemptions.

## Side Effects
- Most modules are pure.
- Modules that import `node:child_process`: `ci-blocking-gate-proof.mjs` (`execFileSync`, `spawnSync`), `guard-prover.mjs` (`execFileSync`, `spawnSync`) and `pack-publishable-group.mjs`.
- `kill-process-tree.mjs` signals processes through an injectable `killFn` (default `process.kill`).
- `nightly-alert-issue.mjs` runs `gh` only through the `gh` function it is given.
- Disk writes:
  - `manifest-restore.mjs`: restores the original `package.json` bytes.
  - `mutation-harness.mjs`: mutates and restores subject files.
  - `pack-publishable-group.mjs`: `mkdirSync` of the destination directory, then `npm pack --pack-destination <dir> --ignore-scripts`.
  - `request-byte-cap.mjs`: `loadCapResolver` writes a temp copy of the runtime contract under `tmpdir()`, imports it, then removes it with `rmSync`.
- Network:
  - `npm-publish-drift-check.mjs`: `githubApi`.
  - `e2e-probe-http.mjs`: `http.get` to `127.0.0.1:<port>`.
  - `apply-safety-scan.mjs` and `scratch-space-scan.mjs` only match text. They do not perform the I/O they scan for.

## Verification
- Run: `node scripts/bun-test.mjs` (from the repo root). The guards are in `tests/`, for example `tests/mutation-harness.test.ts`, `tests/mutation-prover-lane.test.ts`, `tests/cli-spawn-scan.test.ts`, `tests/osv-gate.test.ts`, `tests/server-action-auth-scan.test.ts` and `tests/lcov-merge.test.ts`.
