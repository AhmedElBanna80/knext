# bench-cold-start-phases/ceiling

## Overview
The kubelet ceiling test asks whether a 100 ms PLEG relist removes the pod-IP wait from cold start. The directory has a reproducible offline build of a patched kubelet, a waiter that confirms a restarted kubelet has really reported, and the offline analyzer for the block-design run. `RUNBOOK.md` and `REHEARSAL.md` are the human procedures. `kubelet-patch.diff` is the one-constant patch. `ceiling-setup.example.yaml` is an example manifest for the run.

## Interface
- `build.sh [outdir]`: builds `kubelet-v1.34.10-stock-linux-$ARCH` (control) and `kubelet-v1.34.10-relist100ms-linux-$ARCH` (patched) from `TAG=v1.34.10`, `COMMIT=bd6c4ad159ac77a879838b8f14f23a49bf97de5f`, and writes `SHA256SUMS`. Environment: `GO_TOOLCHAIN` (default `go1.25.12`), `KUBELET_CEILING_GOARCH` (`amd64` or `arm64`, default `amd64`), `KUBELET_CEILING_WORK` (default `<outdir>/src`).
- `wait-kubelet-heartbeat.sh read <context> <node>` and `wait-kubelet-heartbeat.sh wait <context> <node> <heartbeat-before-restart> [timeout-seconds=120]`. `read` prints the node's current Ready `lastHeartbeatTime`. `WAIT_KUBELET_HEARTBEAT_INTERVAL` sets the poll interval (default 1 s).
- `lattice_analyze.py rows.jsonl [--p-arm=p] [--s-arm=s] [--blocks=...] [--perms=100] [--boot=2000] [--seed=1]`. Functions include `load_rows`, `pair_rows`, `gate`, `lock_scan`, `lock_test`, `bootstrap`, `reading` and `main`.

## Invariants
- `build.sh`: the cloned source must resolve to `COMMIT`, or the script exits 1. `go version` must report exactly `GO_TOOLCHAIN`. The patch is checked with `git apply --check` before it is applied. The control build comes first, from the untouched tree. A non-amd64 `ARCH` requires an explicit outdir, so the amd64 `SHA256SUMS` cannot be overwritten. The build uses `CGO_ENABLED=0 -trimpath -buildvcs=false`.
- `wait-kubelet-heartbeat.sh`: a context is required and is always passed as `--context`. The script refuses to run without one. `wait` passes when the Ready condition's `lastHeartbeatTime` has changed while Ready is True, not when the node merely reads Ready. Exit codes: 0 success, 1 timeout with kubectl answering, 2 usage error or kubectl failure.
- `lattice_analyze.py` makes no cluster call (docstring). Exit codes: 0 analysis printed, 2 malformed input or a bad flag, 3 a block missing or too few complete pairs, 4 more than 10% of a block's wakes unusable. The 10% check runs before the missing-block check.

## Side Effects
- `build.sh`: network `git clone --depth 1 --branch v1.34.10` of `https://github.com/kubernetes/kubernetes.git` (only when the work tree is absent), then `git reset --hard` and `git clean -fdq` inside that work tree. Binaries and `SHA256SUMS` go to the outdir (default `$TMPDIR/kubelet-ceiling-build`), never into the repo.
- `wait-kubelet-heartbeat.sh`: read-only kubectl calls. It makes a temp file with `mktemp`, which a trap removes on exit.
- `lattice_analyze.py`: reads JSONL and writes only to stdout.

## Verification
- Run: `node scripts/bun-test.mjs tests/bench-cold-start-ceiling.test.ts tests/bench-cold-start-harness.test.ts` (from the repo root)
