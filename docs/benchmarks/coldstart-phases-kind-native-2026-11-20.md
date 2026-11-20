# Cold start phases on native amd64 kind (2026-11-20)

The kind cold-start study (`coldstart-phases-kind-2026-11-20.md`) repeated on an amd64 GitHub-hosted runner, so
the amd64 app image runs natively instead of under Rosetta. Three arms, 12 true scale-from-zero wakes each,
interleaved. Harness: `scripts/bench-cold-start-phases`. One run, one VM.

**Answer.** Request to first byte is sub-second on native kind in all three arms (median / p95, ms):
**node-1000m 934 / 977, node-nolimit 710 / 757, bun-1000m 803 / 843.** The Mac/Rosetta run measured 3226 ms.
Runtime boot fell from 2174 ms to 205 to 269 ms, which confirms the Rosetta inflation.

## Environment

| Item | Value |
|---|---|
| Run | GitHub Actions run 44707176722 (AhmedElBanna80/knext), 2026-11-20 09:01 to 09:25Z |
| Workflow | `.github/workflows/coldstart-phases-kind-native.yml` on integration/v2 at 52a2cff86 |
| Runner | `ubuntu-latest`, amd64, shared VM |
| Cluster | kind, one node (control-plane, `coldstart-native-control-plane`), installed by `helm/kind-action` (install only); the kind and node-image versions are not recorded in the artifact |
| Serving stack | Knative Serving 1.16.0 + Kourier, cert-manager, knext operator built from HEAD (native amd64) |
| Autoscaler | `stable-window` 10 s, `scale-to-zero-pod-retention-period` 0 s, grace period = ready window + 10 s = 30 s |
| App | minimal Next.js 16.4.5 zone, deployed with the real `kn-next deploy`, one Knative Service per arm |
| Arch | native amd64 node and amd64 image |
| Image pull | **0 ms**: every arm is deployed and Ready before the first wake, so images are pre-loaded; no wake has a `Pulling` event (36 of 36 rows checked) |
| Samples | n = 12 per arm, 36 rows, 0 excluded, arms interleaved by `drive.py`, `--settle 5` |
| Ready window | 20 s after the first byte, so `cond_Ready` was recorded in all 36 rows |
| Arms | node-1000m (node, cpu limit 1000m, the platform default); node-nolimit (node, 64-CPU limit, so the CFS quota never binds); bun-1000m (bun runtime, 1000m) |

## Method

- The workflow builds the packages and CLI, packs the `@getknext/*` tarballs, creates the kind cluster with an
  in-cluster registry, installs cert-manager, Knative Serving + Kourier and the operator, then deploys every arm
  through `kn-next deploy` and waits for Ready (this also pulls images onto the node).
- `drive.py 12 node-1000m,node-nolimit,bun-1000m phases.jsonl --namespace z2 --settle 5` waits for zero pods of
  the target service, then runs `cold-cycle.mjs` from a harness pod inside the cluster for one wake, rotating
  through the arms. Every wake is a true scale from zero (the harness refuses to start otherwise).
- The kind harness manifest adds clock and agent pods and an allow policy so the direct probes pass the
  operator's default NetworkPolicy (see the probe fix in the Mac run's write-up). The clock offset was
  0.11 ms on the first row.
- `analyze.py` builds each table from the control-plane logs and the per-row milestones. p95 is linear
  interpolation between order statistics; at n = 12 it is close to the maximum, so read it as a tail bound.
- Raw data: `data/coldstart-phases-kind-native-2026-11-20.jsonl` (36 rows) and
  `data/coldstart-phases-kind-native-2026-11-20-analysis-*.txt`. The activator and autoscaler logs
  (130 KB and 2 MB) are left out; they are in the run's `coldstart-phases-kind-native` artifact.

## Per-arm tables

Verbatim from the analysis output. Times in ms.

#### node-1000m (n=12)

