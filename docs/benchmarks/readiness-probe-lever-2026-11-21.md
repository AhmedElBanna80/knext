# Readiness probe shape: does it move cold start? (kind, 2026-11-21)

Follow-up to the kind phase study (`coldstart-phases-kind-2026-11-20.md`), which saw the pod's `Ready`
condition arrive late on the operator-rendered readiness probe and left a debt: widen the harness window,
record every row's Ready time and every probe failure, and check whether a 10 s gap appears. This is that
measurement, plus an A/B of probe shapes.

**Answer.** **No difference in request to first byte was detected, and this study is too small to
rule one out on the real app.** The probe shape clearly changes when the pod becomes `Ready`. With the
operator's current probe, `Ready` landed a median 12.0 s after the request (p95 16.8 s) while the first byte
arrived at 3.7 s. With an explicit `periodSeconds: 1` the same app was `Ready` at 3.7 s (p95 5.4 s). First
byte moved by a median +53 ms (bootstrap 95% CI [-1960, +494] ms): that interval does not exclude a 1.2 s
speedup, and for the `timeoutSeconds: 2` variant it does not exclude a 1.2 s slowdown either (CI
[-1933, +1568] ms). On a fast-booting app the first-byte intervals are narrower (about +-0.5 s) and do exclude
a 1.2 s effect in either direction. The operator default is **not changed**; the reasons and the open check
are below.

## Environment

| Item | Value |
|---|---|
| Cluster | kind v0.29.0, one node (`kindest/node` v1.29.14), Apple-Silicon Mac, OrbStack Docker |
| Serving stack | Knative Serving 1.16.0 + Kourier, cert-manager, knext operator built from `integration/v2` at `3a490920a` |
| Autoscaler | `stable-window` 10 s, `scale-to-zero-pod-retention-period` 0 s, `scale-to-zero-grace-period` 30 s (ready window + 10 s, as the native workflow sets it) |
| Real-app arms | the minimal Next.js 16.4.5 zone image from the earlier kind study (node runtime, bytecode cache), **amd64 under Rosetta**, cpu limit 1000m. Rosetta inflates runtime boot, so compare arms with each other, not with a native number |
| Fast-app arms | `node:24-alpine` running a one-line HTTP server, arm64 native, roughly 0.1 s boot. It removes the slow boot so the probe mechanism can be seen on its own |
| Harness | `scripts/bench-cold-start-phases`: `drive.py` + `cold-cycle.mjs` from the `kind/phase-harness-kind.yaml` pods, `READY_WINDOW_MS=20000` (the earlier run used 1500), arms rotated each round, every wake a true scale from zero |
| Samples | 12 wakes per arm: 4 arms on the real app (48 rows), 3 arms on the fast app (36 rows), 0 excluded |

## Arms

| Arm | What it is | Readiness probe on the user container | Probe the kubelet runs on queue-proxy `:8012` (read from the live pod) |
|---|---|---|---|
| `probe-cur` | the NextApp the operator renders | `httpGet /api/health:3000`, no period (Knative aggressive mode) | `periodSeconds 10`, `timeoutSeconds 1`, `failureThreshold 3` |
| `pr-clone` | a Knative Service copied from the operator's, no change | same | same |
| `pr-p1` | the same copy | `periodSeconds: 1` | `periodSeconds 1`, `timeoutSeconds 1` |
| `pr-p1t2` | the same copy | `periodSeconds: 1`, `timeoutSeconds: 2` | `periodSeconds 1`, `timeoutSeconds 2` |
| `fast-cur`, `fast-p1`, `fast-p1t2` | the three probe shapes on the fast app | as above | as above |

The clones exist because only the NextApp is operator-managed; to vary the probe without changing the
operator, each candidate is the operator's rendered Service (`kubectl get ksvc -o json`) with the probe edited
and a copy of the operator's ingress NetworkPolicy pointed at it. The manifests actually applied, the
generator, and the diff against the operator's objects are committed in
`data/readiness-probe-lever-2026-11-21-manifests/` (`generate-arms.py` regenerates every arm from
`operator-ksvc.json` and `operator-netpol.json`; `operator-vs-pr-clone.diff` is the diff).

