#!/usr/bin/env bash
# Resolve the native-amd64 cold-start arms. Prints one "<arm> <runtime> <cpu-limit>" line per
# requested arm, in the order given, or exits 2 naming the first unknown/duplicate arm.
#
#   arms.sh [<set>|<arm>,<arm>,...]        resolve arms
#   arms.sh --min-n [<set>]                 the smallest N allowed: 1 for the smoke set, else 12
#   arms.sh --default-n [<set>]             the default N: 1 for the smoke set, else 12
# (both refuse an unknown set name with exit 2; they take a set, never an arm list)
#
# Named sets (each resolves to a comma list of arms): default (the first native run's three arms),
# ladder (node-1000m, node-2000m, node-4000m, node-nolimit), bun (bun-1000m, bun-nolimit and the
# node-1000m control), smoke (node-1000m only; the only set that may run N=1).
#
# The cpu limit is the NextApp `scaling.cpuLimit` the arm is deployed with. The operator always
# renders a limit, so "no limit" is a quota far above any runner's core count: the CFS quota can
# never bind, which is what "unlimited" means to the workload. 1000m is the platform default.
set -euo pipefail

set_csv() {
  case "$1" in
    default) echo "node-1000m,node-nolimit,bun-1000m" ;;
    ladder) echo "node-1000m,node-2000m,node-4000m,node-nolimit" ;;
    bun) echo "bun-1000m,bun-nolimit,node-1000m" ;;
    smoke) echo "node-1000m" ;;
    *) echo "$1" ;;
  esac
}

if [ "${1:-}" = "--min-n" ] || [ "${1:-}" = "--default-n" ]; then
  case "${2-default}" in
    smoke) echo 1 ;;
    default | ladder | bun) echo 12 ;;
    *) echo "unknown set '${2}' (known sets: default, ladder, bun, smoke)" >&2; exit 2 ;;
  esac
  exit 0
fi

csv="$(set_csv "${1:-default}")"
seen=" "
IFS=',' read -r -a want <<<"$csv"
[ "${#want[@]}" -gt 0 ] || { echo "no arms given" >&2; exit 2; }
for arm in "${want[@]}"; do
  case "$arm" in
    node-1000m)   line="$arm node 1000m" ;;
    node-2000m)   line="$arm node 2000m" ;;
    node-4000m)   line="$arm node 4000m" ;;
    node-nolimit) line="$arm node 64" ;;
    bun-1000m)    line="$arm bun 1000m" ;;
    bun-nolimit)  line="$arm bun 64" ;;
    *) echo "unknown arm '$arm' (known: node-1000m, node-2000m, node-4000m, node-nolimit, bun-1000m, bun-nolimit; sets: default, ladder, bun, smoke)" >&2; exit 2 ;;
  esac
  case "$seen" in *" $arm "*) echo "duplicate arm '$arm'" >&2; exit 2 ;; esac
  seen="$seen$arm "
  echo "$line"
done
