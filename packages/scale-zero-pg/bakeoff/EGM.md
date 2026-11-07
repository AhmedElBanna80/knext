# bakeoff

## Overview

Measurement harness for the Neon vs CloudNativePG (CNPG) foundation bake-off. `cnpg/` holds only YAML (operator 1.29.2, cluster, app Secret) and `results/` holds captured CSVs and summaries. `gateway-exec.Dockerfile` re-bases the unchanged `/gateway` binary from `scale-zero-pg/gateway:dev` onto a digest-pinned `alpine:3.20` with a shell and `kubectl`, and `gateway-exec-mode.yaml` runs it in `exec` mode in the `bakeoff-cnpg` namespace, waking and sleeping CNPG through its hibernation annotation. The source here is the shell drivers. `TUNING.md` is prose. The existing human-maintained [./README.md](./README.md) is left untouched.

## Interface

- `_measure.sh`: cold-wake timing harness that works for either foundation. From one in-cluster psql client pod it times a connect plus `SELECT <PROBE_SQL>` through a gateway DSN. Only the force-cold step (`COLD_CMD`) differs per foundation. Env: `LABEL` (required), `GW_HOST` (default `pggw.bakeoff-cnpg.svc`), `GW_PORT` (55432), `PGUSER`/`PGPASSWORD`/`PGDATABASE` (`app`), `PROBE_SQL` (`SELECT count(*) FROM t`), `N` (5), `CLIENT_NS` (`bakeoff-cnpg`), `CLIENT_POD` (`pgclient`).
- `_run-battery.sh`: the full battery, {cold wake, warm connect, reconnect-after-drain} x {Neon, CNPG}, with N (>=20) samples per cell. It writes one CSV per cell stamped with a shared `RUN_ID` and prints p50/p95/p99. Env: `N` (default 20), `FOUNDATIONS` (`neon cnpg`), `DIMS` (`cold warm reconnect`), `CLIENT_NS`, `CLIENT_POD`. A Neon cold sample counts only when `spec.replicas==0` and no compute pods remain, Terminating included; it forces cold by scaling the Deployment to 0 itself.
- `_verify-wake.sh`: hibernates the CNPG cluster and asserts that one cold connect through the exec-mode gateway wakes it and returns the seeded row count. Exit 0 means green.
- `_wake-breakdown.sh`: splits one CNPG un-hibernate into phases using pod timestamps and a tight psql probe. Deltas are in ms from t0.
- `_drill-cnpg-podkill.sh`: deletes the CNPG primary pod and checks that the operator reschedules it onto the same PVC with `SELECT count(*) FROM t` equal to `EXPECT_ROWS`.

## Invariants

- Every foundation is measured the same way (same client pod, query and percentile math). Only `COLD_CMD` varies (`_measure.sh` header).

## Side Effects

- Live cluster actions: hibernating and un-hibernating CNPG, deleting pods, running client pods, and writing CSVs under `results/`.

## Verification

- Run (needs a cluster): `bash packages/scale-zero-pg/bakeoff/_verify-wake.sh`. This is not part of the package `test` script.
