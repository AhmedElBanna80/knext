# cmd/appdb-operator

## Overview

The AppDatabase CRD controller binary: the declarative provisioning interface for branch-per-app multi-tenancy. It ships in the same image as the gateway, and its Deployment overrides `ENTRYPOINT` to `/appdb-operator`. Config is env-only (`main.go` header).

## Interface

- Binary `/appdb-operator` (`main.go:main`), configured by `APPDB_*` env vars:
  - Namespace and resync: `APPDB_NAMESPACE` (default `scale-zero-pg`), `APPDB_RESYNC_MS` (15000).
  - Health: `APPDB_HEALTH_ADDR` (default `:9092`).
  - Storage plane: `APPDB_PAGESERVER_URL` (`http://pageserver:9898`), `APPDB_PAGESERVER_HOST` (`pageserver`), `APPDB_TENANT_ID` (required, no default), `APPDB_TEMPLATE_TL` (`a0000000000000000000000000000010`), `APPDB_PG_VERSION` (17), `APPDB_SAFEKEEPER_SERVICE` (`safekeeper`), `APPDB_SAFEKEEPER_PORT` (7676), `APPDB_SAFEKEEPER_REPLICAS` (3), `APPDB_RECLAIM_CM` (`apps-wal-reclaim-pending`), `APPDB_HTTP_TIMEOUT_MS` (10000).
  - Gateway endpoint for minted DSNs: `APPDB_GATEWAY_HOST`, `APPDB_GATEWAY_PORT` (55432), `APPDB_GATEWAY_RO_PORT` (55434).
  - Compute rendering: `APPDB_COMPUTE_IMAGE`, `APPDB_COMPUTE_UID`, `APPDB_COMPUTE_GID`, `APPDB_INIT_IMAGE`, `APPDB_INIT_UID`, `APPDB_INIT_GID`, `APPDB_ROLE_PREFIX` (`app_`). The UID/GID vars must be integers in [1, 2147483647]; a malformed value is fatal at start-up (`main.go:applyImageEnv`, `main.go:idFromEnv`).
  - Warm holds: `APPDB_WARM_HOLD_TIMEOUT_MS` (5000).
- HTTP: `/healthz` (503 `stale reconcile` when `Controller.Healthy()` is false), `/readyz` (always 200), `/metrics` (the `appdb_warm_hold_active{app=...}` gauge) (`main.go:main`).
- `gatewayHostFromEnv` (`main.go`): when `APPDB_GATEWAY_HOST` is unset it returns the rooted `appdb.DefaultGatewayHost` (with the trailing dot). When set, the value is passed through verbatim.

## Invariants

- An unset `APPDB_TENANT_ID` is fatal (`main.go:main`).
- Timeline ids are 16 random bytes (32 hex) and passwords 18 random bytes, hex-encoded. A `crypto/rand` failure is fatal (`main.go`, `log.Fatalf("[appdb] crypto/rand: ...")`).
- It runs until SIGINT/SIGTERM via `signal.NotifyContext` (`main.go:main`).

## Side Effects

- Everything in [../../internal/appdb/EGM.md](../../internal/appdb/EGM.md): Kubernetes object writes, pageserver/safekeeper HTTP and warm-hold Postgres connections. It also binds the health/metrics listener.

## Verification

- Run: `cd packages/scale-zero-pg/gateway && go test ./cmd/appdb-operator/...`
