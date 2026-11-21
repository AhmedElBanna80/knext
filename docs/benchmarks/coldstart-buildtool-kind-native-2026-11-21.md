# Cold start across the build-tool axis on native amd64 kind (2026-11-20 and 2026-11-21)

The kind cold-start study with the build tool as the variable. Four scaffold apps (node or bun
runtime × Turbopack or vinext build), each a fresh `knext create` app, each at a 1000m CPU limit.
Same workflow and harness as [`coldstart-phases-kind-native-2026-11-20.md`](coldstart-phases-kind-native-2026-11-20.md).
Measured on two days, so the day-to-day spread is part of the result.

**Answer.**

1. **The build tool is the larger lever; the runtime is the smaller one.** Day 2 medians (request to
   first byte, ms): the Turbopack-vs-vinext gap is 581 ms on Bun and 741 ms on Node. The Node-vs-Bun
   gap is 243 ms on vinext and 403 ms on Turbopack. Day 1 shows the same ordering (build gap 586 and
   749 ms; runtime gap 288 and 451 ms).
2. **vinext is faster on both runtimes.** Bun × vinext is the fastest arm on both days (523 ms median
   on day 2), and Node × Turbopack is the slowest (1507 ms).
3. **Bun is faster than Node within each build tool.** The runtime gap is smaller than the build-tool
   gap in every pairing.
