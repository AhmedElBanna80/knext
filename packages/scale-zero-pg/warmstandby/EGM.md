# warmstandby

## Overview

The prototype warm-standby experiment (design A). It measures the wake cost a pre-scheduled, gated compute pod removes. The productized form is the gateway's `warmpool` driver plus `deploy/compute-files/entrypoint-warm.sh`. The existing human-maintained [./README.md](./README.md) is left untouched.

## Interface

- Manifests: `10-compute-warm-files.yaml` (the `compute-warm-files` ConfigMap holding the gated entrypoint), `20-compute-warm.yaml` (the `compute-warm` Deployment and Service on 55433, reusing the `compute-files` ConfigMap's `config.json`), `30-warm-client.yaml` (the `warm-client` psql pod).
- `_measure.sh`: one sample is the time from gate release (a `kubectl exec` file touch) to the first successful `SELECT` direct to the warm pod on :55433, against a warm pod that is scheduled and running but has not yet attached compute_ctl. Each sample first aborts unless `deploy/compute` is at 0 with no compute pods. Env: `N` (default 20), `NS` (`scale-zero-pg`), `PROBE_SQL`, `LABEL` (`neon-warmstandby`), `RESULTS_DIR` (`../bakeoff/results`).
- `_cleanup.sh`: restores the namespace to rest. It scales `compute-warm` to 0, deletes its manifests (`20-compute-warm.yaml`, `10-compute-warm-files.yaml`, `30-warm-client.yaml`, ignore-not-found) and scales `deploy/compute` to 0. It is idempotent.

## Invariants

- `_cleanup.sh` polls for the `app=compute-warm` pods to drain before deleting the manifests, but the wait is bounded (60 polls of 0.5 s) and it proceeds after that regardless (`_cleanup.sh`).

## Side Effects

- Live cluster actions: creates and deletes warm pods and client pods, and scales `compute`.

## Verification

- Run (needs a cluster): `bash packages/scale-zero-pg/warmstandby/_measure.sh`. This is not part of the package `test` script.
