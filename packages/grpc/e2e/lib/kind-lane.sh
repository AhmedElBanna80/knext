# shellcheck shell=bash
# Helpers shared by the zone-function kind lanes (z7-identity-kind, z10-zone-functions-kind,
# z12-quickstart-kind) and the z11-activator-drill.
# Sourced, never run. The caller sets, before sourcing:
#   CLUSTER        kind cluster name
#   WORK           a private temporary directory (removed by the caller's cleanup)
#   STATE          a directory that survives between runs (recorded image digests)
#   PF_PIDS        file the port-forward pids are appended to (the caller's cleanup kills them)
#   INTERNAL_PORT  local port for the forward to Knative's cluster-local gateway
#   REG_PORT       the local registry's port
#   IMAGE_PREFIX   the registry path prefix this lane pushes under (z7, z10, ...)
#   NS             the lane's namespace
# and exports KUBECONFIG pointing into WORK. ZONE_HOST is set by the caller once the zone has a URL.

log() { printf '\n== %s\n' "$*"; }
ok() { printf 'ok: %s\n' "$*"; }
fail() { printf 'FAIL: %s\n' "$*" >&2; exit 1; }
has_phase() { case " ${PHASES} " in *" $1 "*) return 0 ;; *) return 1 ;; esac; }
k() { kubectl "$@"; }

# wait_until <timeout-seconds> <interval-seconds> <description> <condition>
# The condition is a shell string, evaluated afresh on every attempt (a
# `$(...)` in it is re-run each time, which an argument list would not do).
wait_until() {
  local timeout=$1 interval=$2 desc=$3 cond=$4
  local end=$((SECONDS + timeout))
  until eval "${cond}" >/dev/null 2>&1; do
    [ "${SECONDS}" -lt "${end}" ] || fail "timed out after ${timeout}s waiting for: ${desc}"
    sleep "${interval}"
  done
}

use_cluster() {
  kind get kubeconfig --name "${CLUSTER}" >"${KUBECONFIG}"
  local ctx
  ctx="$(kubectl config current-context)"
  [ "${ctx}" = "kind-${CLUSTER}" ] || fail "kubeconfig context is '${ctx}', want kind-${CLUSTER}"
}

forward_up() { (exec 3<>/dev/tcp/127.0.0.1/"${INTERNAL_PORT}") 2>/dev/null; }

# ensure_forward: a port-forward to Knative's cluster-local gateway, started if
# the port is not accepting. `kubectl port-forward` ends when its stream breaks,
# and a long lane must not fail an assertion because of that. Safe to call from
# a subshell: every pid it starts is written to a file the caller's cleanup reads.
ensure_forward() {
  forward_up && return 0
  # kubectl itself, not the k() wrapper: `$!` of a backgrounded shell function is
  # the function's subshell, and killing that leaves kubectl holding the port.
  kubectl -n kourier-system port-forward svc/kourier-internal "${INTERNAL_PORT}:80" >>"${WORK}/pf-internal.log" 2>&1 &
  echo "$!" >>"${PF_PIDS}"
  wait_until 30 1 "port-forward on ${INTERNAL_PORT}" forward_up
}

zone_call() { # <path?query>: sets ZC_STATUS / ZC_BODY from the zone, through the cluster-local gateway
  local out attempt
  for attempt in 1 2 3; do
    out="$(curl -s -m 30 -H "Host: ${ZONE_HOST}" -w '\n%{http_code}' "http://127.0.0.1:${INTERNAL_PORT}$1" 2>/dev/null)" || out=$'\n000'
    # 000 is curl's "no response": only a dropped port-forward gives it. The zone
    # answering with an error is a status, and is not retried.
    [ "${out##*$'\n'}" = 000 ] || break
    ensure_forward
  done
  ZC_STATUS="${out##*$'\n'}"
  ZC_BODY="${out%$'\n'*}"
}
zone_status() { # <path?query>: just the status of one request to the zone
  zone_call "$1"
  echo "${ZC_STATUS}"
}
expect_zone() { # <description> <path?query> <status> <jq filter that must hold>
  zone_call "$2"
  [ "${ZC_STATUS}" = "$3" ] || fail "$1: status ${ZC_STATUS}, want $3 (body: ${ZC_BODY})"
  jq -e "$4" <<<"${ZC_BODY}" >/dev/null || fail "$1: body does not satisfy $4 (body: ${ZC_BODY})"
  ok "$1"
}

pod_json() { # <service>: the single live pod of a service
  k -n "${NS}" get pods -l "serving.knative.dev/service=$1" -o json \
    | jq '[.items[] | select(.metadata.deletionTimestamp == null)] | if length == 1 then .[0] else error("want exactly one live pod, got \(length)") end'
}
live_pods() { # <service>: the number of live (not terminating) pods of a service
  k -n "${NS}" get pods -l "serving.knative.dev/service=$1" -o json \
    | jq '[.items[] | select(.metadata.deletionTimestamp == null)] | length'
}

build_push() { # <name> <context dir>: build, push, record name=<repo>@<digest>
  local name=$1 ctx=$2 ref="localhost:${REG_PORT}/${IMAGE_PREFIX}/$1:e2e" plog="${WORK}/push-$1.log" digest
  docker build -t "${ref}" "${ctx}"
  docker push "${ref}" | tee "${plog}"
  digest="$(sed -n 's/.*digest: \(sha256:[0-9a-f]\{64\}\).*/\1/p' "${plog}" | tail -1)"
  [ -n "${digest}" ] || fail "could not read the pushed digest of ${name}"
  grep -v "^${name}=" "${STATE}/images.env" >"${STATE}/images.env.new" 2>/dev/null || true
  echo "${name}=localhost:${REG_PORT}/${IMAGE_PREFIX}/${name}@${digest}" >>"${STATE}/images.env.new"
  mv "${STATE}/images.env.new" "${STATE}/images.env"
  ok "${name} -> ${digest}"
}

image_ref() { # <name>
  local ref
  ref="$(sed -n "s/^$1=//p" "${STATE}/images.env" 2>/dev/null | tail -1)"
  [ -n "${ref}" ] || fail "no image recorded for $1 (build and push it first)"
  echo "${ref}"
}
