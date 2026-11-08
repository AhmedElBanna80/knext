# gateway (Go module)

## Overview

The Go module `github.com/alpheya/scale-zero-pg/gateway` (`go.mod`). It targets Go 1.27.3 and depends on `k8s.io/api`, `apimachinery`, `client-go` and `pod-security-admission` v0.34.1, `lib/pq`, `robfig/cron/v3`, `x/sync` and `sigs.k8s.io/yaml`. `Dockerfile` builds six static binaries (`CGO_ENABLED=0`) from `./cmd/*` into one digest-pinned `gcr.io/distroless/static:nonroot` image that runs as `nonroot:nonroot` with `ENTRYPOINT ["/gateway"]` and `EXPOSE 55432 9090`; the build stage is a digest-pinned `golang:1.27.3`. This directory has no Go source files of its own.

## Subdirectories & Boundaries

- cmd: [./cmd/EGM.md](./cmd/EGM.md) - the six binaries (gateway, alertsink, appdb-operator, pswatcher, writer-autoscaler, zone-operator).
- internal: [./internal/EGM.md](./internal/EGM.md) - library packages: data path (`gateway`, `wake`, `proto`, `metrics`), controllers (`appdb`, `zone`, `pswatcher`, `writerscaler`) and test support (`testport`).
