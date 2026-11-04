#!/usr/bin/env bash
# Read-only snapshot of kubelet configz and metrics for each worker, via the API server
# proxy (the caller needs RBAC on nodes/proxy, and nodes list). Makes no change to any node or cluster object. Usage:
#   scripts/bench-cold-start-phases/kubelet-snapshot.sh [context] [outdir]
set -euo pipefail
CTX="${1:-${KNEXT_BENCH_CONTEXT:-}}"
OUT="${2:-${TMPDIR:-/tmp}/kubelet-snapshot}"
[ -n "$CTX" ] || { echo "usage: kubelet-snapshot.sh <context> [outdir] (or set KNEXT_BENCH_CONTEXT)" >&2; exit 2; }
mkdir -p "$OUT"
for node in $(kubectl --context "$CTX" get nodes -o jsonpath='{.items[*].metadata.name}'); do
  kubectl --context "$CTX" get --raw "/api/v1/nodes/$node/proxy/configz" > "$OUT/configz-$node.json"
  kubectl --context "$CTX" get --raw "/api/v1/nodes/$node/proxy/metrics" > "$OUT/metrics-$node.txt"
  echo "$node: configz $(wc -c < "$OUT/configz-$node.json") bytes, metrics $(wc -l < "$OUT/metrics-$node.txt") lines"
done
kubectl --context "$CTX" -n knative-serving get deploy controller \
  -o jsonpath='{.metadata.labels.app\.kubernetes\.io/version}{"\n"}'