| phase | median ms | p95 ms | IQR [Q1, Q3] | min–max |
|---|---|---|---|---|
| 0 autoscaler decides 0->1 (log; inside phase 1) | 11 | 14 | 2 [10, 12] | 9–15 |
| 1 activation: request -> Pod object | 27 | 40 | 4 [25, 30] | 22–50 |
| 2 scheduling: Pod -> bound to node | 8 | 19 | 4 [5, 9] | 3–31 |
| 3 sandbox + containers start: bound -> first log line | 246 | 288 | 20 [240, 259] | 232–299 |
| 4 runtime boot: first log -> Next listening | 269 | 294 | 28 [258, 286] | 225–300 |
| 5 routable: listening -> ready | 370 | 395 | 44 [345, 389] | 257–398 |
| 6 forward + render: ready -> first byte | 10 | 35 | 12 [5, 17] | 1–44 |
| total: request -> first byte | 934 | 977 | 31 [912, 943] | 892–1006 |
|   5x kubelet status lag: first log -> pod IP visible in API | 8 | 15 | 4 [7, 11] | -13–15 |
|   5y net: first log -> TCP :3000 from the other node | 273 | 299 | 28 [261, 288] | 227–305 |
|   5y net: first log -> TCP :3000 from the same node | 273 | 298 | 28 [259, 287] | 228–306 |
|   5z app: listening -> /api/health 200 (same node, direct) | 284 | 305 | 71 [220, 291] | 142–315 |
|   5w activator: first log -> activator marks pod healthy | 628 | 652 | 27 [609, 636] | 551–664 |

#### node-nolimit (n=12)

| phase | median ms | p95 ms | IQR [Q1, Q3] | min–max |
|---|---|---|---|---|
| 0 autoscaler decides 0->1 (log; inside phase 1) | 12 | 16 | 2 [10, 12] | 10–17 |
| 1 activation: request -> Pod object | 28 | 36 | 9 [25, 34] | 23–36 |
| 2 scheduling: Pod -> bound to node | 9 | 14 | 3 [7, 10] | 4–18 |
| 3 sandbox + containers start: bound -> first log line | 242 | 290 | 38 [236, 273] | 230–290 |
| 4 runtime boot: first log -> Next listening | 205 | 213 | 10 [199, 209] | 196–214 |
| 5 routable: listening -> ready | 207 | 222 | 10 [204, 213] | 197–223 |
| 6 forward + render: ready -> first byte | 8 | 11 | 2 [8, 10] | 7–12 |
| total: request -> first byte | 710 | 757 | 44 [690, 734] | 669–774 |
|   5x kubelet status lag: first log -> pod IP visible in API | 8 | 11 | 4 [5, 9] | 1–11 |
|   5y net: first log -> TCP :3000 from the other node | 211 | 218 | 13 [202, 215] | 196–218 |
|   5y net: first log -> TCP :3000 from the same node | 208 | 218 | 10 [203, 213] | 199–220 |
|   5z app: listening -> /api/health 200 (same node, direct) | 132 | 149 | 9 [130, 139] | 124–154 |
|   5w activator: first log -> activator marks pod healthy | 406 | 431 | 19 [398, 417] | 393–432 |

#### bun-1000m (n=12)

| phase | median ms | p95 ms | IQR [Q1, Q3] | min–max |
|---|---|---|---|---|
| 0 autoscaler decides 0->1 (log; inside phase 1) | 12 | 13 | 1 [11, 12] | 10–13 |
| 1 activation: request -> Pod object | 26 | 29 | 3 [24, 27] | 23–30 |
| 2 scheduling: Pod -> bound to node | 6 | 24 | 10 [4, 14] | 3–30 |
| 3 sandbox + containers start: bound -> first log line | 234 | 282 | 33 [227, 260] | 225–292 |
| 4 runtime boot: first log -> Next listening | 106 | 127 | 7 [104, 111] | 97–132 |
| 5 routable: listening -> ready | 381 | 411 | 58 [349, 407] | 338–411 |
| 6 forward + render: ready -> first byte | 2 | 92 | 82 [0, 82] | 0–95 |
| total: request -> first byte | 803 | 843 | 28 [787, 814] | 766–865 |
|   5x kubelet status lag: first log -> pod IP visible in API | 36 | 59 | 12 [30, 42] | 21–62 |
|   5y net: first log -> TCP :3000 from the other node | 109 | 130 | 6 [107, 113] | 98–135 |
|   5y net: first log -> TCP :3000 from the same node | 110 | 129 | 7 [108, 115] | 96–138 |
|   5z app: listening -> /api/health 200 (same node, direct) | 286 | 301 | 26 [262, 288] | 239–311 |
|   5w activator: first log -> activator marks pod healthy | 445 | 478 | 20 [442, 462] | 434–481 |

## Headline

