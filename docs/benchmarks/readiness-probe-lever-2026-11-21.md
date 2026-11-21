# Readiness probe shape: does it move cold start? (kind, 2026-11-21)

Follow-up to the kind phase study (`coldstart-phases-kind-2026-11-20.md`), which saw the pod's `Ready`
condition arrive late on the operator-rendered readiness probe and left a debt: widen the harness window,
record every row's Ready time and every probe failure, and check whether a 10 s gap appears. This is that
measurement, plus an A/B of probe shapes.

**Answer.** There is **no lever on request to first byte**. The probe shape changes when the pod becomes
`Ready`, not when the first byte arrives. With the operator's current probe, `Ready` landed a median 12.0 s
after the request (p95 16.8 s) while the first byte arrived at 3.7 s. With an explicit `periodSeconds: 1`
the same app was `Ready` at 3.7 s (p95 5.4 s) and the first byte was statistically unchanged. The operator
default is **not changed** by this study; the reasons and the open check are below.

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
and a copy of the operator's ingress NetworkPolicy pointed at it. `pr-clone` is the control for "a clone
behaves like the operator's object". Knative rejects `timeoutSeconds` and `failureThreshold` when
`periodSeconds` is zero (the operator test file records this), so the only shapes reachable from the user
container probe are "no period" and "some period".

Failed-probe counts come from the kubelet's `Unhealthy` events with their `count`, captured from an event
watch plus a final snapshot (the harness records one stamp per event and no count). Event stamps have 1 s
resolution, and the kubelet's 503 event keeps counting through the scale-down, so the failures column is a
lower bound counted up to `Ready`; the timeout column is clean because kubelet timeouts only happen during
boot.

## Result: real app (Next.js, Rosetta)

`python3 -I scripts/bench-cold-start-phases/readiness-probe-summary.py data/…-next-app.jsonl data/…-unhealthy-events.json`
(times in ms after the request; p95 is interpolated, at n = 12 read it as a tail bound):

| arm | n | first byte median | p95 | max | Ready median | p95 | max | Ready seen | pods with a pre-Ready failure | kubelet timeouts per wake |
|---|---|---|---|---|---|---|---|---|---|---|
| probe-cur | 12 | 3707 | 9469 | 9807 | **12031** | 16785 | 17448 | 12/12 | 9/12 | 1.50 |
| pr-clone | 12 | 3519 | 5533 | 6075 | **11624** | 12509 | 12834 | 12/12 | 12/12 | 1.83 |
| pr-p1 | 12 | 3760 | 5573 | 6487 | **3667** | 5424 | 6297 | 12/12 | 12/12 | 0.00 |
| pr-p1t2 | 12 | 3675 | 5694 | 5700 | **3707** | 5460 | 5499 | 12/12 | 12/12 | 0.00 |

