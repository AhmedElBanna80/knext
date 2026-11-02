# Image pre-pull and scale-out on OKE: BEFORE baseline (2026-11-02)

This is the baseline half of a before/after comparison. It measures what a scale-out
costs when the new revision's image is not already on the node a pod lands on, and it
records the arm the AFTER measurement will be compared against: the same workload with
image pre-pull turned on.

## Verdict

- **A pod that lands on a node without the image pays a real pull of about 2.1 s**
  (median, n = 27 kubelet pulls; IQR 1.7–2.4 s; p95 2.9 s). Its bound-to-Ready time is
  about **4 s, against about 2 s** for pods on a node that already has the image
  (1 s apiserver resolution).
- **The burst's request latency barely moves.** Paired over 14 rounds, the BEFORE–AFTER
  difference of the burst median is HL −235 ms with a 95% CI of [−621, +157] ms and a
  Wilcoxon p of 0.38. The first pods to become ready sit on the node that already has the
  image, so they become ready first. The pulling pods join about two seconds later. The
  inference that they absorb less of the burst is not directly measured, since requests
  cannot be mapped to pods, so this is an aggregate result, not a per-pod one.
- **A scale-from-zero wake of a single pod almost never pays a pull** on this two-node
  cluster. The revision's deploy pod pulls the image onto one node, and the wakes landed
  on that node every time (0 of 4 rounds, see below). The single-wake comparison is
  therefore not a measure of the unpulled case, and we stopped it early.

## Question

When a new revision's image is not on a node, how much does that node add to scale-out
and to a scale-from-zero wake? The same question for the AFTER arm (`imagePrewarm: true`)
is the subject of the next measurement.

## Method

- **Cluster:** OKE, two nodes (`10.0.1.118`, `10.0.1.169`), namespace `bench-cells`.
  Node-agent pods run the in-cluster probes.
- **Image:** the 2026-11-01 arm-A image (`bench-bunexec`, vinext single executable,
  `linux/amd64`). Each trial pushes a new tag whose only new content is one tiny top layer
  (a marker file). The base layers are unchanged, so the base is cached on every node.
  This is the "realistic redeploy" shape: a small new app layer on a warm base.
- **NextApps:** `pb-off` (`scaling.imagePrewarm: false`, BEFORE) and `pb-on`
  (`imagePrewarm: true`, AFTER, waits for `ImageCacheReady=True` before each burst). Both
  use `maxScale: 4`, `containerConcurrency: 1`, and no ksvc patches, no cordon, no delete.
- **Burst:** after each trial's revision is Ready and the arm is at zero pods, twelve
  concurrent GETs go out from a node agent. With concurrency 1 the autoscaler adds pods
  while the activator queues requests.
- **Per pod:** node, whether the kubelet emitted a `Pulling` event for the pod, the
  `Pulled` duration, and PodScheduled / Ready times (apiserver, 1 s resolution).
- **Design:** ABBA. The arm order alternates each round. 14 rounds, so 14 trials per arm.
- **Analysis:** `scripts/bench-cold-start-phases/burst-ab-analyze.py`. The paired statistics
  are the Hodges–Lehmann shift of per-round differences, a bootstrap 95% CI of that shift
  (4000 resamples, fixed seed), and a Wilcoxon signed-rank p (normal approximation).

## Results

### Pull and pod start (BEFORE, `pb-off`)

| metric | value |
|---|---|
| pods per trial | 4 (2 on each node, all 14 trials) |
| pods that paid a pull | 27 of 56 (two per trial, one in round 10) |
| kubelet pull duration | median 2128 ms, IQR [1681, 2392], p95 2941 ms, range [1151, 3154] |
| bound → Ready, pulled pods | median 4.0 s, p95 5.0 s (n = 27) |
| bound → Ready, cached pods | median 2.0 s, p95 2.0 s (n = 29) |

### Pod start (AFTER, `pb-on`)

| metric | value |
|---|---|
| pods that paid a pull | 0 of 56 |
| bound → Ready, all pods | median 2.0 s, p95 3.0 s (n = 56) |
| ImageCacheReady wait before the burst | median 8 s, range 4–20 s (n = 14) |

