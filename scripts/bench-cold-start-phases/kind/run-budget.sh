#!/usr/bin/env bash
# Fail fast when a requested run cannot fit the job timeout.
#
#   run-budget.sh <n> <arm-count> <ready_window_s> [timeout_min=150] [post_min=15] [setup_min=25]
#
# n x arms x (PER_WAKE_S + ready_window_s) + setup must be <= timeout - post-steps margin.
# PER_WAKE_S is an ESTIMATE, not a measurement: the wait for zero pods (stable window 10 s plus the
# grace period ready_window_s + 10 s, which overlaps the watch window), the 5 s settle, the cold
# start itself (about 3 to 5 s) and polling overhead come to roughly 30 s + window, and 45 s leaves
# slack. The setup figure (kind, Knative, operator build, image builds) is likewise an estimate.
# The post-step margin covers analyse, upload and teardown. Exit 1 prints the arithmetic.
set -euo pipefail

n="${1:?n}"; arms="${2:?arm count}"; window="${3:?ready_window_s}"
timeout_min="${4:-150}"; post_min="${5:-15}"; setup_min="${6:-25}"
PER_WAKE_S=45

for v in "$n" "$arms" "$window" "$timeout_min" "$post_min" "$setup_min"; do
  case "$v" in '' | *[!0-9]*) echo "run-budget: '$v' is not a non-negative integer" >&2; exit 2 ;; esac
done

need=$((n * arms * (PER_WAKE_S + window) + setup_min * 60))
budget=$(((timeout_min - post_min) * 60))
echo "run-budget: ${n} x ${arms} x (${PER_WAKE_S} + ${window}) s + ${setup_min} min setup = ${need} s; budget ${budget} s (${timeout_min} min timeout minus ${post_min} min for post-steps)"
if [ "$need" -gt "$budget" ]; then
  echo "run-budget: does not fit; lower n, drop an arm, or shorten ready_window_s" >&2
  exit 1
fi
