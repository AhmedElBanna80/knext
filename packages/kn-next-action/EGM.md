# kn-next-action (`@getknext/action`)

## Overview

A private composite GitHub Action (`package.json` `private: true`,
`action.yml` `runs.using: composite`) that, from a consumer's CI, configures
cluster access, refuses unsafe or over-broad credentials, logs in to a
registry, installs Bun, and delegates the build, push and `NextApp` apply to
the `knext deploy` CLI verb (`action.yml` step "Deploy"). The action adds no
deployment logic of its own (`action.yml` comment above "Deploy"). The two
`.mjs` checks are thin callers: the classification logic lives in
`@getknext/core` and is loaded at run time from the app's `node_modules`
(`load-core.mjs:loadFromCore`).

## Interface

- `action.yml` inputs: `working-directory` (default `.`), `auth` (default
  `kubeconfig`), `kubeconfig` (base64), `namespace` (required), `dry-run`,
  `doctor` (default `'true'`), `registry` (required), `registry-token`,
  `registry-username` (default `github.actor`), `tag` (default `github.sha`),
  `bucket`, `skip-upload`, `skip-build`, `skip-credential-preflight`, `cli`
  (default empty), `cli-version` (default `'1.3.1'`).
- `action.yml` steps, in order: "Configure cluster access", "Kubeconfig
  check", "Credential preflight", "Log in to the registry", "Setup Bun"
  (`oven-sh/setup-bun` pinned by SHA, `bun-version: '1.4.2'`), "Deploy"
  (`id: deploy`). The action's display name is "Deploy with knext"
  (`action.yml` `name`).
- `package.json`: `type: module`; `files` lists `action.yml`,
  `preflight.mjs`, `kubeconfig-check.mjs`, `load-core.mjs` and `README.md`.
- `load-core.mjs:loadFromCore(subpath, whatFor)` - async; resolves
  `@getknext/core/internal/<subpath>` via `createRequire` anchored at
  `process.cwd()/package.json` and dynamically imports it.
- `kubeconfig-check.mjs` (script) - reads `KUBECONFIG`, loads
  `classifyKubeconfigSafety` from core subpath `kubeconfig-safety`, exits `0`
  only when the result has `ok === true`.
- `preflight.mjs` (script, `--namespace <ns>` via `parseArgs`) - loads
  `classifyCredentialScope` and `hazardProbes` from core subpath
  `credential-scope`; internal helpers `submitRaw(rawPath, body)`,
  `effectiveRules()`, `checkHazard(probe)`; constants `RULES_PATH`
  (`/apis/authorization.k8s.io/v1/selfsubjectrulesreviews`) and `ACCESS_PATH`
  (`/apis/authorization.k8s.io/v1/selfsubjectaccessreviews`).

## Invariants

- Fail closed everywhere: an unloadable core module exits `1`
  (`load-core.mjs:loadFromCore` `catch`); unset `KUBECONFIG`, an unreadable
  file, a missing classifier function, or a non-`ok` result exit `1`
  (`kubeconfig-check.mjs`); a missing `--namespace`, a failed rules review
  (including one with no `status.resourceRules` array,
  `preflight.mjs:effectiveRules`), a
  missing `classifyCredentialScope`/`hazardProbes`, a non-`ok` verdict, an
  empty probe set, or any probe allowed exits `1` (`preflight.mjs`).
- Core modules resolve from the app's working directory, never relative to the
  action's own checkout (`load-core.mjs` header comment, `createRequire(join(process.cwd(), 'package.json'))`).
- The kubeconfig check has no `if:` and no skip branch; `skip-credential-preflight`
  only short-circuits the "Credential preflight" step (`action.yml` steps
  "Kubeconfig check" and "Credential preflight").
- Preflight ordering: the `SelfSubjectRulesReview` verdict
  (`classifyCredentialScope(rules)`) is checked before the
  `SelfSubjectAccessReview` hazard probes (`preflight.mjs`). A rules review
  with `status.incomplete` only warns; the hazard probes are what decide
  (`preflight.mjs:effectiveRules`).
- `checkHazard` throws unless the reply is JSON with an object `status`, no
  non-empty `evaluationError`, and a boolean `allowed` (`preflight.mjs:checkHazard`).
- `submitRaw` uses `kubectl create --raw <path> -f -` and falls back to
  `kubectl create -o json --validate=false -f -` only when the error message
  matches `unknown flag` / `unknown shorthand flag`; any other error is
  rethrown (`preflight.mjs:submitRaw`).
- Kubeconfig error output names the path and errno, never file contents
  (`kubeconfig-check.mjs` `catch` block).
- "Deploy" receives every input through `env:` and quoted shell variables, not
  `${{ }}` inside `run:` (`action.yml` comment above `env:`). A non-empty
  `tag` or `bucket` is checked against `tag_re` / `bucket_re`, and
  `cli-version` (only when `cli` is empty) against `version_re`; a refused
  value of these three is never echoed (`action.yml` "Deploy" `run`).
- With `cli` empty, the CLI runs as `npx --yes @getknext/core@<cli-version>` at
  an exact version only; ranges and dist-tags are refused (`action.yml`
  `version_re`, `CLI=(npx --yes ...)`). `cli` is split with `read -r -a`, and
  its first word must be on `PATH` (`command -v`); when that word is `node`,
  its second word must be an existing file (`[ ! -f "${CLI[1]}" ]`).
- `auth: oidc` and any unknown `auth` value exit `1`; only `kubeconfig` is
  implemented, and it exits `1` when the `kubeconfig` input is empty
  (`action.yml` "Configure cluster access" `case`).
- An empty `registry-token` exits `1` before `docker login` (`action.yml`
  "Log in to the registry").
- "Kubeconfig check", "Credential preflight" and "Deploy" run in
  `working-directory`, so core resolves from the app (`action.yml`
  `working-directory: ${{ inputs.working-directory }}` on those steps).

## Side Effects

- Decodes the kubeconfig to `$RUNNER_TEMP/kubeconfig` under `umask 077` and
  appends `KUBECONFIG=...` to `$GITHUB_ENV` (`action.yml` "Configure cluster access").
- Sends `SelfSubjectRulesReview` and `SelfSubjectAccessReview` POSTs to the
  apiserver via `kubectl` subprocesses (`preflight.mjs:submitRaw`,
  `execFileSync('kubectl', ...)`).
- Reads the kubeconfig file from disk (`kubeconfig-check.mjs:readFileSync`).
- Runs `docker login` with `--password-stdin` against the registry host
  `${KNEXT_REGISTRY%%/*}` (`action.yml` "Log in to the registry").
- Installs Bun on the runner (`action.yml` "Setup Bun").
- Runs the CLI's `doctor --namespace` when `doctor` is `true`, then `deploy`
  with `--namespace`, `--registry` and the optional `--tag`, `--bucket`,
  `--skip-upload`, `--skip-build`, `--dry-run` flags (`action.yml` "Deploy",
  `DEPLOY_ARGS`); the build, push and cluster write happen inside that CLI.
- Writes GitHub workflow commands (`::error::`, `::warning::`) to
  stderr/stdout (all three `.mjs` files, `action.yml`).

## Verification

- Run: `node scripts/bun-test.mjs` (from repo root; covered by
  `tests/kn-next-action-preflight.test.ts`,
  `tests/kn-next-action-preflight-hazard-and-kubeconfig.test.ts`,
  `tests/kn-next-action-bun-setup.test.ts` and
  `tests/action-script-injection.test.ts`)
