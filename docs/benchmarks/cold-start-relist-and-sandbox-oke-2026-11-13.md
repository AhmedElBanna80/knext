# Cold start on OKE: the kubelet relist and the sandbox phase (2026-11-13)

Cluster: OKE, context `knext-oke-sa`, namespace `bench-cells`, nodes `10.0.1.118` and `10.0.1.169`,
Kubernetes v1.34.10, CRI-O 1.34.8, default runtime `runc` 1.2.9 (`crun` 1.14.3 is installed with a handler).
Subject: ksvc `bp-b` (Next standalone + Bun exec, the row 15/16 image), image cached on the node.

All reads below are read-only. No node or cluster setting was changed.

## 1. The kubelet relist period is 1 s on both nodes (confirmed)

From the kubelet's own metrics (`/api/v1/nodes/<n>/proxy/metrics`), cumulative since kubelet start:

| Node | `pleg_relist_interval` mean | relists | `pleg_relist_duration` mean |
|---|---|---|---|
| 10.0.1.118 | 1.0033 s | 3,506,620 | 2.7 ms |
| 10.0.1.169 | 1.0037 s | 224,285 | 3.1 ms |

A container that comes up between two relists is reported at the next one, so it waits 0–1 s, 0.5 s on
average. That is consistent with the "listening → Ready" phase rows 14–16 of the ledger measure at about
540–620 ms; those rows name kubelet status reporting as the likely cause, and these reads do not prove the
relist is all of it.
EventedPLEG, the supported way around it, made that phase much slower on this cluster (row 16).

One wake's kubelet log shows it directly: the pod's sandbox was ready at 58.341, the next relist reported it
at 58.493, and both containers were reported one relist later, at 59.498.

## 2. The sandbox and container phase (one wake, `crictl inspect`, ns timestamps)

Wake at 2026-11-13 19:54 on 10.0.1.118, request to first byte 1770 ms:

| Step | Time | Since previous |
|---|---|---|
| sandbox created | 38.101 | |
| user-container created | 38.373 | 272 ms (sandbox, network namespace, flannel CNI add) |
| user-container started | 38.414 | 41 ms |
| queue-proxy created | 38.542 | 128 ms |
| queue-proxy started | 38.622 | 79 ms |

520 ms from sandbox to both containers running. The kubelet creates and starts the two containers one after
the other. The created→started steps are 41 + 79 ms; with the 128 ms between the user container starting and
queue-proxy being created (which includes queue-proxy's create), the container work is about 250 ms. Swapping
`runc` for `crun` is estimated, not measured, at about 50–100 ms of that. It was not tested: shipping it needs
a cluster-wide Knative feature flag and a NextApp field, and the gain is small next to the relist.

## 3. What this means for a sub-second median

The current median is about 1.6 s (rows 14–16). The relist wait (~500 ms on average) is one of the two largest
platform phases, next to sandbox start, and its period is a compile-time constant in the kubelet. A median under 1 s at true scale-to-zero therefore needs one of:

1. **A kubelet with a shorter relist** (diagnostic only on a managed node pool). The ceiling runbook
   (`scripts/bench-cold-start-phases/ceiling/RUNBOOK.md`) measures it. It predicts a floor near 1.09 s, and it
   needs an SSH or serial-console route to the node that does not depend on the kubelet, so it is a
   founder-run session.
2. **Not starting from zero on the request:** an opt-in keep-warm or predictive pre-wake.

Runtime and network levers left on this path (crun, CNI tuning) are estimated, not measured, at roughly
100–150 ms in total.
