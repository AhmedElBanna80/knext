# Startup CPU boost and the listening-to-Ready gap on OKE (2026-11-02)

Two measurements on the OKE bench cluster, run back to back on the same two worker nodes.

- **A:** does a higher CPU limit shorten scale-from-zero cold starts?
- **B:** where does the time between the app listening and the pod reporting Ready go?

## Summary

- **A: no benefit detected.** A 2-core CPU limit did not shorten cold starts in this sample, but with 20 wakes per arm the test has little power, so this is "no benefit detected", not "no effect". Against `cpu-base`, the Hodges-Lehmann shift (the median of all 400 pairwise differences) is +141 ms for `cpu-boost2` and +35 ms for `cpu-boost2req`. The difference of table medians is +223 ms and +172 ms, with 95% bootstrap CIs of [−88, +488] ms and [−199, +438] ms. The intervals belong to the difference of table medians, not to the Hodges-Lehmann shifts, which have no interval in this report. Both arms are nominally slower, not faster. The `cpu-boost2` interval excludes differences below −88 ms; the `cpu-boost2req` interval excludes differences below −199 ms. Smaller improvements, and any effect of a few hundred ms in the other direction, are not ruled out.
- **B: the two largest segments on the bind-to-Ready path are bound to "Ready in" (median 595 ms, p95 1002 ms) and "Ready in" to the pod Ready condition (median 503 ms, p95 1055 ms).** The first is sandbox and container start, which the logs cannot split further. The second is the pod's status reaching the API: `podIP` appears a median 451 ms after "Ready in" (p95 1020 ms), and the Ready condition follows in a later write, a median 45 ms after `podIP`. The medians do not add. The per-arm "Ready in" to Ready medians are 449, 620 and 469 ms; the data do not attribute that spread to the CPU setting.
- **Application boot is not measured.** "Ready in" is logged at process start ("Ready in 0ms" on every wake), so app initialisation is not timed and could be part of the ~600 ms between scheduler binding and "Ready in", or come after it. The queue-proxy sidecar's first log line lands at bound + 619 ms (median), about 29 ms after "Ready in", which is consistent with sandbox and container start dominating. This data cannot separate sandbox creation, pod networking, container runtime start and app initialisation from one another.
- **The lag is consistent with a periodic status write about once a second, but that is a hypothesis.** The distribution of queue-proxy first log to `podIP` is roughly uniform over 0–1 s. 59 wakes cannot distinguish a 1 s period from other periods of similar size. The kubelet source facts are below; nothing about the nodes' kubelet configuration was inspected.

## Setup

- Cluster: OKE, two workers (10.0.1.118, 10.0.1.169), each with 3815m allocatable CPU. Kubernetes v1.34.10.
- Namespace `bench-cells`. Three NextApps with minScale 0 and maxScale 1, all on the same bench image digest (Bun runtime, Turbopack build). They differ only in `spec.resources`:
  - `cpu-base`: no resources block (operator defaults: request 250m, limit 1).
  - `cpu-boost2`: limit 2, request unchanged (250m).
  - `cpu-boost2req`: request 1, limit 2.
- Driver: `drive.py` with three arms, rotating the order each round, 20 rounds, 60 wakes total. Every round waits for all arms to reach zero pods, then wakes each arm once, serially. Each wake is one request from an in-cluster harness pod.
- Node-clock offsets used to re-base timestamps: all under 0.3 ms (median 0.22 ms).
- The scheduler-bound and pod-added timestamps come from API watches; the "Ready in" and queue-proxy lines carry the container runtime's log timestamps, re-based onto the harness clock.
- Data: `docs/benchmarks/data/cpu-boost-oke-2026-11-02.jsonl` (one row per wake, with watch timestamps, container logs and events). Scripts: `scripts/bench-cold-start-phases/` (`cpu-boost-nextapps.yaml`, `phase-bench-2.yaml`, `cpu-boost-analyze.py`, and `drive.py` with its pod name made configurable via `PHASE_POD`).

## Measurement A: startup CPU

Total cold start, measured as the time from the request to the first response byte, in ms (all 60 wakes valid; n = 20 per arm):

| Arm | Median | p95 | Mean | Min | Max |
|---|---|---|---|---|---|
| cpu-base (limit 1) | 1276 | 2027 | 1428 | 1145 | 2293 |
| cpu-boost2 (limit 2) | 1500 | 2128 | 1552 | 1056 | 2165 |
| cpu-boost2req (request 1, limit 2) | 1448 | 2132 | 1474 | 967 | 2220 |

