# Image pre-pull and scale-out on OKE: before and after (2026-11-02)

One before/after report. It measures what a scale-out costs when the new revision's image
is not already on the node a pod lands on (before: `scaling.imagePrewarm: false`), and what
changes when image pre-pull is turned on (after: `imagePrewarm: true`).

## Verdict

- **A pod that lands on a node without the image layer pays a real pull of about 2 s** (all
  pulls were measured on one node, 10.0.1.118; see the node caveat below).
  Of the 27 `Pulled` events in the before arm, the 14 from the first pod to land on a node
  have a median of 2.3 s (IQR 1.9–2.8 s, p95 3.0 s). Bound-to-Ready for pulling pods is
  about **4 s, against about 2 s** for pods on a node that already has the image (1 s
  apiserver resolution).
- **Pre-pull moves the pull off the scale-out path, to before it.** Each after-arm burst
  first waited for the image to be cached on every node (median 8 s, up to 20 s after
  deploy); a burst inside that window would still pay pulls. In the after arm 0 of 56 pods
  paid a pull, and bound-to-Ready was 2.0 s (p95 3.0 s). Caveat on that 0/56: the
  harness recorded no event count, so it cannot by itself rule out a silently failed
  events fetch (see "Limits of the 0 of 56 result").
- **The burst's request latency barely moves.** Paired over 14 rounds, the after-minus-before
  difference of the burst median is HL −235 ms with a 95% CI of [−621, +157] ms and a
  Wilcoxon p of 0.38. The first pods to become ready sit on the node that already has the
  image, so they become ready first, and the pulling pods join about two seconds later.
  That the pulling pods therefore absorb less of the burst is an inference: requests
  cannot be mapped to pods, so this is an aggregate result, not a per-pod one.
- **Single-pod wakes: no evidence either way.** In the four rounds run, the wake never
  paid a pull (0 of 4; 95% Clopper–Pearson interval 0–60%). Each wake landed on the node
  where that round's deploy pod had just pulled the image. Why the scheduler placed it
  there is not measured. With n = 4 this does not support "a single wake almost never
  pays a pull"; it only shows that the unpulled case did not occur in these rounds.

## Question

When a new revision's image is not on a node, how much does that node add to scale-out
and to a scale-from-zero wake, and how much of it does `imagePrewarm: true` remove?

## Method

- **Cluster:** OKE, two nodes (`10.0.1.118`, `10.0.1.169`), namespace `bench-cells`.
  Node-agent pods run the in-cluster probes.
- **Image:** the 2026-11-01 vinext single-executable image (`bench-bunexec`,
  `linux/amd64`). Each trial pushes a new tag whose only new content is one tiny top layer
  (a marker file). The base layers are unchanged, so the base is cached on every node.
  This is the "realistic redeploy" shape: a small new app layer on a warm base.
- **Two NextApps for the burst test:** one with `scaling.imagePrewarm: false` (before) and
  one with `imagePrewarm: true` (after; each burst waits for `ImageCacheReady=True`). Both
  use `maxScale: 4`, `containerConcurrency: 1`, and no ksvc patches, no cordon, no delete.
- **Burst:** after each trial's revision is Ready and the arm is at zero pods, twelve
  concurrent GETs go out from a node agent. With concurrency 1 the autoscaler adds pods
  while the activator queues requests.
- **Per pod:** node, whether the kubelet emitted a `Pulling` event for the pod, the
  `Pulled` duration, and PodScheduled / Ready times (apiserver, 1 s resolution).
- **Design:** ABBA. The arm order alternates each round. 14 rounds, so 14 trials per arm.
- **Single-wake test:** two further NextApps. Each round deploys a fresh image (the deploy
  pod pulls it onto one node), then wakes one app once with no pre-pull, and wakes the
  other once after the image was pulled onto both nodes by pull pods. 4 rounds.
