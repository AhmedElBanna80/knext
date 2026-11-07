# writerscaler

## Overview

The writer vertical autoscaler. It watches each writer compute's CPU and memory pressure and applies an in-place pod resize (the `pods/resize` subresource) within configured min/max bounds, so a running Postgres writer grows or shrinks without a restart (package doc, `decide.go`).

## Interface

- Pure decision (`decide.go`): `Direction` (`Hold`, `Up`, `Down`, with `String`), `Sample`, `Bounds`, `Decision` (`ChangeCPU`, `ChangeMem`, `NeedsBounce`, ...), `Decide(Sample, Bounds) Decision`.
- Control loop (`controller.go`): `PodInfo`, `Cluster` (port), `Usage`, `Config` (embeds `Bounds`, plus `UpHold`/`DownHold`/`Cooldown` tick counts for hysteresis), `Controller`, `NewController(cl, cfg, m, logger)`, `Controller.Tick(ctx) (int, error)`, `Controller.Metrics`.
- Kubernetes adapter (`k8s.go`): `K8sClient`, `NewK8sClient(namespace, selector, container)`, `Writers`, `Usage`, `ResizeCPU`, `ResizeMem`, `FlagBounce`, `SelectorSummary`.
- Metrics (`metrics.go`): `Metrics`, `NewMetrics`, counters (`Check`, `Resize`, `NeedsBounce`, `Error`, `NoSample`, `SetWriters`) and their readers, `PromText`, `Handler`.

## Invariants

- `Decide` is pure and total: the same input gives the same output, with no clock and no I/O [`decide.go:Decide`].
- A non-positive limit counts as no pressure, so a container with no limit is never scaled [`decide.go:ratio`].
- Only the limit moves (clamped to the min/max bounds by one step); the request stays at the manifest baseline so a resize never needs node re-admission [`decide.go:Decide`].
- CPU and memory are patched in separate `pods/resize` calls, because a combined patch is rejected [`k8s.go:resizePatch`, `controller.go:Cluster`].
- `NeedsBounce` is set only when a writer is memory-bound at its max limit, because `shared_buffers` is fixed at boot. The controller flags it with an annotation and never bounces the pod [`decide.go:Decision`, `k8s.go:FlagBounce`].

## Side Effects

- Kubernetes: lists writer pods, reads usage (metrics-server), patches the `pods/resize` subresource for CPU and memory, and merge-patches the `writer-autoscaler.scale-zero-pg/needs-bounce` annotation onto pods that need a bounce [`k8s.go:FlagBounce`].
- `Metrics` counters are mutex-guarded. The HTTP handler reads them while the loop writes [`metrics.go`].

## Verification

- Run: `cd packages/scale-zero-pg/gateway && go test ./internal/writerscaler/...`
