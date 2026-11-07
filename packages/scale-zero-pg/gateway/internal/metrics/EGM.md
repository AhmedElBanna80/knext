# metrics

## Overview

Gateway counters and their HTTP surface. The package serves JSON on `/metrics.json`, Prometheus text on `/metrics` and liveness on `/healthz`, using only the standard library `net/http` (package doc, `metrics.go`).

## Interface

- `Metrics`, `NewMetrics` (`metrics.go`): a mutex-guarded counter set. It has a fleet-wide part and a per-compute-key part (`sysMetrics`: connections, active, wakes, last wake ms, wake-budget refusals, backend TLS failures).
- Writers (`metrics.go`): `ConnOpen`, `ConnClose`, `Wake`, `WakeFailure`, `WakeRetry`, `RejectConn`, `WakeBudgetExceeded`, `BackendTLSFailure`, `ReplicationConn`, `Sleep`, `SleepFailure`, `WakeBackFailure`, `PeerCheckFailure`, `SetGateOpen`.
- Readers (`metrics.go`): `Connections`, `Active`, `Wakes`, `WakeFailures`, `WakeRetries`, `Sleeps`, `SleepFailures`, `WakeBackFailures`, `PeerCheckFailures`, `Rejected`, `WakeBudgetExceededCount`, `BackendTLSFailureCount`, `ReplicationConns`, `PromText`.
- HTTP (`metrics.go`): `Handler` serves the three endpoints with no peer auth. `HandlerWithPeerAuth(PeerAuth)` serves the same endpoints but puts `/metrics.json` behind a bearer token.
- Peer auth (`metrics.go`): `PeerAuth`, `PeerAuth.Disabled`, `ResolvePeerAuth(getenv)`, `ErrPeerAuthUnset`.

## Invariants

- Peer auth fails closed. `ResolvePeerAuth` returns `ErrPeerAuthUnset` when `GW_PEER_TOKEN` is empty and `GW_PEER_AUTH_DISABLED` is not `"true"`. Under `HandlerWithPeerAuth`, that explicit opt-out is the only way `/metrics.json` is served without a token; `Handler()` (no peer auth) is the unauthenticated variant [`metrics.go:ResolvePeerAuth`, `metrics.go:handler`].
- The token check needs the `Bearer ` prefix and compares with `hmac.Equal` (constant time). Any mismatch, missing header or other scheme is rejected, and the handler answers `401` [`metrics.go:peerAuthOK`, `metrics.go:handler`].
- Only `/metrics.json` is gated. `/metrics` and `/healthz` stay open under `HandlerWithPeerAuth` [`metrics.go:HandlerWithPeerAuth`].
- Every counter read and write takes `m.mu`, so the type is safe for concurrent use [`metrics.go:Metrics`].

## Side Effects

- In-memory counter changes only. The package opens no listener: callers mount `Handler`/`HandlerWithPeerAuth` on their own `http.Server` (see `cmd/gateway/main.go`).

## Verification

- Run: `cd packages/scale-zero-pg/gateway && go test ./internal/metrics/...`
