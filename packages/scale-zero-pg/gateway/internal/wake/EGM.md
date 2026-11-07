# wake

## Overview

Resolves compute targets and wakes or sleeps them. The gateway stays mode-agnostic: every mode exposes `Resolve(systemID) -> Target` plus `Wake`/`Sleep` (package doc, `wake.go`). `GW_COMPUTE_MODE` (default `static`) picks the mode: `static`, `exec`, `kubectl`, `template` or `warmpool`; any other value is an error (`wake.go:MakeDriverWithScaler`). The package doc comment lists only the first four; `warmpool` lives in `warm.go`. The package also holds the apps-gateway tenant authorization, the per-app wake budget, wake coalescing, the read-only lane env remap and backend TLS.

## Interface

- Config: `Env` (map of `GW_*` vars) and `EnvFromOS` (`wake.go`).
- Targets and connect (`wake.go`): `Target{Host, Port, Key}`, `Opts` (`ConnectTimeoutMs`, `WakeTimeoutMs`, `RetryMs`, `WakeGuard`, `WakeRetryBaseMs`, `WakeMaxAttempts`, `OnWakeRetry`, `Coalescer`, `BackendTLS`), `ParseHostPort`, `TryConnect`, and `ConnectWithWake(ctx, driver, t, opts, onWake) (conn, woke, wakeMs, err)`.
- Drivers (`wake.go`): `Driver` (`Mode`, `Resolve`, `Wake`, `Sleep`, `CanSleep`), `MakeDriver`, `MakeDriverWithScaler`, `IdleDelayAnnotation` (`apps.kn-next.dev/idle-delay-ms`), `AnnotationReader`.
- Kubernetes (`k8s.go`): `Scaler` (`Scale`). The private `k8sScaler` also implements `DeploymentAnnotation`, `Replicas`, `CountPods` and `DeletePods`. `warm.go` defines `WarmOps` and `GateStateSink`; the warmpool driver's `AttachMetrics(GateStateSink)` mirrors gate state into metrics.
- Authorization (`authz.go`): `AuthError`, `AuthFailureCode` (`"28P01"`), `UniformAuthFailure(user)`, and on the template driver `Authorize(user, database)` and `AuthorizeReplication(user, database)`.
- Wake budget (`budget.go`): `WakeLimiter`, `NewWakeLimiter`, `NewWakeLimiterFromEnv`, `Allow(key)`, `ErrWakeBudgetExceeded`.
- Coalescing (`singleflight.go`): `WakeCoalescer`, `NewWakeCoalescer`, `Do(ctx, key, fn)`.
- Read-only lane (`ro.go`): `ROEnv(base)` remaps `GW_RO_*` onto a `kubectl` env. `ROTemplateEnv(base)` remaps it onto a per-app `template` env.
- Warm gate (`gate.go`): `Gate`, `NewGate`, `Open`, `Close`, `IsOpen`, `SetOnState`, `Addr`.
- Backend TLS (`backendtls.go`): `BackendTLS` (`CAFile`, `CertFile`, `KeyFile`, `ServerName`), `NewBackendTLSFromEnv`, `TryConnectTLS`, `ErrBackendTLSUnavailable`, `ErrBackendDialFailed`, `ErrBackendTLSConfig`.

## Invariants

- Template mode refuses to start if `GW_K8S_DEPLOYMENT_TEMPLATE` lacks `{system}`. Without it every database would collapse onto one Deployment [`wake.go:MakeDriverWithScaler`].
- Template mode refuses to start if `GW_APP_ROLE_PREFIX == GW_REPL_ROLE_PREFIX` (defaults `app_` and `repl_`). Equal prefixes would merge the per-app and replication roles [`wake.go:MakeDriverWithScaler`].
- Every authorization refusal returns the same `UniformAuthFailure(user)` message with SQLSTATE `28P01`. That covers malformed RFC1123 names, reserved names (default `GW_RESERVED_SYSTEMS=tmpl,warm,ro`) and a wrong role. `Authorize` requires `user == rolePrefix+database`. `AuthorizeReplication` requires `user == replRolePrefix+database` [`authz.go`].
- Wake retries default to a 200 ms exponential base, at most 8 attempts and a 5 s cap per backoff step; a wake-budget refusal is terminal and never retried [`retry.go`].
- `ConnectWithWake` returns at once, with no gate or retry, when the first `TryConnectTLS` succeeds. When the compute is asleep, the order is: `WakeGuard` (budget), then `onWake`, then the bounded `wakeWithRetry` around `driver.Wake`. With a `Coalescer` set, that whole unit is single-flighted per `Target.Key` [`wake.go:ConnectWithWake`].
- An `ErrBackendTLSConfig` error is returned before any budget token is spent or any scale call is made [`wake.go:ConnectWithWake`].
- A nil `*WakeLimiter` (from `GW_WAKE_BUDGET` <= 0 or unset) always allows. Buckets are per key [`budget.go:NewWakeLimiter`, `budget.go:Allow`].
- The warmpool driver opens the gate only when the cold deployment has 0 desired replicas and 0 pods (Terminating included). Any error refuses [`warm.go:warmDriver.Wake`].
- `Scale` is a GetScale then UpdateScale that converges on the target count, so retrying it is safe [`k8s.go:k8sScaler.Scale`].
- The per-app idle window is read-only here. An absent, malformed or unreadable annotation falls back to `GW_IDLE_MS` [`wake.go:deploymentIdleDelayMs`].

## Side Effects

- Kubernetes API calls through client-go (in-cluster config, else kubeconfig, built lazily once): Deployment scale-subresource get/update, Deployment annotation reads, pod list/count and pod delete [`k8s.go`].
- `exec` mode runs the `GW_WAKE_CMD` / `GW_SLEEP_CMD` shell commands [`wake.go:execDriver`].
- The warmpool driver's `Sleep` closes the gate, then deletes the warm pods (`GW_WARM_SELECTOR`, default `app=compute-warm`) [`warm.go:warmDriver.Sleep`].
- TCP (optionally TLS) dials to compute backends [`backendtls.go:TryConnectTLS`].
- `Gate.Open` binds a TCP listener on `GW_GATE_PORT` (default 9091) [`gate.go`, `wake.go:MakeDriverWithScaler`].
- Reads the CA, client cert and key files from `GW_COMPUTE_CA_FILE`, `GW_COMPUTE_CLIENT_CERT_FILE` and `GW_COMPUTE_CLIENT_KEY_FILE` (defaults under `/etc/pggw-mtls-ca/` and `/etc/pggw-client-tls/`) when `GW_COMPUTE_TLS` is on (default `true`). A blank path while TLS is on is a startup error [`backendtls.go:backendTLSPathsFromEnv`, `backendtls.go:NewBackendTLSFromEnv`].

## Verification

- Run: `cd packages/scale-zero-pg/gateway && go test ./internal/wake/...`
