# ADR-0073: Opt-in predictive pre-wake for scale-to-zero apps

- **Status:** **Proposed (2026-11-17).** Design only. No CRD field, operator code, runtime code or
  user-facing docs change when this ADR merges. Acceptance is a sprint-close decision.
- **Task:** v2 Sprint 7, S7-11 (with Z9 #2054).
- **Relates to:** ADR-0030 (scheduled warm floor, the shipped owner-authored pre-warm and its
  deferred learned controller), ADR-0004 Decision 4 (zone-to-function wake-ahead, which this
  generalises), ADR-0028 (scale-to-zero model and `spec.scaling`), ADR-0032 (target burst capacity),
  ADR-0001 (the operator is the single writer of the Knative Service).
- **Trigger class:** ADR (Proposed, design-only). It names a future CRD/config surface but adds none.

## Context

### Where a cold start spends its time

Measured on OKE, in-repo:

| Phase | Measured | Source |
|---|---|---|
| Request reaches Knative, Pod object created, scheduled | ~0.08–0.10 s + ~0.01–0.02 s | [`cold-start-phase-breakdown-2026-10-01.md`](../benchmarks/cold-start-phase-breakdown-2026-10-01.md) §3 |
| Sandbox (network namespace, CNI add) to user container created | 272 ms (one wake, `crictl inspect`) | [`cold-start-relist-and-sandbox-oke-2026-11-13.md`](../benchmarks/cold-start-relist-and-sandbox-oke-2026-11-13.md) §2 |
| Sandbox to both containers running | 520 ms | same, §2 |
| Runtime boot to listening | 0.15 s (Bun) / 0.33 s (Node) | phase breakdown §3 and §5 |
| Kubelet relist period (status reporting) | 1.0033 s / 1.0037 s mean on the two nodes; a container waits 0–1 s, ~0.5 s on average | relist doc §1 |
| Listening to Ready ("kubelet status lag") | ~540–620 ms | [`cold-start-ledger.md`](../benchmarks/cold-start-ledger.md) rows 14–16 |
| Ready to first byte, with self-warm | 16 ms (94 without) | ledger row 14 |

The current median at true scale-to-zero is about **1.6 s** (ledger rows 14–16). The two largest
platform phases are the relist wait and the sandbox start. The relist period is a compile-time
constant in the kubelet, and EventedPLEG, the supported way around it, made that phase much slower
on OKE (ledger row 16: 745 ms to 3525 ms). The relist doc's §3 concludes that a sub-second median
needs either a kubelet with a shorter relist (a founder-run ceiling test,
`scripts/bench-cold-start-phases/ceiling/RUNBOOK.md`) or **not starting from zero on the request**.
The runtime and network levers left (crun, CNI tuning) are estimated at roughly 100–150 ms in total.

So the remaining large lever is time: start the pod before the request that needs it.

### What knext already has

- **Scheduled warm floor (ADR-0030, shipped).** `NextApp.spec.scaling.warmSchedule` holds the app at
  a floor of pods during owner-declared windows. The operator is the single writer of the ksvc
  `autoscaling.knative.dev/min-scale` annotation. A change rolls a new Revision, which is fine twice
  per window and is not fine per request. The learned controller (#387) and the warm budget (#389)
  are deferred in that ADR.
- **Wake-ahead for bound functions (Z9, ADR-0004 Decision 4, shipped).** When a zone process starts,
  a process-start primer sends one plain, credential-free GET to each bound function's cluster-local
  health URL. The request goes through the activator, so the function starts while the zone boots.
  It writes nothing to the cluster. On the Z10 kind lane it takes the zone's first call from
  609–804 ms (opted out) to 41–69 ms (opted in) across seven `integration/v2` runs; the margin is
  566–738 ms, median 662 ms (all seven runs are committed in
  [`z9-wake-margin-2026-11-17.jsonl`](../benchmarks/data/z9-wake-margin-2026-11-17.jsonl))
  ([run 43987101504](https://github.com/AhmedElBanna80/knext/actions/runs/43987101504): 55 ms
  against 659 ms).

Neither covers the unscheduled first visit to a zone that is at zero.

### Kind-relative evidence: how much lead does a pre-wake need?

[`scripts/bench-cold-start-phases/prewake-ab.sh`](../../scripts/bench-cold-start-phases/prewake-ab.sh)
(this ADR's harness) wakes a scale-to-zero Knative Service with and without a pre-wake sent a fixed
lead before the request. The pre-wake is the mechanism Decision 1 recommends: **one plain GET through
the activator, sent from a client pod in the cluster, not awaited**; the measured GET follows
`lead` ms later from the same pod, on its own connection. The harness writes nothing to the cluster
for this arm.

One run, 2026-11-17, kind cluster `knext-s7-11` (one node, Kubernetes v1.29.14, Knative Serving
and Kourier v1.16.0), a stand-in target (a Node HTTP server that waits 300 ms before listening), the
request timed inside the client pod, 8 rounds with the arm order rotated each round, every cycle from
zero pods. Data: [`prewake-ab-kind-get-2026-11-17.jsonl`](../benchmarks/data/prewake-ab-kind-get-2026-11-17.jsonl).

| Arm | n | Median (ms) | Range (ms) | Delta vs cold (ms) | Relative to cold | Verdict |
|---|---|---|---|---|---|---|
| cold (no pre-wake) | 8 | 1106 | 913–1644 | 0 | 1.00 | |
| GET 500 ms ahead | 8 | 1051 | 492–1074 | −55 | 0.95 | not distinguishable from cold |
| GET 1000 ms ahead | 8 | 568 | 518–632 | −538 | 0.51 | separated from cold |
| GET 1500 ms ahead | 8 | 50 | 20–88 | −1056 | 0.05 | separated from cold |
| GET 3000 ms ahead | 8 | 8 | 4–10 | −1098 | 0.01 | separated from cold |

The shape: a GET sent 500 ms ahead is **not distinguishable from cold** here (its range lies inside
cold's). At 1000 ms the request still pays about half of the cold start, and a pre-wake hides less
than its lead (about 540 ms of a 1000 ms lead): the wake does not start the instant the GET leaves.
Only at 1500 ms, about 1.4 times this rig's cold median, does the request cost what a warm one does,
and a longer lead buys nothing more. So the useful lead is longer than the cold start itself. The OKE
cold start is ~1.6 s, so the lead needed there is expected to be longer still; that is the number the
OKE A/B must produce.

A secondary arm, min-scale set on the revision's PodAutoscaler 1500 ms ahead (8 runs, 12–16 ms), is
recorded in the same file as `minscale@1500`. It is a **different scale-up path**: it does not go
through the activator and it writes a Knative-internal object. It is a comparison only and is **not
evidence for option B**. An earlier min-scale-only run that preceded this one is kept as
[`prewake-ab-kind-minscale-2026-11-17.jsonl`](../benchmarks/data/prewake-ab-kind-minscale-2026-11-17.jsonl)
for the record and is superseded by the table above.

Kind absolute numbers are not OKE numbers: kind runs one node on a laptop, with a different
container runtime and network from OKE's, and the target is a stand-in Node server, not a knext app. Read only the relative
column and the shape: that a lead shorter than the cold start hides only part of it (or, at 500 ms
here, nothing distinguishable), and at which lead the request costs the same as a warm one. An arm
whose range overlaps cold is reported as not distinguishable from cold, never as a win. The OKE A/B is the founder's
([`prewake-ab-oke-runbook.md`](../benchmarks/prewake-ab-oke-runbook.md)).

**Non-200 cycles are excluded from every median.** `prewake-ab-summary.py` keeps only cycles whose
`status` is `"200"` (line 4), and the medians, ranges and verdicts are computed over those alone. It
prints `non-200 cycles excluded: N` (line 26) when N is non-zero. A cycle that returns a non-200 is
therefore never counted as a fast or slow cold start. If the cold arm has no successful cycle, the
summary exits rather than compute deltas. The 2026-11-17 kind run above had no excluded cycles: all
48 cycles (six arms, 8 rounds) returned 200, so the table is over the full sample. Any future run that
prints the exclusion line must report its N alongside the table.

## Decision

**Proposed:** knext adds an **opt-in, signal-driven pre-wake** that reuses Z9's mechanism, and keeps
ADR-0030's schedule for predictable peaks. Nothing is on by default, and scale-to-zero stays the
default.

1. **Mechanism: a plain GET through the activator, never a cluster write.** A pre-wake is one
   non-blocking, credential-free GET to the target app's cluster-local health path, with the same
   bounds as Z9's wake-ahead (cluster-local URLs only, short per-request timeout, capped URL count,
   failures logged and never thrown, never delays serving). It does not touch min-scale, does not
   roll a Revision and does not add a writer next to the operator (ADR-0001).
2. **First trigger: server-side, from an already-warm app.** An app that is serving a request wakes
   the apps its navigation leads to (for example, the shell zone wakes the zones its top-level links
   point at) on its first request after a cold start, and at most once per cooldown. The list of
   targets is owner-declared, rendered by the operator into the app's environment the way
   `KNEXT_WAKE_FUNCTIONS` is for Z9. No new endpoint exists, so no endpoint needs auth.
3. **Browser hints come later, and only behind auth.** A navigation or prefetch hint from the browser
   that reaches a wake endpoint is a second phase. A wake starts paid compute, so the endpoint is
   treated as mutating: it requires the app's existing session (or a signed token), is rate-limited
   per session, and accepts only targets from the owner's declared list. No unauthenticated wake
   endpoint ships, ever.
4. **The lead has to be measured, not assumed.** A pre-wake helps only if it fires early enough. The
   kind A/B above shows the shape (a lead about 1.4 times the cold start before the request is
   needed, and a shorter lead hides less than its length); the OKE A/B in the runbook gives the number. The pre-wake is
   reported as a ledger row with its lead before it is described to users as making cold start
   faster.

Not decided here: a learned predictor (ADR-0030's deferred #387) and anything inside the activator.

## Options considered

| Option | What it does | Latency effect | Cost | Risk | Fits knext's rules |
|---|---|---|---|---|---|
| **A. Scheduled min-scale windows** (ADR-0030, shipped) | Operator raises the min-scale floor during owner-declared windows | Removes the cold start inside a window; none outside | Pods held for the whole window | Each flip rolls a Revision; cannot combine with a pinned traffic target | Yes, already Accepted; covers predictable peaks only |
| **B. Signal-driven pre-wake** (recommended) | A warm app, or later an authenticated browser hint, sends a plain GET that wakes the target ahead of the user's request | Hides the part of the cold start that fits inside the lead (kind A/B above) | One extra wake per signal; a pod that wakes and is not used costs one scale-down window | Wasted wakes; the browser phase is an abuse surface, so it needs auth and rate limits | Yes: no cluster write, reuses Z9's bounded seam, no unauthenticated mutating endpoint |
| **C. Activator-side prediction** | Knative's activator (or a proxy in front of it) predicts demand and scales ahead | Could cover first visits with no app signal | A fork or a sidecar of Knative's data path | Owning Knative's data path; upgrade burden; another writer of scale | No: knext is the narrow adapter, not a Knative fork |
| **D. Do nothing** | Keep scale-to-zero as is; a shorter relist stays a founder-run ceiling test | None; median stays ~1.6 s on OKE | None | The sub-second goal is unreachable at true scale-to-zero | Yes, and honest; leaves the goal open |

B over A: A already exists and stays; B covers the unscheduled first visit A cannot. B over C: C buys
the same effect by owning Knative's data path. B over D: D is the fallback if the OKE A/B shows the
lead available in real navigation is too short to matter.

## Consequences

- **If accepted:** a new opt-in field and an operator env render (action items), a supervisor-side
  primer beside Z9's wake-ahead, and a ledger row measured on OKE before any user-facing claim.
- **Cost is the owner's choice.** Every wasted wake keeps a pod for one scale-down window. The docs
  must state it the way ADR-0037 states image pre-pull's cost.
- **Zone boundaries.** A health GET from one zone to another carries no data and reads no database, so
  it is not a cross-zone data flow under the zones contract. The sprint-close System Designer review
  should still confirm that reading.
- **No effect on a cold first request with no warm app in front of it.** The very first visit to a
  fully idle site still pays the full cold start; only the schedule (A) or the ceiling test helps
  there.
- **No cluster write.** The measured arm is a plain GET, exactly the product mechanism. The harness's
  optional min-scale arm writes a Knative-internal PodAutoscaler and is a measurement knob only; a
  product pre-wake must never write Knative-internal objects.

## Action items

- [ ] Founder: run the OKE A/B in [`prewake-ab-oke-runbook.md`](../benchmarks/prewake-ab-oke-runbook.md)
      and append the result to the cold-start ledger.
- [ ] Sprint close: accept, amend or reject this ADR on that evidence.
- [ ] If accepted, a future CRD/config surface (**not implemented**): `NextApp.spec.scaling.preWake`
      with `targets` (names of apps in the same namespace to wake), `trigger` (`firstRequest`),
      `cooldownSeconds`, and later `browserHint: { enabled, rateLimitPerMinute }` that requires the
      app's session. The matching `kn-next.config.ts` key, an operator env render (the shape of
      `KNEXT_WAKE_FUNCTIONS`), and the CLI flag. Each goes through the CRD and config triggers.
- [ ] If accepted, a supervisor primer beside `wake-ahead.cjs`, with the never-answering-target test
      Z9 already has.
- [ ] Docs: a cost section, a "what pre-wake does not fix" section, and the measured OKE lead.
