# Cold start phases on native amd64 kind, CPU limit ladder (2026-11-20)

The native amd64 kind study (`coldstart-phases-kind-native-2026-11-20.md`) repeated with four arms that differ only in
the CPU limit: 1000m, 2000m, 4000m, and no limit. All four run the node runtime. Twelve true scale-from-zero wakes per
arm, interleaved. Harness: `scripts/bench-cold-start-phases`. One run, one runner VM.

**Answer.** Request to first byte, median / p95 (ms): **node-1000m 1556 / 1633, node-2000m 1232 / 1306,
node-4000m 1221 / 1333, node-nolimit 1236 / 1338.** Going from 1 to 2 CPUs saves about 324 ms at the median. Above
2 CPUs this run shows no further gain: the 2000m, 4000m and no-limit medians sit within 15 ms of each other, a smaller
gap than any arm's IQR on the total (34 to 70 ms). The direction matches the first native run; the size does not (see
Comparison with run 1).

## Environment

| Item | Value |
|---|---|
| Run | GitHub Actions run 44725565328 (AhmedElBanna80/knext), `push` on `bench/run-coldstart-native-ladder`, head 3fb53a918, completed 2026-11-20 11:42Z |
| Workflow | `.github/workflows/coldstart-phases-kind-native.yml`, arm set `ladder` |
| Runner | `ubuntu-latest`, amd64, shared VM. **The vCPU count was not logged.** This is a gap: the run does not record how many cores the runner has |
| Cluster | kind, one node, installed by `helm/kind-action` (install only). The kind and node-image versions are not recorded, as in run 1 |
| Serving stack | Knative Serving + Kourier, cert-manager, knext operator, as in run 1 (same workflow file, later revision) |
| App | minimal Next.js zone, deployed with `kn-next deploy`, one Knative Service per arm |
| Image pull | **0 ms by construction**: every arm is deployed and Ready before the first wake |
| Samples | n = 12 per arm, 48 rows, 0 excluded (`valid 48, excluded 0`) |
| Ready window | 20 s after the first byte, so `cond_Ready` was recorded in every row |

Arms:

| Arm | Runtime | CPU limit | Note |
|---|---|---|---|
| node-1000m | node | 1000m | the platform default |
| node-2000m | node | 2000m | |
| node-4000m | node | 4000m | |
| node-nolimit | node | 64 CPUs | far above any runner's core count, so the CFS quota never binds |

## Method

- The workflow builds the packages and CLI, creates the kind cluster, installs the serving stack and operator, then
  deploys every arm through `kn-next deploy` and waits for Ready.
- The arms set the limit as `scaling.cpuLimit` in the app config. The CLI maps it to `spec.resources.cpuLimit`
  (`packages/kn-next/src/cli/cr-builder.ts:155-166`) and fills the other resource fields with its own constants.
- `drive.py` interleaves the four arms. Each wake is a true scale from zero; the harness refuses to start otherwise.
- `analyze.py` builds each table from the control-plane logs and the per-row milestones. p95 is linear interpolation
  between order statistics. At n = 12 it is close to the maximum, so read it as a tail bound.
- Raw data is in `docs/benchmarks/data/` (see Data below).

## Data

- `data/coldstart-phases-kind-native-ladder-2026-11-20.jsonl`: 48 rows, all four arms.
- `data/coldstart-phases-kind-native-ladder-2026-11-20-phases-node-<arm>.jsonl`: 12 rows per arm.
- `data/coldstart-phases-kind-native-ladder-2026-11-20-analysis-*.txt`: the analysis output, one file per arm and
  `-all`.

The activator and autoscaler logs are not included. They are in the run's `coldstart-phases-kind-native` artifact.

## Per-arm tables

Verbatim from the `analyze.py` output (`analysis-all.txt`). Times in ms.

#### node-1000m (n=12)

