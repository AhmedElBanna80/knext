# Cold-start node diagnosis on OKE (2026-11-02)

**Question:** where does the scale-from-zero time go between the request and the first response byte, and how much of the listening-to-Ready gap comes from the kubelet's one-second status cycle?

**Short answer:** most of the gap is before the pod's IP reaches the API, and it is not on the Knative side. The kubelet's relist period is measured at 1.003 s (on the other node, see below) and is a candidate contributor, but this data does not show how much of the wait it causes. The activator does not wait for the pod's Ready condition, so it cannot be the cause of the gap. No node-side log data was collected (see "Not shown").

## Conditions

- Cluster: OKE, two workers (10.0.1.118, 10.0.1.169), kubelet v1.34.10, CRI-O 1.34.8, Oracle Linux 8.10, systemd cgroup driver. Knative Serving 1.16.0.
- App: `cpu-base` NextApp (default resources, minScale 0, maxScale 1), bench image digest `bench-bunexec@sha256:b3aeecac…`, the same image as the earlier CPU run.
- Driver: the existing `drive.py` with one arm, 25 rounds. Each round waits for zero pods, then one wake through the in-cluster harness pod (`cold-cycle.mjs`). Driver edited to take the harness pod name from `PHASE_POD`.
- **All 25 wakes were placed on 10.0.1.169.** With one arm the scheduler did not alternate nodes as it did in the earlier two-arm run, so there is no cross-node comparison here.
- Date and time: 2026-11-02, about 17:10 to 18:58 CET.

## Access limits

- **Node log access was refused.** The read-only host-log reader pods (hostPath `/var/log`, one per worker) were denied by the permission layer as a shared-cluster mutation. Nothing was created. Kubelet logs, CRI-O logs and the journal were therefore not read.
- The node-level evidence in this report comes from the kubelet's HTTP `configz` and `metrics` endpoints, read through the API proxy. These are read-only.

## Measured

### End-to-end (25 wakes, all valid)

| Segment | Median ms | p10 | p90 | n |
|---|---|---|---|---|
| Request → pod bound (scheduler) | 116 | 96 | 194 | 25 |
| Bound → user container first log | 865 | 441 | 907 | 24 |
| Bound → app "Ready in" log (see note) | 1017 | 593 | 1055 | 24 |
| User first log → queue-proxy first log | 129 | 114 | 150 | 24 |
| Bound → `podIP` in API | 1507 | 1137 | 1996 | 25 |
| `"Ready in"` → `podIP` in API | 677 | 279 | 987 | 24 |
| CRI container `startedAt` → `podIP` in API (`startedAt` has 1 s resolution) | 1355 (min 457, max 2092) | 812 | 1876 | 25 |
| Bound → `startedAt` (1 s resolution; negative values are rounding) | 170 | -452 | 710 | 25 |
| `podIP` → first successful harness TCP connect to :3000 | 6 | 6 | 7 | 25 |
| `podIP` → Ready condition | 40 | 30 | 191 | 25 |
| Ready → first byte | 104 | 85 | 129 | 25 |
| **Total: request → first byte** | **1806** | **1439** | **2255** | 25 |

**Re-basing method.** Every time in the rows is ms after the harness request. Watch-derived times are taken on the harness clock directly. Log and `startedAt` times come from the node's clock; they are shifted by an NTP-style offset (remote minus the midpoint of a request round trip) measured against a clock pod on the app's node just before each wake. In this run the offset was 0.2 ms (max 0.3) with round trip 0.9 ms (max 1.0), so the shift is negligible. Watch-delivery latency (apiserver to harness) for the `podIP` update is not measured; every watch-derived time, including `podIP`, is the arrival time at the harness and is later than the true write by an unknown amount.

