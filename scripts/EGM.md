# scripts

## Overview
This directory holds the repo's tooling: CI guards and gates, release and publish automation, the e2e drivers for the official Next.js compatibility harness, kind e2e assertions, supply-chain scans, and the mutation-prover fleet. It contains 290 top-level files (275 `.mjs`, 13 `.sh`, one `.ts` and one `.json`). 166 of them are `mutation-prove-*.mjs` provers, and the rest are mostly single-purpose CLIs over the pure logic in [lib](./lib/EGM.md). This contract was compiled from each file's header comment and `export` list. It is an index, so treat each file's header as the authority for that file.

## Interface

### Test runner and local gates
- `bun-test.mjs`: runs the suite under `bun test`, one process per test file. Flags: `--coverage`, `--no-skip`, `--concurrency=N`, `--bun=PATH` (default `KNEXT_BUN` or `bun`), `--junit-dir=`, `-t <name>`. Positional arguments select the target files.
- `check-coverage.mjs`: merges the per-file lcov and enforces the floors from `lib/coverage-policy.mjs`.
- `prepush.mjs`: exports `runSteps`. Its internal `DEFAULT_STEPS` list runs `biome check`, then a temp-dirs test, then `bun run typecheck`.
- `assert-tree-unchanged.mjs snapshot|check <file>`: compares `git status --porcelain --untracked-files=all` before and after a run.

### Mutation provers
- 166 files named `mutation-prove-*.mjs`. Each one mutates a guard's subject and requires the guard's spec to go red.
- Shared drivers: `lib/prover-report.mjs` (imported by all 166), `lib/mutation-harness.mjs` (97) and `lib/guard-prover.mjs` (95).
- Lane tooling: `run-mutation-provers.mjs` (flags `--shard <i>/<n>`, `--list`, `--report <file>`), `prover-lane-plan.mjs` (`parseRefs`, `resolveRef`), `prover-lane-aggregate.mjs`, `prover-lane-known-red.mjs`.
- Shell driver: `mutate-prove.sh`.
- Other provers: `prove-publish-lane-guard-mutants.mjs`, `mutate-self-contained-dockerfile-proof.mjs`, `use-cache-collapse-keys-mutation.mjs`.

### Official-harness compat e2e
- Deploy, logs and cleanup scripts: `e2e-deploy.sh`, `e2e-deploy-vinext.sh`, `e2e-logs.sh`, `e2e-cleanup.sh`.
- Build helpers: `e2e-native-rebuild-musl.sh`, `e2e-preflight.mjs`.
- Bake and bytecode checks: `e2e-bake-accept.mjs` (`parseWarmedLines`, `evaluateBakeOutcome`), `e2e-bytecode-liveness.mjs` (`deployIsLive`, `isShardBytecodeLive`).
- Run summaries: `e2e-summary.mjs` (`summarize`), `e2e-shard-history.mjs`.

### Compat credential window
- `compat-window-audit.mjs`, `compat-window-fingerprint.mjs` (`computeFingerprint`, `HARNESS_ROOTS`), `compat-run-ledger.mjs`.
- `compat-credential-ref.mjs` (`resolveCredentialRef`), `compat-credential-line.mjs`, `compat-credential-freeze-guard.mjs` (`evaluateFreezeGuard`).
- `compat-line-workflow.mjs`, `compat-line-tracker.mjs`, `compat-matrix-tracker.mjs`.
- Vinext ledgers: `compat-vinext-ledger.mjs`, `compat-vinext-structural-gaps.mjs`.
- `compat-shipped-pin-dispatch-and-wait.mjs`, `compat-sharp-pin.mjs`, `compat-disk-floor-check.mjs`, `credential-slot-watchdog.mjs`, `soak-1304-readiness.mjs`, `generate-smoke-manifest.mjs`.

