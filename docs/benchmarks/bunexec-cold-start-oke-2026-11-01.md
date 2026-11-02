# bun-exec cold start on OKE (2026-11-01)

**Verdict: tie.** Single executable (`build: vinext`, arm A) and standalone + Bun (`build: turbopack`, `runtime: bun`, arm B) are indistinguishable on scale-from-zero cold start on the OKE bench cluster. Median difference A−B is +36 ms; Hodges–Lehmann +79 ms, 95% bootstrap CI [−143, +230] ms, Mann–Whitney p = 0.19. The CI spans zero, so the claim is a tie under the V-C6 rule.

## Question

Does the vinext → `bun build --compile --bytecode` single executable cold-start faster than the same app as standalone + Bun, on the live OKE cluster, under the V-C6 claim policy (paired A/B, n ≥ 60 valid pairs per arm)?

## Build provenance

- **Source commit:** `e92fcf1e3` (`origin/integration/v2` tip at build time). Both arms are built from this one commit.
- **CLI:** built from that commit's source (`packages/kn-next`, `bun run build`). `packages/db` was built first, because the kn-next DTS step needs it.
- **Dependencies:** `@getknext/core`, `@getknext/lib` and `@getknext/db` were packed from the same commit with `bun pm pack` (npm pack leaves `workspace:` specifiers, which npm cannot install). The two apps installed those tarballs, not the registry releases.
- **Apps:** the default scaffold from that CLI, `knext create --yes --runtime bun` with `--builder vinext` (A) or `--builder turbopack` (B). Bench-only config deltas, identical in both arms: `scaling.maxScale: 1`, the scaffold's `scaleDownDelay: "5m"` removed (so each arm returns to zero between cycles), and `imagePullSecrets: ["ghcr-bench"]`.
- **Build:** `knext build` in each app. A compiled the single executable (`knext-exec-linux-x64`, post-compile smoke passed). B staged `Dockerfile.standalone` with target `standalone-bun`.
- **Image:** `docker buildx build --platform linux/amd64 --push`, Docker 29.8.2 with OrbStack on an arm64 Mac, the amd64 cross build via buildx.

## Images (GHCR)

Package `ghcr.io/getknext-dev/bench-bunexec`, pushed with the founder-approved `gh` login (`docker login ghcr.io`, token piped on stdin, never printed).

| arm | ref | digest | shape |
|---|---|---|---|
| A | `ghcr.io/getknext-dev/bench-bunexec:e92fcf1e3-a` | `sha256:89352fe217ad6ea8597b80607f1fa3f68f4c7c163ce6bc048acc6d382d40acab` | vinext single executable, `build: vinext`, `alpine:3.22` + binary + `.output/public` |
| B | `ghcr.io/getknext-dev/bench-bunexec:e92fcf1e3-b` | `sha256:b3aeecac42e624aacb43823cd096c1d195369e18d918d5267236c47cf82ffa9d` | turbopack standalone, `runtime: bun`, `standalone-bun` target |

Both images carry the label `dev.knext.app.id=bench-bunexec-e92fcf1e3` (checked with `crane config`), and both are `linux/amd64`. The first push of each arm (untagged digests `sha256:9924eaaf…` for A and `sha256:cd0c74f1…` for B) lacked the label and was superseded before any deploy that counted. Those two digests remain in the package, untagged.

**Pull access.** The existing `ghcr-bench` (`kubernetes.io/dockerconfigjson`) secret in `bench-cells` is referenced by `imagePullSecrets`. The CLI did not create it, and I did not read its contents. Both images pulled on both nodes with it. The package's visibility as reported by the API is `internal`. I did not change visibility and did not create a secret.

## Deployed verification (per arm)

- **Operator:** `kn-next-operator-system/kn-next-operator-controller-manager`, image `ghcr.io/getknext-dev/kn-next-operator:v0.1.0@sha256:6e26c7a37e68eb6d3a2ba8e4c2c02b7bc4c7f2ec2fc0a5e495fff2366b120385`, 2/2 ready. CRD `nextapps.apps.kn-next.dev` serves `v1alpha1` with `build` enum `turbopack|vinext|webpack` and `runtime` enum `bun|node`.
- **Arm A** (`NextApp bx-a`, revision `bx-a-00002`): `spec.image` = digest A, `build: vinext`. Every measured cycle's user container reports `imageID` = digest A, with one build id (`1793571430577`).
- **Arm B** (`NextApp bx-b`, revision `bx-b-00001`): `spec.image` = digest B, `build: turbopack`, `runtime: bun`. Every measured cycle reports imageID = digest B, with one build id.
- **Pull inside a cycle:** 0 of 132 cycles (pod events show `already present on machine` or no pull).
- **Pre-pull:** before the sitting, throwaway pods `prepull-{a,b}-{118,169}` (`nodeName` pinned, one per image per node) pulled both images onto both nodes. Events read `Successfully pulled` or `already present`.

## Method

- **Interleaving:** ABBA. Each round waits until both arms have zero pods (+10 s), then wakes each arm once. Order alternates per round, so each arm takes each slot 33 times.
- **Instrument:** a single `node -e` probe process inside the existing `agent-118` / `agent-169` pod (bench-cells, `pods/exec` only). The source node alternates. It measures request-sent → response-body-complete (`GET /`, `http://<arm>.bench-cells.svc.cluster.local`) with `process.hrtime`, then 5 warm GETs (median reported). `kubectl exec` overhead is outside the timed interval.
- **Deviation from the rc.6 instrument:** the phase harness (`scripts/bench-cold-start-phases/cold-cycle.mjs`) needs a running `phase-bench` pod. None was running, and I did not create a harness pod. This round therefore has **no watch-based phase breakdown** (see below).
- **Driver:** `scripts/bench-cold-start-phases/bunexec-ab-incluster.py 66 bx-a bx-b`. Raw rows: `docs/benchmarks/data/bunexec-ab-oke-2026-11-01.jsonl` (132 rows) and `.log`. Analysis: `scripts/bench-cold-start-phases/bunexec-ab-analyze.py` (uses `stats.py` from the same directory for the exact Mann–Whitney and the bootstrap).
- **Validity:** a cycle is invalid if the arm was not at zero, the cold or warm request was not 200 or errored, or no pod evidence was found. Zero cycles were invalid. All 66 rounds were run and all 132 are counted.

