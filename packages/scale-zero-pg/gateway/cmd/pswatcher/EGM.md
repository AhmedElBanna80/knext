# cmd/pswatcher

## Overview

The pageserver auto-failover controller binary. It watches the primary pageserver's liveness. On sustained failure it promotes the warm-Secondary standby at generation+1, flips the client Service selector and bounces the compute. It ships in the gateway image, and its Deployment overrides `ENTRYPOINT` to `/pswatcher`. Config is env-only (`main.go` header).

## Interface

- Binary `/pswatcher` (`main.go:main`), configured by `PSW_*` env vars:
  - Loop and health: `PSW_NAMESPACE` (default `scale-zero-pg`), `PSW_POLL_MS` (default 2000), `PSW_FAIL_THRESHOLD` (default 3), `PSW_PROBE_TIMEOUT_MS` (2000), `PSW_HEALTH_ADDR` (default `:9091`).
  - Tenants and generation: `PSW_TENANT_ID` (required), `PSW_APPS_TENANT_ID` (optional), `PSW_BASE_GENERATION` (1), `PSW_GEN_CONFIGMAP` (`pageserver-generation`).
  - Freeze: `PSW_FREEZE_CONFIGMAP` (`pageserver-failover-freeze`), `PSW_MAX_FREEZE_MS` (2h).
  - Routing: `PSW_CLIENT_SERVICE` (`pageserver`), `PSW_COMPUTE_SELECTOR` (`plane=compute`), `PSW_ROUTED_BASE_URL` (default `http://<client service>:9898`).
  - Primary: `PSW_PRIMARY_STATUS_URL` (`http://pageserver-primary:9898/v1/status`), `PSW_PRIMARY_SELECTOR` (`app=pageserver`), `PSW_PRIMARY_SELECTOR_APP` (`pageserver`), `PSW_PRIMARY_CONTAINER` (`pageserver`), `PSW_PRIMARY_NODE_BASE_URL` (`http://pageserver-primary:9898`).
  - Standby: `PSW_STANDBY_STATUS_URL` (`<standby base>/v1/status`), `PSW_STANDBY_SELECTOR_APP` (`pageserver-standby`), `PSW_STANDBY_BASE_URL` (`http://pageserver-standby:9898`).
  - Standby warming: `PSW_WARM_INTERVAL_MS` (30000), `PSW_WARM_DEADLINE_MS` (10000).

## Invariants

- An unset `PSW_TENANT_ID` is fatal (`main.go:main`).
- `SeedLedger` runs once before the first tick. Its error is logged, not fatal, so the ledger key stays absent and the fail-closed readers refuse to attach (`main.go:main`).
- One `Tick` per `PSW_POLL_MS`; a tick error is logged and the loop continues. It runs until SIGINT/SIGTERM via `signal.NotifyContext`, then shuts the HTTP server down with a 3 s deadline (`main.go:main`).
- The failover and ledger invariants are owned by the library. See [../../internal/pswatcher/EGM.md](../../internal/pswatcher/EGM.md).

## Side Effects

- Pageserver HTTP and Kubernetes ConfigMap/Service/pod writes through `internal/pswatcher`. It also binds the health/metrics listener (`/healthz`, `/metrics`, `/metrics.json` via `Metrics.Handler`).

## Verification

- Run: `cd packages/scale-zero-pg/gateway && go test ./cmd/... ./internal/pswatcher/...`
