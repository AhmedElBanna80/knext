# cmd/gateway

## Overview

`main.go` builds the default `ENTRYPOINT` (`/gateway`) of the multi-binary image (`../../Dockerfile`). It wires the wake-on-connect Postgres proxy: a writer lane, an optional read-only lane, a metrics server and a graceful drain on signal.

## Interface

- Binary `/gateway` (`main.go:main`). Config comes from `wake.EnvFromOS()` (every `GW_*` var) plus the ports read here: `GW_PORT` (default 55432), `GW_METRICS_PORT` (9090), `GW_RO_PORT` (lane off when unset, 55434 if set but unparseable), `GW_DRAIN_DEADLINE_MS` (25000). Peer-aware idle uses `GW_POD_NAMESPACE`, `GW_PEER_SELECTOR`, `GW_POD_IP` and `GW_PEER_TOKEN`.
- Metrics server: `gw.Metrics().HandlerWithPeerAuth(peerAuth)` (writer-lane metrics only) with 5 s read-header, 30 s read and 120 s idle timeouts, shut down with a 3 s deadline after drain (`main.go:main`).

## Invariants

- Boot aborts (`Fatalf`) if `metrics.ResolvePeerAuth` fails, so an empty `GW_PEER_TOKEN` without the dev opt-out never serves (`main.go:main`).
- The RO lane is a second `gateway.Gateway` sharing the same peer checker. `GW_COMPUTE_MODE=template` gives it `wake.ROTemplateEnv` (per-app `compute-ro-<app>` computes); any other writer mode gives it `wake.ROEnv`, which is always `kubectl` mode on one RO Deployment (`main.go:main`, `wake/ro.go`).
- On SIGTERM/SIGINT both listeners close before `Drain` runs. Drain is bounded by `GW_DRAIN_DEADLINE_MS`, and the two lanes drain concurrently (`main.go:main`).

## Side Effects

- Binds TCP listeners on `GW_PORT`, optionally `GW_RO_PORT`, and `GW_METRICS_PORT`.
- Kubernetes access (scale, peers) through `internal/gateway` and `internal/wake`. See [../../internal/gateway/EGM.md](../../internal/gateway/EGM.md) and [../../internal/wake/EGM.md](../../internal/wake/EGM.md).

## Verification

- Run: `cd packages/scale-zero-pg/gateway && go test ./cmd/...`
