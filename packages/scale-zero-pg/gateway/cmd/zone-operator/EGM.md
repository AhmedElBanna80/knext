# cmd/zone-operator

## Overview

The Zone CRD controller binary. It reconciles each Zone by composing an AppDatabase and adding the cross-zone fabric on top: a per-zone REPLICATION role, publications, and per `dataDependency` a logical-replication subscription or `postgres_fdw` foreign tables. Subscription conninfo points at the apps-gateway, so a sleeping publisher gets woken. A finalizer drops the subscriptions, publications and slots on peers before the composed AppDatabase reclaims the timeline. It ships in the gateway image, with `ENTRYPOINT` overridden to `/zone-operator` (`main.go` header).

## Interface

- Binary `/zone-operator` (`main.go:main`), configured by `ZONE_NAMESPACE` (default `scale-zero-pg`), `ZONE_RESYNC_MS` (15000), `ZONE_HEALTH_ADDR` (`:9093`), `ZONE_GATEWAY_HOST` (`pggw-apps.scale-zero-pg.svc`), `ZONE_GATEWAY_PORT` (55432), `ZONE_REPL_ROLE_PREFIX` (`repl_`, kept in lock-step with the apps-gateway `GW_REPL_ROLE_PREFIX`), `ZONE_WAKE_TIMEOUT_SEC` (120) and `ZONE_AUTO_RESYNC` (on unless exactly `false`).
- HTTP: `/healthz` (503 `stale reconcile` when `Controller.Healthy()` is false) and `/readyz` (always 200) (`main.go:main`).

## Invariants

- Replication-role passwords are 18 random bytes, hex-encoded. A `crypto/rand` failure is fatal (`main.go`, `log.Fatalf("[zone] crypto/rand: ...")`).
- It runs until SIGINT/SIGTERM (`main.go:main`).

## Side Effects

- AppDatabase CR writes, `psql` exec into zone computes and Secret/status writes through [../../internal/zone/EGM.md](../../internal/zone/EGM.md). It also binds the health listener.

## Verification

- Run: `cd packages/scale-zero-pg/gateway && go test ./cmd/... ./internal/zone/...`