### Release and publish
- `publish-preflight.mjs`, `publish-lane-guard.mjs`, `verify-published-group.mjs`, `ensure-published-group.mjs`.
- `pack-release-tarballs.mjs`, `rewrite-workspace-ranges.mjs`.
- Tarball and published-bytes checks: `ga-tarball-diff.mjs`, `ga-tarball-diff-gate.mjs`, `published-bytes-freeze-check.mjs`, `published-bytes-select-pin.mjs`, `dependabot-published-bytes-pause.mjs`.
- `release-notes-body.mjs`, `operator-release-notes-body.mjs`, `npm-dist-tag-rollback.mjs`, `publish-verify-alert.mjs`, `rename-for-ghp.mjs`.
- Changesets: `check-changeset-required.mjs`, `list-changeset-marker-branches.mjs`.
- `verify-publish-environments.mjs`, `check-npm-publish-drift.mjs`, `merge-train.mjs`, `merged-sha-check.mjs`.

### Install and scaffold smoke tests
- `install-smoke.mjs`, `install-smoke-probe.mjs`, `smoke-pack-cli.mjs`.
- `scaffold-pack-contents.mjs`, `verify-scaffold-install.mjs`, `verify-scaffold-resolves-npm10.mjs`, `rc-scaffold-platform-e2e.mjs`.
- `verify-anonymous-install.mjs`, `verify-rc-pack-parity.mjs`.

### Supply chain and pins
- Dependency and closure audits: `audit-published.mjs`, `audit-shipped-npm.mjs`, `osv-gate.mjs`, `govulncheck-gate.mjs`, `release-age-gate.mjs`, `precompile-closure-audit.mjs`, `sbom-docs-closure.mjs`.
- `secret-scan.mjs` (`validateAllowlist`, `filterFindings`), `summarize-trivy-fs-report.mjs`.
- Pin checks: `verify-action-pins.mjs`, `verify-image-pins.mjs`, `verify-crane-pin.mjs`, `verify-operator-bundle-image.mjs`, `check-base-images-pinned.sh`, `docker-hub-mirror-guard.mjs`.
- `resolve-shipped-images.mjs`, `resolve-scale-test-image.mjs`, `write-native-integrity.mjs`, `generate-musl-native-lockfile.sh`, `scan-suite-native-addons.mjs`.

### Static repo guards
- `check-escalation-triggers.mjs` (`TRIGGERS`, `ACK_BODY_PATTERN`), `check-config-filename-mentions.mjs` (`OLD_NAME`, `findViolations`).
- Import and closure checks: `check-ts-import-extensions.mjs`, `adapter-import-closure.mjs` (`computeAdapterClosure`).
- `check-ratchet-floors.mjs`, `check-ffi-crate-rev.mjs`, `crd-schema-diff.mjs` (`run`, `CRD_PATH`), `crd-narrowing-waivers.json`.
- `workflow-script-install-guard.mjs`, `verify-phase-gates.mjs`, `verify-retracted-figures.mjs`.
- Repo scans: `scan-dangling-paths.mjs`, `scan-half-scan-candidates.mjs` (advisory only), `scan-mock-hoisting.mjs`, `scan-mutation-residue.mjs`, `scan-published-seams.mjs`.
- `bun-patched-drift.mjs`, `ci-resolve-push-base.mjs`, `next-minor-matrix.mjs`, `gen-cr-fields.ts`, `codemod-vitest-to-bun.mjs`, `biome-format.mjs`.

### Kind and cluster e2e assertions
- CDN: `cdn-e2e-assert.mjs`, `cdn-e2e-purge-assert.mjs`, `cdn-e2e-mutate-preload.mjs`, `cdn-e2e-expect-red.sh`.
- `use-cache-2pod-e2e-assert.sh`, `public-hosts-e2e-assert.sh`, `deep-health-alert-e2e.sh`, `load-test.sh`, `scale-suite-tolerance.mjs`, `nightly-alert-issue.mjs`.
- Redis: `redis-acl-spike.mjs`, `redis-commands.mjs` (`REDIS_COMMANDS`).
- `mutation-prove-2396-redis-acl.mjs` (exports nothing): mutates the operator's Redis ACL surface (the command list, the isolation decision, prefix-ownership ranking, the derived-prefix squat, the command catalog read through `ACL CAT`, provisioner endpoint pinning, the status verdict and requeue, the credentials binding and the finalizer's Secret-over-status decision) and requires the named Go test to go red by exit code. `ONLY=<text>` runs the cases whose name contains it. Envtest cases need `KUBEBUILDER_ASSETS` or `packages/kn-next-operator/bin/k8s` (`make setup-envtest`); without either the prover exits 2.

