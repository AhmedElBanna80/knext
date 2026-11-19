# shellcheck shell=bash
# Which pod ANSWERED a call, observed rather than assumed (sourced by run.sh).
#
# The function logs nothing per request, but every pod's queue-proxy counts the requests it
# served: `revision_request_count{pod_name=...,response_code=...}` on its user-metrics port
# (9091). The drill reads that counter through the API server's pod proxy (so no port-forward,
# and the NetworkPolicy is not in the way) before and after one call. The pod whose total rose
# by exactly one is the pod that answered. Every other pod must be unchanged.
#
# Needs from the caller: `k` (kubectl), NS, and `fn_pods_ready` ("<name> <uid> <label>" lines).

# pod_metrics <pod name>: the queue-proxy's Prometheus text for that pod. Overridable in tests.
pod_metrics() {
  k get --raw "/api/v1/namespaces/${NS}/pods/$1:9091/proxy/metrics"
}

# pod_request_total <pod name>: requests that pod's queue-proxy has counted, across every
# response code. A pod that has served nothing exposes no series, which is 0.
pod_request_total() {
  local text
  text="$(pod_metrics "$1")" || return 1
  awk '/^revision_request_count[{ ]/ { sum += $NF } END { printf "%d\n", sum }' <<<"${text}"
}

# request_snapshot: "<uid> <total>" for every Ready function pod, sorted by uid.
request_snapshot() {
  local pod uid label total
  while read -r pod uid label; do
    [ -n "${pod}" ] || continue
    total="$(pod_request_total "${pod}")" || { echo "request_snapshot: cannot read ${pod}'s counter" >&2; return 1; }
    echo "${uid} ${total}"
  done <<<"$(fn_pods_ready)"
}

# answering_pod_uid <before> <after>: print the uid of the one pod that answered, from two
# snapshots. Fails (and prints nothing) unless the same pods are in both, exactly one counter
# rose, and it rose by exactly one: zero answers, two pods answering, or a pod that came or went
# all mean the call cannot be attributed.
answering_pod_uid() {
  local before="$1" after="$2" uid total prev risen="" n=0
  [ "$(awk '{print $1}' <<<"${before}" | sort)" = "$(awk '{print $1}' <<<"${after}" | sort)" ] \
    || { echo "the pods changed between the snapshots" >&2; return 1; }
  while read -r uid total; do
    [ -n "${uid}" ] || continue
    prev="$(awk -v u="${uid}" '$1 == u { print $2 }' <<<"${before}")"
    if [ "${total}" -lt "${prev}" ]; then echo "pod ${uid}'s counter fell (${prev} -> ${total})" >&2; return 1; fi
    if [ "${total}" -gt "${prev}" ]; then
      [ $((total - prev)) = 1 ] || { echo "pod ${uid} counted $((total - prev)) calls, want exactly 1" >&2; return 1; }
      risen="${uid}"
      n=$((n + 1))
    fi
  done <<<"${after}"
  [ "${n}" = 1 ] || { echo "${n} pods counted the call, want exactly 1" >&2; return 1; }
  echo "${risen}"
}

# assert_answered_by <want uid> <before> <after>: fail unless the pod that answered is <want>.
assert_answered_by() {
  local got
  got="$(answering_pod_uid "$2" "$3")" || return 1
  [ "${got}" = "$1" ] || { echo "the call was answered by pod ${got}, want pod $1" >&2; return 1; }
}
