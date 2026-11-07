# cmd/alertsink

## Overview

A webhook receiver that logs every alert delivery. It is the checkable end of the pager path: the alert-fire drill greps its log for the alert name to prove Prometheus to Alertmanager to receiver end to end. The file comment says to replace it with Slack/PagerDuty in production and keep it for dev/CI (`main.go`).

## Interface

- Binary `/alertsink` (`main.go:main`). It listens on `SINK_ADDR` (default `:8080`).
- `handler(logger)` (`main.go`): `/healthz` returns 200. `/` reads up to 1 MiB of the body, logs `[sink] <method> <path> <body>` and returns 200. A body read error returns 400.

## Invariants

- It keeps no state. Each request is only logged, and the body read is capped by `io.LimitReader(r.Body, 1<<20)` (`main.go:handler`).

## Side Effects

- Binds an HTTP listener and writes delivered payloads to stdout.

## Verification

- Run: `cd packages/scale-zero-pg/gateway && go test ./cmd/alertsink/...`
