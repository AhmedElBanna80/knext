# bench-cold-start-phases

## Overview
This directory measures the per-phase cold start of a Knative Service on any cluster. `cold-cycle.mjs` runs inside a harness pod and records one cold cycle. `drive.py` runs on a workstation and wakes the arms in an interleaved order. `analyze.py` and `stats.py` turn the resulting JSONL into phase tables and two-sample tests. The other `*-analyze.py`, `*-incluster.py` and `*-drive.py` files are study-specific drivers and analyzers. Cluster-specific settings resolve through `benchconfig.py`. The human guide is the README.md beside this file. The YAML files are cluster-specific example manifests.

## Interface
- `cold-cycle.mjs <ksvc>` (and `--print-config`): one cold cycle, printed as one JSON object of `t_*` milliseconds since the request. Internal functions: `agentPodFor`, `agentIp`, `agentPoll`, `apiGet`, `watch`, `execHeal`, `clockOffset`, `tcpPoll`, `qpProbePoll`, `main`. It reads `NS` (default: the pod's service-account namespace), `AGENT_PODS`, `AGENT_LABEL` (default `app=phase-agent`), `HEALTH_PATH` (default `/api/health`), `HEAL` and `HEAL_BIN` (default `node`) from the environment.
- `drive.py <rounds> <arm1,arm2,...> <out.jsonl>` (an arm may be written `arm@pool`; the output is appended). Flags: `--dns`, `--heal ARM`, `--config`, `--context`, `--namespace`, `--pod`, `--container`, `--scratch-dir`, `--agent-pods`, `--agent-label`, `--pool-label`, `--place-mode {all,restore}` (default `all`), `--block`, `--expect-state`, `--lock-file`, `--abort-on-foreign`, `--abort-failed-fraction`, `--settle` (10), `--poll-interval` (3). Functions: `wake`, `wait_zero`, `install_harness`, `place`, `set_cordon`, `take_lock`, `restore_begin`, `check_unchanged`, `main`.
- `benchconfig.py`: `load_file`, `resolve`. The precedence is CLI flag, then `KNEXT_BENCH_*` environment variable, then config file (`--config` or `KNEXT_BENCH_CONFIG`), then default. `PHASE_POD` is still read as a legacy name for the harness pod. `bench-config.example.json` is a sample config file.
- `analyze.py run.jsonl [--by-node] [--by-treatment] [--rows] [--activator=] [--autoscaler=] [--namespace=] [--config=]`: `milestones`, `table`, `load_cp`, `main`.
- `stats.py run.jsonl <metric> <groupA> <groupB>`: `u_stat`, `exact_p` (exact Mann-Whitney), `boot_ci` (bootstrap CI), `compare`.
- Study drivers: `baseline-stability-drive.py`, `bunexec-ab-incluster.py`, `burst-ab-incluster.py`, `prepull-ab-incluster.py`.
- Study analyzers: `baseline-stability-analyze.py`, `bunexec-ab-analyze.py`, `burst-ab-analyze.py`, `cpu-boost-analyze.py`, `node-diagnosis-analyze.py`, `prepull-ab-analyze.py`.
- Other tools:
  - `compact.py in.jsonl out.jsonl`: trims harness JSONL for committing.
  - `dns-probe.js`: times resolver lookups inside an app container and prints JSON.
  - `kubelet-snapshot.sh [context] [outdir]`: saves each node's kubelet `configz` and `metrics`.
- Subdirectories: [ceiling](./ceiling/EGM.md) (patched-kubelet ceiling test) and [gke](./gke/EGM.md) (GKE runtime and minimisation tools, including [gke/variants](./gke/variants/EGM.md)).

## Invariants
- `benchconfig.load_file`: an unknown config key (other than `$comment`) raises `SystemExit`, so a typo cannot fall back to a default silently.
- `cold-cycle.mjs` throws if the arm does not have zero pods at the start (`${ARM} has N pod(s); not at zero`) and if no namespace can be found. Apart from `HEAL=1`, which execs one DNS lookup in the new container, it is read-only against the cluster (header comment).
- `drive.py`: each round waits for every arm to reach zero pods and then rotates the wake order. `wake` starts the harness detached and guarded by `[ -e out ]`, so it never starts a second run. `take_lock` takes a non-blocking `fcntl.flock` and exits if another restore-mode driver holds the lock, so only one runs per workstation. `check_unchanged` stops the run if someone else changed a cordon this run manages.
- `kubelet-snapshot.sh` requires a context (argument or `KNEXT_BENCH_CONTEXT`). Without one it exits 2.

## Side Effects
- `drive.py`: `kubectl cp` and `kubectl exec` into the harness pod. In placement modes it also runs `kubectl cordon` and `uncordon` (`set_cordon`). It writes the output JSONL.
- `burst-ab-incluster.py` and `prepull-ab-incluster.py`: `kubectl apply --validate=strict`, `kubectl patch nextapp ... --type merge`, and (prepull only) `kubectl create` of pull pods. `prepull-ab-incluster.py` also pushes images with `crane append` and `crane export`.
- `cold-cycle.mjs`: Kubernetes API GET and watch calls using the pod's service-account token. Also TCP connects and `K-Network-Probe: queue` probes to the new pod, and agent polls.
- `kubelet-snapshot.sh`: read-only `kubectl get --raw` calls through the node proxy. It writes files under the outdir (default `$TMPDIR/kubelet-snapshot`).
- The analyzers read JSONL and print. Some write `--json` output.

## Verification
- Run: `node scripts/bun-test.mjs tests/bench-cold-start-harness.test.ts tests/bench-cold-start-analyzers.test.ts tests/bench-cold-start-drivers.test.ts tests/bench-cold-start-incluster-drivers.test.ts tests/bench-cold-start-remaining-analyzers.test.ts` (from the repo root)