## Results (n = 66 valid pairs per arm, ms)

| metric | arm A (bun-exec) | arm B (standalone + Bun) |
|---|---|---|
| cold median | **1689** | **1653** |
| cold IQR [Q1, Q3] | [1474, 1958] | [1448, 1785] |
| cold p95 | 2268 | 2030 |
| cold range | [1088, 2293] | [1132, 2342] |
| cold mean | 1716 | 1629 |
| warm median (of 5 GETs per cycle) | 3.4 | 3.8 |

**Paired A−B on cold:** median diff +36 ms; Hodges–Lehmann +79 ms; 95% bootstrap CI [−143, +230]; Mann–Whitney p = 0.19. **Tie.**

**Warm:** A 3.4 ms vs B 3.8 ms. Per-cycle warm medians differ detectably (p ≈ 1e-4), but the difference is about 0.4 ms and immaterial.

**Balance check.** A median on node `10.0.1.118` 1543 ms, on `10.0.1.169` 1917 ms. B median on `.118` 1594 ms, on `.169` 1725 ms. The node effect is about +370 ms for A and +130 ms for B on `.169`. ABBA balances the slots (33 each), so this does not bias the A−B comparison, but a node-level confound is present in the data.

## Phase breakdown (coarse)

Only apiserver timestamps (1 s resolution) were available. The watch-based harness was not run.

| arm | container started − pod created (median) | Ready − pod created (median; distribution) |
|---|---|---|
| A | 1 s | 2 s (1 s: 28, 2 s: 37, 3 s: 1) |
| B | 1 s | 1 s (0 s: 1, 1 s: 35, 2 s: 30) |

At this resolution the phases look the same in both arms. The sub-second activation / runtime-boot split that the phase breakdown needs is not measured here.

## Comparison with prior rounds

The rc.6 result cited in the round brief (2026-10-07: single-exec median 2071 ms vs standalone + Bun 1907 ms, HL −169 ms, p = 0.33) is not recorded in a committed document in this tree, so it is quoted from the brief and not re-verified here. It was also a tie. This round is a tie too, with the sign reversed (+36 ms here). The two rounds differ in build (commit), cluster state, instrument (curl from a timer pod vs in-pod node probe) and n (10 vs 66 per arm). They are not pooled. Both say the same thing: no measured cold-start advantage for bun-exec on this scaffold.

## Not measured

- **Arm C** (standalone + Node with `NODE_COMPILE_CACHE`) was not built or run. There was no budget for a third build, push, deploy and a further n = 66 sitting in this round.
- The phase breakdown above is coarse. The sub-second phases need the watch-based harness with a running `phase-bench` pod.

## Incidents during setup (not counted as samples)

1. Docker was not running (OrbStack). Started it with `open -a OrbStack`.
2. The first `knext build` of B failed its type check. `@getknext/db` had not been built, so kn-next's DTS build failed and produced no `.d.ts`. Building `packages/db` first fixed it.
3. The first `npm install` of the tarballs failed on `workspace:` specifiers. Repacking with `bun pm pack` fixed it.
4. The first redeploy of `bx-a` was refused with "admission webhook could not be reached". The operator was 2/2 ready and a retry succeeded. This was an availability blip on the apiserver side and did not change the image.
5. The first labelled push of each arm replaced an unlabelled build. The unlabelled digests were never deployed for a counted cycle.

## Resources left on the cluster

Nothing was deleted (no `kubectl delete`, no namespace, NextApp or ksvc deletion).

- **NextApps (created, in `bench-cells`):** `bx-a` (image A, `build: vinext`) and `bx-b` (image B, `build: turbopack`, `runtime: bun`), both `maxScale: 1`. Knative Services `bx-a` and `bx-b`, revisions `bx-a-00001`, `bx-a-00002`, `bx-b-00001`.
- **Completed pods (created):** `prepull-a-118`, `prepull-a-169`, `prepull-b-118`, `prepull-b-169`. They are left in place.
- **GHCR:** package `ghcr.io/getknext-dev/bench-bunexec`, tags `e92fcf1e3-a` and `e92fcf1e3-b` (the labelled digests above), plus untagged digests `sha256:9924eaaf…` and `sha256:cd0c74f1…` from the superseded first pushes.
- **Local:** the Docker config on the workstation holds a GHCR login from the `gh` token. Scratch build trees are under the session scratchpad.

## Files

- Report: `docs/benchmarks/bunexec-cold-start-oke-2026-11-01.md` (this file).
- Raw data: `docs/benchmarks/data/bunexec-ab-oke-2026-11-01.jsonl`, `docs/benchmarks/data/bunexec-ab-oke-2026-11-01.log`.
- Driver: `scripts/bench-cold-start-phases/bunexec-ab-incluster.py`. Analysis: `scripts/bench-cold-start-phases/bunexec-ab-analyze.py`.
- Ledger row: `docs/benchmarks/cold-start-ledger.md`, row 11.
