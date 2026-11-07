# appdb

## Overview

The AppDatabase operator: a client-go reconcile controller that makes reality match an `AppDatabase` custom resource. It reimplements the imperative logic of `deploy/provision-app.sh` in Go. It branches the shared apps-template timeline, renders the per-app compute (Deployment + Service + ConfigMap), mints the per-app credential Secret and wires apps-gateway routing. The decision logic in `reconcile.go` is pure and port-driven (package doc, `types.go`).

## Interface

- CRD types (`types.go`): `Group` (`apps.scale-zero-pg.dev`), `Version` (`v1alpha1`), `Resource` (`appdatabases`), `Kind` (`AppDatabase`), `Finalizer` (`apps.scale-zero-pg.dev/deprovision`), `GVR`.
  - Phases: `PhaseProvisioning`, `PhaseReady`, `PhaseFailed`, `PhaseDeleting`.
  - Conditions: `CondProvisioned`, `CondReady`, `CondColdRestorable`, `CondWarmHold`.
  - Structs: `AppDatabase`, `AppDatabaseSpec`, `WarmWindow`, `Quotas`, `ROPool`, `AppDatabaseStatus`, `Condition`, `DefaultQuotas`.
- Reconcile (`reconcile.go`): `Deps.Reconcile(ctx, cr) (requeue, err)`, `ReservedNames` (`tmpl`, `warm`, `ro`), `IdleDelayAnnotation` (aliases the `wake` package constant).
- Ports (`ports.go`): `PageserverOps`, `SafekeeperOps`, `ClusterOps`, `WarmHolds`, `ComputeSpec`, `ROComputeSpec`, `Deps`, `DefaultGatewayHost` (`pggw-apps.scale-zero-pg.svc.cluster.local.`).
- Controller (`controller.go`): `Controller`, `NewController(dyn, deps, ns, resync, logger)`, `Run(ctx)`, `Healthy()`.
- Kubernetes adapter (`k8s.go`): `K8sCluster`, `NewK8sCluster(cs, dyn, ns, render, reclaimCM, logger)` and its methods.
  - Secrets: `SecretExists`, `CreateSecret`, `EnsureSecretOwnerRef`, `EnsureSecretROKey`, `DatabaseURL`.
  - Computes: `ApplyCompute`, `ApplyROCompute`, `DeleteROCompute`, `DeleteCompute`, `DeploymentAvailable`.
  - Reclaim ledger: `RecordReclaimPending`, `ClearReclaimPending`.
  - CR status: `UpdateStatus`, `AddFinalizer`, `RemoveFinalizer`, `Event`.
- Storage adapters (`pageserver.go`):
  - `HTTPPageserver` (`NewHTTPPageserver(baseURL, timeout)`): `TimelineExists`, `TemplateLastLSN`, `TemplateRemoteConsistentLSN`, `TimelineAncestorLSN`, `Branch`, `DeleteTimeline`.
  - `HTTPSafekeeper` (`NewHTTPSafekeeper(namespace, service, port, nReplicas, timeout)`): `Replicas`, `DeleteTimeline(ctx, ordinal, tenant, tl)`.
- Rendering (`render.go`): `RenderConfig`, `DefaultRenderConfig(ns)` (pageserver host `pageserver`, PG `17`, role prefix `app_`, digest-pinned `neondatabase/compute-node-v17:8464` and `neondatabase/neon:8464` images), `DefaultImageUID` (1000), `RenderConfigMap`, `RenderService`, `RenderDeployment`, `RenderROService`, `RenderRODeployment`, `RenderROHPA`.
- Warm holds (`warmhold.go`, `warm_schedule.go`): `HoldManager`, `NewHoldManager`, `EnsureHold`, `ReleaseHold`, `Held`, `HoldConn`, `HoldDialer`, `SQLDialer`, `DefaultHoldTimeout` (5s).

## Invariants

- A validation failure sets `PhaseFailed` and is terminal: there is no requeue until the spec changes [`reconcile.go:Reconcile`].
- The timeline id is persisted to status before branching, so a re-created CR gets a fresh id [`reconcile.go:reconcileApply`].
- The credential Secret `app-db-<app>` is minted before the branch, and re-provisioning keeps the same password. Its `DATABASE_URL` is `postgres://<role>:<pw>@<GatewayHost>:<GatewayPort>/<app>?sslmode=disable` [`reconcile.go:reconcileApply`, `k8s.go:CreateSecret`].
- `spec.appName` and `spec.idleDelay` are validated first. `spec.idleDelay` must be within 0 to 6h. 0 or nil means the fleet default, and a negative value is rejected. The value is written only as Deployment metadata, never into the pod template [`reconcile.go:validateIdleDelay`, `reconcile.go:idleDelayMillis`].
- The app role gets a precomputed SCRAM-SHA-256 verifier, so no tenant plaintext reaches the compute (4096 iterations) [`scram.go:scramSHA256Verifier`].
- Deprovision reclaims the timeline on the pageserver and on every safekeeper. A failure on any safekeeper is recorded to the reclaim ledger, the finalizer is kept, and the CR is requeued [`reconcile.go:reclaimTimeline`].
- A warm hold is one authenticated idle connection through the apps-gateway, using the Secret's `DATABASE_URL`. The operator never writes `spec.replicas`. Holds live only in memory and are rebuilt on resync [`warmhold.go`].

## Side Effects

- Kubernetes writes: per-app Secret, ConfigMap, Deployment, Service, RO Deployment/Service/HPA, the reclaim-ledger ConfigMap, CR status and finalizers, and Events [`k8s.go`].
- HTTP to the pageserver (branch, LSN reads, timeline delete) and to each safekeeper (timeline delete) [`pageserver.go`].
- Postgres connections through the apps-gateway for warm holds (`lib/pq`) [`warmhold.go:SQLDialer`].

## Verification

- Run: `cd packages/scale-zero-pg/gateway && go test ./internal/appdb/...`
