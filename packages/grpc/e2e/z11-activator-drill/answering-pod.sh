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
# response code. Fails closed, naming the pod, when the scrape cannot be read, is empty, has no
# `revision_request_count` series, or has a series whose value is not a number: a missing metric
# is NOT zero, because a pod we cannot read could be the one that answered. The drill only reads
# pods that have already served a call, so the series always exists for them.
pod_request_total() {
  local text total rc=0
  text="$(pod_metrics "$1")" || { echo "pod $1: cannot read its metrics" >&2; return 1; }
  [ -n "${text}" ] || { echo "pod $1: the metrics scrape is empty" >&2; return 1; }
  total="$(awk '
    /^revision_request_count[{ ]/ {
      n++
      v = $NF
      if (v !~ /^[0-9]+(\.[0-9]+)?([eE][+-]?[0-9]+)?$/) { bad = 1 } else { sum += v }
    }
    END { if (n == 0) exit 3; if (bad) exit 4; printf "%d\n", sum }' <<<"${text}")" || rc=$?
  case "${rc}" in
    0) echo "${total}" ;;
    3) echo "pod $1: the scrape has no revision_request_count series" >&2; return 1 ;;
    4) echo "pod $1: a revision_request_count value is not a number" >&2; return 1 ;;
    *) echo "pod $1: the metrics could not be parsed" >&2; return 1 ;;
  esac
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

# answer_is_accepted <status> <code>: the function accepted the token (it got as far as the
# handler, which has no such item).
answer_is_accepted() { [ "$1" = 404 ] && [ "$2" = not_found ]; }

# answer_is_refused <status> <code> <message>: the function refused the token itself.
answer_is_refused() { [ "$1" = 401 ] && [ "$2" = unauthenticated ] && [ "$3" = "token rejected" ]; }

# check_accepted_by <want uid> <before> <after> <status> <code>: the call was accepted AND the
# expected pod answered it.
check_accepted_by() {
  answer_is_accepted "$4" "$5" || { echo "want 404 not_found, got status $4 code '$5'" >&2; return 1; }
  assert_answered_by "$1" "$2" "$3"
}

# check_refused_by <want uid> <before> <after> <status> <code> <message>: the call was refused
# with the token message AND the expected pod answered it.
check_refused_by() {
  answer_is_refused "$4" "$5" "$6" || { echo "want 401 unauthenticated 'token rejected', got status $4 code '$5' message '$6'" >&2; return 1; }
  assert_answered_by "$1" "$2" "$3"
}

# check_direct_accepted <status> <code>: the POSITIVE CONTROL for a direct dial to a function pod
# with its NetworkPolicy off. A call carrying a VALID token on that same path must reach the
# handler (404 not_found: the item does not exist), so the 401s the no-token and garbage-token
# calls got were the token check, not a path that refuses everything. A 401 here means the
# valid token was refused (the leg proves nothing); anything else is no answer from the handler.
check_direct_accepted() {
  if [ "$1" = 404 ] && [ "$2" = not_found ]; then return 0; fi
  if [ "$1" = 401 ]; then
    echo "the direct path refused a VALID token (status $1 code '$2'): the policy-off refusals prove nothing" >&2
  else
    echo "want 404 not_found from the handler, got status $1 code '$2'" >&2
  fi
  return 1
}
