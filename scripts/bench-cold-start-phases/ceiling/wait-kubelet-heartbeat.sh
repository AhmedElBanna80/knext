#!/usr/bin/env bash
# Waits until a node's NEW kubelet has reported, not merely until the node reads Ready.
#
#   wait-kubelet-heartbeat.sh <node> <heartbeat-before-restart> [timeout-seconds=120]
#
# Why this exists: `kubectl wait --for=condition=Ready` is satisfied at once after a kubelet restart,
# because the API still holds the OLD kubelet's Ready=True until the node-lifecycle controller
# flips it (measured on kind: 53.6 s, the 40 s grace period plus the monitor interval). It would pass
# for a kubelet that is crash-looping. The new kubelet's first status post moves the Ready condition's
# lastHeartbeatTime (measured on kind: 0.45-0.83 s after a restart), so this waits for that to change
# while Ready is True. Read the heartbeat BEFORE the restart:
#
#   HB=$(kubectl get node <node> -o jsonpath='{.status.conditions[?(@.type=="Ready")].lastHeartbeatTime}')
#
# lastHeartbeatTime has one-second resolution, so a restart that posts within the same second as the
# previous heartbeat would read as "no change"; the previous heartbeat is minutes old in practice.
# Runs kubectl from the workstation. Exit 0 on a new heartbeat with Ready=True, 1 on timeout.
set -euo pipefail

NODE="${1:?usage: wait-kubelet-heartbeat.sh <node> <heartbeat-before-restart> [timeout-seconds]}"
BEFORE="${2:?usage: wait-kubelet-heartbeat.sh <node> <heartbeat-before-restart> [timeout-seconds]}"
TIMEOUT="${3:-120}"
INTERVAL="${WAIT_KUBELET_HEARTBEAT_INTERVAL:-1}"

cond() { # $1 = field of the Ready condition
  kubectl get node "$NODE" -o jsonpath="{.status.conditions[?(@.type==\"Ready\")].$1}" 2>/dev/null || true
}

end=$((SECONDS + TIMEOUT))
while :; do
  hb="$(cond lastHeartbeatTime)"
  st="$(cond status)"
  if [ -n "$hb" ] && [ "$hb" != "$BEFORE" ] && [ "$st" = "True" ]; then
    echo "node $NODE: Ready=True with a new heartbeat $hb (was $BEFORE)"
    exit 0
  fi
  if [ "$SECONDS" -ge "$end" ]; then
    echo "node $NODE: no new kubelet heartbeat after ${TIMEOUT}s (heartbeat $hb, was $BEFORE, Ready=$st)" >&2
    exit 1
  fi
  sleep "$INTERVAL"
done
