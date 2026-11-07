# pswatcher

## Overview

The pageserver auto-failover controller. It automates the manual runbook: promote a warm Secondary pageserver at generation+1, flip the client Service selector to it, and bounce the compute. Primary liveness drives it. The generation is persisted in a ConfigMap ledger, so repeated failovers keep incrementing and a restarted watcher never reuses a stale generation (package doc, `watcher.go`).

## Interface

- Controller (`watcher.go`): `Config`, `Controller`, `NewController(p, standby, pr, k, cfg, m)`, `Tick(ctx) (promoted bool, err)`, `SeedLedger(ctx)`, `SetClock`, `SetGenerationViewer`, `SetStandbyMembershipViewer`, `SetStandbyWarmer`, `SetLogger`, `Metrics`.
- Ports (`watcher.go`): `Prober`, `Promoter`, `GenerationViewer`, `SecondaryWarmer`, `StandbyMembershipAt`, `TenantMembershipViewer`, `K8sOps`.
- Errors and constants (`watcher.go`): `DefaultMaxFreezeDuration` (2h), `ErrTenantNotFound`, `ErrGenerationUnreadable`, `ErrTenantShardsUnreadable`, `ErrNoStandbyMembership`, `ErrLedgerConflict`.
- HTTP adapters for the pageserver API (`http.go`), each with a `New…(…, timeout)` constructor (`NewHTTPProber`, `NewHTTPPromoter`, `NewHTTPGenerationViewer`, `NewHTTPTenantMembershipViewer`, `NewHTTPTenantMembershipAt`, `NewHTTPSecondaryWarmer`): `HTTPProber` (GET the status URL), `HTTPPromoter` (`PUT <base>/v1/tenant/<T>/location_config` with `{"mode":"AttachedSingle","generation":N,"tenant_conf":{}}`; a 404 maps to `ErrTenantNotFound`), `HTTPGenerationViewer` (`GET <base>/v1/tenant/<T>`, top-level `generation`), `HTTPTenantMembershipViewer`, `HTTPTenantMembershipAt` (both read `GET <base>/v1/location_config`), `HTTPSecondaryWarmer` (`PUT …/location_config` with `{"mode":"Secondary","secondary_conf":{"warm":true},"tenant_conf":{}}`).
- Kubernetes adapter (`k8s.go`): `K8sClient`, `NewK8sClient(namespace, genConfigMap, freezeConfigMap, primaryContainer)` (in-cluster config, falling back to kubeconfig; container defaults to `pageserver`; the ledger key is `generation` and the freeze key is `until`), `FailoverFreeze`, `ServiceSelectorApp`, `FlipServiceSelector`, `DeletePods`, `PodReady`, `GetGeneration`, `SetGeneration(gen, rv)`.
- Config helper (`config.go`): `RoutedTenants(base, apps)`: base first, apps appended only when non-empty and distinct; nil for an empty base.
- Metrics (`metrics.go`): `Metrics`, `NewMetrics`, `BuildVersion` (default `"dev"`), the capability tokens `FeatureFreeze`, `FeatureRoutedSet`, `FeatureStandbyWarm` and `FeaturesLabel` (their comma-joined list), the failover, freeze, converge, ledger and standby-warm counters, `PromText`, `Handler` (`/healthz`, `/metrics`, `/metrics.json`, no auth).

## Invariants

- The ledger is never lowered, and `SeedLedger` never invents a value. An absent key is seeded only from a generation recovered from the routed pageserver, otherwise `SeedLedger` returns an error. A present key is only healed upward, with a resourceVersion CAS [`watcher.go:SeedLedger`, `k8s.go:SetGeneration`].
- Promotion covers every routed tenant (`Config.Tenants`), which defaults to `[Tenant]` [`watcher.go:Config`].
- A maintenance freeze's effective expiry is clamped to createdAt + `MaxFreezeDuration`. An unreadable or malformed freeze counts as no freeze: HA stays on and the error is counted [`watcher.go:Tick`, `watcher.go:DefaultMaxFreezeDuration`].
- Standby warming targets only the node the client Service does not select. If the selector resolves to no known node, the reconcile aborts [`watcher.go:Config.WarmTargets`].
- `Controller` runs on a single goroutine with no internal locking [`watcher.go:Controller`].

## Side Effects

- HTTP to the pageserver APIs: status probes, generation and membership GETs, the attach and warm PUTs [`http.go`].
- Kubernetes: reads the freeze ConfigMap, reads and CAS-writes the generation ConfigMap, patches the Service selector, deletes compute pods, reads pod readiness [`k8s.go`].

## Verification

- Run: `cd packages/scale-zero-pg/gateway && go test ./internal/pswatcher/...`