| phase | median ms | p95 ms | IQR [Q1, Q3] | min–max |
|---|---|---|---|---|
| 0 autoscaler decides 0->1 (log; inside phase 1) | 17 | 19 | 3 [14, 18] | 14–19 |
| 1 activation: request -> Pod object | 38 | 43 | 8 [33, 41] | 28–45 |
| 2 scheduling: Pod -> bound to node | 11 | 17 | 8 [8, 15] | 4–19 |
| 3 sandbox + containers start: bound -> first log line | 399 | 430 | 25 [392, 417] | 384–440 |
| 4 runtime boot: first log -> Next listening | 495 | 516 | 32 [470, 502] | 454–519 |
| 5 routable: listening -> ready | 605 | 638 | 37 [582, 619] | 567–656 |
| 6 forward + render: ready -> first byte | 20 | 35 | 12 [15, 28] | 10–39 |
| total: request -> first byte | 1556 | 1633 | 65 [1530, 1595] | 1511–1656 |
|   5x kubelet status lag: first log -> pod IP visible in API | 9 | 20 | 6 [7, 13] | 1–21 |
|   5y net: first log -> TCP :3000 from the other node | 489 | 507 | 29 [473, 501] | 459–509 |
|   5y net: first log -> TCP :3000 from the same node | 489 | 506 | 27 [473, 500] | 456–508 |
|   5z app: listening -> /api/health 200 (same node, direct) | 455 | 498 | 45 [431, 477] | 421–506 |
|   5w activator: first log -> activator marks pod healthy | 1088 | 1129 | 67 [1055, 1121] | 1043–1133 |

#### node-2000m (n=12)

| phase | median ms | p95 ms | IQR [Q1, Q3] | min–max |
|---|---|---|---|---|
| 0 autoscaler decides 0->1 (log; inside phase 1) | 16 | 31 | 5 [16, 21] | 14–34 |
| 1 activation: request -> Pod object | 39 | 60 | 7 [36, 43] | 32–67 |
| 2 scheduling: Pod -> bound to node | 14 | 22 | 6 [10, 16] | 7–25 |
| 3 sandbox + containers start: bound -> first log line | 420 | 474 | 37 [408, 445] | 394–480 |
| 4 runtime boot: first log -> Next listening | 358 | 395 | 35 [346, 380] | 329–404 |
| 5 routable: listening -> ready | 385 | 410 | 35 [371, 405] | 353–412 |
| 6 forward + render: ready -> first byte | 5 | 16 | 8 [4, 12] | 0–21 |
| total: request -> first byte | 1232 | 1306 | 34 [1214, 1249] | 1173–1354 |
|   5x kubelet status lag: first log -> pod IP visible in API | 10 | 19 | 11 [6, 17] | -8–20 |
|   5y net: first log -> TCP :3000 from the other node | 362 | 397 | 35 [348, 383] | 332–406 |
|   5y net: first log -> TCP :3000 from the same node | 358 | 396 | 37 [346, 383] | 331–402 |
|   5z app: listening -> /api/health 200 (same node, direct) | 249 | 267 | 29 [228, 257] | 198–269 |
|   5w activator: first log -> activator marks pod healthy | 728 | 782 | 43 [707, 750] | 691–797 |

#### node-4000m (n=12)

| phase | median ms | p95 ms | IQR [Q1, Q3] | min–max |
|---|---|---|---|---|
| 0 autoscaler decides 0->1 (log; inside phase 1) | 15 | 19 | 2 [14, 16] | 14–21 |
| 1 activation: request -> Pod object | 36 | 39 | 4 [34, 38] | 30–41 |
| 2 scheduling: Pod -> bound to node | 15 | 24 | 6 [13, 19] | 5–28 |
| 3 sandbox + containers start: bound -> first log line | 408 | 482 | 38 [397, 435] | 391–500 |
| 4 runtime boot: first log -> Next listening | 364 | 411 | 25 [351, 376] | 335–450 |
| 5 routable: listening -> ready | 383 | 408 | 30 [368, 399] | 350–412 |
| 6 forward + render: ready -> first byte | 7 | 20 | 12 [4, 16] | 3–20 |
| total: request -> first byte | 1221 | 1333 | 65 [1186, 1250] | 1152–1422 |
|   5x kubelet status lag: first log -> pod IP visible in API | 11 | 20 | 8 [7, 15] | 6–21 |
|   5y net: first log -> TCP :3000 from the other node | 362 | 413 | 23 [354, 377] | 339–455 |
|   5y net: first log -> TCP :3000 from the same node | 364 | 413 | 24 [353, 377] | 340–452 |
|   5z app: listening -> /api/health 200 (same node, direct) | 238 | 287 | 28 [232, 261] | 205–289 |
|   5w activator: first log -> activator marks pod healthy | 729 | 801 | 42 [710, 752] | 689–848 |

#### node-nolimit (n=12)