### Other exported symbols
The scripts below also export these symbols, mostly so `tests/` can import their pure logic. Names already given above are not repeated.
- `adapter-import-closure.mjs`: `specifiersOf`.
- `audit-published.mjs`: `PUBLISHED`, `OPTIONAL_BETA`, `auditScope`, `siblingRangeProblems`, `classifyVulnerabilities`.
- `biome-format.mjs`: `biomeFormat`.
- `bun-patched-drift.mjs`: `UPSTREAM_PR`, `pinnedBunVersion`, `stockVersionFromTag`, `driftVerdict`.
- `cdn-e2e-assert.mjs`: `derivePrefix`, `send`, `headerLines`, `diffResponses`, `isHtml`, `stored`, `hit`, `config`, `CheckFailure`, `must`, `checks`, `zeroDiffProbes`, `runChecks`.
- `cdn-e2e-mutate-preload.mjs`: `MUTATIONS`, `MARKER`, `FOREIGN_BUILD_MUTATIONS`, `FOREIGN_BUILD_MARKER`, `FOREIGN_STALE_MUTATIONS`, `FOREIGN_STALE_MARKER`, `USE_CACHE_TAGS_MUTATIONS`, `USE_CACHE_TAGS_MARKER`, `locate`, `mutate`.
- `cdn-e2e-purge-assert.mjs`: `PAGE_TAG`, `UC_TAG`, `UC_PATH`, `nextTagOf`, `appTagOf`, `ORIGIN_PAGES`, `purgeConfig`, `purgeChecks`.
- `check-changeset-required.mjs`: `NO_CHANGESET_LABEL`, `fixedGroupNames`, `derivePackageRoots`, `isTestOrDocsOnly`, `touchedPackages`, `isChangesetEntryPath`, `parseChangesetFrontmatter`, `hasChangesetEntry`, `hasNoChangesetLabel`, `CONSUMER_VISIBLE_DEPENDENCY_KEYS`, `consumerVisibleManifestChanged`, `decide`.
- `check-config-filename-mentions.mjs`: `trackedFilePaths`, `readTrackedFiles`.
- `check-escalation-triggers.mjs`: `ACK_LABEL`, `LEGACY_ACK_LABEL`, `isStaticSupplyChainPath`, `LOW_PRIVILEGE_SECRETS`, `workflowHoldsCredential`, `referencedPaths`, `invokedPaths`, `moduleEdges`, `shellSourceGaps`, `releaseClosure`, `releasePathClosure`, `classifyContent`, `mergeFired`, `parseNameStatus`, `PUBLIC_MANIFEST_KEYS`, `publicSurfaceChanged`, `classify`, `isAcknowledged`, `stripComments`.
- `check-ratchet-floors.mjs`: `collectFloors`, `collectAllowlist`, `resolveMergeBase`, `RatchetFloorGuardError`.
- `check-ts-import-extensions.mjs`: `findTsExtensionImports`.
- `ci-resolve-push-base.mjs`: `resolvePushBase`.
- `codemod-vitest-to-bun.mjs`: `callHoisted`, `liftImportOriginal`.
- `compat-credential-freeze-guard.mjs`: `PIN_FILE`, `GUARD_SELF_FILES`, `isFrozen`, `markerValidity`, `markerIntroducedByPr`, `isMarkerNarrowingOnly`, `evaluateRcTagChange`, `frozenFileSet`.
- `compat-credential-line.mjs`: `CREDENTIAL_LINES`, `lineSpec`, `isLineTag`, `isLineRef`, `resolveLineCredentialRef`.
- `compat-credential-ref.mjs`: `PIN_FILE`, `COMPAT_MODES`, `isRcTag`, `isRcRef`, `gitLsRemote`.
- `compat-disk-floor-check.mjs`: `evaluateDiskFloor`, `getFreeBytes`.
- `compat-line-tracker.mjs`: `lineGh`, `fetchLineLedgers`, `auditLine`, `buildLineTrackerBody`, `upsertLineTracker`.
- `compat-line-workflow.mjs`: `sha256`, `SOURCE_SHAPES`, `sourceShapeOf`, `lineSubstitutions`, `localImportSpecifiers`, `lineGuardClosure`, `lineGuardDigests`, `deriveLineWorkflow`, `parseDerivedHeader`, `underiveLineWorkflow`, `checkLineWorkflow`.
- `compat-matrix-tracker.mjs`: `TRACKER_TITLE`, `TRACKER_LABEL`, `CREDENTIAL_RESET_LABEL`, `formatCellRow`, `buildTrackerBody`, `FETCH_FAILURE_REASONS`, `looksLikeFetchFailure`, `findTrackerIssue`, `PINNED_ISSUES_QUERY`, `UNPIN_ISSUE_MUTATION`, `PIN_ISSUE_MUTATION`, `ensurePinned`.
- `compat-run-ledger.mjs`: `DEFAULT_OUT_FILE`, `DEFAULT_SUMMARY_DIR`, `DEFAULT_FINGERPRINT_FILE`, `parseShardId`, `parseShardTotal`, `buildLedger`, `renderTable`, `renderRedDetail`, `readSummaries`, `readJsonObject`.
- `compat-vinext-ledger.mjs`: `LEDGER_FILE_CAP`, `MAX_EXPIRY_DAYS`, `LANES`, `CLASSES`, `FLAKY_FILE_CAP`, `FLAKY_MAX_EXPIRY_DAYS`, `FLAKY_MIN_EVIDENCE_RUNS`, `FLAKY_WINDOW`, `LANE_WORKFLOW`, `LANE_WORKFLOW_PATH`, `DEFAULT_NEXTJS_REF`, `EXPECTED_SHARD_TOTAL`, `MAX_CONSECUTIVE_HISTORY_SKIPS`, `LISTING_RETRY_ATTEMPTS`, `LISTING_RETRY_BASE_MS`, `validateLedger`, `applyLedger`, `staleEntries`, `publishedNumber`, `refreshSnapshots`, `skippedWarnings`, `isCompleteDefaultRun`, `flakyWindow`, `isAuthOrApiError`, `classifyListingError`, `retryAfterMs`, `isNoArtifactError`, `previousRunCandidates`, `downloadRun`, `collectHistory`, `verifyEvidence`, `isShallowRepo`, `deriveAddedFromGitLog`, `verifyAddedDates`, `readSummaries`, `flakyHistory`.
- `compat-vinext-structural-gaps.mjs`: `STRUCTURAL_FILE_CAP`, `STRUCTURAL_CANONICAL_FILES`, `STRUCTURAL_MAX_REVIEW_DAYS`, `STRUCTURAL_LANES`, `STRUCTURAL_BUILDER`, `STRUCTURAL_CLASS`, `STRUCTURAL_REASON`, `manifestIncludes`, `manifestExcludes`, `validateStructuralGaps`, `structuralEntries`, `structuralApplyRefusal`, `overlapWithPerFile`, `staleStructural`, `loadStructuralGaps`.
- `compat-window-audit.mjs`: `WINDOW_REQUIRED_RUNS`, `WINDOW_REQUIRED_NIGHTS`, `MIN_RUN_SPACING_HOURS`, `CREDENTIAL_LANE`, `CREDENTIAL_CELLS`, `AUDIT_SCOPES`, `DEFAULT_FETCH_LIMIT`, `LANE_MARKER_PREFIX`, `laneFromArtifacts`, `MODE_MARKER_PREFIX`, `modeFromArtifacts`, `claimsCredential`, `PRE_KNEXT_PHASES`, `UNRESOLVED_REASONS`, `unresolvedNight`, `isUnresolved`, `gradeNight`, `selectLaneNights`, `parseScheduleCrons`, `parseCredentialCronsFromWorkflow`, `credentialCronForLane`, `MISSING_NIGHT_GRACE_HOURS`, `auditWindow`, `auditCredentialMatrix`, `formatMatrix`, `formatReport`, `readLedgerDir`, `fetchLedgers`.
- `compat-window-fingerprint.mjs`: `SCHEMA`, `workflowRootForLane`, `collectHarness`, `SERVED_FROM_LIB`, `SC_SERVED_FROM`, `readHarnessServedFrom`.
- `crd-schema-diff.mjs`: `WAIVERS_PATH`, `readWaivers`, `resolveLatestVTag`, `readCrdAtRef`, `readCrdFromDisk`.
- `credential-slot-watchdog.mjs`: `REPO`, `WORKFLOW_FILE`, `WATCHDOG_WORKFLOW_FILE`, `RUNS_PER_PAGE`, `MAX_RUN_PAGES`, `fetchScheduledRuns`, `fetchWindowRuns`, `attachExactLanes`, `resolveCheckAnchors`, `evaluateWatchdog`, `runWatchdogFromEnv`, `formatWindow`, `runCli`.
- `dependabot-published-bytes-pause.mjs`: `readPin`, `decide`.
- `docker-hub-mirror-guard.mjs`: `REPO_ROOT`, `MIRROR_HOST`, `MIRROR_ACTION`, `DEFERRED_DERIVED`, `DEFERRED_PINNED`, `EXEMPT_NO_DOCKER_PULL`, `DEFERRED_FROZEN`, `DEFERRAL_TRACKER`, `UNMIRRORED_BASELINE`, `pullSites`, `baselineDrift`, `firstPullIndex`, `imageRefOk`, `findViolations`.
- `e2e-bytecode-liveness.mjs`: `NODE_CACHE_ACCEPTED_FLOOR`, `NODE_CACHE_HIT_RATIO_FLOOR`, `LIVENESS_RUNTIMES`, `countNodeCompileCache`, `parseBootLine`, `summarizeBootLedger`.
- `e2e-shard-history.mjs`: `classifyRuns`, `renderLedgerTable`, `summarizeLanes`.
- `ensure-published-group.mjs`: `DEFAULT_MAX_ATTEMPTS`, `defaultBackoffMs`, `GroupStillIncoherentError`, `prereleaseDistTag`, `extractConflictVersion`, `isAlreadyPublishedConflict`, `DEFAULT_RESOLVE_POLL_ATTEMPTS`, `defaultResolvePollBackoffMs`, `pollResolves`, `ensureGroupPublished`, `fixedGroupVersionMismatches`, `npmResolvesAt`, `npmProbe`, `npmPublish`, `DEFAULT_REGISTRY`, `RegistryUnreachableError`.
- `ga-tarball-diff-gate.mjs`: `defaultRunDiff`, `readCredentialRcTag`, `readTargetVersion`, `listGitTagsDefault`, `main`.
- `ga-tarball-diff.mjs`: `run`.
- `govulncheck-gate.mjs`: `parseStream`, `knownModules`, `evaluate`.
- `list-changeset-marker-branches.mjs`: `MARKER_PATHS`, `parseLsRemote`, `classify`.
- `merge-train.mjs`: `REPO`, `runGh`, `fetchPrHead`, `fetchPrView`, `isHeadAncestorOfMain`, `defaultExec`, `runPreflight`, `enqueueAndWait`, `investigateFailure`, `listOpenChildPRs`, `deleteBaseBranch`.
- `merged-sha-check.mjs`: `checkContained`.
- `next-minor-matrix.mjs`: `buildMatrix`.
- `npm-dist-tag-rollback.mjs`: `DEFAULT_REGISTRY`, `DEFAULT_DIST_TAG`, `EXPECTED_GROUP_SIZE`, `discoverGroupPackageNames`, `validateTargetPublished`, `buildRollbackCommands`, `executeCommands`.
- `operator-release-notes-body.mjs`: `parseInstallYaml`, `buildOperatorBody`.
- `pack-release-tarballs.mjs`: `parseArgs`, `resolveGroup`, `buildManifest`.
- `publish-lane-guard.mjs`: `PUBLISH_LANES`, `PREPARED_LANES`, `PRE_MODE_TAGS`, `checkPreMode`, `RELEASE_CUT_REF`, `RELEASE_CUT_MAJORS`, `parseSemver`, `resolveLane`, `recognisedLane`, `preparedDistTag`, `fixedGroupNames`, `checkLaneMajor`, `main`.
- `publish-preflight.mjs`: `WORKSPACE_ROOTS`, `REACHABILITY_PROBE`, `DEFAULT_REGISTRY`, `readWorkspaceManifests`, `publishablePackages`, `decide`, `preflight`, `npmViewSucceeds`, `readIgnoreList`, `RegistryUnreachableError`.
- `publish-verify-alert.mjs`: `verifyAndAlert`.
- `published-bytes-freeze-check.mjs`: `readPin`, `defaultTagResolves`, `defaultRunDiff`, `main`.
- `published-bytes-select-pin.mjs`: `readPinTextAt`, `selectPinFromGit`.
- `redis-acl-spike.mjs`: `MINIMAL_COMMANDS`, `escapeAclGlob`, `aclRulesFor`, `failureKind`, `exitCodeFor`.
- `redis-commands.mjs`: `REDIS_SUBCOMMANDS`, `REDIS_NO_ARG_COMMANDS`, `CLIENT_COMMANDS`.
- `release-notes-body.mjs`: `PACKAGES`, `isPrerelease`, `compareSemver`, `releaseFlags`, `notesRelPath`, `buildBody`.
- `rename-for-ghp.mjs`: `OLD_SCOPE`, `NEW_SCOPE`, `GHP_REGISTRY`, `DEFAULT_PACKAGES`, `rewriteScopeString`, `rewriteManifest`, `stageForGhp`.
- `resolve-scale-test-image.mjs`: `isCosignTag`, `isPublishTag`, `collectSignatureDigests`, `selectNewestSignedDigest`, `buildRef`, `listPackageVersions`, `checkPullable`, `resolveScaleTestImage`.
- `rewrite-workspace-ranges.mjs`: `DEP_GROUPS`, `rewriteWorkspaceRange`, `rewriteManifest`.
- `scaffold-pack-contents.mjs`: `CREATE_DIST_ENTRY`, `TEMPLATES_PREFIX`, `scaffoldPackProblems`, `packedFileList`.
- `scan-half-scan-candidates.mjs`: `testBlocks`, `scanSource`, `scanRepo`, `main`.
- `scan-mutation-residue.mjs`: `scanTracked`, `scanForResidue`, `formatReport`.
- `scan-published-seams.mjs`: `main`.
- `scan-suite-native-addons.mjs`: `SUITE_ROOTS`, `extractDeclaredDeps`, `nativeReasons`.
- `verify-action-pins.mjs`: `PINNED_WORKFLOWS`, `discoverWorkflows`, `discoverPinnableFiles`, `parsePins`, `githubApi`, `GIT_FALLBACK_STATUSES`, `runGit`, `gitLsRemoteTag`, `gitCatFile`, `parseActionInputs`, `parseWorkflowCallInputs`, `fetchDeclaredInputs`, `verifyPinInputs`, `resolveTagCommit`, `verifyPin`, `unreadableUsesValues`, `mentionsUses`, `verifyWorkflows`, `verifyPins`, `formatFinding`.
- `verify-anonymous-install.mjs`: `DOCS_INSTALL_SOURCE`, `discoverInstallUrl`, `discoverDocSources`, `findAllInstallUrls`, `findUrlDriftFindings`, `splitYamlDocuments`, `WORKLOAD_KINDS`, `yamlKey`, `extractContainerImages`, `findUnscannedKindImages`, `parseImageRef`, `defaultHttp`, `createRecordingHttp`, `resolveAnonymousManifest`, `verifyAnonymousPull`, `verifyBundle`, `CREDENTIAL_NAME_RE`, `findEnvCredentialLeaks`, `CREDENTIAL_FILE_ENV_VARS`, `classifyAuthStoreCredential`, `dockerAuthStoreHasCredential`, `findFileCredentialLeaks`, `ALLOWED_REQUEST_HEADERS`, `findRequestCredentialLeaks`, `ALLOWED_JOB_ACTIONS`, `ALLOWED_JOB_RUN_COMMANDS`, `ALLOWED_JOB_EXPRESSIONS`, `ALLOWED_JOB_WITH_KEYS`, `FORBIDDEN_TOP_LEVEL_KEYS`, `FORBIDDEN_JOB_KEYS`, `parseJobSteps`, `stepUses`, `parseWithEntries`, `parseEnvEntries`, `ALLOWED_STEP_ENV`, `auditAnonymousWorkflowJob`, `describeFetchFailure`, `fetchInstallBundle`, `runAnonymousInstallCheck`.
- `verify-image-pins.mjs`: `discoverGoSources`, `discoverBenchmarkSources`, `discoverSources`, `parseImageRef`, `parseImagePins`, `resolveTagDigest`, `verifyImagePin`, `basePinKeys`, `verifyRepo`.
- `verify-operator-bundle-image.mjs`: `verifyBundleImage`, `main`.
- `verify-publish-environments.mjs`: `manualChecks`, `evaluatePublishEnvironments`.
- `verify-published-group.mjs`: `DEFAULT_REGISTRY`, `REACHABILITY_PROBE`, `parseSemver`, `caretSatisfies`, `workspaceProtocolProblems`, `fixedGroupProblems`, `POST_POLL_MAX_MS`, `defaultPostPollBackoffMs`, `pollViewVersion`, `registryGroupProblems`, `npmViewVersion`, `npmResolvesAtVersion`, `npmProbe`, `RegistryUnreachableError`.
- `workflow-script-install-guard.mjs`: `REPO_ROOT`, `WORKFLOWS_DIR`, `trackedWorkflowFiles`, `spawnedScriptsOf`, `nonBuiltinPackagesFor`, `resolveScriptPath`, `findViolations`.