The diff shows the `pr-clone` Service **`.spec` is identical** to the operator's (same template, probe,
resources, service account), and its NetworkPolicy `.spec` differs only in the `podSelector` target. What
differs is metadata: name, labels (`app`, `bench` instead of `app`, `generated-by`), and no `ownerReference`
to a NextApp. So "differs only in the probe" holds for the pod template and the policy, which is what the
pod sees. It does not cover anything else the operator reconciles for a NextApp (I did not enumerate the
operator's other objects for `probe-cur`), nor timing differences from the operator reconciling its own
object. `pr-clone` and `probe-cur` differ on one mechanism count (12/12 vs 9/12 pods with a pre-Ready failure
event); see the mechanism bullet below. Treat the clone as a control that is close to, not proven equal to,
the operator's object. Knative rejects `timeoutSeconds` and `failureThreshold` when
`periodSeconds` is zero (the operator test file records this), so the only shapes reachable from the user
container probe are "no period" and "some period".

Failed-probe counts come from the kubelet's `Unhealthy` events with their `count`, captured from an event
watch plus a final snapshot (the harness records one stamp per event and no count). Event stamps have 1 s
resolution, and the kubelet's 503 event keeps counting through the scale-down, so the failures column is a
lower bound counted up to `Ready`; the timeout column is clean because kubelet timeouts only happen during
boot. Both `fails/wake` figures for the period-1 arms (1.00 with 0 timeouts) are an artefact of that
straddling rule (their 503 event spans boot and scale-down and counts once), not a measured failure count.
The summary tool refuses an empty events capture and reports `unknown` for any pod the capture never
mentions (here: 0 of 84 pods), so "0 failures" cannot silently mean "no capture". The committed events file
holds the `Unhealthy` events plus each pod's `Scheduled` event as proof the capture saw the pod.

## Result: real app (Next.js, Rosetta)

`python3 -I scripts/bench-cold-start-phases/readiness-probe-summary.py data/…-next-app.jsonl data/…-unhealthy-events.json`
(times in ms after the request; p95 is interpolated, at n = 12 read it as a tail bound):

| arm | n | first byte median | p95 | max | Ready median | p95 | max | Ready seen | pods with a pre-Ready failure | kubelet timeouts per wake |
|---|---|---|---|---|---|---|---|---|---|---|
| probe-cur | 12 | 3707 | 9469 | 9807 | **12031** | 16785 | 17448 | 12/12 | 9/12 | 1.50 |
| pr-clone | 12 | 3519 | 5533 | 6075 | **11624** | 12509 | 12834 | 12/12 | 12/12 | 1.83 |
| pr-p1 | 12 | 3760 | 5573 | 6487 | **3667** | 5424 | 6297 | 12/12 | 12/12 | 0.00 |
| pr-p1t2 | 12 | 3675 | 5694 | 5700 | **3707** | 5460 | 5499 | 12/12 | 12/12 | 0.00 |

Each arm against `probe-cur`, candidate minus baseline (`readiness-probe-summary.py`, second table).
CI = percentile bootstrap, 10000 resamples, seed 7, of the difference of medians; HL = Hodges-Lehmann shift;
p = **two-sided** Mann-Whitney U (exact when there are no ties, normal approximation otherwise). **The p-values
are unadjusted**: there are six comparisons on the real app and four on the fast app (two metrics each), and
no correction was applied, so read them as descriptive. The last column asks whether the CI excludes a
shift of +-1200 ms, the size of the probe-grid regression the operator's readiness-probe comment cites.

| metric | arm | median diff | HL shift | 95% CI | p | excludes a 1.2 s slowdown / speedup? |
|---|---|---|---|---|---|---|
| first byte | pr-clone | -188 | -201 | [-2201, +814] | 0.35 | slowdown yes / speedup no |
| first byte | pr-p1 | +53 | +11 | [-1960, +494] | 0.98 | slowdown yes / speedup no |
| first byte | pr-p1t2 | -32 | -147 | [-1933, +1568] | 0.59 | slowdown **no** / speedup no |
| Ready | pr-clone | -407 | -664 | [-8129, +390] | 0.18 | slowdown yes / speedup no |
| Ready | pr-p1 | -8363 | -8336 | [-9377, -7634] | 0.0001 | slowdown yes / speedup no (it is a 7.6 s or larger speedup) |
| Ready | pr-p1t2 | -8323 | -8115 | [-9401, -6819] | 0.0001 | slowdown yes / speedup no (it is a 6.8 s or larger speedup) |

- **No first-byte difference was detected, and the interval is too wide to exclude one.** All four arms sit
  at 3.5 to 3.8 s median with overlapping tails and none of the three comparisons is significant, but at
  n = 12 on a Rosetta app the 95% CIs for the median difference are 2.5 to 3.5 s wide: they exclude a 1.2 s
  *slowdown* for `pr-p1` (upper bound +494 ms) but do not exclude a 1.2 s speedup for any arm, and for
  `pr-p1t2` they exclude neither direction. The wide intervals come from slow wakes in every arm (the two
  9 to 10 s wakes in `probe-cur` are its 8th and 11th wakes, file lines 30 and 43 of the committed
  `next-app.jsonl`; the other arms have single slow wakes of 6.1, 6.5 and 5.7 s), which I attribute to Rosetta
  jitter but did not isolate. "No detected difference" is the claim; "no first-byte lever" is not shown.
- **Ready moves a lot.** Under the current probe, 11 of 12 pods were Ready 10.7 to 17.4 s after the request
  and one at 3.2 s. Under `periodSeconds: 1`, Ready was within a few hundred ms of the first byte in every
  wake (median Ready minus first byte: -137 ms and -98 ms; under the current probe: +7824 ms).
- **Mechanism: consistent with the next kubelet probe one period later in most pods; not established.** The
  kubelet's first probe of queue-proxy times out after 1 s while the app is still booting (`Readiness probe
  failed: … Client.Timeout exceeded while awaiting headers`, stamped 0.5 to 2 s after the request); I infer,
  without having read queue-proxy's code, that queue-proxy holds the request while it retries the app. Counting
  `probe-cur` and `pr-clone` together (24 wakes): 21 pods have a recorded timeout, and in 17 of
  them Ready came 10.2 to 11.8 s after the first timeout stamp, which is what a 10 s kubelet period predicts.
  The other 4 (all `pr-clone`, wakes 5, 9, 11 and 12, file lines 18, 34, 44 and 47) became Ready 1.1 to 2.3 s
  after the timeout, at about the first byte (3.1 to 4.3 s), which a strict 10 s grid does not predict, and
  these data do not say why. In `probe-cur`, 11 of 12 pods were late (Ready 10.7 to 17.4 s) but only 9 have a
  recorded timeout; the other 2 (wakes 5 and 6, file lines 17 and 24; Ready 10.7 and 11.1 s) are late with no
  failure event in the capture, which covers those pods (each has its `Scheduled` event). The 12th pod
  (wake 2, line 8) was Ready at 3.2 s with no failure event: its first probe succeeded. So the 10 s gap is
  real and common, the period explanation fits 17 of the 21 pods that have a timeout, and the rest are
  unexplained.
- **The first byte arrived before the endpoint was Ready.** The endpoint became Ready after the first byte in
  12 of 12 `probe-cur` wakes and 9 of 12 `pr-clone` wakes (0 of 12 `pr-p1`), so the request was served
  while the pod was not yet Ready. The harness's own queue-proxy probe (`qp_probe_ok`) succeeds between 512 ms
  before and 71 ms after the first byte in all 48 rows. That is consistent with the activator probing queue-proxy
  directly (the earlier native-kind study times that as phase `5w`, "activator marks pod healthy", about 0.4
  to 0.6 s after the first log there), but I did not read the activator logs for these
  runs, so how the activator decided is inferred, not observed. This is the earlier kind run's finding, now
  with a 20 s window so Ready is seen in 48 of 48 rows.

## Result: fast app (native boot)

| arm | n | first byte median | p95 | max | Ready median | p95 | max | Ready seen |
|---|---|---|---|---|---|---|---|---|
| fast-cur | 12 | 1100 | 1815 | 2041 | 1238 | 6057 | 10965 | 12/12 |
| fast-p1 | 12 | 1080 | 1424 | 1466 | 1129 | 1984 | 2388 | 12/12 |
| fast-p1t2 | 12 | 896 | 1390 | 1425 | 883 | 1386 | 1422 | 12/12 |

Against `fast-cur` (same method; unadjusted, two-sided): first byte median difference -21 ms (95% CI
[-558, +370], p = 0.63) for `fast-p1` and -204 ms ([-541, +203], p = 0.27) for `fast-p1t2`; Ready -109 ms
([-680, +328], p = 0.48) and -355 ms ([-895, +68], p = 0.07). **Every one of these intervals excludes a 1.2 s
shift in either direction**, so on a fast-booting app on kind `periodSeconds: 1` does not cost 1.2 s of
first byte or of Ready (it could still cost or save a few hundred ms at n = 12). The one Ready outlier in
`fast-cur` (10965 ms) is its first wake, with no pre-Ready failure event recorded, so its cause is
unexplained.

Side observation: the `node -e` server does not exit on SIGTERM (it is PID 1 with no handler), so these pods
lingered for the Service's 300 s termination grace, which made the rounds long. That affects scale-down only,
never a wake, because the harness waits for zero pods before each one.

## Decision: no operator change

The operator keeps Knative's aggressive probe (no `periodSeconds`). The reasons:

1. **No first-byte benefit was detected.** The change buys earlier `Ready`, which matters for rollout and
   deploy waits and for how long requests keep taking the activator hop; the first-byte intervals on the real
   app are too wide to show a benefit or to exclude a loss (above), and first byte is the metric the project
   optimises.
2. **An earlier OKE A/B found the opposite sign for a different shape.** The operator's old probe
   (`initialDelaySeconds 2`, `periodSeconds 3`) cost about 1.2 s of median cold start on OKE; that finding is
   pinned by `aggressive_readiness_probe_test.go`. This study's shapes (`periodSeconds 1`, no delay) differ,
   and kind with Rosetta cannot reproduce OKE's CRI-O node. On the real app the `pr-p1t2` CI
   ([-1933, +1568] ms) does not exclude a 1.2 s slowdown, so the kind result cannot clear that finding.
   Flipping a measured default on kind data alone is the wrong direction of evidence.
3. **The change would be a trade, not a pure win.** With an explicit period Knative stops probing the user
   container aggressively from queue-proxy, and the kubelet probes queue-proxy every second for the pod's
   lifetime. Both are cheap, but neither was measured at OKE scale.

## What is not shown

- No OKE run. The `Ready` lag will appear on OKE if the app is still booting at the kubelet's first probe;
  OKE boots are about 1.9 to 2.4 s, so it probably does, but that is unmeasured here.
- The 4 `pr-clone` pods that were Ready 1 to 2 s after a timeout, and the 2 `probe-cur` pods that were late
  with no recorded failure: cause unestablished.
- A first-byte effect smaller than about 2 s on the real app: the CIs are too wide to see it.
- Multiplicity: no correction was applied across the six (real app) and four (fast app) comparisons.
- The fast-app Ready outlier: cause unestablished.
- Nothing here measures what else depends on `Ready` (rollout traffic shifting, the `kn-next deploy` wait).
  If those matter, they are the argument for a probe change, and they are deploy latency, not cold start.

## If the question is reopened

A founder-run OKE A/B of `periodSeconds: 1` against the current probe, first byte and `Ready`, n of at least
24 per arm, would settle point 2. Make the candidate a second NextApp through a one-line operator change on a
branch (the probe is rendered in `nextapp_ksvc.go`, `ReadinessProbe`), keep the arms interleaved, and read
`Ready` with `READY_WINDOW_MS=20000`. If the probe ever becomes a user knob it is a CRD and config surface,
which is an escalation trigger; prefer a fixed default.

## Reproduce

1. `scripts/bench-cold-start-phases/kind/phase-harness-kind.yaml` into the app namespace; scale-to-zero grace
   period set to the ready window plus 10 s.
2. Deploy the NextApp. For each candidate: `kubectl get ksvc <app> -o json`, rename it, edit
   `.spec.template.spec.containers[0].readinessProbe`, apply it with a copy of the operator's
   `<app>-allow-ingress` NetworkPolicy whose `podSelector` targets the new Service.
3. `kubectl get events -n <ns> --watch --output-watch-events -o json > events.json` in the background.
4. `READY_WINDOW_MS=20000 python3 scripts/bench-cold-start-phases/drive.py 12 <arms> out.jsonl --namespace <ns> --settle 5`
5. `python3 -I scripts/bench-cold-start-phases/readiness-probe-summary.py out.jsonl events.json`

## Data

All under `docs/benchmarks/data/`, prefix `readiness-probe-lever-2026-11-21-`:

| File | What |
|---|---|
| `next-app.jsonl` | the 48 real-app rows (compacted with `compact.py`) |
| `fast-app.jsonl` | the 36 fast-app rows |
| `unhealthy-events.json` | every kubelet `Unhealthy` event with its count and stamps, plus each pod's `Scheduled` event as capture coverage, from the watch and a snapshot |
| `next-app-summary.txt`, `fast-app-summary.txt` | the summary tool's output, verbatim |
| `manifests/` | the Services and NetworkPolicies applied, `generate-arms.py`, `operator-vs-pr-clone.diff` |
