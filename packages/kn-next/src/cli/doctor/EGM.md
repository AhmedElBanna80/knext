# doctor

## Overview

The engine behind `knext doctor`, whose entry point is `../doctor.ts`
(`runDoctor`, `doctorMain`). This directory holds argument parsing, a read-only
kubectl runner, the shared types, report formatting, and pure classifiers for
CRD and operator versions. Every external dependency is injected (`DoctorDeps`,
`KubectlFn`, `ManifestProbeFn`), so a check degrades to a result instead of
throwing. The individual diagnostics live in [`./checks/`](./checks/EGM.md).

## Interface

- `parseDoctorArgs`, `DoctorArgs` (`args.ts`): flags `--json`, `--verbose`, `-h`/`--help` and `--ci-kubeconfig <path>`.
- `defaultResolveConfigFile` (`config-file.ts`): detects a cwd that has only the legacy config filename. Re-exports `CONFIG_FILE` and `LEGACY_CONFIG_FILE`.
- `servedCrdVersions`, `classifyCrdPairing`, `CrdPairing`, `CrdDirection`, `CrdVersionEntry`, `CrdDocument` (`crd-version.ts`): CRD and CLI pairing verdict (`crd-older`, `crd-newer` or `unknown`).
- `parseSemver`, `resolveOperatorVersion`, `classifyOperatorCompat`, `shortDigest`, `Semver`, `OperatorVersion`, `OperatorCompat` (`operator-version.ts`): operator compatibility verdict (`ok`, `operator-older` or `different-line`).
- `kubectlRunner` (`kubectl.ts`): the production `KubectlFn`, built on `spawnSync`.
- `classifyKubectlFailure`, `infraFailure` (`kubectl.ts`): turn kubectl stderr into a failure class and a hint.
- `inspectKubeconfig`, `diagnoseNoCluster`, `NO_KUBE_CONTEXT_SENTENCE` (`kubectl.ts`): local kubeconfig inspection and the no-cluster diagnosis.
- `probeManifest`, `parseImageRef`, `safeJson`, `isReady` (`kubectl.ts`): anonymous registry probe and helpers.
- `parseKubectlClientVersion`, `supportsStrictValidation` (`kubectl.ts`): parse the kubectl client version and test it against the strict-validation floor.
- `classifyCNIEnforcement` (`kubectl.ts`): returns `enforced`, `likely-unenforced` or `unknown`.
- `mk`, `formatDoctorTable` (`report.ts`): build a `CheckResult` and render the human-readable table.
- `actionableDetail` (`error-format.ts`): formats a kubectl failure as actionable detail text.
- Types in `types.ts`: `CheckStatus`, `CheckResult`, `DoctorReport`, `DoctorDeps`, `CheckContext`, `KubectlFn`, `KubectlResult`, `ManifestProbeFn`, `ProbeOutcome`, `KubeconfigState`, `KubeconfigInspectFn`, `ConfigFileResolution`, `KubectlFailureClass`, `CNIEnforcement`, `DaemonSetRef`, `DeploymentJson`, `InfraFailure`, `NoClusterDiagnosis`.
- Constants in `types.ts`: `MIN_STRICT_VALIDATION_KUBECTL`, `OPERATOR_NAMESPACE` (`kn-next-operator-system`), `NEXTAPP_CRD`, `KSVC_CRD`, `KOURIER_INGRESS_CLASS`, `QUEUE_PROXY_OWNED_PORTS`, `QUEUE_PROXY_USER_METRICS_PORT`, `SKIP_UNREACHABLE`, `PRIVATE_REGISTRY_DOCS_URL`, `VERSIONING_DOCS_URL`.
- Subdirectory [`./checks/EGM.md`](./checks/EGM.md): one check function per diagnostic.

## Invariants

- `CheckStatus` is exactly `"pass" | "warn" | "fail" | "skip" | "error"`. `"error"` means the probe failed; `"fail"` is a fact about the cluster [`types.ts:CheckStatus`].
- `DoctorReport.exitCode` is 1 if and only if some check is `fail` or `error`. `warn` and `skip` never fail the run [`types.ts:DoctorReport`].
- The strict-validation floor is kubectl v1.25 [`types.ts:MIN_STRICT_VALIDATION_KUBECTL`, `kubectl.ts:supportsStrictValidation`].
- `KubectlFn` never throws. Failures return `ok: false`. The runner uses `shell: false` and a 16 MiB `maxBuffer` [`kubectl.ts:kubectlRunner`].
- Unknown flags throw. `--ci-kubeconfig` must be followed by a path, not another flag [`args.ts:parseDoctorArgs`].
- `infraFailure` handles only the `network`, `auth` and `forbidden` classes [`kubectl.ts:infraFailure`].
- In CNI classification, a ready enforcing agent wins. An enforcing agent that is not ready gives `unknown`. Flannel alone gives `likely-unenforced` [`kubectl.ts:classifyCNIEnforcement`].

## Side Effects

- Spawns `kubectl` through `spawnSync` with `shell: false`. The verbs used are `get` (including `get --raw /version`) and `version --client`, so doctor never mutates the cluster [`kubectl.ts:kubectlRunner`].
- Reads `HOME` and `KUBECONFIG` from the environment, then reads the kubeconfig files locally [`kubectl.ts:inspectKubeconfig`].
- Fetches a registry manifest over the network, plus a token endpoint when the registry returns a Bearer challenge [`kubectl.ts:probeManifest`].
- Checks with `existsSync` whether `knext.config.ts` and the legacy config file exist in the cwd [`config-file.ts`].
- No file writes and no `process.exit`. The exit code is returned in `DoctorReport`.

## Verification

- Run from `packages/kn-next`: `node ../../scripts/bun-test.mjs packages/kn-next`. The tests live in `packages/kn-next/src/__tests__/`.