### Subdirectories
- [api-surface](./api-surface/EGM.md): public API type-surface report generator and check.
- [bench-cold-start-phases](./bench-cold-start-phases/EGM.md): per-phase cold-start benchmark harness, with [ceiling](./bench-cold-start-phases/ceiling/EGM.md) and [gke](./bench-cold-start-phases/gke/EGM.md).
- [deep-health-alert-e2e](./deep-health-alert-e2e/EGM.md): Prometheus alert assertions for the deep-health e2e.
- [kind-manifests](./kind-manifests/EGM.md): checksum-verified, digest-pinned installs of cert-manager, Knative and Kourier.
- [lib](./lib/EGM.md): pure logic shared by the guards and provers.
- [prereqs](./prereqs/EGM.md): single-command pinned install of the cluster prerequisites.
- [upgrade-e2e](./upgrade-e2e/EGM.md): operator upgrade-under-load e2e.
- `cdn-e2e-red/` (data, no contract): `.txt` files that each list a red leg's expected `check|message` lines. The CDN kind e2e workflows and `tests/cdn-e2e-scripts.test.ts` read them.
- `musl-native-lockfiles/` (data, no contract): committed `package.json` and `package-lock.json` pairs for the musl native addons (sharp, `@img/sharp-libvips`, sqlite3), plus `next-sharp-resolution.json` and `suite-native-addons.json`.

