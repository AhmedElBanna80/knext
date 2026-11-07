# deep-health-alert-e2e

## Overview
The assertions half of the deep-health alert e2e on kind. `scripts/deep-health-alert-e2e.sh` (in the parent directory) drives the run. `fixture-app.yaml` and `prometheus.yaml` are the manifests it applies.

## Interface
- `assert-alert.mjs`: CLI `node assert-alert.mjs <kube-context> [timeoutSeconds]`. The default timeout is 600 s.
- `ARMS` lists the four arms, which run concurrently:
  - `e2e-app` (tracing on): expects `down`.
  - `e2e-app-notracing`: expects `down`.
  - `e2e-app-waking`: expects `waking`.
  - `e2e-app-up`: expects `up`.
- `READING` maps each expected reading to the label selectors that prove it.
- `ALERT_FOR` maps `down` to `KnextDeepHealthDown`, `waking` to `KnextDeepHealthStuckWaking`, and `up` to no alert.
- `ALERTS`: the two alert names (`KnextDeepHealthDown`, `KnextDeepHealthStuckWaking`).
- Internal functions: `raw`, `kubectl`, `waitFor`, `loopbackBody`, `runArm`.

## Invariants
- Every wait is a poll with a deadline. A timeout fails and reports what was last seen. A missing target, a missing series and an alert that never fires are separate failures (header comment).
- Every query and every alert lookup is scoped to one arm's `app` label.
- Prometheus is read through the API-server service proxy `/api/v1/namespaces/monitoring/services/prometheus-operated:web/proxy`, so no port-forward is needed. Namespace: `deep-health-e2e`.

## Side Effects
- Spawns `kubectl --context <ctx>` for `get --raw`, `exec`, `logs`, and `exec ... touch|rm -f /tmp/stop-traffic`. The last one toggles traffic inside each arm's pod.
- Exit codes: 2 on usage error, 1 on assertion failure.

## Verification
- Run: `node scripts/bun-test.mjs tests/deep-health-alert-e2e-wiring.test.ts tests/deep-health-tracing-off-e2e-wiring.test.ts` (from the repo root)