| phase | median ms | p95 ms | IQR [Q1, Q3] | min–max |
|---|---|---|---|---|
| 0 autoscaler decides 0->1 (log; inside phase 1) | 18 | 24 | 3 [16, 19] | 15–25 |
| 1 activation: request -> Pod object | 40 | 48 | 8 [35, 44] | 31–50 |
| 2 scheduling: Pod -> bound to node | 12 | 21 | 6 [9, 15] | 6–26 |
| 3 sandbox + containers start: bound -> first log line | 421 | 480 | 41 [411, 452] | 390–504 |
| 4 runtime boot: first log -> Next listening | 375 | 423 | 23 [363, 386] | 355–438 |
| 5 routable: listening -> ready | 387 | 400 | 36 [359, 394] | 329–406 |
| 6 forward + render: ready -> first byte | 7 | 20 | 15 [2, 17] | 0–21 |
| total: request -> first byte | 1236 | 1338 | 70 [1219, 1289] | 1149–1361 |
|   5x kubelet status lag: first log -> pod IP visible in API | 11 | 21 | 5 [9, 13] | 7–28 |
|   5y net: first log -> TCP :3000 from the other node | 375 | 428 | 19 [368, 387] | 357–445 |
|   5y net: first log -> TCP :3000 from the same node | 377 | 422 | 21 [364, 385] | 360–437 |
|   5z app: listening -> /api/health 200 (same node, direct) | 233 | 272 | 30 [219, 249] | 199–273 |
|   5w activator: first log -> activator marks pod healthy | 743 | 799 | 29 [725, 754] | 696–826 |

## Headline

| Arm | Total median | Total p95 | Sandbox + start | Runtime boot | Listening to ready | App first `/api/health` |
|---|---|---|---|---|---|---|
| node-1000m | 1556 | 1633 | 399 | 495 | 605 | 455 |
| node-2000m | 1232 | 1306 | 420 | 358 | 385 | 249 |
| node-4000m | 1221 | 1333 | 408 | 364 | 383 | 238 |
| node-nolimit | 1236 | 1338 | 421 | 375 | 387 | 233 |

The step from 1 to 2 CPUs moves runtime boot (495 to 358 ms) and listening to ready (605 to 385 ms). Sandbox and
container start does not fall with the limit: it is 399 ms at 1000m and 408 to 421 ms above it. Beyond 2 CPUs the
phase medians are flat, within about 20 ms of each other. These are descriptive medians; no mechanism is claimed.

## Comparison with run 1

Run 1 is the native amd64 run the same morning (GitHub Actions run 44707176722). It had no 2000m or 4000m arm, so the
1-to-2 CPU step cannot be compared with it directly.

| | Run 1 (44707176722) | Ladder run (44725565328) |
|---|---|---|
| node-1000m total median | 934 | 1556 |
| node-nolimit total median | 710 | 1236 |
| node-nolimit minus node-1000m | −224 | −320 |
| Sandbox + start, node-1000m | 246 | 399 |
| Runtime boot, node-1000m | 269 | 495 |
| Listening to ready, node-1000m | 370 | 605 |

This runner was much slower overall. The same 1000m arm is 622 ms slower here, and the sandbox step alone is about
150 ms slower. **Absolute numbers do not carry across runners; only the within-run deltas are comparable.**

Within each run the no-limit arm is faster than the 1000m arm: by 224 ms in run 1 and by 320 ms in this run. The two
deltas agree in direction and differ in size. Two runs cannot say how much of that gap is runner noise. In this run
the 2000m arm gives a gain (324 ms) at least as large as the no-limit arm does (320 ms) against the same control.

## Caveats

- **The runner's vCPU count was not logged.** Without it, the statement that the gain saturates above 2 CPUs cannot be
  read against the runner's hardware. If the runner has fewer than 4 cores, the 4000m arm is only a higher quota than
  the machine can supply. This run does not show either way.
- One run, one shared VM. Neighbour noise is uncontrolled. n = 12 per arm, and p95 is close to the maximum. The
  within-run IQRs (34 to 70 ms on the total) are not run-to-run variance.
- Kind is not OKE. OKE has a measured kubelet PLEG relist floor and a real image pull; neither is in these numbers.
  Read them as a floor without those costs, not as a prediction for OKE.
- No CPU throttling counter was read, on this runner or in run 1. The phase shifts above are descriptive.
- The kind and node-image versions are not recorded (as in run 1).

## Reproduce

Dispatch `coldstart-phases-kind-native.yml` with `set=ladder`, or push `bench/run-coldstart-native-ladder` (the
workflow's push trigger). The artifact is `coldstart-phases-kind-native`. Local analysis, as in the native run:
`python3 scripts/bench-cold-start-phases/analyze.py phases.jsonl --no-marker --p95 --namespace=z2`.
