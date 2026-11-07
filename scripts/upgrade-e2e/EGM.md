# upgrade-e2e

## Overview
The operator upgrade-under-load e2e. `run.sh` runs the scenario on a kind cluster that already has cert-manager, Knative and Kourier:

1. Install the operator built from the old tag.
2. Deploy a NextApp with the old published CLI.
3. Start continuous traffic.
4. Upgrade the operator and CRD to this tree's build (operator first).
5. Run the assertions.
6. Upgrade the CLI and redeploy, following the upgrade guide.

The `.mjs` files hold the pass/fail logic. Most of it is pure and unit-tested.

## Interface
- `run.sh` environment: `KIND_CLUSTER` (default `kn-next-operator-upgrade-e2e`), `OLD_CLI_VERSION` (default `0.4.3`), `OLD_OPERATOR_TAG` (the 0.4.3 release tag), `NEW_CLI_VERSION` (empty means this tree's built dist), `APP_IMAGE` (digest-pinned), `TRAFFIC_INTERVAL_MS` (500), `READY_BOUND_SECONDS` (90), `ERROR_BUDGET` (0.02), `BREAK_CRD_UPGRADE` (0), `WORKDIR` (`mktemp -d /tmp/knext-upgrade-e2e.XXXXXX`), `APP_NAMESPACE` and `APP_NAME` (both `upgrade-e2e-app`).
- `cr-diff.mjs`: `specUnchanged(before, after, ignoreKeys = [])`, plus a CLI.
- `error-budget.mjs`: `evaluateErrorBudget(attempts, maxErrorRate)` returns `{ok, total, errors, rate}`. Also a CLI.
- `ready-flap.mjs`: `cumulativeNotReadyMillis(samples)`, `evaluateReadyBound(samples, boundMillis)`, plus a CLI.
- `traffic-monitor.mjs`: `attempt(url, hostHeader, requestImpl = http.request)`. `ok` is true for a 2xx or 3xx status; a connection error resolves `{ok: false, status: <message>}`. The CLI loop appends `{ts, ok, status}` JSON lines.
- `break-crd.mjs`: removes `spec.properties.image` from a CRD file, for the mutation proof.

## Invariants
- `specUnchanged` compares only `spec`. `ignoreKeys` excuses only top-level keys that were absent before and are present after. It never excuses a removed field or a changed value (header comment).
- `cumulativeNotReadyMillis` adds up every not-Ready gap. It does not take the longest single flap.
- `BREAK_CRD_UPGRADE=1` is the mutation-proof switch. `run.sh` logs loudly when it fires, and it must never be 1 in CI.
- `traffic-monitor.mjs` counts a connection failure against the error budget, the same as a bad status.

## Side Effects
- `run.sh`: checks the old operator tag out in a detached git worktree (removed afterwards), builds both operators with `make docker-build`, loads them with `kind load docker-image`, and installs them with `make install`/`make deploy`. It installs the old CLI with `npm install --prefix`, runs `kubectl apply`, and port-forwards `svc/kourier-internal` in `kourier-system` for the traffic loop. All state, including `port-forward.log` and `port-forward.pid`, goes under `$WORKDIR`.
- `break-crd.mjs`: `writeFileSync` on the CRD path it is given.
- `traffic-monitor.mjs`: HTTP requests to the target, plus log file appends.
- The CLIs exit 2 on usage error and 1 on a failed assertion.

## Verification
- Run: `node scripts/bun-test.mjs tests/upgrade-e2e-cr-diff.test.ts tests/upgrade-e2e-error-budget.test.ts tests/upgrade-e2e-ready-flap.test.ts tests/upgrade-e2e-traffic-monitor.test.ts` (from the repo root)