Two different quantities, both relative to `cpu-base`. The **Hodges-Lehmann shift** is the median of all 400 pairwise differences; the **difference of table medians** is simply the table's median minus the baseline's. The confidence interval is a 95% bootstrap interval for the difference of table medians (10,000 resamples). The report gives no interval for the Hodges-Lehmann shift.

| Arm | Hodges-Lehmann shift | Difference of table medians | 95% bootstrap CI of the difference of table medians | CI width | Mann-Whitney p |
|---|---|---|---|---|---|
| cpu-boost2 | +141 ms | +223 ms | [−88, +488] | 575 ms | 0.18 |
| cpu-boost2req | +35 ms | +172 ms | [−199, +438] | 637 ms | 0.81 |

Power is the limit here: the intervals for the difference of table medians are 575 and 637 ms wide, so only large reductions are excluded (below −88 ms for `cpu-boost2`, below −199 ms for `cpu-boost2req`). A real improvement smaller than that would not show.

Within-node permutation test (arm labels shuffled inside each node, 5000 draws, n-weighted mean of the per-node median differences): `cpu-boost2` +169 ms (p = 0.19), `cpu-boost2req` +119 ms (p = 0.39). The script prints these.

Stratified by node (the arms were not balanced across nodes, so read these with care):

| Node | cpu-base | cpu-boost2 | cpu-boost2req |
|---|---|---|---|
| 10.0.1.118 | 1208 (n=6) | 1537 (n=13) | 1225 (n=7) |
| 10.0.1.169 | 1409 (n=14) | 1280 (n=7) | 1582 (n=13) |

Node placement moves the medians by several hundred ms in both directions, which is larger than any arm effect. None of the node-stratified comparisons shows a consistent improvement from a higher limit.

**Comparability with earlier reports.** This run's baseline (`cpu-base`, median 1276 ms) is faster than the roughly 1.65 to 2 s medians in the earlier OKE cold-start reports. The runs differ in measurable ways, so the numbers should not be compared across reports: (a) the instrument: the earlier reports timed with an in-pod `curl` or a `node` probe to the cluster-local service address and ended at the complete body, while this run used a watch-based harness that ends at the first response byte (here the body end, from the `resp_end` field, is 0.10 to 0.20 ms after the first byte in all 60 wakes, checked by the analyzer); (b) the app: this run uses a bench image (Bun runtime, Turbopack build, page of about 5 KB), the earlier ones a freshly scaffolded app from a different build; (c) the request path: this run's harness requests the public URL and does not record the route, while the earlier reports state a cluster-local path through the activator. `maxScale` is 1 in both this run and the 2026-11-01 report. Nothing here shows which of these differences, if any, explains the gap.

**Throttling:** not measured. Container cgroup `cpu.stat` (`nr_throttled`) was not readable without host access, and this run did not use a host-path reader. The node CPU capacity (3815m) was not the limiting factor in the sample: each arm's pod asked for at most 1 core.

## Measurement B: the listening-to-Ready gap

Medians (ms after the request), all valid wakes:

| Phase | Median | p95 |
|---|---|---|
| Pod added | 54 | 117 |
| Scheduler binds the pod (`nodeName` set) | 73 | 134 |
| Pod IP visible in status (`podIP`) | 1240 | 1991 |
| First response byte | 1442 | 2129 |

Successive segments:

| Segment | Median | p95 |
|---|---|---|
| Bound → app "Ready in" log line (sandbox and container start; app boot not measured) | 595 | 1002 |
| "Ready in" → pod Ready condition (status reaching the API) | 503 | 1055 |
| Ready condition → first response byte | 97 | 118 |

Per-arm, the medians differ and do not follow the CPU settings in order. The middle arm (`cpu-boost2`) has the highest "Ready in" to Ready median, 620 ms, against 449 and 469 ms for the other two. The run does not show a cause for that spread:

| Arm | Bound→"Ready in" median (container start) | "Ready in"→Ready median | First byte median |
|---|---|---|---|
| cpu-base | 613 | 449 | 1276 |
| cpu-boost2 | 587 | 620 | 1500 |
| cpu-boost2req | 597 | 469 | 1454 (n=19) |

Timing of the container-side events relative to the bind (median ms, n = 60 unless stated):

| Event | Median | p90 |
|---|---|---|
| user container first log line | 473 | 877 |
| app "Ready in" line | 595 | 997 |
| queue-proxy first log line | 619 | 1022 |

Distribution of the interval from the queue-proxy's first log line to the `podIP` appearing in the API (59 wakes with a Ready marker): min 32, p10 115, p25 240, median 441, p75 706, p90 958, max 1038 ms. In 100 ms bins from 0 the counts are 4, 9, 4, 9, 9, 1, 8, 3, 3, 7, 2. Split by node the medians are 387 ms (10.0.1.118, n = 26) and 456 ms (10.0.1.169, n = 34).

