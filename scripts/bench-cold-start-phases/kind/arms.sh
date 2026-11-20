#!/usr/bin/env bash
# Resolve the native-amd64 cold-start arms. Prints one "<arm> <runtime> <cpu-limit>" line per
# requested arm, in the order given, or exits 2 naming the first unknown/duplicate arm.
#
#   arms.sh [node-1000m,node-nolimit,bun-1000m]
#
# The cpu limit is the NextApp `scaling.cpuLimit` the arm is deployed with. The operator always
# renders a limit, so "no limit" is a quota far above any runner's core count: the CFS quota can
# never bind, which is what "unlimited" means to the workload. 1000m is the platform default.
set -euo pipefail

csv="${1:-node-1000m,node-nolimit,bun-1000m}"
seen=" "
IFS=',' read -r -a want <<<"$csv"
[ "${#want[@]}" -gt 0 ] || { echo "no arms given" >&2; exit 2; }
for arm in "${want[@]}"; do
  case "$arm" in
    node-1000m)   line="$arm node 1000m" ;;
    node-nolimit) line="$arm node 64" ;;
    bun-1000m)    line="$arm bun 1000m" ;;
    *) echo "unknown arm '$arm' (known: node-1000m, node-nolimit, bun-1000m)" >&2; exit 2 ;;
  esac
  case "$seen" in *" $arm "*) echo "duplicate arm '$arm'" >&2; exit 2 ;; esac
  seen="$seen$arm "
  echo "$line"
done