4. **The sandbox and container start is about 330–400 ms on every arm and is not what the build tool
   changes.** On bun it is 327–371 ms across both days. On node it is 395–403 ms by the analyzer's
   definition (see [Sandbox step](#sandbox-step-two-definitions)). On Turbopack the routable step
   (listening to ready) is 478 ms on Bun and 564 ms on Node on day 2 (488 and 576 ms on day 1).
5. **bun × vinext has the weakest bytecode evidence, and its live check is not a runtime check.**
   It has only a build-time pragma differential (`@bytecode` count 2 against a baseline of 1), with no
   marker verification (a fix adding marker verification is in flight). Its live process check is by
   basename `server` only, which confirms the compiled executable's name, not that the runtime is Bun.
   The evidence records no live fields for this arm. The vinext CR omits the runtime by design, so
   `spec_runtime` is empty in both vinext arms.

## Environment

| Item | Value |
|---|---|
| Runs | Day 1: GitHub Actions run 44808959901, 2026-11-20 20:10Z, head `0218bdaab`. Day 2: run 44841667176, 2026-11-21 00:07Z, head `a4de6621b`. Both `success`. |
| Trigger | `push` to `bench/run-coldstart-native-buildtool` (the buildtool set) |
| Workflow | `.github/workflows/coldstart-phases-kind-native.yml` ("Cold-start phases on kind (native amd64, manual)") |
| Runner | `ubuntu-latest`, amd64, shared VM |
| Cluster | kind, one node, installed by `helm/kind-action` v1.15.1 (install only). The kind and node-image versions are not recorded in the artifacts. |
| Arms | `node-turbopack-1000m`, `node-vinext-1000m`, `bun-turbopack-1000m`, `bun-vinext-1000m` (each `knext create` scaffold, 1000m CPU) |
| Samples | n = 12 per arm per day, 48 rows per day, 0 excluded (`valid 48, excluded 0`) |
| Ready window | 20 s after first byte (the default for a push trigger) |

## Method

- The workflow builds the packages and CLI, creates the kind cluster with an in-cluster registry,
  installs the serving stack and the operator, then deploys every arm through `kn-next deploy` and
  waits for Ready. This also pulls images onto the node, so the wake itself has no pull.
- `drive.py 12 <arms> phases.jsonl --namespace z2 --settle 5` rotates the arms through one wake each,
  interleaved. Each wake waits for zero pods of the target service, then runs `cold-cycle.mjs` from a
  harness pod inside the cluster. Every wake is a true scale from zero.
- The window for the total is the request (t0) to the first response byte. The watcher keeps
  recording for the 20 s Ready window after first byte, which is where the `cond_Ready` and probe
  timestamps come from.
- Phase milestones are those of `scripts/bench-cold-start-phases/analyze.py`. `pod_added` and
  `pod_bound` come from the Pod watch. `ctr_first_log` is the earlier of the first user-container line
  and the first queue-proxy line. `app_listening` is the first user-container line containing
  `Ready in`. Phases 4 and 5 therefore exist only for the Turbopack arms: the vinext server logs
  `LISTENING:3000` instead, so the analyzer never sets `app_listening` for them.
- p95 is linear interpolation between order statistics. At n = 12 it sits near the maximum, so read
  it as a tail bound.
- Phase medians are not additive, so phase medians do not sum to the total median.

## Per-arm phase tables

Verbatim from `analysis-*.txt` (in the data directories). Times in ms, median and p95.

### bun × vinext

| phase | day 1 median · p95 | day 2 median · p95 |
|---|---|---|
| 1 activation: request → Pod object | 35 · 40 | 36 · 50 |
| 2 scheduling: Pod → bound | 12 · 17 | 11 · 17 |
| 3 sandbox + containers start: bound → first log | 327 · 365 | 342 · 402 |
| 4–5 runtime boot and routable | not split (no `Ready in` line) | not split |
| 6 forward + render: ready → first byte | 0 · 3 | 0 · 3 |
| total: request → first byte | 502 · 532 | 523 · 601 |

### node × vinext

| phase | day 1 median · p95 | day 2 median · p95 |
|---|---|---|
| 1 activation | 37 · 62 | 36 · 44 |
| 2 scheduling | 12 · 26 | 8 · 20 |
| 3 sandbox + containers start | 396 · 446 | 395 · 449 |
| 4–5 runtime boot and routable | not split | not split |
| 6 forward + render | 30 · 123 | 31 · 46 |
| total | 790 · 871 | 766 · 838 |

### bun × turbopack

| phase | day 1 median · p95 | day 2 median · p95 |
|---|---|---|
| 1 activation | 35 · 40 | 36 · 48 |
| 2 scheduling | 11 · 17 | 10 · 25 |
| 3 sandbox + containers start | 366 · 404 | 371 · 469 |
| 4 runtime boot: first log → Next listening | 155 · 166 | 165 · 180 |
| 5 routable: listening → ready | 488 · 548 | 478 · 516 |
| 6 forward + render | 2 · 117 | 68 · 120 |
| total | 1088 · 1153 | 1104 · 1236 |

### node × turbopack

| phase | day 1 median · p95 | day 2 median · p95 |
|---|---|---|
| 1 activation | 37 · 50 | 34 · 40 |
| 2 scheduling | 14 · 21 | 11 · 20 |
| 3 sandbox + containers start | 403 · 453 | 395 · 442 |
| 4 runtime boot: first log → Next listening | 489 · 511 | 486 · 521 |
| 5 routable: listening → ready | 576 · 611 | 564 · 602 |
| 6 forward + render | 12 · 16 | 14 · 35 |
| total | 1539 · 1613 | 1507 · 1604 |

## Sandbox step: two definitions

Phase 3 is `pod_bound` to `ctr_first_log`. The reported figures use the analyzer's definition, which
takes the earlier of the user-container and queue-proxy first lines. For the Node arms the
queue-proxy starts first, so the two definitions differ by about 60–130 ms. A user-container-only
definition is shown for comparison.

| arm | day 1, analyzer | day 2, analyzer | day 2, user-container line only |
|---|---|---|---|
| bun × vinext | 327 | 342 | 342 |
| bun × turbopack | 366 | 371 | 371 |
| node × vinext | 396 | 395 | 526 |
| node × turbopack | 403 | 395 | 454 |

Across both days, the sandbox step is 327–371 ms on the bun arms and 395–403 ms on the node arms,
by the analyzer's definition. The user-container-only definition gives 454–528 ms on the node arms.
The analyzer's figures are the ones to quote.

## Bytecode evidence per arm

Evidence files are in the data directories as `evidence-<arm>-1000m.json`.

| arm | kind | build-time evidence (day 2; day 1 in parentheses) | live evidence (day 2) |
|---|---|---|---|
| node × vinext | V8 compile cache at `/app/.compile-cache` | 1,462,428 bytes in 103 files (1,462,500 bytes, 103 files) | `NODE_COMPILE_CACHE=/app/.compile-cache` in the live main process, pid 6180. Day 1 has no live fields. |
| node × turbopack | V8 compile cache at `/app/.next/standalone/.next/compile-cache` | 1,433,804 bytes in 465 files (1,433,780 bytes, 465 files) | `NODE_COMPILE_CACHE` matches the cache dir in the live supervisor child, pid 5494 (`supervisor-child`). Day 1 has no live fields. |
| bun × vinext | Bun bytecode, `/app/server`, 84,678,192 bytes | method `pragma-differential`: `@bytecode` pragma count app=2, baseline=1. No marker verification. | none recorded. The harness checks only that the process is `/app/server`. |
| bun × turbopack | Bun bytecode, `/app/.next/standalone/knext-standalone-exec`, 92,411,440 bytes | method `marker`: verified, the binary sits under a `@bytecode` pragma with a constant-pool copy | live child pid 5819, `live_child_matched_by: argv0`, matched on the executable's basename |

Compile-cache byte totals differ by 24–72 bytes between days. This layer is not bit-reproducible, so
the counts show a cache was baked, not that two builds were identical.

## Day-to-day delta

Request to first byte, median and p95 (ms), day 2 minus day 1:

| arm | median delta | p95 delta |
|---|---|---|
| bun × vinext | +21 | +69 |
| node × vinext | −24 | −33 |
| bun × turbopack | +16 | +83 |
| node × turbopack | −32 | −9 |

The four arms kept their order on both days. The largest median move is 32 ms and the largest p95
move is 83 ms. For bun × turbopack, most of the p95 movement is the sandbox step's p95
(404 → 469 ms). Its forward-and-render median also moved from 2 to 68 ms, a bimodal step that the
median hides. Day 1 has no live checks, so its bytecode evidence is the build-time record only.

## Caveats

- **bun × vinext has no marker verification and no live runtime check.** Its bytecode claim rests on
  the pragma differential alone. The basename `server` check does not show the process is Bun.
- **`spec_runtime` is empty in both vinext arms' evidence**, by design, since the vinext CR omits the
  runtime. For those arms the runtime is identified by the arm name and the image, and the evidence does not record it.
- **Day 1 had no live checks.** Only day 2 confirmed the running process against the cache or the
  executable.
- **kind on a GitHub-hosted runner is not OKE.** These numbers are not comparable to the OKE
  cold-start numbers in the user docs, nor to the spike-zone kind numbers in
  [`zone-functions-coldstart-kind-2026-10-09.md`](zone-functions-coldstart-kind-2026-10-09.md),
  which ran on a different cluster with a different apparatus.
- **One runner, two runs.** Two days cannot give a confidence interval, and the within-run IQRs are
  not run-to-run variance.
- **n = 12 per arm**, so p95 is close to the maximum.
- **Kind and node-image versions are not recorded** in the artifacts.
- **Which phase dominates.** The sandbox and container start is the largest split phase on the vinext
  arms, and it is about 330–400 ms on every arm. On Turbopack, the routable step (listening to ready)
  is about 480 ms on Bun and about 565 ms on Node. That step is Turbopack-specific.

## Reproduce

- Push `bench/run-coldstart-native-buildtool` (the workflow's buildtool-set push trigger), or dispatch
  `coldstart-phases-kind-native.yml` with the buildtool set. The artifact `coldstart-phases-kind-native`
  holds the JSONL and the analysis.
- Run the analyzer on a committed phases file:
  `python3 scripts/bench-cold-start-phases/analyze.py <phases-file> --no-marker --p95 --namespace=z2`.
  On the day-2 data this reproduces every table row except phase 0 (autoscaler) and phase 5w
  (activator), which need the activator and autoscaler logs. Those logs are not committed; the
  autoscaler log is 2.7 MB and is kept out of the repository, as in the sibling study; it is in the run's artifact.
- Runs: day 1 `44808959901` (`0218bdaab`), day 2 `44841667176` (`a4de6621b`).
