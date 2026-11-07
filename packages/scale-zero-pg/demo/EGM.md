# demo

## Overview

The end-to-end knext + scale-to-zero Postgres demo. `manifests/` (namespace, database Secret, `NextApp`, canary) and `operator/` (operator install bundle) hold YAML only. The source here is the drill scripts plus the Next.js app. The existing human-maintained [./README.md](./README.md) is left untouched.

## Interface

- `_verify.sh`: the demo drill. A knext `NextApp` (Knative scale-to-zero) and the Postgres both sleep at rest. One cold HTTP request wakes both and returns data, and then both idle back to zero, repeated N times. It also measures three request classes (`T_both`, `T_appcold`, `T_warm`) to separate both-cold overhead from the app's own cold start. Knobs: `DB_DEPLOY` (the observed compute, default `compute`), `DB_PREWAKE`, `KSVC_HOST` (derived at runtime unless overridden) (`_verify.sh` header).
- `migrate-to-perapp.sh`: moves the `pg-demo` NextApp off the shared primary onto its own per-app database. It does this by invoking `deploy/provision-app.sh`. Subcommands: `migrate [<app>]` (default `pgdemo`), `restore` (back to the shared-primary DSN) and `show [<app>]` (DSNs with the password redacted). Env: `KCTX`, `NS` (default `scale-zero-pg`), `APP_NS` (default `knext-demo`), `APP` (`migrate-to-perapp.sh` header).
- Child contract: [./app/EGM.md](./app/EGM.md) - the `pg-demo` Next.js app.

## Invariants

- `migrate-to-perapp.sh` provisions through `deploy/provision-app.sh` and does not reimplement it (`migrate-to-perapp.sh` header).

## Side Effects

- `migrate-to-perapp.sh` provisions a per-app database and applies the demo's `DATABASE_URL` Secret (`knext-demo/pg-demo-db`) with `kubectl apply` (`migrate-to-perapp.sh`, `K ... apply -f -`).
- `_verify.sh` creates two helper pods (curl and psql drivers) in the `knext-demo` namespace and removes them on exit, then sends cold and warm HTTP requests through `kourier-internal.knative-serving.svc`. It never scales the database; it only observes compute replicas (`_verify.sh` header).

## Verification

- Run (needs a cluster): `bash packages/scale-zero-pg/demo/_verify.sh`. This is not part of the package `test` script.