**Note on "Ready in".** The app prints `Ready in 0ms` (all 24 rows that have the line) at process start, before the server necessarily listens on :3000. The listen time is not measured. It is only bounded above by `podIP`: the harness starts polling TCP to :3000 after `podIP` arrives and succeeds on the first try in 25 of 25 rows, at `podIP` + 6 ms (median). So "Ready in" → `podIP` includes an unknown pre-listen interval, and the app may have been listening well before `podIP`.

The earlier report's log-based bound→"Ready in" was about 600 ms on two nodes; here it is 1017 ms (p10 593). The first-byte total here is 1806 ms against the earlier run's 1276 ms. That difference is unexplained and untested: this run changed node count, arm count and day together, and nothing here isolates any of them.

### Image and readiness probes

- The user container's image was reported "already present on machine" (the `Pulled` event), so no image pull was in the timed path.
- No readiness-probe `Unhealthy` event appeared in any of the 25 wakes. Successful probes are not logged, so this shows only that no probe failed visibly. It does not give the time of the first successful probe.

### Knative and kubelet configuration (read live)

- `cpu-base` revision deployment: user container has **no readiness probe and no startup probe**. Queue-proxy readiness probe: HTTP GET `/` on port 8012 with header `K-Network-Probe: queue`, periodSeconds 10, failureThreshold 3, timeoutSeconds 1.
- Kubelet (both nodes, configz): cgroup driver `systemd`, runtime endpoint `unix:///var/run/crio/crio.sock`, `cpuManagerPolicy: none`, `nodeStatusUpdateFrequency: 10s` (node status, not pod status), explicit feature gates: `DynamicResourceAllocation` only.
- Kubelet metrics (node 10.0.1.118 only, cumulative since kubelet start). **All 25 wakes ran on 10.0.1.169**, whose metrics were not captured, so the value below is from the node the wakes did not use:
  - `kubernetes_feature_enabled{name="EventedPLEG",stage="ALPHA"} 0`: **EventedPLEG is off.** Pod status therefore comes from the periodic relist, not from runtime events.
  - Relist interval: mean 1.0031 s over 2,551,197 relists.
  - Relist duration: mean 2.55 ms.
- CRI-O: `enable_pod_events` documented default is `false` (`docs/crio.conf.5.md:326`, CRI-O v1.34.0). CRI-O implements `GetContainerEvents` (`server/container_events.go`), but only when that option is on. Whether the OKE nodes set it was not checked; it is not needed while the kubelet gate is off.

## Inferred (not measured)

- **The relist period is measured; its contribution to the wait is not.** With EventedPLEG off, the kubelet learns about container changes on its relist, about once per second (mean 1.003 s on 10.0.1.118; the period is a hard-coded constant in kubelet v1.34.0, `pkg/kubelet/kubelet.go`). The value for 10.0.1.169, where the wakes ran, was not captured.
- **The uniform-phase model is rejected, so it cannot supply an estimate.** A Kolmogorov-Smirnov test of the `"Ready in"` → `podIP` waits against Uniform(0, 1000 ms) gives D = 0.284, p = 0.033 (n = 24); against queue-proxy first log → `podIP` it gives D = 0.313, p = 0.014. The data do not support an expected-value estimate (such as 500 ms) from a random phase in a 1 s cycle, and this report makes none.
- **A single relist cycle cannot explain the whole wait.** CRI container `startedAt` → `podIP` has median 1355 ms (min 457, max 2092, n = 25; `startedAt` has 1 s resolution, so each value is uncertain by up to 1 s). That is longer than one relist period in most rows. What fills the rest is not identified by this data.
- **Queue-proxy startup is about 130 ms behind the user container** (measured as first-log difference). It does not account for the wait.
- **The readiness probe is not the gap.** The gap from `podIP` to Ready is a median 40 ms, so the Ready write follows the IP write almost immediately. The probe's first success time is not observable without logs.
- **The activator is not in the pre-`podIP` wait.** See the activator finding below.

## Activator finding (Knative 1.16.0, source read at tag `knative-v1.16.0`)

