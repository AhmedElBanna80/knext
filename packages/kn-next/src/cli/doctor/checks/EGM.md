# doctor/checks

## Overview

One diagnostic per file for `knext doctor`. Each check receives a `CheckContext`
(defined in `../types.ts`; see [`../EGM.md`](../EGM.md)) and returns `CheckResult[]`, built with
`mk()` from `../report.ts`. Cluster checks talk to the cluster only through the
injected `ctx.kubectl` runner and only read. Local checks read the working
directory, `package.json`, the Next config and the packaged templates.
`../../doctor.ts` decides which checks run and in what order.

## Interface

Result shape for every check: `{ id, title, status, detail, hint? }`, where
`status` is `"pass" | "warn" | "fail" | "skip" | "error"`.

Cluster checks:

- `clusterCheck(deps, verbose)` (`cluster.ts`): apiserver reachability through `kubectl get --raw /version`. Returns `{ checks, reachable }`, and `reachable` gates the other cluster checks.
- `crdCheck` (`crd.ts`): the NextApp CRD is installed and its served version pairs with the CLI.
- `crdSchemaCheck` (`crd-schema.ts`): the installed CRD schema covers every field the CLI emits.
- `operatorCheck` (`operator.ts`): the operator Deployment exists and is ready in `kn-next-operator-system`.
- `operatorVersionCheck` (`operator-version.ts`): operator version compatibility with the CLI.
- `operatorImageCheck` (`operator-image.ts`, async): the operator image is pullable or digest-pinned.
- `knativeCheck` (`knative.ts`): the Knative Serving CRD (`services.serving.knative.dev`) is installed.
- `certManagerCheck` (`cert-manager.ts`): cert-manager is present.
- `ingressCheck` (`ingress.ts`): Kourier ingress class and related deployments.
- `metricsCheck` (`metrics.ts`): metrics wiring for NextApps, including queue-proxy port conflicts.
- `networkPolicyCheck` (`network-policy.ts`): whether the CNI enforces NetworkPolicy, classified from DaemonSets.
- `appImageCheck` (`app-image.ts`, async): every NextApp image is pullable. Uses ServiceAccounts, pull secrets and a time-budgeted registry manifest probe.
- `unverifiedSecretsCheck` (`unverified-secrets.ts`): NextApp secret references that cannot be verified.
- `redisPrefixCheck`, `defaultRedisKeyPrefix`, `LEGACY_SHARED_KEY_PREFIX` (`redis-prefix.ts`): Redis key-prefix collisions and the legacy shared prefix. It reports a stored prefix as refused by the cluster when `../../redis-key-prefix.ts:keyPrefixProblem` objects: over 63 characters, whitespace or a Redis glob character, or `kn-next` / `kn-next:*`. Admission refuses more than that: the platform keyspace `knext` / `knext:*`, which doctor does not flag, and a squat on the derived shape `kn-<12 hex>` (or under it) that is not the app's own, which doctor reports only as a collision warning, and only when the owning app is on the cluster.
- `writePolicyCheck`, `evaluateWritePolicy`, `CANONICAL_POLICY_CEL`, `WritePolicyVerdict`, `WritePolicyReason` (`write-policy.ts`): the operator's ValidatingAdmissionPolicy write bound.

Local checks:

- `kubectlValidationCheck` (`kubectl-validation.ts`): the kubectl client is at least v1.25.
- `nodeFloorCheck` (`node-floor.ts`): the Node.js major version floor.
- `nextMinorCheck`, `NextMinorPolicy`, `readInstalledNextVersion` (`next-minor.ts`): the installed Next minor is in the credentialed set or peer range.
- `nextAdvisoriesCheck` (`next-advisories.ts`): the installed Next.js version against known advisories.
- `cacheComponentsCheck`, `NEXT_CONFIG_FILES` (`use-cache.ts`): `cacheComponents` or `use cache` in the Next config.
- `nodeEntryStalenessCheck`, `extractNodeEntryMarker` (`node-entry-staleness.ts`, async): the project node entry marker against the packaged template.
- `storageModeCheck` (`storage-mode.ts`, async): the storage mode configured in `knext.config.ts`.
- `turbopackFragmentsCheck` (`turbopack-fragments.ts`, async): Turbopack module-fragment hazards.
- `vinextPatchesCheck` (`vinext-patches.ts`): the state of the bundled vinext patches.
- `ciKubeconfigCheck(path, readFile?)` (`ci-kubeconfig.ts`): the `--ci-kubeconfig` file must not need cloud-account credentials. Returns `[]` when no path is given.

## Invariants

- A probe that itself failed (network, auth, forbidden) reports `"error"` through `infraFailure`. A confirmed cluster fact, such as a missing CRD or Deployment, reports `"fail"` [`crd.ts:crdCheck`, `operator.ts:operatorCheck`, `knative.ts:knativeCheck`].
- An unreachable cluster is `warn`, and the dependent cluster checks report `SKIP_UNREACHABLE` [`cluster.ts:clusterCheck`].
- A kubectl client below v1.25 is `fail`, because `--validate` is a boolean flag there and deploy would die at flag parsing. A version that cannot be determined is `warn` [`kubectl-validation.ts:kubectlValidationCheck`].
- A Node major below `NODE_FLOOR_MAJOR` is `fail` [`node-floor.ts:nodeFloorCheck`].
- An emitted CR field missing from the installed CRD schema is `fail` [`crd-schema.ts:crdSchemaCheck`].
- A CI kubeconfig that needs cloud credentials is `fail`. An unreadable file is `error` [`ci-kubeconfig.ts:ciKubeconfigCheck`].
- These checks warn at worst: operator-version, network-policy, redis-prefix, unverified-secrets, next-minor, use-cache, node-entry-staleness and app-image. write-policy also warns at worst, but returns `error` on an infrastructure failure [`write-policy.ts:writePolicyCheck`].
- `evaluateWritePolicy` mirrors the Go operator verdict and is held to `packages/kn-next-operator/internal/writepolicy/testdata/verdict-cases.json`. When the result is unknown it reports "not verified", never "enforced" [`write-policy.ts`].
- `app-image` probes under a total time budget and stops probing the images the budget cuts off [`app-image.ts:appImageCheck`].
- A config load error in `storage-mode` yields no config instead of throwing, so doctor never crashes on the state it diagnoses [`storage-mode.ts:loadAppConfigOrUndefined`].

## Side Effects

- Read-only `kubectl get` through `ctx.kubectl`. It reads CRDs, Deployments, NextApps, ServiceAccounts, Secrets, DaemonSets, ConfigMaps, ValidatingAdmissionPolicies and ValidatingAdmissionPolicyBindings (`write-policy.ts`), plus `get --raw /version`. No check mutates the cluster.
- `kubectl version --client -o json` runs the local binary and does not contact the cluster [`kubectl-validation.ts`].
- Anonymous registry manifest probes over the network through `ctx.deps.probeImage` (`CheckContext.deps: DoctorDeps`, `../types.ts`). `operator-image.ts` calls `ctx.deps.probeImage`, and `app-image.ts` calls `deps.probeImage` [`app-image.ts`, `operator-image.ts`].
- Local file reads: the `--ci-kubeconfig` path, `package.json`, the Next config files, the project node entry, the packaged template under `templateRoot()`, and `knext.config.ts` through `loadConfig`.
- Reads `process.versions.node`. No file writes and no `process.exit`.

## Verification

- Run from `packages/kn-next`: `node ../../scripts/bun-test.mjs packages/kn-next`. The tests live in `packages/kn-next/src/__tests__/`.
