# scale-zero-pg

## Overview

The database layer of the knext platform: a wake-on-connect Postgres gateway plus the AppDatabase and Zone operators, in Go and Kubernetes. It is a private, non-JS package. Its `package.json` scripts only let turbo drive the Go and shell toolchain (`package.json` `description`). This directory has no source files of its own. `docs/` is prose, apart from `docs/release/gateway-cd.workflow.yml`, an inactive GitHub workflow template (its header says it does not run from there). The human-maintained `README.md`, `CLAUDE.md`, `HANDOFF.md`, `TASKS.md` and `postgres-neon-scs-architecture-detailed.md` are left untouched.

## Interface

- `package.json` scripts: `build` (`cd gateway && go build ./...`), `build:image` (`docker build -t scale-zero-pg/gateway:ci gateway/`), `lint`, `test` (see Verification).
- `turbo.json` scopes the cache inputs: `build`, `lint` and `build:image` read `gateway/**` (`build:image` is uncached); `test` reads `gateway/**` and `deploy/**`.
- `Makefile` targets: `help`, `local-up`/`local-down` (`docker compose` in `local/`, a directory that does not exist in this tree), `check` (`go vet`), `smoke` (`go test ./...`), `gateway` (`go run ./cmd/gateway`), `deploy` (`kubectl apply -f deploy/`, then `bash deploy/seed-ledger.sh`).

## Subdirectories & Boundaries

- gateway: [./gateway/EGM.md](./gateway/EGM.md) - Go module and multi-binary image: the wake-on-connect proxy, AppDatabase/Zone operators, pageserver failover watcher, writer autoscaler and alert sink.
- deploy: [./deploy/EGM.md](./deploy/EGM.md) - Kubernetes manifests, the break-glass `provision-app.sh`, secret generators, `_validate.sh` contracts and the live `_verify-*.sh` drill battery.
- demo: [./demo/EGM.md](./demo/EGM.md) - end-to-end knext NextApp + scale-to-zero Postgres demo app and drills.
- bakeoff: [./bakeoff/EGM.md](./bakeoff/EGM.md) - Neon vs CNPG cold-wake measurement harness.
- warmstandby: [./warmstandby/EGM.md](./warmstandby/EGM.md) - prototype warm-standby wake measurement, superseded in production by the `warmpool` driver.

## Verification

- Run: `cd packages/scale-zero-pg && npm test`. This runs `cd gateway && go test ./...`, then in `deploy/` the `test_skctl.py` and `test_promdrift.py` unittests and `test_verify-drift-seterr.sh`, `test_provision-app.sh` and `test_gen-secrets.sh`.
- Lint: `npm run lint` (`gofmt -l` must be empty, then `go vet ./...`).
