# bench-cold-start-phases/gke

## Overview
Tools from the 2026-10-01 GKE runtime and minimisation sitting of the cold-start bench. There is an in-pod first-request tracer, a V8 CPU-profile summariser, a per-phase A/B comparator built on the parent harness, and a checker for the arm contract. The YAML files here are cluster-specific example manifests, not source.

## Interface
- `first-request.mjs`: CLI `node|bun first-request.mjs [--gap=<ms>] <server command...>`. It spawns the server, polls TCP `127.0.0.1:3000` every 5 ms until a connection is accepted, and optionally sleeps `--gap` ms. It then times `GET /api/health` twice and `GET /` twice, and prints one JSON line (`listen_ms`, `health1`, `health2`, `root1`, `root2`, `compile_cache_lines`, `cc_accepted`, `cc_rejected`). Finally it sends `SIGINT` to the child.
- The YAML files (`harness-rbac.yaml`, `nextapps-primer.yaml`, `nextapps-runtime-min.yaml`, `node-agents.yaml`, `prepull-variants.yaml`) are example manifests.
- `cpuprofile-window.py`: CLI `python3 cpuprofile-window.py <file.cpuprofile> [<from_s> <to_s>]`. It prints a timeline of busy and idle samples in 100 ms buckets. If a window is given, it also prints self time by script and by function inside that window.
- `compare.py`: CLI `python3 compare.py <run.jsonl>[,...] <A>:<B>[,...] [--family=phases|total] [--phases=...] [--json=out.json]`. Functions: `load`, `select`, `values`, `iqr`, `holm`, `main`. The phase table is `PHASES`, with keys `1`-`6`, `T`, `5z`, `34`, `56` and `B`; `--phases` defaults to `1,2,3,4,5,6,T,5z`. `load` keeps only rows with no `error`, `code` 200 and a `marker`, and returns the dropped count.
- `verify-arms.sh`: CLI `bash verify-arms.sh arm1 arm2 ...`. For each ksvc it prints the container image digest prefix, command, env, readiness probe, resources, volumes and init-container count.
- Subdirectory: [variants](./variants/EGM.md) holds the bench image variants (`bc-check.mjs`, `warm-entry.mjs`, `instrumentation-stub.js`).

## Invariants
- `compare.py` adds the parent directory to `sys.path` and imports `analyze` and `stats` from `../`. It needs `../analyze.py` and `../stats.py`.
- `compare.py`: each comparison is arm B minus arm A. The Holm correction (`holm`) covers every p-value printed in one invocation. An `arm@pool` spec keeps only the wakes whose `node` contains `pool` (`select`).
- `verify-arms.sh` selects the cluster only through `KNEXT_BENCH_CONTEXT` and `KNEXT_BENCH_NAMESPACE`. If they are unset, kubectl's current context and namespace apply.

## Side Effects
- `first-request.mjs`: spawns a child process and sends loopback HTTP and TCP traffic on port 3000. It calls `process.exit(0)` 2 s after the SIGINT.
- `verify-arms.sh`: read-only `kubectl get ksvc <arm> -o json`.
- `compare.py`: reads JSONL. With `--json`, it writes the results file.
- `cpuprofile-window.py`: reads the profile and writes only to stdout.

## Verification
- Run: `node scripts/bun-test.mjs tests/bench-cold-start-harness.test.ts tests/bench-cold-start-analyzers.test.ts tests/bench-cold-start-drivers.test.ts` (from the repo root)
