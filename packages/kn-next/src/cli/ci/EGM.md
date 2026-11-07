# ci

## Overview

Client-side CI setup for knext. `knext init-ci` generates a GitHub Actions
workflow or a GitLab pipeline, together with a namespace-scoped RBAC manifest.
`knext ci-preflight` refuses a deploy credential that is over-broad or that
depends on cloud-account credentials. This code writes files to disk, sends a
secret to `gh` or `glab`, or queries the cluster through the read-only review
APIs. It never applies the RBAC manifest or any workload. The user applies the
rendered RBAC YAML.

## Interface

- `initCiMain` (`init-ci-cmd.ts`): the `knext init-ci` verb. Flags: `--namespace` (required), `--provider github|gitlab` (default `github`), `--app-dir` (default `.`), `--force`, `--push-secret <path>` and `--help`.
- `ciPreflightMain` (`ci-preflight-cmd.ts`): the `knext ci-preflight` verb. Flags: `--namespace` (required), `--kubeconfig` (otherwise `$KUBECONFIG`) and `-h`/`--help`.
- `initCi`, `InitCiResult`, `CiProvider`, `skippedFileMessage` (`init-ci.ts`): write the generated files, without overwriting by default.
- `renderWorkflow`, `renderRbacManifest`, `mintKubeconfigCommands`, `nextSteps` (`init-ci.ts`): text renderers.
- Path constants in `init-ci.ts`: `WORKFLOW_PATH` (`.github/workflows/knext-deploy.yml`), `RBAC_PATH` (`knext-ci-rbac.yaml`) and `MINTED_KUBECONFIG_PATH` (`knext-deployer.kubeconfig`).
- `renderGitlabPipeline`, `GITLAB_CI_PATH` (`.gitlab-ci.yml`), `BUN_VERSION` (`1.4.2`) (`init-ci-gitlab.ts`).
- `REQUIRED_SECRETS` (`ci-secrets.ts`, re-exported by `init-ci.ts`): the CI secrets each template needs, with a reason for each.
- `runCiPreflight`, `RunCiPreflightOptions`, `CiPreflightResult`, `KubectlRawFn` (`ci-preflight.ts`): the preflight orchestrator. Returns `{ ok, lines }`.
- `classifyKubeconfigSafety`, `CLOUD_CREDENTIAL_REFUSAL`, `KubeconfigSafetyVerdict` (`kubeconfig-safety.ts`).
- `CI_ROLE_RULES`, `classifyCredentialScope`, `hazardProbes`, `renderRoleYaml`, `PolicyRule`, `ScopeVerdict`, `HazardProbe` (`credential-scope.ts`).
- `pushKubeconfigSecret`, `defaultGhRun`, `GhRunFn`, `GhRunResult`, `PushSecretResult`, `DEFAULT_SECRET_NAME` (`push-kubeconfig-secret.ts`).
- `pushKubeconfigSecretGitlab`, `GlabRunFn`, `GlabRunResult`, `GlabAvailableFn`, `PushSecretGitlabResult`, and its own `DEFAULT_SECRET_NAME` (also `KNEXT_KUBECONFIG`) (`push-kubeconfig-secret-gitlab.ts`).
- Published subpaths: `./internal/credential-scope` (`dist/cli/ci/credential-scope.js`) and `./internal/kubeconfig-safety` (`dist/cli/ci/kubeconfig-safety.js`).

## Invariants

- The published CI Role grants only `apps.kn-next.dev/nextapps` with the verbs `get`, `list`, `create`, `patch` and `update`. It grants no `delete` and no Secrets access [`credential-scope.ts:CI_ROLE_RULES`].
- Each of these produces a refusal finding: a wildcard API group, resource or verb; any resource outside the Role; any verb beyond the allowed set [`credential-scope.ts:classifyCredentialScope`].
- A kubeconfig is refused if any `users[]` entry reaches an `exec` or `auth-provider` key at any depth. Unparseable YAML is also refused [`kubeconfig-safety.ts:classifyKubeconfigSafety`].
- The preflight runs in this order: safety check, SelfSubjectRulesReview, scope check, SelfSubjectAccessReview hazard probes. Any failure or review error refuses. An empty probe set throws [`ci-preflight.ts:runCiPreflight`].
- An incomplete SelfSubjectRulesReview only warns. The hazard probes do the real verification [`ci-preflight.ts:effectiveRules`].
- `ci-preflight` requires `--namespace`, which has no default. The kubeconfig path comes from `--kubeconfig`, falling back to `$KUBECONFIG`; when neither is set it refuses with exit code 1 [`ci-preflight-cmd.ts:ciPreflightMain`]. `init-ci` requires `--namespace` and validates `--provider`. A usage error returns exit code 1 [`ci-preflight-cmd.ts`, `init-ci-cmd.ts`].
- Existing files are skipped unless `--force` is given [`init-ci.ts:initCi`].
- A secret is pushed only after the safety classifier passes. It is base64-encoded and passed on stdin, never as an argv entry. The default name is `KNEXT_KUBECONFIG`. The GitLab variable is set with `--masked --protected` [`push-kubeconfig-secret.ts`, `push-kubeconfig-secret-gitlab.ts`].
- The generated GitLab pipeline runs `knext doctor --ci-kubeconfig` and `knext ci-preflight` before `knext deploy`. It writes the kubeconfig with `umask 077` and `chmod 600`, and pins `@getknext/core@<cliVersion()>` [`init-ci-gitlab.ts:renderGitlabPipeline`].

## Side Effects

- Writes `.github/workflows/knext-deploy.yml` or `.gitlab-ci.yml`, plus `knext-ci-rbac.yaml`, to disk only [`init-ci.ts:initCi`].
- Reads the kubeconfig named by `--push-secret`, `--kubeconfig` or `$KUBECONFIG`.
- Runs `kubectl create --raw` against the `selfsubjectrulesreviews` and `selfsubjectaccessreviews` review APIs, with the body on stdin. If `--raw` is reported as an unknown flag, it falls back to `create -o json --validate=false -f -`. These review calls store nothing [`ci-preflight.ts:defaultKubectlRaw`].
- `gh secret set KNEXT_KUBECONFIG` writes a GitHub repository secret over the network [`push-kubeconfig-secret.ts:defaultGhRun`].
- `glab --version`, then `glab variable set ... --masked --protected`, writes a GitLab CI/CD variable. If `glab` is absent, the code prints the manual steps instead [`push-kubeconfig-secret-gitlab.ts`].
- Writes to stdout and stderr and returns exit codes. There is no `process.exit` call.

## Verification

- Run from `packages/kn-next`: `node ../../scripts/bun-test.mjs packages/kn-next`. The tests are `src/__tests__/ci-*.test.ts`.
