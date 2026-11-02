# Startup CPU boost and the listening-to-Ready gap on OKE (2026-11-02)

Two measurements on the OKE bench cluster, run back to back on the same two worker nodes.

- **A:** does a higher CPU limit shorten scale-from-zero cold starts?
- **B:** where does the time between the app listening and the pod reporting Ready go?

## Summary

- **A: no measurable effect.** A 2-core CPU limit did not shorten cold starts in this sample. The median shift is +141 ms (95% CI −88 to +488 ms, p = 0.18) and the arm with a 1-core request shows +35 ms (CI −199 to +438 ms, p = 0.81). Neither arm is faster than the baseline, and the intervals exclude reductions larger than roughly 90 ms.
- **B: the listening-to-Ready gap is kubelet status reporting, not the app or readiness probing.** The app logs "Ready in" a median of about 0.5 s before the pod's `podIP` and Ready condition reach the API. The gap is the same for every CPU setting. The largest single phase in a cold start is the scheduler-bound-to-IP segment (median 1.17 s), which splits roughly evenly between app startup inside the container (about 0.6 s) and that status lag (about 0.5 s).
- **Candidate lever (not verified):** the lag looks like kubelet pod-status update latency, which is set at the node level (PLEG relist period, or the evented PLEG feature gate). Knative's config maps do not control it. Verifying it needs kubelet logs or node access, which this run did not have.

## Setup

- Cluster: OKE, two workers (10.0.1.118, 10.0.1.169), each with 3815m allocatable CPU. Kubernetes v1.34.10.
- Namespace `bench-cells`. Three NextApps with minScale 0 and maxScale 1, all on the same bench image digest (Bun runtime, Turbopack build). They differ only in `spec.resources`:
  - `cpu-base`: no resources block (operator defaults: request 250m, limit 1).
  - `cpu-boost2`: limit 2, request unchanged (250m).
  - `cpu-boost2req`: request 1, limit 2.
- Driver: `drive.py` with three arms, rotating the order each round, 20 rounds, 60 wakes total. Every round waits for all arms to reach zero pods, then wakes each arm once, serially. Each wake is one request from an in-cluster harness pod.
- Node-clock offsets used to re-base timestamps: all under 0.3 ms (median 0.22 ms).
- Data: `docs/benchmarks/data/cpu-boost-oke-2026-11-02.jsonl` (one row per wake, with watch timestamps, container logs and events). Scripts: `scripts/bench-cold-start-phases/` (`cpu-boost-nextapps.yaml`, `phase-bench-2.yaml`, `cpu-boost-analyze.py`, and `drive.py` with its pod name made configurable via `PHASE_POD`).

## Measurement A: startup CPU

Total cold start, measured as the time from the request to the first response byte, in ms (all 60 wakes valid; n = 20 per arm):

| Arm | Median | p95 | Mean | Min | Max |
|---|---|---|---|---|---|
| cpu-base (limit 1) | 1276 | 2027 | 1428 | 1145 | 2293 |
| cpu-boost2 (limit 2) | 1500 | 2128 | 1552 | 1056 | 2165 |
| cpu-boost2req (request 1, limit 2) | 1448 | 2132 | 1474 | 967 | 2220 |

Hodges-Lehmann shift and 95% bootstrap CI (median difference), relative to `cpu-base`:

- `cpu-boost2`: +141 ms, CI [−88, +488], Mann-Whitney p = 0.18.
- `cpu-boost2req`: +35 ms, CI [−199, +438], p = 0.81.

Stratified by node (the arms were not balanced across nodes, so read these with care):

| Node | cpu-base | cpu-boost2 | cpu-boost2req |
|---|---|---|---|
| 10.0.1.118 | 1208 (n=6) | 1537 (n=13) | 1225 (n=7) |
| 10.0.1.169 | 1409 (n=14) | 1280 (n=7) | 1582 (n=13) |