### Burst request latency (client-side, ms)

| arm | median of trial medians | p95 (median over trials) | max (median over trials) |
|---|---|---|---|
| BEFORE `pb-off` | 1625 (IQR 1438–2086) | 1636 | 1638 |
| AFTER `pb-on` | 1497 (IQR 1311–1685) | 1520 | 1525 |

Paired, per round, AFTER − BEFORE (n = 14): burst median HL −235 ms, 95% CI [−621, +157] ms,
Wilcoxon p = 0.38. Burst max: HL −225 ms, CI [−610, +167] ms, p = 0.38. The CI spans zero.
We don't claim a latency improvement from this data.

### Single-wake arm (stopped at 4 rounds)

Each round deployed a fresh image to `pp-u` with no pre-pull. The deploy pod pulled it
onto one node. We then woke the arm once and classified the wake by its in-cycle pull.

| metric | value |
|---|---|
| deploy-pod pull (kubelet) | median 1970 ms, range 1895–2009 ms (n = 4) |
| wakes that paid a pull in-cycle | 0 of 4 (all landed on the deploy node) |
| `pp-u` wake, cached (no pull) | median 1501 ms (n = 4) |
| `pp-p` wake, image pre-pulled on both nodes | median 1717 ms (n = 4) |
| paired `pp-u` − `pp-p` | HL −183 ms, CI [−468, +41] ms, p = 0.58 (n = 4) |

The model "pulled wake plus pull" gives about 3.7 s for a wake that must pull first.
This is a derived estimate, not a measurement; no wake in this arm actually pulled.

The single-wake arm was stopped because the scheduler kept placing wakes on the node that
already held the image, so the unpulled sample could not be collected without a
placement lever. The NextApp exposes none, and changing the ksvc or cordoning was out of
scope. The burst design above is the arm that actually exercises the pull.

### Not measured

- **All-layers-new worst case** (a fully flattened 53 MiB image): designed, not run.
- **App-listening phase**: not separated from the probe's end-to-end timing. Phase
  timestamps are apiserver-only, at 1 s resolution.
- **Requests per pod**: the burst cannot map requests to pods, so the first-request
  latency of pulling pods is not reported.

## Caveats

- Two nodes. The "node without the layer" is always the other node, and pods bind to it
  roughly half the time. The result may differ on a larger cluster.
- Tiny top layer. A real application layer is typically much larger (tens of MB), so the
  pull on a real redeploy would take longer than the 2 s measured here.
- The pilot trials are excluded from the data. The first (aborted) run's round 1 and the
  round killed mid-deploy are also excluded.

## Files

- Burst data (14 rounds): `docs/benchmarks/data/burst-ab-oke-2026-11-02.jsonl`
- Single-wake data (4 rounds): `docs/benchmarks/data/prepull-ab-oke-2026-11-02.jsonl`
- Drivers and analysis: `scripts/bench-cold-start-phases/burst-ab-incluster.py`,
  `burst-ab-analyze.py`, `prepull-ab-incluster.py`, `prepull-ab-analyze.py`.
  `bunexec-ab-incluster.py` (the probe helper they import) is copied from the
  2026-11-01 run, which lives on branch `bench/bunexec-cold-2026-11-01`, not on this branch.

## Leftovers (nothing deleted)

- **NextApps:** `pp-p`, `pp-u`, `pb-off`, `pb-on` (all in `bench-cells`).
- **Knative services and revisions:** each NextApp re-patch created a revision. Old
  revisions are scaled to zero but remain.
- **Running pods:** `pb-off` has four pods still scaling down, and each arm's
  `pb-on-imgcache` DaemonSet pod (two) is running by design.
- **Completed pull pods:** 12 `pp-pull-*` pods from the pre-pull steps.
- **GHCR tags** in `ghcr.io/getknext-dev/bench-bunexec`: 14 `pp-*` tags (the pilot,
  the aborted run's round 1, rounds 1–4, and round 5's pair) and 30 `pb-*` tags (the
  pilot and 14 rounds). Untagged manifests from crane pushes may remain as well.
- **Scratch:** images built locally are under the session scratchpad.
