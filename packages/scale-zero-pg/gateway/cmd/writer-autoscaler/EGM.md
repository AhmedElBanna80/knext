# cmd/writer-autoscaler

## Overview

The writer vertical-autoscaler binary. It reads each writer compute's CPU and memory pressure from metrics-server and resizes the running pod in place within min/max bounds. One selector covers the primary `compute` and every per-app `compute-<app>` writer. It ships in the gateway image, with `ENTRYPOINT` overridden to `/writer-autoscaler` (`main.go` header).

## Interface

- Binary `/writer-autoscaler` (`main.go:main`), configured by `WAS_*` env vars:
  - Targeting: `WAS_NAMESPACE` (default `scale-zero-pg`), `WAS_SELECTOR` (`plane=compute,role!=ro`), `WAS_CONTAINER` (`compute`).
  - Loop and health: `WAS_POLL_MS` (default 15000), `WAS_HEALTH_ADDR` (default `:9092`).
  - Bounds: `WAS_MIN_CPU` (`250m`), `WAS_MAX_CPU` (`2`), `WAS_CPU_STEP` (`250m`), `WAS_MIN_MEM` (`256Mi`), `WAS_MAX_MEM` (`1Gi`), `WAS_MEM_STEP` (`256Mi`), as Kubernetes quantities; an unparseable quantity is fatal at start-up (`main.go:qtyMilli`, `main.go:qtyBytes`).
  - Thresholds: `WAS_UP_RATIO` (0.80), `WAS_DOWN_RATIO` (0.30), `WAS_UP_HOLD` (3 ticks), `WAS_DOWN_HOLD` (8), `WAS_COOLDOWN` (4).

## Invariants

- It never bounces a live writer. A writer that is memory-bound at its max limit is flagged with an annotation for a maintenance-window bounce (`main.go` header, `internal/writerscaler/decide.go:Decision`).
- It runs until SIGINT/SIGTERM (`main.go:main`).

## Side Effects

- `pods/resize` patches and pod annotations through [../../internal/writerscaler/EGM.md](../../internal/writerscaler/EGM.md). It also binds the health/metrics listener.

## Verification

- Run: `cd packages/scale-zero-pg/gateway && go test ./cmd/... ./internal/writerscaler/...`
