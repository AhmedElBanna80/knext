# Cold-start phase harness

One harness measures the per-phase cold start of a Knative Service on any cluster:

- `cold-cycle.mjs` runs inside the cluster (one cold cycle per run, prints one JSON line).
- `drive.py` runs on your workstation, wakes arms in an interleaved order and collects the lines.
- `analyze.py`, `stats.py` turn the JSONL into phase tables and two-sample comparisons.

Nothing about a particular cluster is hard-coded. Cluster-specific settings come from, in order of
precedence: a command-line flag, a `KNEXT_BENCH_*` environment variable, the JSON config file, then
the default.

## Settings

| Setting | Flag | Environment | Config key | Default |
|---|---|---|---|---|
| kubectl context | `--context` | `KNEXT_BENCH_CONTEXT` | `context` | kubectl's current context |
| Namespace | `--namespace` | `KNEXT_BENCH_NAMESPACE` | `namespace` | kubectl's current namespace |
| Harness pod | `--pod` | `KNEXT_BENCH_POD` (or `PHASE_POD`) | `harnessPod` | `phase-bench` |
| Harness container | `--container` | `KNEXT_BENCH_CONTAINER` | `harnessContainer` | `harness` |
| Scratch directory on the pod | `--scratch-dir` | `KNEXT_BENCH_SCRATCH_DIR` | `scratchDir` | `/tmp` |
| Node name to agent pod | `--agent-pods` (JSON) | `KNEXT_BENCH_AGENT_PODS` | `agentPods` | none: the agent is the pod with `--agent-label` on that node |
| Agent pod label | `--agent-label` | `KNEXT_BENCH_AGENT_LABEL` | `agentLabel` | `app=phase-agent` |
| Node pool label (for `arm@pool`) | `--pool-label` | `KNEXT_BENCH_POOL_LABEL` | `nodePoolLabel` | `cloud.google.com/gke-nodepool` |

The config file is `--config=<file>`, else `$KNEXT_BENCH_CONFIG`, else `bench-config.json` next to
`drive.py` (git-ignored). Copy [`bench-config.example.json`](bench-config.example.json) and edit it. An
unknown key is an error, so a typo cannot silently fall back to a default.

`analyze.py` and `stats.py` read the namespace the same way and use it to keep only that
namespace's control-plane log lines. With no namespace set they join log lines to a cycle by
revision name alone.

## Running

```bash
cp bench-config.example.json bench-config.json   # edit context, namespace, agent map
python3 drive.py 11 arm-a,arm-b out.jsonl
python3 drive.py 11 arm-a@pool-1,arm-a@pool-2 out.jsonl   # pin an arm to a node pool
python3 drive.py 30 a@pool-1,b@pool-2 out.jsonl --place-mode=restore --block=b1
                                  # pin by cordon, but leave every cordon as found; label the rows
python3 analyze.py out.jsonl --autoscaler=autoscaler.jsonl --activator=activator.jsonl
```

The in-cluster pieces (`node-agents.yaml`, `harness-rbac.yaml`, `phase-bench-2.yaml`, the study
NextApp manifests, and the GKE variants under `gke/`) are manifests you apply to your own cluster.
They are not templated: each records the cluster one study ran on and starts with a
`CLUSTER-SPECIFIC EXAMPLE` comment saying so. Before applying one, edit:

- `metadata.namespace` (and every `namespace:` in `harness-rbac.yaml`) to match `--namespace`;
- `spec.nodeName` on the agent and harness pods to node names from `kubectl get nodes`, and put the
  same names in the `agentPods` map (or rely on the `--agent-label` lookup);
- the kubectl context in any `kubectl --context ...` example comment to yours.

## Pre-wake A/B

`prewake-ab.sh` measures cold-start latency with and without a pre-wake GET (a plain GET through the
activator, from a client pod) sent a fixed lead before the request, and reports each lead's delta relative to a cold wake. On kind:

```sh
scripts/bench-cold-start-phases/prewake-ab.sh --context kind-<name> --setup --rounds 6
```

It refuses a non-kind context without `--allow-non-kind`. The OKE procedure is the founder's
runbook, [`docs/benchmarks/prewake-ab-oke-runbook.md`](../../docs/benchmarks/prewake-ab-oke-runbook.md).

## Overlap between arms within a round

`drive.py` waits for zero pods once per round and then wakes the arms one after another. While arm B wakes, arm A's pod from the same round is still up (it only scales down after the autoscaler's grace period), and the harness's post-response watch (`READY_WINDOW_MS`) keeps running. A longer window lengthens that overlap. The arm order rotates every round, so the effect is spread across arms rather than always hitting the same one; it is mitigated, not removed.

## Native amd64 kind run: arms and sets

`.github/workflows/coldstart-phases-kind-native.yml` runs this harness on an amd64 runner. Arms are
resolved by `kind/arms.sh`: `node-1000m`, `node-2000m`, `node-4000m`, `node-nolimit`, `bun-1000m`,
`bun-nolimit` (the nolimit arms use a 64-CPU limit). Named sets:

| Set | Arms | Default N |
|---|---|---|
| `default` | node-1000m, node-nolimit, bun-1000m | 12 |
| `ladder` | node-1000m, node-2000m, node-4000m, node-nolimit | 12 |
| `bun` | bun-1000m, bun-nolimit, node-1000m (control) | 12 |
| `smoke` | node-1000m | 1 |

Pick the set with the `set` dispatch input, or by pushing to `bench/run-coldstart-native` (default),
`-ladder`, `-bun` or `-smoke`. Only `smoke` may use N below 12; it is a cheap check that a workflow
change still runs end to end, not a measurement. `kind/run-budget.sh <n> <arms> <window>` bounds the
run: the ladder at N=20 needs 4 x 20 x (45 + 20) s + 25 min = 6700 s of the 8100 s budget.
