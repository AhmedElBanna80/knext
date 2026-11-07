# cmd

## Overview

The six `main` packages built into one distroless, nonroot image by `../Dockerfile`. `/gateway` is the default `ENTRYPOINT`, and the other Deployments override it. This directory holds only a test file of its own (`server_timeouts_test.go`) and no production source.

## Subdirectories & Boundaries

- alertsink: [./alertsink/EGM.md](./alertsink/EGM.md) - webhook receiver that logs alert deliveries (dev/CI end of the pager path).
- appdb-operator: [./appdb-operator/EGM.md](./appdb-operator/EGM.md) - AppDatabase CRD controller, configured by `APPDB_*`.
- gateway: [./gateway/EGM.md](./gateway/EGM.md) - wake-on-connect Postgres proxy: writer lane, optional RO lane, metrics, bounded drain.
- pswatcher: [./pswatcher/EGM.md](./pswatcher/EGM.md) - pageserver auto-failover controller, configured by `PSW_*`.
- writer-autoscaler: [./writer-autoscaler/EGM.md](./writer-autoscaler/EGM.md) - in-place vertical resize of writers, configured by `WAS_*`.
- zone-operator: [./zone-operator/EGM.md](./zone-operator/EGM.md) - Zone CRD controller, configured by `ZONE_*`.
