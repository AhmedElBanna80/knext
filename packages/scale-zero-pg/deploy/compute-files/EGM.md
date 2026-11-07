# deploy/compute-files

## Overview

The shell entrypoints, the compute_ctl spec template `config.json` and the shared hardening library mounted at `/compute-files` into every Neon compute pod (`neondatabase/compute-node-v17`) through the compute-files ConfigMap. Each entrypoint renders `/compute-files/config.json` to `/tmp/config.json`, substituting `TENANT_ID`, `TIMELINE_ID`, `CLOUD_ADMIN_MD5_PLACEHOLDER` and the `JWT_JWK_*_PLACEHOLDER` values, sources `lib-harden.sh` and `exec`s `compute_ctl`. The existing human-maintained [./README.md](./README.md) is left untouched.

## Interface

- `entrypoint.sh`: primary and per-app writer. It requires `TENANT_ID`/`TIMELINE_ID` (`: "${TENANT_ID:?...}"`) and substitutes them into the spec. With `APP_ROLE` set (a per-app compute) it replaces a missing or public-default `CLOUD_ADMIN_MD5` with a random one, injects the `APP_ROLE`/`APP_ROLE_VERIFIER` SCRAM login role and starts `harden_pg_hba &` in the background. `PG_MAX_CONNECTIONS` overrides `max_connections`, and a missing `JWT_JWK_X` gets a random throwaway trust anchor. It then calls `stage_tls_key` and `exec /usr/local/bin/compute_ctl` against `localhost:55433`.
- `entrypoint-ro.sh`: read-only pool compute. It uses the same tenant and timeline as the writer and injects `RO_MODE` into the spec so Postgres boots as a read-only endpoint: `Replica` (default) or `Static`, which pins `RO_STATIC_LSN` or the LSN in `/ro-lsn/lsn` and exits if neither is set. Any other mode exits.
- `entrypoint-warm.sh` (bash): gated warm-tier compute. It blocks in `until (exec 3<>"/dev/tcp/${GATE_HOST}/${GATE_PORT}")` on the required `WARM_GATE_ADDR` (`host:port`) and boots compute_ctl only once the gateway opens the gate.
- `lib-harden.sh` (POSIX sh, sourced by all three entrypoints; `harden_pg_hba` runs only when `APP_ROLE` is set):
  - `stage_tls_key <spec>` copies the server TLS key to `/tmp/pggw-server-tls.key` (mode 0600). When the key or CA is missing or empty it removes the ssl GUCs instead, so the compute boots plaintext.
  - `harden_pg_hba` waits for loopback Postgres, then edits `pg_hba.conf`. It inserts `host all cloud_admin all reject` before the network catch-all. When `SHOW ssl` is `on` it rewrites the catch-all to `hostssl all all all scram-sha-256 clientcert=verify-ca`; otherwise it keeps `host all all all scram-sha-256`, so client-cert mTLS is not enforced on a plaintext compute.

## Invariants

- `lib-harden.sh` is the single copy of the pg_hba harden for every compute tier, so the tiers cannot drift (`lib-harden.sh` header).
- `clientcert=verify-ca` must not be changed to `verify-full`. The gateway presents one shared client leaf whose CN is a service name, and `verify-full` would refuse every gateway-to-compute connection (`lib-harden.sh` header).
- The `cloud_admin` reject stays a broad `host` rule, never `hostssl`, so plaintext `cloud_admin` attempts are refused too (`lib-harden.sh` header).
- The warm entrypoint does no single-writer check itself. The gateway's warmpool driver opens the gate only after the cold compute is drained (`entrypoint-warm.sh` header). See [../../gateway/internal/wake/EGM.md](../../gateway/internal/wake/EGM.md).

## Side Effects

- Writes the rendered spec and staged key under `/tmp`, rewrites `pg_hba.conf` in `PGDATA` and reloads it via loopback `psql`, then replaces the shell process with `compute_ctl`.

## Verification

- Run: `cd packages/scale-zero-pg/deploy && bash test_harden_pghba.sh`. This test is not part of the package `test` script, which runs `cd packages/scale-zero-pg && npm test`.
