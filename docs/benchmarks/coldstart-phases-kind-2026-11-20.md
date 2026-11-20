# Cold start phases on local kind (2026-11-20)

One knext app, scaled from zero 13 times on a single-node kind cluster, split into phases with the
existing harness (`scripts/bench-cold-start-phases`). Nothing was built for this: the harness is
unchanged apart from a `--p95` flag and a `--no-marker` flag in `analyze.py`.

**Answer.** Request to first byte is **3169 ms median, 3408 ms p95** (n = 13, 0 failed). **The runtime
boot phase dominates: 2192 ms median, 69% of the total.** Of that, about 0.9 s is the node process
reaching its first log line and 1.3 s is Next getting to "listening". The next phase,
listening to routable, is 640 ms. Activation, scheduling, sandbox and container start together are
under 350 ms. Image pull is 0 ms.

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
| Image pull | **0 ms, pre-pulled**: no `Pulling` event in any of the 13 wakes; every pod logged "already present on machine" |
| Limits | cpu 250m request / 1000m limit, memory 256Mi / 512Mi |

## Method

- `cluster/up.sh` from the zone-functions spike creates the cluster. `stage-zone.sh node` deploys the app
  with the packed `@getknext/*` tarballs. `scripts/bench-cold-start-phases/kind/phase-harness-kind.yaml` adds
  the harness, a clock pod and an agent pod.
- `drive.py 13 s156-zone out.jsonl --context kind-... --namespace z2 --settle 5` waits for zero pods, then
  runs `cold-cycle.mjs` inside the cluster for each wake. One arm, so no interleaving.
- Every wake is a true scale from zero: the harness waits until no pod of the service exists.
- `analyze.py ... --no-marker --p95 --activator=... --autoscaler=...` builds the table. The harness clock offset
  was 0.18 ms against the agent (same host), so no rebasing correction mattered.
- p95 is linear interpolation between order statistics. At n = 13 it is close to the maximum, so read it as
  a tail bound, not an estimate.
- Raw data: `data/coldstart-phases-kind-2026-11-20.jsonl`. Table output: `data/coldstart-phases-kind-2026-11-20-analysis.txt`.

## Phases

Times in ms after the request was sent (t = 0). Phase rows are differences of consecutive milestones.

| Phase | Median | p95 | What it covers |
|---|---|---|---|
| Request in | 0 | 0 | request sent from the in-cluster harness |
| Activator + autoscaler: request to Pod object | 44 | 55 | autoscaler decides 0 to 1 at 27 median, inside this phase |
| Pod scheduled: Pod to bound | 9 | 24 | scheduler |
| Sandbox + container start: bound to first log line | 295 | 320 | sandbox, CNI, both containers created and started (first line is queue-proxy's) |
| Image pull | 0 | 0 | pre-pulled, none observed |
| Runtime boot: first log to Next listening | **2192** | **2307** | node process start under Rosetta, supervisor, Next |
| App first-health (listening to routable) | 640 | 734 | first healthy answer to the activator's probe, then routed |
| Forward + render: routable to first byte | 0 | 152 | |
| **Total: request to first byte** | **3169** | **3408** | |

Milestones, for reference (median / p95, ms from t = 0): queue-proxy first log 348 / 386; app's first
log line 1245 / 1336; "Ready in" 2540 approx; pod IP visible in the API 804 / 1164; Endpoints present
813 / 1171.

Split of the runtime boot: app's first log to listening is 1301 / 1363 (Next reports "Ready in 0ms",
so the compile cache is doing its job and the time is before Next's own timer starts); queue-proxy's
first log to the app's first log is about 900 ms.

## What dominates

1. **Runtime boot, 69% of the wake.** It is node starting an amd64 binary through Rosetta, then the knext
   supervisor and Next standalone server reaching the port. On a native amd64 node this phase is much shorter
   (OKE: 0.15 s Bun, 0.33 s Node in the 2026-10-01 breakdown), so treat the kind number as a
   Rosetta-inflated ceiling, not a product number.
2. **Listening to routable, 640 ms (20%).** It matches OKE's 0.54 to 0.62 s for the same phase, so this one
   is not an emulation artefact. Kubelet status lag (first log to pod IP in the API: 457 median, 808 p95)
   sits inside it.
3. Everything before the container runs (activation, scheduling, sandbox) is about 350 ms in total.

## A side finding: pod Ready is bimodal and does not gate the first byte

`Ready` arrived at about 3.0 s in 3 of 13 wakes and at 11.4 to 12.1 s in the other 10. The kubelet's
first readiness probe fires about 0.8 s after the container starts, before the app listens, times out
(`Readiness probe failed ... context deadline exceeded`), and the next probe is 10 s later. The first byte
does not wait for it: the activator probes queue-proxy directly. It matters only for anything that waits
on pod Ready (scale-down, rollouts).

## Comparison with OKE 2026-11-13

| | kind (this run) | OKE 11-13 |
|---|---|---|
| Subject | Next standalone, Node + bytecode, amd64 under Rosetta | `bp-b`, Next standalone + Bun exec |
| Request to first byte, median | 3169 ms | 1770 ms (one wake) |
| Sandbox to both containers running | 295 ms (bound to first log) | 520 ms (sandbox to both started) |
| Listening to routable | 640 ms | 540 to 620 ms |
| Kubelet relist | not measured here | 1.003 s, confirmed |

Caveats. Kind is not OKE: one node, a different CNI (kindnet, not flannel), a different CRI (containerd,
not CRI-O), a different Kubernetes (1.29, not 1.34), no network between nodes. The OKE row is one wake and
a Bun single executable; this run is thirteen wakes of Node. The pod-ready path differs too: this run did
not measure the kubelet PLEG relist, so the kind "listening to routable" number cannot be split into relist
and app health the way the OKE note does. Runtime boot is not comparable at all, because of Rosetta.

## What this says about the next lever

- On a real amd64 node the 2.2 s runtime boot should mostly go away, leaving listening to routable (about
  0.6 s) as the largest single phase on both clusters. That is the phase predictive pre-wake would hide,
  and the phase the relist floor bounds.
- This run does not decide whether pre-wake should be built. It shows kind cannot answer the runtime-boot
  question; that needs an amd64 node.

Not measured: kubelet relist on kind, p95 at n above 13, Bun, a native amd64 run.

## Reproduce

```sh
export Z2_KUBECONFIG=$PWD/kubeconfig Z2_STAGE=$PWD/stage Z2_TARBALLS=$PWD/tgz
bash spikes/zone-functions-coldstart/cluster/up.sh          # registry container on :5001 first
bash spikes/zone-functions-coldstart/bench/stage-zone.sh node s156-zone
kubectl apply -f scripts/bench-cold-start-phases/kind/phase-harness-kind.yaml
python3 scripts/bench-cold-start-phases/drive.py 13 s156-zone out.jsonl --context kind-knext-z2-coldstart --namespace z2
python3 scripts/bench-cold-start-phases/analyze.py out.jsonl --no-marker --p95 --namespace=z2
```
