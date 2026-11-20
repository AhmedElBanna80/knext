# Cold start phases on local kind (2026-11-20)

One knext app, scaled from zero 12 times on a single-node kind cluster, split into phases with the
existing harness (`scripts/bench-cold-start-phases`). The harness is unchanged apart from a `--p95`
flag and a `--no-marker` flag in `analyze.py`, plus a kind manifest for its pods.

**Answer.** Request to first byte is **3226 ms median, 3561 ms p95** (n = 12, 0 failed). **The runtime
boot phase dominates: 2174 ms median, 67% of the total.** Of that, about 0.9 s is the node process
reaching its first log line and 1.3 s is Next getting to "listening". After that the app needs about
0.48 s to answer its first `/api/health`, and the queue-proxy probe the activator relies on succeeds
about 0.2 s later. Activation, scheduling, sandbox and container start together are about 350 ms.
Image pull is 0 ms.

An earlier run of this study was thrown away: the operator's default NetworkPolicy dropped the
harness's direct probes, so every probe-derived milestone was null and the "routable" boundary was
just the first byte. See [the probe fix](#the-probe-fix).

## Environment

| Item | Value |
|---|---|
| Cluster | kind v0.29.0, one node (`kindest/node` v1.29.14), kubectl v1.33.3 |
| Host | Apple Silicon (arm64) Mac, OrbStack Docker 29.8.2 |
| Node arch | aarch64; the app image is **amd64** and runs under Rosetta |
| Serving stack | Knative Serving 1.16.0 + Kourier, cert-manager (repo-pinned manifest), knext operator built from this tree |
| Autoscaler | `stable-window` 10 s, `scale-to-zero-grace-period` 10 s, `scale-to-zero-pod-retention-period` 0 s |
| App | the minimal Next.js 16.4.5 zone in `spikes/zone-functions-coldstart/zone`, `kn-next deploy`, runtime `node`, turbopack |
| Bytecode | `NODE_COMPILE_CACHE=/app/.next/standalone/.next/compile-cache` baked in the image (Node 24.22.2) |
| Probes | operator-rendered, not the harness's: the Knative Service carries the operator's `httpGet /api/health:3000` readiness probe with no `periodSeconds`, which Knative rewrites to a kubelet probe of queue-proxy `:8012` (`periodSeconds: 10`, `timeoutSeconds: 1`, read from the live pod) |
| Image pull | **0 ms, pre-pulled**: no `Pulling` event in any wake; pods logged "already present on machine" |
| Limits | cpu 250m request / 1000m limit, memory 256Mi / 512Mi |

## Method

- `cluster/up.sh` from the zone-functions spike creates the cluster. `stage-zone.sh node` deploys the app
  with the packed `@getknext/*` tarballs. `scripts/bench-cold-start-phases/kind/phase-harness-kind.yaml` adds
  the harness, a clock pod, an agent pod and an additive NetworkPolicy for the harness's probes.
- `drive.py 12 s156-zone out.jsonl --context kind-... --namespace z2 --settle 5` waits for zero pods, then
  runs `cold-cycle.mjs` inside the cluster for each wake. One arm, so no interleaving.
- Every wake is a true scale from zero: the harness refuses to start unless no pod of the service exists.
- `analyze.py ... --no-marker --p95 --activator=... --autoscaler=...` builds the table. The harness clock
  offset against the agent was under 1 ms (same host).
- p95 is linear interpolation between order statistics. At n = 12 it is close to the maximum, so read it as
  a tail bound, not an estimate.
- Raw data: `data/coldstart-phases-kind-2026-11-20.jsonl`. Table output: `data/coldstart-phases-kind-2026-11-20-analysis.txt`.

## The probe fix

The first run had no `qp_probe_ok`, no `app_tcp_3000` and no same-node health milestone in any row.
Cause: the operator renders a default-on, port-restricted NetworkPolicy for the app, and kindnet enforces
it, so the harness pod's and the agent pod's direct connections to the new pod (`:3000`, `:8012`) were
dropped. `analyze.py` then falls back to `qp_ready = min(Ready condition, first byte)`, which was the first
byte in 10 of 13 wakes. The "listening to routable 640 ms" and "forward + render 0 ms" rows from that run
were therefore "listening to first byte" split arbitrarily. They are withdrawn.

This run adds one allow policy for the labelled harness pods (ports 3000 and 8012 only, selecting only the
app's pods). All five probe milestones are now present in all 12 rows.

## Phases

Times in ms. Phase rows are differences of consecutive milestones measured from the request being sent.

| Phase | Median | p95 | What it covers |
|---|---|---|---|
| Request in | 0 | 0 | request sent from the in-cluster harness |
| Activator + autoscaler: request to Pod object | 43 | 50 | autoscaler decides 0 to 1 at 25 median, inside this phase |
| Pod scheduled: Pod to bound | 7 | 10 | scheduler |
| Sandbox + container start: bound to first log line | 301 | 315 | sandbox, CNI, both containers created and started (first line is queue-proxy's) |
| Image pull | 0 | 0 | pre-pulled, none observed |
| Runtime boot: first log to Next listening | **2174** | **2220** | node process start under Rosetta, supervisor, Next |
| Listening to queue-proxy probe success | 689 | 731 | contains the app's first `/api/health` answer, then the probe the activator uses |
| Probe success to first byte | 19 | 286 | forward + render |
| **Total: request to first byte** | **3226** | **3561** | |

Inside "listening to queue-proxy probe success": the app's first direct `/api/health` 200 arrives 475 ms
after listening (p95 498). Subtracting leaves about 215 ms between the app being healthy and queue-proxy
answering the activator-style probe. The activator marks the pod healthy at 2863 ms after the first log
line (p95 3140).

Other milestones (median / p95, ms from the request): pod IP visible in the API 918 / 1356; TCP `:3000`
open from another pod 2516 / 2580; queue-proxy probe success 3247 / 3318.

## What dominates

1. **Runtime boot, 67% of the wake.** Node starting an amd64 binary through Rosetta, then the knext
   supervisor and Next standalone server reaching the port. Next reports "Ready in 0ms", so the compile
   cache is doing its job and the time is before Next's own timer starts. On a native amd64 node this phase
   is much shorter (the 2026-10-01 OKE breakdown has 0.15 s Bun, 0.33 s Node), so read the kind number as a
   Rosetta-inflated ceiling.
2. **Listening to probe success, 689 ms (21%).** The app's first health answer is about 0.48 s of it and is
   the app's own first-request cost under emulation. Kubelet status lag (first log to pod IP in the API:
   564 median, 1013 p95) is not on this path, because the probes ran straight to the pod IP.
3. Everything before the container runs (activation, scheduling, sandbox) is about 350 ms.

## A side finding: pod Ready lags the request path

In this run `Ready` was seen within the harness's window (the first byte plus 1.5 s) in 4 of 12 wakes, at
about 3.2 s. In the first run it arrived at about 3.0 s in 3 of 13 wakes and at 11.4 to 12.1 s in the other
10. These pods used the operator's probes, so this is not a harness artefact. What the data shows:

- The pod's only readiness probe is the one on queue-proxy `:8012`, `periodSeconds: 10`, `timeoutSeconds: 1`.
- 11 of 12 pods logged `Readiness probe failed: Get "http://<ip>:8012/": context deadline exceeded` in the first
  second, while the app was still booting (2.2 s to listening).
- The next probe is 10 s after that, which matches the 11.4 to 12.1 s Ready times.
- The first byte does not wait for it: the activator probes queue-proxy itself (the `K-Network-Probe: queue`
  request the harness reproduces), and it succeeded at 3247 ms median.

So with an app that takes longer than the 1 s probe timeout to come up, the kubelet's Ready is up to 10 s
behind the request path. Nothing here shows what else depends on Ready; that was not measured.

## Comparison with OKE

| | kind (this run) | OKE 10-01 (same harness) | OKE 11-13 |
|---|---|---|---|
| Subject | Next standalone, Node + bytecode, amd64 under Rosetta | Bun and Node cells, native | `bp-b`, Next standalone + Bun exec |
| Request to first byte, median | 3226 ms | about 2.3 s (healthy node) | 1770 ms (one wake) |
| Sandbox to containers running | 301 ms (bound to first log) | 0.8 to 1.4 s | 520 ms |
| Listening to routable | 689 ms | 0.83 to 0.86 s | 540 to 620 ms (ledger rows) |
| App's first `/api/health` after listening | 475 ms | 0.72 to 0.76 s | not measured |
| Kubelet relist | not measured here | not measured | 1.003 s, confirmed |

Caveats. Kind is not OKE: one node, kindnet instead of flannel, containerd instead of CRI-O, Kubernetes
1.29 instead of 1.34, no cross-node network. The two OKE columns used different definitions and different
cells, and the 11-13 figures are a single wake. Runtime boot is not comparable at all because of Rosetta.
On kind the listening-to-routable phase is in the same range as OKE's but not equal, so no claim of a match
is made.

## What this says about the next lever

- On a real amd64 node the 2.2 s runtime boot should mostly go away, leaving listening to routable
  (0.5 to 0.9 s on both clusters) as the largest single phase. That is the phase predictive pre-wake would
  hide.
- This run does not decide whether pre-wake should be built. It shows kind cannot answer the runtime-boot
  question; that needs a native amd64 node.

Not measured: kubelet relist on kind, p95 at n above 12, Bun, a native amd64 run.

## Reproduce

```sh
export Z2_KUBECONFIG=$PWD/kubeconfig Z2_STAGE=$PWD/stage Z2_TARBALLS=$PWD/tgz
bash spikes/zone-functions-coldstart/cluster/up.sh          # registry container on :5001 first
bash spikes/zone-functions-coldstart/bench/stage-zone.sh node s156-zone
kubectl apply -f scripts/bench-cold-start-phases/kind/phase-harness-kind.yaml
python3 scripts/bench-cold-start-phases/drive.py 12 s156-zone out.jsonl --context kind-knext-z2-coldstart --namespace z2
python3 scripts/bench-cold-start-phases/analyze.py out.jsonl --no-marker --p95 --namespace=z2
```