Reading the segments:

- **The bound-to-"Ready in" segment (median 595 ms) is not measured as app boot.** Every wake logs "Ready in 0ms" at process start, so app initialisation is outside what this data times. The queue-proxy sidecar, which is not the app, logs its first line a median of 29 ms after "Ready in" (range −37 to +64 ms), so both containers start about 0.6 s after binding. That interval is sandbox creation, pod networking and container start, and it may also include app initialisation. This data cannot say how it divides among them.
- **`podIP`, `PodReadyToStartContainers` and both containers' running state are observed in one watch update in 60 of 60 wakes.** The Ready condition is a separate, later update: it follows `podIP` by 21 to 401 ms (median 45, p90 269, n = 59). So the pod's status reaches the API in two watch updates, not one.
- **The first update lags the containers by a roughly uniform 0–1 s.** From "Ready in" to `podIP` the median is 451 ms (p90 952, p95 1020). That pattern is what a periodic status write about once a second would produce, and 59 wakes cannot distinguish a 1 s period from other periods of similar size. It is a hypothesis, not a finding. "Ready in" to Ready has a minimum of 291 ms, so the full gap is not a pure uniform lag; the Ready condition adds the 21 to 401 ms second write on top.
- **What the data does not support about the probe.** The harness's own TCP timestamps for the app and queue-proxy ports are censored at the `podIP` time (see below), so the median 45 ms between `podIP` and Ready is not a measurement of the readiness probe. The longest "Ready in" to Ready interval is 1095 ms across 59 wakes. The data does not show what triggers the Ready write.

### Kubelet source facts (Kubernetes v1.34.0)

Read from the tagged source, not from the nodes:

- In `pkg/kubelet/kubelet.go`, the generic pod lifecycle event generator (PLEG) relist period is a hard-coded constant, `genericPlegRelistPeriod = time.Second * 1`, not a kubelet configuration setting. Its comment says a longer period makes the kubelet take longer to detect container changes and update pod status, and that the relist itself can take longer than 1 s. https://github.com/kubernetes/kubernetes/blob/v1.34.0/pkg/kubelet/kubelet.go
- With the `EventedPLEG` feature gate on, the generic relist period becomes 300 s and the kubelet relies on runtime events instead (same file). The gate is Alpha and off by default since 1.26 in v1.34 (`pkg/features/kube_features.go`). https://github.com/kubernetes/kubernetes/blob/v1.34.0/pkg/features/kube_features.go
- **Not verified:** whether the OKE nodes use the default, whether their container runtime supports evented PLEG, and whether the relist period is what produces the lag seen here. Evented PLEG is not measured in this data. The kubelet's own sync and status-update paths are other candidates that this run did not examine.
- The Knative config maps (`config-deployment`, `config-autoscaler`, `config-features`) were not changed and were not examined for anything that controls this lag.

## What is not shown

- **Activator path:** the harness requests the public URL. It does not record which route served each wake, so the activator's involvement is not established by this data.
- **Throttling:** not measured (see above).
- **Probe-level detail:** the harness starts its TCP polling of the app port only after `podIP` appears, so its own app-port accept timestamp is censored at `podIP`. The app's "Ready in" log line is therefore the only listen-side timestamp, and it is what the gap figures use. Note it is logged at process start ("Ready in 0ms"), not after any application initialisation.
- **Sample size:** 20 wakes per arm. The 95% CIs are 575 and 637 ms wide in total, so effects smaller than the excluded range (see Measurement A) are not ruled out.
- **Missing marker:** one `cpu-boost2req` wake (round 17) has a "Ready in" line but no Ready condition in the watch, so it is excluded from the Ready-gap segments (n=19). It is included in the total cold-start numbers.
- **Image pulls:** the events show cached pulls (container start about 0.47 s after binding in the median), so this run does not include a cold image pull.
- **Other tenants:** the cluster also hosts other bench apps and imagecache pods. Their load was not measured or controlled during the run.

## Reproduce

```
kubectl --context knext-oke-sa apply --validate=strict -f scripts/bench-cold-start-phases/cpu-boost-nextapps.yaml
kubectl --context knext-oke-sa apply --validate=strict -f scripts/bench-cold-start-phases/phase-bench-2.yaml
PHASE_POD=phase-bench-2 python3 scripts/bench-cold-start-phases/drive.py 20 cpu-base,cpu-boost2,cpu-boost2req docs/benchmarks/data/cpu-boost-oke-2026-11-02.jsonl
python3 scripts/bench-cold-start-phases/cpu-boost-analyze.py docs/benchmarks/data/cpu-boost-oke-2026-11-02.jsonl
```
