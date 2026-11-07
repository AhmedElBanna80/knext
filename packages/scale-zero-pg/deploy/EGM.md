# deploy

## Overview

All Kubernetes manifests for the database plane, plus the operational scripts around them. There are 31 numbered manifests (`00-namespace.yaml` to `88-loadsoak-k6.yaml`) plus `compute-app.template.yaml`. The Makefile `deploy` target runs `kubectl apply -f deploy/` (non-recursive, so `optional/` and `40-keda-scaledobject.yaml.optional` are not applied) and then `bash deploy/seed-ledger.sh`:

| Range | Contents |
| --- | --- |
| 00-30 | namespace, gateway, mTLS certs, computes, knext Secret |
| 50-64 | storage plane, storage-init, PDB, pageserver standby, pswatcher, monitoring stack, backup, slot/zone monitors |
| 70 | NetworkPolicy |
| 81-88 | apps-gateway, AppDatabase and Zone CRDs and operators, writer-autoscaler, k6 load-soak |

`compute-app.template.yaml` is the per-app template, with `__APP__`, `__TENANT_ID__`, `__TIMELINE_ID__`, `__REPLICAS__` and quota placeholders that `provision-app.sh` substitutes. `optional/` holds opt-in manifests (`27-compute-ro-hpa.yaml`, `28-gateway-public-lb.yaml`), and `testdata/` holds fixtures (`app-base-schema.sql`, `safekeeper.control.real`). The source files here are Bash and Python tooling: provisioning, secret generation, manifest validation and a large `_verify-*.sh` live-drill battery.

## Interface

- `provision-app.sh`: break-glass branch-per-app CLI. Subcommands are dispatched at the bottom of the file:
  - `init-plane`
  - `create <app>` with `--cpu-request/--cpu-limit/--mem-request/--mem-limit/--max-conns`
  - `render <app>` (no cluster)
  - `destroy <app> [--keep-timeline]`
  - `reclaim-orphans`
  - `list`
  - `fsck [--converge]`
  - `rotate-cred <app> [--bounce]`
- Secret generators (idempotent):
  - `gen-secrets.sh`: Secrets `storage-s3-creds`, `pg-cloud-admin`, `pg-base-admin`, `alertmanager-receiver`, `compute-jwt-trust` and `backup-s3-target`, plus the `storage-objstore` ConfigMap, each left untouched if it already exists. The exception is `myapp-database` (base-gateway `DATABASE_URL`/`DATABASE_URL_RO` on ports 55432/55434, host `DBHOST`, default `pggw.<ns>.svc.cluster.local.`), which is re-derived from `pg-base-admin` and re-applied on every run.
  - `gen-tls.sh`: `pggw-tls`.
  - `gen-peer-token.sh`: `pggw-peer-token`.
- `seed-ledger.sh`: create-if-absent seed of the `generation` key in the `pageserver-generation` ConfigMap (env `NS`, default `scale-zero-pg`; `KCTX`, empty = current context).
- `harden-pvs.sh`: patches PVs bound to scale-zero-pg PVCs to reclaim policy `Retain`.
- `_validate.sh`: server-side dry-run of the manifests plus numbered contract checks.
- `_lib-drill.sh`: shared, cluster-free drill helpers for the `_verify-*.sh` battery. It is meant to be sourced. Functions: `ceil_div`, `budget_from_measured_ms`, `wake_budget_ms`, `wake_budget_s`, `idle_budget_ms`, `hold_budget_s`, `idle_wait_s`, `ro_direct_dsn`, `retry_bounded`, `rb_wallclock`, `pods_present`, `probe_wake_budget`, `rollout_ready_retry`, `preflight_cluster_health`.
- `_verify-*.sh`, `_measure-ro-staleness.sh`, `_rehearse-upgrade.sh`, `_restore-writable.sh`, `_spike-logrepl.sh`, `_metrics.sh`: live drills and measurements against a cluster. Each file's header comment states the claim it proves.
- `skctl.py`: safekeeper on-disk `safekeeper.control` (v9) serializer for the writable-restore drill. Functions: `crc32c`, `lsn2int`, `seg_no`, `seg_name`, `pack_control`, `unpack_control`, `cmd_craft`, `cmd_seg`, `cmd_segrange`, `cmd_off`, `cmd_version`, `cmd_checkver`.
- `promdrift.py`: offline drift-check logic for `_verify-drift.sh` section H. It compares the tracked Prometheus config against live cluster data. Functions: `canonical_hash`, `extract_manifest_cm_data`, `check_prom_drift`, `run_cli_from_obj`.
- Child contract: [./compute-files/EGM.md](./compute-files/EGM.md) - compute pod entrypoints and the shared pg_hba/TLS harden.

## Invariants

- `provision-app.sh` refuses `RESERVED_NAMES` (default `tmpl warm ro`), the same set as the operator's `appdb.ReservedNames` and the gateway's `GW_RESERVED_SYSTEMS` (`provision-app.sh`, `RESERVED_NAMES=`).
- `destroy` reclaims the timeline on the pageserver and on every safekeeper by default. A safekeeper failure is recorded to the `apps-wal-reclaim-pending` ConfigMap rather than swallowed (`provision-app.sh` header, `record_reclaim_pending`).
- `seed-ledger.sh` writes `generation=1` only when the key is absent and never lowers an existing value. The key is deliberately left out of the manifests so `kubectl apply` cannot reset it (`seed-ledger.sh` header).
- `_validate.sh` does not use `set -e`. `fail()` records each failure and the script always reaches its summary, so no later contract can pass just because the run aborted early (`_validate.sh` header).
- The secret generators never overwrite an existing credential Secret ("leaving untouched (no silent rotation)" in `gen-secrets.sh`, `gen-tls.sh`, `gen-peer-token.sh`). The only reconciled object is `gen-secrets.sh`'s derived `myapp-database` DSN Secret (`gen-secrets.sh`, `DBNAME=`).

## Side Effects

- `kubectl` writes to the target cluster: Secrets, ConfigMaps, per-app compute objects, PV patches.
- Pageserver/safekeeper HTTP calls from `provision-app.sh`.
- The `_verify-*.sh` drills run against a live cluster and change its state. For example, `_verify-wal-janitor.sh` runs the real wal-janitor, which deletes objects from the live durability bucket (`_verify-wal-janitor.sh` header).

## Verification

- Run: `cd packages/scale-zero-pg && npm test`. Beyond the Go tests, this runs `test_skctl.py`, `test_promdrift.py`, `test_verify-drift-seterr.sh`, `test_provision-app.sh` and `test_gen-secrets.sh` in this directory. The live `_verify-*.sh` drills need a cluster and are not part of it.