| Arm | Total median | Total p95 | Runtime boot | Listening to ready | App first `/api/health` |
|---|---|---|---|---|---|
| node-1000m | 934 | 977 | 269 | 370 | 284 |
| node-nolimit | 710 | 757 | 205 | 207 | 132 |
| bun-1000m | 803 | 843 | 106 | 381 | 286 |

All three are sub-second at both median and p95. Before the container runs (activation, scheduling, sandbox
and container start) is about 265 to 285 ms in every arm.

## Comparison with the Mac/Rosetta run

| | Mac, Rosetta (node, 1000m) | Native amd64, node-1000m |
|---|---|---|
| Total, median | 3226 ms | 934 ms |
| Runtime boot, median | 2174 ms | 269 ms (205 without the CPU limit) |
| Listening to ready, median | 689 ms | 370 ms |
| App first `/api/health` after listening | 475 ms | 284 ms |

Runtime boot dropped from 2174 ms to 205 to 269 ms, so the emulation inflation flagged in the earlier write-up
is confirmed: the 2.2 s was mostly Rosetta, not Next. The two runs differ in more than architecture (host,
kind and Kubernetes versions, interleaving, a 20 s ready window), so the ratio is not a pure Rosetta factor.

## CPU limit

node-nolimit against node-1000m, same runtime, same image:

- Total median 710 against 934 ms, about 224 ms lower.
- Runtime boot 205 against 269 ms; listening to ready 207 against 370 ms; the app's first direct
  `/api/health` 132 against 284 ms.

On this runner the 1-CPU limit is a real lever on cold-start time, mostly through first-request work being
throttled by the CFS quota. This is a finding, not a product change: nothing here recommends changing the
default limit, and the effect on a loaded node, memory and neighbours was not measured.

## Bun

At the same 1000m limit, bun's runtime boot is 106 ms against node's 269 ms. Its listening-to-ready phase is
381 ms (node 370), and the app's first direct `/api/health` takes 286 ms (node 284), so bun's first-request
path costs more than its boot saves. Net: bun 803 ms against node 934 ms, about 131 ms lower. The activator
sees bun healthy 445 ms after the first log against node's 628 ms. Kubelet status lag is 36 ms for bun and
8 ms for node.

## Ready against first byte

`cond_Ready` was recorded in all 36 rows. Ready minus first byte, from the `watch` dicts in `phases.jsonl`
(a positive value means the pod's Ready condition came after the first response byte):

| Arm | Median | Max | Min | Rows where Ready came first |
|---|---|---|---|---|
| node-1000m | -5.1 ms | 211.3 ms | -28.1 ms | 9 of 12 |
| node-nolimit | 180.6 ms | 9574.4 ms | -6.9 ms | 4 of 12 |
| bun-1000m | 38.7 ms | 506.4 ms | -95.4 ms | 5 of 12 |

The earlier Mac write-up carried a hypothesis that Ready arrives about 10 s late (a next kubelet probe after
a timed-out one). Here, 35 of 36 rows have Ready within 0.57 s of the first byte, so no systematic 10 s gap
appears. One node-nolimit row has Ready 9574 ms after the first byte. That is consistent with an occasional
missed readiness probe followed by the next one 10 s later (`periodSeconds: 10`), but this is a hypothesis: that
row's event list shows no readiness-probe failure before Ready (its only `Unhealthy` event is stamped at pod
deletion, 19.4 s), and one row cannot establish a mechanism. Ready does not gate
the first byte (total for that row is within the arm's normal range).

## Caveats

- Kind is not OKE. OKE has a measured ~1 s kubelet PLEG relist floor and a real image pull; neither is in
  these numbers. Read them as an L1 floor without those costs, not as a prediction for OKE.
- The runner is a shared VM; neighbour noise is uncontrolled.
- One run. It cannot speak to variance across runs or across days; the within-run IQRs (28 to 44 ms on the
  total) are not run-to-run variance.
- n = 12 per arm; p95 is close to the maximum.
- Kind and node-image versions are not recorded in the artifact.
- Arms ran on one node and one image cache, so pull = 0 by construction.

## Reproduce

Push `bench/run-coldstart-native` (the workflow's only push trigger) or dispatch
`coldstart-phases-kind-native.yml`; the artifact `coldstart-phases-kind-native` holds the JSONL and the
analysis. Locally: `python3 scripts/bench-cold-start-phases/analyze.py phases.jsonl --no-marker --p95 --namespace=z2`.