## Invariants
- `lib/prover-lane.mjs` discovers provers only by `PROVER_RE = /^mutation-prove-.*\.mjs$/`. A prover file that does not match is never run by the lane.
- Every `mutation-prove-*.mjs` imports `lib/prover-report.mjs`, so the lane can compare the number of mutations each prover declared with the number it ran.
- `bun-test.mjs` isolates each test file in its own process, because bun's `mock.module` registrations last for the whole run (header comment). With `--no-skip`, a file that reports any skipped or todo test fails.
- `check-config-filename-mentions.mjs` fails on any mention of the old config filename outside its exemptions (`OLD_NAME`, `isExempt`).
- Scripts that fail closed state in their headers that an unreachable upstream is a failure, never a pass. Examples: `verify-action-pins.mjs` and the `RegistryUnreachableError` paths in `publish-preflight.mjs` and `verify-published-group.mjs`.
- `check-ffi-crate-rev.mjs` (`CRATE_PATHSPEC`) watches `crates/knext-ffi/` and `crates/knext-ffi-macros/` and excludes `*.md` with the `:(exclude)*.md` pathspec, so docs-only Markdown never requires moving the `packages/ffi/package.json` `knextFfi.crateRev` pin. Its exit-2 paths (shallow history, unresolvable base ref) fail closed.

