# zone

## Overview

The Zone operator: a client-go reconcile controller for the zone-scaling axis. A Zone composes an `AppDatabase` (the zone's in-zone DB and RO pool) and adds the cross-zone fabric on top: a per-zone REPLICATION role, publications, and for each declared `dataDependency` either a logical-replication subscription (`replicate`) or `postgres_fdw` foreign tables (`federate`). The decision logic in `reconcile.go` is pure and port-driven, and `sql.go` builds and validates all emitted SQL (package doc, `types.go`).

## Interface

- CRD types (`types.go`): `Group` (`zones.scale-zero-pg.dev`), `Version` (`v1alpha1`), `Resource` (`zones`), `Kind` (`Zone`), `Finalizer` (`zones.scale-zero-pg.dev/deprovision`), `GVR`, `AppDBGVR` (`apps.scale-zero-pg.dev/v1alpha1` `appdatabases`, referenced by string so the package never imports `appdb`).
  - Modes: `ModeReplicate`, `ModeFederate`.
  - Phases: `PhaseComposing`, `PhaseReady`, `PhaseDegraded`, `PhaseFailed`, `PhaseDeleting`.
  - Conditions: `CondComposed`, `CondPublished`, `CondFabric`.
  - Subscription states: `SubStreaming`, `SubPending`, `SubFederated`, `SubDenied`, `SubError`, `SubNeedsResync`.
  - Structs: `Zone`, `ZoneSpec`, `ZoneDatabase`, `Quotas`, `Publication`, `DataDependency`, `ZoneStatus`, `SubscriptionStatus`, `Condition`, `DefaultQuotas` (`1000m`/`250m` CPU, `1Gi`/`256Mi` memory, 100 connections).
- Reconcile (`reconcile.go`): `Deps.Reconcile(ctx, cr) (requeue, err)`, `ReservedNames` (`tmpl`, `warm`, `ro`).
- Ports (`ports.go`): `AppDBOps`, `ComposeSpec`, `SQLOps`, `ClusterOps`, `ZoneLister`, `Deps`.
- Controller (`controller.go`): `Controller`, `NewController(dyn, deps, ns, resync, logger)`, `Run`, `Healthy`.
- AppDatabase client (`appdbclient.go`): `DynAppDB`, `NewDynAppDB`, `EnsureAppDatabase`, `AppDatabaseReady`, `DeleteAppDatabase`.
- SQL executor (`execsql.go`): `DynSQL`, `NewDynSQL`, plus `Ensure`/`Drop` for the repl role, publication, subscription, replication slot and federation, `ResyncSubscription` and `SlotInvalidatedOnPeer`.
- Kubernetes adapter (`k8s.go`): `K8sCluster`, `NewK8sCluster`, `EnsureReplSecret`, `ReplSecret`, `DeleteReplSecret`, `ComputeExists`, `ComputeAwake`, `WakeCompute`, `UpdateStatus`, `AddFinalizer`, `RemoveFinalizer`, `Event`, `ListZones`, `FromUnstructured`.

## Invariants

- Table identifiers that fail validation are refused, never quoted and passed through [`sql.go:validTableIdent`, `sql.go:validateTables`].
- Single writer per replicated table:
  - a table may be published by at most one zone;
  - a zone may not both publish and replicate-import the same table;
  - a replicate-import must have exactly one publisher.
  [`sql.go:checkSingleWriter`]
- The both-sides-agree check: a dependency is granted only when the peer publishes the requested tables [`sql.go:publishedByZone`, `sql.go:pubsCovering`].
- If the zone list cannot be read, Reconcile requeues instead of admitting fabric or marking the zone `Failed`. DELETE skips this guard [`reconcile.go:Reconcile`].
- `readOnly` health queries never wake a sleeping peer compute. Admin `exec` wakes the compute first [`execsql.go:exec`, `execsql.go:readOnly`].
- Ensure-publication never drops a live publication [`sql.go:buildEnsurePublication`].
- A still-active replication slot is never dropped [`sql.go:buildDropReplicationSlot`].

## Side Effects

- Creates, reads and deletes `AppDatabase` CRs through the dynamic client [`appdbclient.go`].
- Runs `psql -h localhost -p 55433 -U cloud_admin -d postgres -v ON_ERROR_STOP=1` in the `compute` container of a Ready `compute-<zone>` pod through the Kubernetes exec API, streaming the SQL on stdin [`execsql.go:run`].
- Emitted object names: subscription `zone_sub_<zone>`, FDW server `zone_fdw_<zone>`, foreign schema `zone_<zone>` (hyphens become underscores) [`sql.go:subName`, `sql.go:fdwServer`, `sql.go:fdwSchema`].
- Kubernetes: per-zone replication Secret `zone-repl-<zone>`, compute wake, Zone status, finalizers and Events [`k8s.go`].

## Verification

- Run: `cd packages/scale-zero-pg/gateway && go test ./internal/zone/...`
