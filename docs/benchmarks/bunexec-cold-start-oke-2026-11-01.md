# bun-exec cold start on OKE — BLOCKED, no measurement (2026-11-01)

**Status: not measured.** No cold cycles were run, so there is no n, no median, no CI and no verdict.
This file records what was checked, why the round stopped, and what is needed to unblock it.

## Question

Does the vinext → `bun build --compile --bytecode` single executable (arm A, `bun-exec`) cold-start
faster than the same app as standalone + Bun (arm B), on the live OKE cluster, under the V-C6 claim
policy (paired A/B, n ≥ 60 valid pairs per arm)?

## Cluster and access

- Kube context `knext-oke-sa` (cluster `cluster-knext-oke-cgsssn62kra`, user `knext-lead-sa`).
  Reachable and read-only checks succeeded. `knext-oke` was not used and no OCI credentials were touched.
- Namespaces present: `bench-cells`, `bench-n3` (empty), `bench-131-20261013`, `rc2-test`, `rc3-test`, `mirror-bench`.
  No new namespace was created and nothing was deleted or patched.

## Image provenance check (what is deployed, and how current)

Every NextApp in the cluster was enumerated (`kubectl get nextapps -A`). No running pair of the same
app exists in both build shapes.

| NextApp (namespace) | image (digest) | build / runtime | source commit | age / drift vs `origin/integration/v2` |
|---|---|---|---|---|
| `file-manager` (fm-vinext) | `ghcr.io/getknext-dev/file-manager:8ae13e89b-next1643-vinext@sha256:c3b24eb4e7ebb8dedcb9e50c39e76f6ca57a34ade8c860c06f3988cad325c1c0` | vinext (single exec) | `8ae13e89b` (main, 2026-10-28) | 824 commits behind; 165 touch `cli/`, `adapters/`, `config.ts`, or the operator |
| `file-manager` (fm-v1-demo) | `ghcr.io/getknext-dev/fm-v1-demo:v1.0.0-r2@sha256:d0a3e4cc3bdd0452333b78c2ee420fcdb088d96a7d0e11016592a92935ab3b1d` | turbopack, bun | tag `v1.0.0-r2` (commit not recorded in the tag) | older release; not the same build line |
| `bc-bun-main` / `bc-bun-lite` (bench-cells) | `ghcr.io/getknext-dev/litebench-{main,lite}-bun@sha256:f6b2f2af…` / `ac8860da…` | turbopack, bun | not recorded (GHCR tag `ab1`, pushed 2026-10-11) | 20 days old; predates the current v2 line |
| `cc-b24`, `cc-n22`, `cc-n24` (bench-cells) | `cc24-*` images | turbopack, bun/node | tag `n24-20261012` (2026-10-12) | stale |
| `b131` / `n131` (bench-131-20261013) | `bench131-*` (2026-10-13) | turbopack, bun/node | not recorded | stale |

Deployed-state checks: `file-manager` in `fm-vinext` is `Ready` on revision `file-manager-00004`. Its
pods are the app plus `minio`, `postgres` and `redis` (29 days old). The NextApp's
`last-applied-configuration` confirms `build: vinext` and `buildId: 8ae13e89b-next1643-vinext`.

**Conclusion on currency:** no image on the cluster was built from a current `integration/v2`.
The newest vinext image is 824 commits behind it. Reusing any of them would measure a build that is
not what the branch ships.

**Same-app pairing:** the only vinext image (`file-manager`, fm-vinext) and the only bun-standalone
image for that app (`file-manager`, fm-v1-demo) come from different commits and different release
lines, and both bring Postgres, Redis and MinIO into the cold path. The previous Redis/Postgres
degradation (`docs/benchmarks/vinext-bunexec-oke-ab-2026-08-17.md`, the cold-start ledger rows 6–7)
makes that pairing inadmissible for a cold-start claim.

## Why the round stopped

Building fresh images for both arms (the same scaffold app, one vinext build and one standalone+Bun
build, from `e92fcf1e3`) is possible locally: bun 1.4.2 and Docker buildx are installed. The result
must then be pushed to `ghcr.io/getknext-dev`. The only write credential available to this session is
the user's `gh` CLI token (`write:packages`). Using it to log in to the registry is not the repo's
normal CI publish path (the release workflow uses CI-scoped credentials), so this was treated as a
new-credential push and not done.

A calibrated check (`jev pick`, choice over push / stop / reuse) returned **stop 0.81** (confidence
0.72); push 0.19; reuse 0.00.

## What is needed to unblock

1. A registry push path that the repo normally uses for bench images (CI job or the release
   workflow's credential), or the founder's explicit go-ahead to push with the `gh` token.
2. Then: build both arms from `origin/integration/v2` HEAD (`e92fcf1e3` at the time of this check),
   record each digest and the CLI commit, and deploy both via `knext deploy --image` to a fresh
   NextApp pair in an existing bench namespace (`bench-cells`). Confirm `dev.knext.app.id` matches
   across arms before any sample is counted.
3. Run the interleaved ABBA driver (`scripts/bench-cold-start-phases/cold-cycle.mjs`) for ≥ 60 valid
   pairs per arm, one cluster sitting at a time.

## Resources left on the cluster

Nothing was created, modified or deleted on the cluster in this round. All checks were read-only.

## Files

- This report: `docs/benchmarks/bunexec-cold-start-oke-2026-11-01.md` (branch
  `bench/bunexec-cold-2026-11-01`, worktree `.claude/worktrees/bench-bunexec-cold`).
- No ledger row was added: a ledger row needs a measured result, and none exists.