- **Analysis:** `scripts/bench-cold-start-phases/burst-ab-analyze.py` and
  `prepull-ab-analyze.py`. The paired statistics are the Hodges–Lehmann shift of per-round
  differences, a bootstrap 95% CI of that shift (4000 resamples, fixed seed), and a
  Wilcoxon signed-rank p (normal approximation).

## Results

### Where the pulls happened (node confound)

All 27 pulls in the before arm landed on node `10.0.1.118` (27 of its 28 pods). None
landed on `10.0.1.169` (0 of 28), and the after arm has 0 of 28 on each node. So pull cost
here is confounded with node identity: this data cannot separate "a node without the
layer" from "this particular node". The two nodes are not interchangeable in this cluster
(an earlier investigation found one of them to have node-local network anomalies), so the
2 s figure should be read as measured on `10.0.1.118`.

Why `10.0.1.169` already held the layer in every one of the 14 trials is not explained by
this data. The burst harness did not record which node the revision's deploy pod ran on,
which is the natural cause (the deploy pod pulls the image onto its node). The only
placement data that exists is from the single-wake test, and it points the other way: the
deploy pod landed on `10.0.1.118` in 3 of 4 rounds and on `10.0.1.169` in 1. Recording
the deploy pod's node per trial would settle it.

### Pull and pod start (before arm)

| metric | value |
|---|---|
| pods per trial | 4 (2 on each node, all 14 trials) |
| pods with a `Pulling` event | 27 of 56 (two per trial, one in round 10) |
| `Pulled` event, first pulling pod per node (n = 14) | median 2315 ms, IQR [1852, 2761], p95 3033 ms, range [1639, 3154] |
| `Pulled` event, second pulling pod per node (n = 13) | median 1841 ms, IQR [1231, 2306], p95 2398 ms, range [1151, 2425] |
| bound → Ready, first pulling pod per node | median 4.0 s (n = 14) |
| bound → Ready, second pulling pod per node | median 3.0 s (n = 13) |
| bound → Ready, all pulled pods | median 4.0 s, p95 5.0 s (n = 27) |
| bound → Ready, cached pods | median 2.0 s, p95 2.0 s (n = 29) |

Only the first pod to land on a node can have started a download. The second pod on the
same node (created 0–2 s later) most likely emitted its own `Pulling` and `Pulled` events
while waiting on the first pod's in-flight pull, so its `Pulled` duration is a wait, not an
independent download. This is inferred from the shorter durations and the 1.0 s shorter
bound-to-Ready; the harness has no data that distinguishes the two. Therefore the 27
events are not 27 downloads: at most 14 downloads, one per trial, and the 2.3 s first-pod
figure is the one that estimates a pull. (Overall median across all 27 events: 2128 ms.)

### Pod start (after arm)

| metric | value |
|---|---|
| pods with a `Pulling` event | 0 of 56 |
| bound → Ready, all pods | median 2.0 s, p95 3.0 s (n = 56) |
| ImageCacheReady wait before the burst | median 8 s, range 4–20 s (n = 14) |

#### Limits of the 0 of 56 result

The events query was run with its exit code ignored and an empty result treated as "no
events", and these rows do not store how many events came back. A failed or truncated
events fetch would therefore have been recorded as "no pull", identically to a true zero.
The data cannot rule that out. Two things point against it, neither is proof: the same
code did return pulls for 27 of 56 before-arm pods, and every after-arm pod became Ready
in the cached-pod time (median 2.0 s, versus 4.0 s for pulling pods). What would confirm
it: re-run with the corrected harness, which now stores the event count per pod and marks
the row invalid when the fetch fails; or check the node container-runtime pull logs for
the after-arm window on both nodes (Kubernetes events expire after about an hour, so
the events themselves are gone).

### Burst request latency (client-side, ms)