- Readiness watch: `endpointsUpdated` pushes each Endpoints object's ready and not-ready addresses to the per-revision watcher (`pkg/activator/net/revision_backends.go:557-577`). The address lists come from `endpointsToDests` (`pkg/activator/net/helpers.go:60`), which takes both `Addresses` and `NotReadyAddresses`.
- **Does the activator probe not-ready pods?** Yes, if they are in the Endpoints' `NotReadyAddresses`. Each update triggers an immediate probe, and a 200 ms ticker also runs while any destination is unconfirmed (`revision_backends.go:91` default probe frequency; `:410-420` run loop).
- **Does it need `podIP` first?** Yes. A pod enters `NotReadyAddresses` only after the endpoints controller sees its IP, so the activator's first probe is after `podIP` in the API.
- **Does it wait for Ready?** No. `enableProbeOptimisation` defaults to true (`revision_backends.go:530-537`). It is set false only if the revision has an exec readiness probe or a startup probe (`:538-543`). The probe result counts as healthy when the pod is ready **or** optimisation is on (`:267`). `cpu-base` has neither exec readiness nor startup, so the activator marks the pod healthy from the queue-proxy health answer, without waiting for Ready.
- Consequence: the activator adds at most one probe interval after the endpoints update. The wait before `podIP` is before the endpoints object exists, so it is on the pod-status path, not the activator path.
- **Is there a setting that shortens the pre-`podIP` wait?** No Knative setting controls the kubelet's status write. `enableProbeOptimisation` is already on for this app. The one Knative-side choice that matters is to avoid exec readiness or startup probes, which turn optimisation off. This app has neither.
- **Realistic small change:** none in Knative that targets this gap. A candidate lever is in the kubelet: EventedPLEG (alpha, a node-level change) would remove the relist wait, but this run did not test it and the data do not show how much of the wait it would remove.

## Not shown

- **Sandbox creation, CNI setup, image check, container create and container start** are not separated. No host, kubelet or CRI logs were read (permission refused). The only sub-split available is the `Pulled`/`Created`/`Started` events, which have second resolution and cannot divide a sub-second window.
- **Whether the activator is in the request path** was not recorded. The harness requests the public URL and does not log the route.
- **The first kubelet probe timing and the queue-proxy readiness probe's first success** are not observed.
- **Throttling** was not measured.
- **Cross-node behaviour** was not measured; all wakes landed on one node.
- **Ledger:** this report adds no row to the evidence ledger. Rows 11 to 13 are unmerged on other branches, so the entry is deferred until they land.
- **Sample:** 25 wakes on one arm. Medians and percentiles are descriptive; no effect is claimed for any configuration.

## Reproduce

`kubelet-snapshot.sh` needs RBAC for `nodes/proxy` (get) and `nodes` (list).

```
scripts/bench-cold-start-phases/kubelet-snapshot.sh knext-oke-sa /tmp/kubelet-snapshot
PHASE_POD=phase-bench-2 python3 scripts/bench-cold-start-phases/drive.py 25 cpu-base docs/benchmarks/data/cold-start-node-diagnosis-oke-2026-11-02.jsonl
python3 scripts/bench-cold-start-phases/node-diagnosis-analyze.py docs/benchmarks/data/cold-start-node-diagnosis-oke-2026-11-02.jsonl --json docs/benchmarks/data/cold-start-node-diagnosis-oke-2026-11-02-analysis.json
```

Data: `docs/benchmarks/data/cold-start-node-diagnosis-oke-2026-11-02.jsonl` (25 rows), `…-analysis.json`, `cold-start-node-diagnosis-kubelet-2026-11-02.json` (metric lines and derived values).

## Leftovers

- No host-log reader pods were created. Nothing to delete for that.
- The harness pod `phase-bench-2` and the `cpu-base` NextApp are unchanged, apart from the expected scale-to-zero cycles.
