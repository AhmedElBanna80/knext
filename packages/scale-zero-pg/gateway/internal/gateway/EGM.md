# gateway (package)

## Overview

The wake-on-connect Postgres proxy server. The flow is: accept, handle SSL/GSS, parse the StartupMessage, resolve the compute from the database name, wake it if asleep, replay the startup bytes, then pipe. After the handshake the package is a byte pipe and auth and queries pass through untouched. When the last connection for a compute has stayed closed for `GW_IDLE_MS`, the compute is scaled back to zero in modes that can sleep (package doc, `gateway.go`).

## Interface

- `Gateway`, `New(env wake.Env, log) (*Gateway, error)` (`gateway.go`). Its one exported field is `Peers PeerChecker` (nil = single-replica idle).
- `Serve(ln)`, `Close()`, `Drain(ctx)`, `Metrics()`, `Driver()` (`gateway.go`).
- `PeerChecker` (`ActiveConnections(ctx, key)`) (`gateway.go`). `NewK8sPeers(namespace, selector, selfIP, metricsPort, peerToken)` (`peers.go`) returns a nil checker (single-replica semantics) when the namespace or selector is empty or the process is not in-cluster.
- Driver capabilities checked by type assertion (`gateway.go`, `dbrewrite.go`): `systemAuthorizer`, `replicationAuthorizer`, `servedDatabaseRewriter`.
- Opt-in compute_ctl `/status` readiness probe (`statusgate.go`), configured by `GW_STATUS_PORT`, `GW_STATUS_TOKEN`, `GW_STATUS_TOKEN_FILE`, `GW_STATUS_READY`, `GW_STATUS_POLL_MS`, `GW_STATUS_REQ_TIMEOUT_MS` and `GW_STATUS_TIMEOUT_MS`.
- Env knobs read in `New` (`gateway.go`), with defaults: `GW_CONNECT_TIMEOUT_MS` (1000), `GW_WAKE_TIMEOUT_MS` (60000), `GW_RETRY_MS` (250), `GW_WAKE_RETRY_BASE_MS` (200), `GW_WAKE_MAX_ATTEMPTS` (8), `GW_IDLE_MS` (300000), `GW_AUTH_FAIL_FLOOR_MS` (250), `GW_ROLE_APPLY_SETTLE_MS` (250), `GW_MAX_CONNS` (0 = unlimited), `GW_WAKE_BUDGET`, `GW_WAKE_WINDOW_MS`, `GW_TLS_CERT_FILE`, `GW_TLS_KEY_FILE`. `New` also builds the driver (`wake.MakeDriver`) and backend TLS (`wake.NewBackendTLSFromEnv`) from the same env, and always installs a `wake.WakeCoalescer`.

## Invariants

- Authorization runs before any wake. A driver that gates ordinary traffic but cannot gate replication refuses replication startups [`gateway.go:systemAuthorizer`, `gateway.go:replicationAuthorizer`].
- On an authorizing (template) driver, a wake or resolve failure returns the same `28P01` `UniformAuthFailure` as an auth refusal, after the `authFloor` delay. Otherwise it returns `57P03 compute unavailable` [`gateway.go:computeUnavailable`].
- A wake refused by the budget returns SQLSTATE `53400` and the compute is not scaled [`gateway.go:wakeBudgetSQLSTATE`].
- At the `GW_MAX_CONNS` limit a new connection gets `53300` and is closed [`gateway.go:Serve`].
- Malformed startup packets get `08P01` [`gateway.go:handle`].
- An SSLRequest is answered `S` and upgraded to TLS (min TLS 1.2, 30 s handshake deadline) only when both `GW_TLS_CERT_FILE` and `GW_TLS_KEY_FILE` are set; otherwise it gets `N`. Setting only one of them is a startup error. GSSENC always gets `N`, and a CancelRequest is closed [`gateway.go:loadTLS`, `gateway.go:handle`].
- A StartupMessage with no `database` param routes to `postgres` [`gateway.go:handle`].
- A connection is enrolled for drain at accept, before any wake. `Drain` waits for in-flight sessions until ctx expires, then force-closes them. A closed gateway refuses new connections [`gateway.go:Drain`, `gateway.go:registerConn`].
- An active replication stream keeps its compute awake. `replCount` is at most `count` [`gateway.go:activeEntry`].
- Peer-aware idle counts connections per app. A peer listing or scrape error means "don't sleep" [`peers.go:k8sPeers`].
- The startup `database` param is rewritten only when the driver serves a different physical database. Otherwise the original bytes are replayed unchanged [`dbrewrite.go:rewriteStartupDatabase`].

## Side Effects

- Listens for client TCP connections (optionally TLS via `GW_TLS_CERT_FILE`/`GW_TLS_KEY_FILE`) and dials computes through `wake` [`gateway.go`].
- Scales computes to zero on idle through the `wake.Driver` [`gateway.go`].
- Lists gateway peer pods and scrapes each peer's `http://<podIP>:<metricsPort>/metrics.json` with the bearer token and a 2 s timeout [`peers.go`].
- Optional HTTP polling of compute_ctl `/status` [`statusgate.go`].

## Verification

- Run: `cd packages/scale-zero-pg/gateway && go test ./internal/gateway/...`