Node placement moves the medians by several hundred ms in both directions, which is larger than any arm effect. None of the node-stratified comparisons shows a consistent improvement from a higher limit.

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
| Bound → app "Ready in" log line | ~600 | ~1000 |
| "Ready in" → pod Ready condition | ~500 | ~1050 |
| Ready condition → first response byte | 97 | 118 |

Per-arm, the same segments are flat across the CPU settings:

| Arm | Bound→"Ready in" median | "Ready in"→Ready median | First byte median |
|---|---|---|---|
| cpu-base | 613 | 449 | 1276 |
| cpu-boost2 | 587 | 620 | 1500 |
| cpu-boost2req | 597 | 469 | 1454 (n=19) |

Reading the segments:

- **The app is not the bottleneck.** The app logs "Ready in" about 0.6 s after the scheduler binds the pod, the same for every arm.
- **Readiness probing is not the bottleneck.** The queue-proxy readiness probe runs every 10 s in the revision's deployment, but the pod's Ready condition follows the queue-proxy's TCP accept by a median of about 40 ms. The probe is not what gates Ready here.
- **The status lag is.** The pod's `podIP` and Ready condition appear together, a median of about 0.5 s after the app has logged "Ready in" (p95 about 1 s). This is the largest part of the listening-to-Ready gap.
- **Candidate setting:** the lag is consistent with the kubelet's pod-lifecycle relist period (PLEG) or the evented PLEG feature gate, which govern how quickly the kubelet notices container state changes and publishes them. Both are node-level kubelet settings. The Knative config maps (`config-deployment`, `config-autoscaler`, `config-features`) do not set anything that controls it, and they were not changed. This is a hypothesis: the kubelet's own configuration and logs were not inspected.

## What is not shown

- **Activator path:** the harness requests the public URL. It does not record which route served each wake, so the activator's involvement is not established by this data.
- **Throttling:** not measured (see above).
- **Probe-level detail:** the harness starts its TCP polling of the app port only after `podIP` appears, so its own app-port accept timestamp is censored at `podIP`. The app's "Ready in" log line is therefore the only real listen timestamp, and it is what the gap figures use.
- **Sample size:** 20 wakes per arm. The 95% CIs are about ±300 ms wide, so effects smaller than that are not excluded. A CPU effect of a few hundred ms would not show here.
- **Missing marker:** one `cpu-boost2req` wake (round 17) has a "Ready in" line but no Ready condition in the watch, so it is excluded from the Ready-gap segments (n=19). It is included in the total cold-start numbers.
- **Image pulls:** the events show cached pulls (container start about 0.47 s after binding in the median), so this run does not include a cold image pull.
- **Other tenants:** the cluster also hosts other bench apps and imagecache pods. Their load was not measured or controlled during the run.

## Leftovers (not deleted)

- NextApps `cpu-base`, `cpu-boost2`, `cpu-boost2req` in `bench-cells` (minScale 0; scaled to zero after the run).
- Pod `phase-bench-2` in `bench-cells` (Running, sleep, pinned to 10.0.1.118). Created for this run because the earlier harness pod `phase-bench` had completed. The completed pod `phase-bench` was not touched.
- Worktree `.claude/worktrees/bench-cpu-boost` on branch `bench/cpu-boost-ready-gap`.

## Reproduce

```
kubectl --context knext-oke-sa apply --validate=strict -f scripts/bench-cold-start-phases/cpu-boost-nextapps.yaml
kubectl --context knext-oke-sa apply --validate=strict -f scripts/bench-cold-start-phases/phase-bench-2.yaml
PHASE_POD=phase-bench-2 python3 scripts/bench-cold-start-phases/drive.py 20 cpu-base,cpu-boost2,cpu-boost2req docs/benchmarks/data/cpu-boost-oke-2026-11-02.jsonl
python3 scripts/bench-cold-start-phases/cpu-boost-analyze.py docs/benchmarks/data/cpu-boost-oke-2026-11-02.jsonl
```