| arm | median of trial medians | p95 (median over trials) | max (median over trials) |
|---|---|---|---|
| before (no pre-pull) | 1625 (IQR 1438–2086) | 1636 | 1638 |
| after (pre-pull) | 1497 (IQR 1311–1685) | 1520 | 1525 |

Paired, per round, after − before (n = 14): burst median HL −235 ms, 95% CI [−621, +157] ms,
Wilcoxon p = 0.38. Burst max: HL −225 ms, CI [−610, +167] ms, p = 0.38. The CI spans zero.
We don't claim a latency improvement from this data.

### Single-wake test (stopped at 4 rounds)

Each round deployed a fresh image to the no-pre-pull app. The deploy pod pulled it onto
one node. We then woke the app once and classified the wake by its in-cycle pull.

| metric | value |
|---|---|
| deploy-pod pull (kubelet) | median 1970 ms, range 1895–2009 ms (n = 4) |
| wakes that paid a pull in-cycle | 0 of 4 (95% interval 0–60%); each landed on its round's deploy-pod node |
| wake, image cached (no pull) | median 1501 ms (n = 4) |
| wake, image pre-pulled on both nodes | median 1717 ms (n = 4) |
| paired no-pre-pull − pre-pulled | HL −183 ms, CI [−468, +41] ms, p = 0.58 (n = 4) |

Modelled, not measured: the cached wake (1501 ms) plus the deploy-pod pull (1970 ms) gives
about **3.5 s** for a wake that must pull first. No wake in this test actually pulled.

The test was stopped because every wake landed on the node that already held the image,
so the unpulled sample could not be collected without a placement lever. That the
scheduler prefers the node holding the image is a hypothesis that fits these four rounds
and was not measured. The NextApp exposes no placement control, and changing the ksvc or
cordoning was out of scope. The burst design above is the arm that actually exercises the
pull.

### Not measured

- **All-layers-new worst case** (a fully flattened 53 MiB image): designed, not run.
- **App-listening phase**: not separated from the probe's end-to-end timing. Phase
  timestamps are apiserver-only, at 1 s resolution.
- **Requests per pod**: the burst cannot map requests to pods, so the first-request
  latency of pulling pods is not reported.
- **Scheduler placement**: why wakes and burst pods land where they do.

## Caveats

- Two nodes, and the pull cost is confounded with node identity (see above). The result
  may differ on a larger cluster.
- Tiny top layer. A real application layer is typically much larger (tens of MB), so the
  pull on a real redeploy would take longer than the 2 s measured here.
- The pilot trials are excluded from the data. The first (aborted) run's round 1 and the
  round killed mid-deploy are also excluded.

## Files

- Burst data (14 rounds): `docs/benchmarks/data/burst-ab-oke-2026-11-02.jsonl`
- Single-wake data (4 rounds): `docs/benchmarks/data/prepull-ab-oke-2026-11-02.jsonl`
- Drivers and analysis: `scripts/bench-cold-start-phases/burst-ab-incluster.py`,
  `burst-ab-analyze.py`, `prepull-ab-incluster.py`, `prepull-ab-analyze.py`.
  `bunexec-ab-incluster.py` is the probe helper they import, from the 2026-11-01 run.
- The drivers now check the events fetch and store an event count per pod; the committed
  data predates that and has no event count.

## Leftovers (nothing deleted)

- **NextApps:** the four benchmark NextApps (two burst, two single-wake) in `bench-cells`.
- **Knative services and revisions:** each NextApp re-patch created a revision. Old
  revisions are scaled to zero but remain.
- **Running pods:** the no-pre-pull burst app has four pods still scaling down, and the
  pre-pull app's image-cache DaemonSet pod (two) is running by design.
- **Completed pull pods:** 12 pull pods from the single-wake pre-pull steps.
- **GHCR tags** in `ghcr.io/getknext-dev/bench-bunexec`: 14 single-wake tags and 30
  burst tags (pilots, aborted first run, and rounds). Untagged manifests from crane pushes
  may remain as well.