Exact Mann-Whitney against `probe-cur` (`stats.py`'s `exact_p`):

| | first byte | Ready |
|---|---|---|
| vs `pr-clone` | p = 0.35 | p = 0.18 |
| vs `pr-p1` | p = 0.98 | p = 0.0001 |
| vs `pr-p1t2` | p = 0.59 | p = 0.0001 |

- **First byte does not move.** All four arms sit at 3.5 to 3.8 s median with overlapping tails; none of the
  three comparisons is distinguishable from `probe-cur`. The 9 to 10 s maxima in `probe-cur` are two wakes
  (rows 8 and 11); the other arms have comparable single slow wakes (6.1, 6.5, 5.7 s), which is Rosetta jitter,
  not a probe effect.
- **Ready moves a lot.** Under the current probe, 11 of 12 pods were Ready 10.7 to 17.4 s after the request,
  one at 3.2 s. Under `periodSeconds: 1`, Ready was within a few hundred ms of the first byte in every wake
  (median Ready minus first byte: -137 ms and -98 ms; under the current probe: +7824 ms).
- **Mechanism, from the events.** The kubelet's first probe of queue-proxy lands while the app is still
  booting and times out after 1 s (`Readiness probe failed: … Client.Timeout exceeded while awaiting
  headers`, stamped 0.5 to 2 s after the request); we infer, without having read queue-proxy's code, that it
  holds the request while it retries the app. The next probe is one period later. In `probe-cur`, Ready came 10.2 to 11.8 s after the first timeout stamp in 9 of 9 pods with a
  recorded timeout. In `pr-clone`, 8 of 12 did the same (10.3 to 10.9 s); the other 4 became Ready 1.1 to
  2.3 s after the timeout, and these data do not say why. So the 10 s gap is real and is the probe period,
  but it is not universal. One pod in `probe-cur` was Ready at 3.2 s with no failure event: its first probe
  succeeded.
- **The first byte does not wait for Ready.** The activator probes the pod directly and routes as soon as
  queue-proxy answers: the harness's own queue-proxy probe (`qp_probe_ok`) succeeds between 512 ms before and
  71 ms after the first byte in all 48 rows, while the endpoint became Ready after the first byte in 12 of 12
  `probe-cur` wakes and 9 of 12 `pr-clone` wakes (and 0 of 12 `pr-p1`). This is the same finding as the
  earlier kind run, now with a 20 s window so Ready is seen in 48 of 48 rows.

## Result: fast app (native boot)

| arm | n | first byte median | p95 | max | Ready median | p95 | max | Ready seen |
|---|---|---|---|---|---|---|---|---|
| fast-cur | 12 | 1100 | 1815 | 2041 | 1238 | 6057 | 10965 | 12/12 |
| fast-p1 | 12 | 1080 | 1424 | 1466 | 1129 | 1984 | 2388 | 12/12 |
| fast-p1t2 | 12 | 896 | 1390 | 1425 | 883 | 1386 | 1422 | 12/12 |

Against `fast-cur`: first byte p = 0.63 (`fast-p1`) and p = 0.27 (`fast-p1t2`); Ready p = 0.48 and p = 0.07.
None is distinguishable at n = 12. The one Ready outlier in `fast-cur` (10965 ms) is its first wake, with no
pre-Ready failure event recorded, so its cause is unexplained. Nothing here suggests `periodSeconds: 1`
**slows** a fast-booting app on kind: the p1 arms are no later than the current one at the median.

Side observation: the `node -e` server does not exit on SIGTERM (it is PID 1 with no handler), so these pods
lingered for the Service's 300 s termination grace, which made the rounds long. That affects scale-down only,
never a wake, because the harness waits for zero pods before each one.

## Decision: no operator change

The operator keeps Knative's aggressive probe (no `periodSeconds`). The reasons:

1. **The metric the project optimises is first byte, and the data shows no first-byte lever.** The change
   buys earlier `Ready`, which matters for rollout and deploy waits and for how long requests keep taking the
   activator hop, not for scale-from-zero latency.
2. **An earlier OKE A/B found the opposite sign for a different shape.** The operator's old probe
   (`initialDelaySeconds 2`, `periodSeconds 3`) cost about 1.2 s of median cold start on OKE; that finding is
   pinned by `aggressive_readiness_probe_test.go`. This study's shapes (`periodSeconds 1`, no delay) differ,
   and kind with Rosetta cannot reproduce OKE's CRI-O node, so the kind result does not clear that finding.
   Flipping a measured default on kind data alone is the wrong direction of evidence.
3. **The change would be a trade, not a pure win.** With an explicit period Knative stops probing the user
   container aggressively from queue-proxy, and the kubelet probes queue-proxy every second for the pod's
   lifetime. Both are cheap, but neither was measured at OKE scale.

## What is not shown

- No OKE run. The `Ready` lag will appear on OKE if the app is still booting at the kubelet's first probe;
  OKE boots are about 1.9 to 2.4 s, so it probably does, but that is unmeasured here.
- The 4 of 12 `pr-clone` pods that were Ready 1 to 2 s after a timeout: cause unestablished.
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
| `unhealthy-events.json` | every kubelet `Unhealthy` event with its count and stamps, from the watch and a snapshot |
| `next-app-summary.txt`, `fast-app-summary.txt` | the summary tool's output, verbatim |
