# internal

## Overview

The Go library packages behind the six binaries in `../cmd`. This directory has no source files of its own. `gateway` and `wake` form the wake-on-connect data path, `proto` is its wire codec, and `metrics` is its observability surface. `appdb`, `zone`, `pswatcher` and `writerscaler` are the controllers. `testport` is test support only.

## Subdirectories & Boundaries

- appdb: [./appdb/EGM.md](./appdb/EGM.md) - AppDatabase CRD reconciler: branches timelines, renders per-app compute, mints credentials, reclaims on delete.
- gateway: [./gateway/EGM.md](./gateway/EGM.md) - wake-on-connect proxy server: authorize, wake, replay startup, pipe, idle-sleep, graceful drain.
- metrics: [./metrics/EGM.md](./metrics/EGM.md) - gateway counters with `/metrics`, `/healthz` and a bearer-gated `/metrics.json` (fails closed).
- proto: [./proto/EGM.md](./proto/EGM.md) - minimal Postgres startup and error wire codec.
- pswatcher: [./pswatcher/EGM.md](./pswatcher/EGM.md) - pageserver auto-failover at generation+1, with a ledger that never goes down.
- testport: [./testport/EGM.md](./testport/EGM.md) - race-free test port reservation (test support).
- wake: [./wake/EGM.md](./wake/EGM.md) - compute drivers (static/exec/kubectl/template/warmpool), tenant authz, wake budget, coalescing, backend TLS.
- writerscaler: [./writerscaler/EGM.md](./writerscaler/EGM.md) - in-place vertical resize of writer computes. It never bounces a pod.
- zone: [./zone/EGM.md](./zone/EGM.md) - Zone CRD reconciler: composes an AppDatabase and adds the replication/FDW fabric with single-writer guards.