## Side Effects
- `redis-acl-spike.mjs` writes to the Redis at `KNEXT_REDIS_ACL_SPIKE_URL` (never `REDIS_URL`): each run creates two throwaway ACL users and removes them and their keys when done.
- Release scripts call the npm registry and GitHub (`gh`), and some publish or alter dist-tags (`ensure-published-group.mjs`, `npm-dist-tag-rollback.mjs`).
- Pack and smoke scripts write tarballs and temp directories. `rewrite-workspace-ranges.mjs` rewrites `package.json` files in the tree. `install-smoke.mjs` guards them with `lib/manifest-restore.mjs:guardManifests`, which restores every workspace `package.json` afterwards.
- The e2e shell drivers (`e2e-deploy.sh`, `e2e-cleanup.sh`) build and boot an app locally and persist its `BUILD_ID`, `PORT` and `PID` to `.adapter-build.log`; `e2e-cleanup.sh` reads that file and stops the server. The cluster assertion scripts (`deep-health-alert-e2e.sh`, `load-test.sh`, `public-hosts-e2e-assert.sh`, `use-cache-2pod-e2e-assert.sh`) run `kubectl` against the current context.
- The mutation provers temporarily edit tracked files and restore them, through `lib/mutation-harness.mjs` or `mutate-prove.sh`.
- `run-mutation-provers.mjs` (`residueFinding`) runs after every prover, killed or not, and names any tracked file the prover left modified. It restores those files with `git checkout HEAD -- <files>` only in CI (`GITHUB_ACTIONS=true`) or with `KNEXT_LANE_RESTORE_AFTER_KILL=1`; elsewhere the tree stays dirty and the finding says so. A killed prover (`restoreTreeAfterKill`) only removes the untracked files it created, under the same gate, and no path runs a whole-tree `git checkout`. When cleanup is on (CI or `KNEXT_LANE_CLEANUP=1`), `cleanPrivateTmp()` empties the lane's private `TMPDIR` between provers.
- `secret-scan.mjs` runs gitleaks over the full git history with `--redact=100`, then filters findings against `security/gitleaks-allowlist.json`. A missing or crashed gitleaks is a failure.

## Verification
- Run: `node scripts/bun-test.mjs` (from the repo root). The guards for these scripts are in `tests/`. To run a single guard, pass its path, for example `node scripts/bun-test.mjs tests/osv-gate.test.ts`.
