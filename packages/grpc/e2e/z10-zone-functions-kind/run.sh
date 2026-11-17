#!/usr/bin/env bash
# Z10: zone functions on kind, the cold path.
#
# A warm zone calls a Go and a Rust function that have scaled to zero. Every call
# wakes the function through Knative's activator, and the lane proves the call
# lands, and that a failed call's code survives that path unchanged.
#
# Prerequisite: a kind cluster with Knative and the operator from this checkout,
# which the Z7 lane's `up` phase builds (CI runs it first):
#   PHASES=up packages/grpc/e2e/z7-identity-kind/run.sh
#   packages/grpc/e2e/z10-zone-functions-kind/run.sh
#
# Phases (PHASES, space-separated; default all):
#   images    build and push the Go function, the Rust function and the zone
#   deploy    recreate the namespace; the zone warm (minScale 1), the functions at minScale 0
#   cold      each function scaled to zero; a write then a read through the zone wakes it
#   trailers  scaled to zero again; a read of a missing item comes back NotFound through
#             the activator, the same code as the warm control
#   grpctrailers  the same, over the gRPC protocol (HTTP/2, not Connect): scaled to zero, a call
#             made with createGrpcTransport must get its code from the grpc-status trailer
#             (0 for a success, 5 for a missing item) and the same code as a warm control;
#             a call whose status never arrives fails the phase
#   zerozone  the zone at minScale 0 too: once the zone and the Go function both have no
#             pod, one call through the zone (a single request, no retry) wakes both; the
#             woken zone logs that it chose h2c for the function, whose Knative port is
#             named h2c and whose injected URL is plain http with no HTTP/1.1 override
#   rollout   the Go function's served version moves: a newer one (1.1.0) is called by
#             the 1.0.0 zone, an older one (0.9.0) is refused by the zone's glue
#             (FailedPrecondition) before any call, the same one (1.0.0) is called again;
#             each bump rolls exactly one zone revision
#   sovereignty  a second zone lists four functions; three take another zone's Secret
#             (env, envFrom, volume) and are refused (SecretNotAllowed, no Knative Service, no pod),
#             the control takes its own zone's Secret through all three and is rendered
#   crosszone a zone lists a function that names another zone: the listing zone reports
#             BackendBindings=False/CrossZoneBinding and renders no URL for it, the function
#             reports Bound=False/ZoneNotListed and Ready=False/ZoneNotListed, with no Knative
#             Service and no pod
#   wake      the zone restarts on an image that loads knext's wake-ahead preload: an
#             opted-out function stays at zero; an opted-in one is woken by the zone's
#             start before any call, and the first call is faster
#
# Environment: KIND_CLUSTER (default knext-z7-e2e), REGISTRY_PORT (5001),
# Z10_NAMESPACE (z10-e2e), Z10_WITH_RUST (1), PHASES, INTERNAL_PORT (18090),
# Z10_ZERO_TIMEOUT (seconds to wait for scale-to-zero, default 300).
#
# The script never deletes a cluster. It deletes only the namespace it created
# (stamped with a label; a namespace without the label is refused).

set -euo pipefail
# Never trace: the lane must not print what it reads.
set +x
umask 077

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG="$(cd "${HERE}/../.." && pwd)"
REPO="$(cd "${PKG}/../.." && pwd)"
Z7="${PKG}/e2e/z7-identity-kind"

CLUSTER="${KIND_CLUSTER:-knext-z7-e2e}"
REG_PORT="${REGISTRY_PORT:-5001}"
NS="${Z10_NAMESPACE:-z10-e2e}"
WITH_RUST="${Z10_WITH_RUST:-1}"
PHASES="${PHASES:-images deploy cold trailers grpctrailers zerozone rollout sovereignty crosszone wake}"
INTERNAL_PORT="${INTERNAL_PORT:-18090}"
ZERO_TIMEOUT="${Z10_ZERO_TIMEOUT:-300}"
OPERATOR_NS='kn-next-operator-system'

ZONE=storefront
GO_FN=example-go
RUST_FN=inventory-rust
ZONE_HOST=""

WORK="$(mktemp -d "${TMPDIR:-/tmp}/knext-z10-e2e.XXXXXX")"
STATE="${TMPDIR:-/tmp}/knext-z10-e2e-state-${CLUSTER}"
mkdir -p "${STATE}"
export KUBECONFIG="${WORK}/kubeconfig"
PF_PIDS="${WORK}/pf.pids"
IMAGE_PREFIX=z10
# shellcheck source=../lib/kind-lane.sh
source "${HERE}/../lib/kind-lane.sh"

diagnostics() {
  # Never a Secret, never a token: object status, pod state and log tails only.
  echo "---- diagnostics (no Secret is read) ----" >&2
  k -n "${NS}" get nextapp,backendservice,ksvc,pods -o wide 2>&1 | tail -40 >&2 || true
  k -n "${NS}" get backendservice -o json 2>/dev/null | jq -c '[.items[] | {name: .metadata.name, c: .status.conditions}]' >&2 || true
  k -n "${NS}" logs -l "serving.knative.dev/service=${ZONE}" -c user-container --tail=30 >&2 2>&1 || true
  k -n knative-serving logs deployment/activator --tail=40 >&2 2>&1 || true
  k -n "${OPERATOR_NS}" logs deployment/kn-next-operator-controller-manager --tail=40 >&2 2>&1 || true
}

cleanup() {
  local rc=$?
  if [ -f "${PF_PIDS}" ]; then
    while read -r pid; do kill "${pid}" 2>/dev/null || true; done <"${PF_PIDS}"
  fi
  if [ "${rc}" -ne 0 ]; then diagnostics; fi
  rm -rf "${WORK}"
  exit "${rc}"
}
trap cleanup EXIT

start_forwards() {
  ensure_forward
  ZONE_HOST="$(k -n "${NS}" get nextapp "${ZONE}" -o jsonpath='{.status.url}' 2>/dev/null | sed -E 's#^https?://##')"
  [ -n "${ZONE_HOST}" ] || fail "nextapp/${ZONE} has no status.url yet"
}

functions() { # the functions this run binds
  echo "${GO_FN}"
  if [ "${WITH_RUST}" = 1 ]; then echo "${RUST_FN}"; fi
}

# ---------------------------------------------------------------- phase: images

phase_images() {
  log "images: Go function, zone, Rust function"
  build_push function-go "${REPO}/templates/go"
  bun "${Z7}/zone-caller/build.ts" "${WORK}/zone-ctx"
  build_push zone-caller "${WORK}/zone-ctx"
  if [ "${WITH_RUST}" = 1 ]; then build_push function-rust "${REPO}/templates/rust"; fi
  if has_phase wake; then
    # The same zone started with knext's wake-ahead preload (zone-caller/build.ts --wake).
    bun "${Z7}/zone-caller/build.ts" "${WORK}/zone-wake-ctx" --wake
    build_push zone-caller-wake "${WORK}/zone-wake-ctx"
  fi
}

# ---------------------------------------------------------------- phase: deploy

phase_deploy() {
  log "namespace ${NS}: the zone ${ZONE} warm, its functions at minScale 0"
  if k get namespace "${NS}" >/dev/null 2>&1; then
    [ "$(k get namespace "${NS}" -o json | jq -r '.metadata.labels["e2e.kn-next.dev/z10-owned"] // ""')" = true ] \
      || fail "namespace ${NS} exists and this harness did not create it; refusing to delete it"
    k delete namespace "${NS}" --wait=true --timeout=600s
  fi
  k create namespace "${NS}"
  k label namespace "${NS}" e2e.kn-next.dev/z10-owned=true
  k label namespace "${NS}" pod-security.kubernetes.io/enforce=restricted

  local go_img zone_img rust_img backends rust_bs=''
  go_img="$(image_ref function-go)"
  zone_img="$(image_ref zone-caller)"
  backends="    - name: example
      service: ${GO_FN}"
  if [ "${WITH_RUST}" = 1 ]; then
    rust_img="$(image_ref function-rust)"
    backends="${backends}
    - name: inventory
      service: ${RUST_FN}"
    rust_bs="---
apiVersion: apps.kn-next.dev/v1alpha1
kind: BackendService
metadata:
  name: ${RUST_FN}
  namespace: ${NS}
spec:
  zone: ${ZONE}
  image: ${rust_img}
  language: rust
  port: 8080
  protoVersion: 1.0.0
  wakeAhead: false
  scaling:
    minScale: 0
    maxScale: 1"
  fi

  # The zone stays warm; the functions may scale to zero, so a call to one goes
  # through the activator. wakeAhead is set off on each function (the operator's
  # default is on): a zone that wakes its functions when it starts would hide the
  # cold path this lane is about.
  k apply --validate=strict -f - <<YAML
apiVersion: apps.kn-next.dev/v1alpha1
kind: NextApp
metadata:
  name: ${ZONE}
  namespace: ${NS}
spec:
  image: ${zone_img}
  healthCheckPath: /api/health
  scaling:
    minScale: 1
    maxScale: 1
  backends:
${backends}
---
apiVersion: apps.kn-next.dev/v1alpha1
kind: BackendService
metadata:
  name: ${GO_FN}
  namespace: ${NS}
spec:
  zone: ${ZONE}
  image: ${go_img}
  language: go
  port: 8080
  protoVersion: 1.0.0
  wakeAhead: false
  scaling:
    minScale: 0
    maxScale: 1
${rust_bs}
YAML

  local fn
  for fn in $(functions); do
    wait_until 600 3 "BackendService ${fn} Ready" \
      "k -n ${NS} wait --for=condition=Ready --timeout=2s backendservice/${fn}"
  done
  start_forwards
  wait_until 300 3 "the zone settled on a revision with its bindings" zone_settled
  ok "the zone is Ready and bound; the functions may scale to zero"
}

zone_settled() {
  local pod
  pod="$(pod_json "${ZONE}")" || return 1
  jq -e --argjson rust "${WITH_RUST}" '
    .status.phase == "Running" and ([.status.containerStatuses[]? | .ready] | all)
    and ([.spec.containers[] | select(.name == "user-container") | .env[]?.name]
         | (index("EXAMPLE_SERVICE_URL") != null and index("EXAMPLE_SERVICE_PROTO_VERSION") != null
            and (($rust == 0) or (index("INVENTORY_SERVICE_URL") != null and index("INVENTORY_SERVICE_PROTO_VERSION") != null))))' \
    <<<"${pod}" >/dev/null || return 1
  zone_call /api/health
  [ "${ZC_STATUS}" = 200 ]
}

# ---------------------------------------------------------------- cold-path helpers

# await_zero <service>: wait until the function has no pod at all, not even a
# terminating one: a pod still draining could serve a "cold" call and prove nothing.
await_zero() {
  # A plain loop, not wait_until's eval'd condition string.
  local end=$((SECONDS + ZERO_TIMEOUT))
  until [ "$(all_pods "$1")" = 0 ]; do
    [ "${SECONDS}" -lt "${end}" ] || fail "timed out after ${ZERO_TIMEOUT}s waiting for: $1 scaled to zero"
    sleep 5
  done
  ok "${1} has scaled to zero"
}

all_pods() { # <service>: every pod of a service, terminating ones included
  k -n "${NS}" get pods -l "serving.knative.dev/service=$1" -o json | jq '.items | length'
}
pod_uids() { # <service>: the uids of every pod of a service, sorted
  k -n "${NS}" get pods -l "serving.knative.dev/service=$1" -o json | jq -r '.items[].metadata.uid' | sort
}

# cold_call <service> <path?query> <want status> <jq filter> <description>:
# the service is at zero, the zone call wakes it, and the answer is the one wanted.
cold_call() {
  local fn=$1 path=$2 want=$3 filter=$4 desc=$5 started elapsed
  [ "$(all_pods "${fn}")" = 0 ] || fail "${desc}: ${fn} has a pod before the call, so the call would not be cold"
  started=${SECONDS}
  zone_call "${path}"
  elapsed=$((SECONDS - started))
  [ "${ZC_STATUS}" = "${want}" ] || fail "${desc}: status ${ZC_STATUS}, want ${want} (body: ${ZC_BODY})"
  jq -e "${filter}" <<<"${ZC_BODY}" >/dev/null || fail "${desc}: body does not satisfy ${filter} (body: ${ZC_BODY})"
  [ -n "$(pod_uids "${fn}")" ] || fail "${desc}: the call succeeded but ${fn} has no pod: it did not go through a cold start"
  ok "${desc} (cold, ${elapsed}s through the activator)"
}

# ---------------------------------------------------------------- phase: cold

phase_cold() {
  log "cold: each function scaled to zero; the zone's call wakes it"
  [ -n "${ZONE_HOST}" ] || start_forwards
  await_zero "${GO_FN}"
  cold_call "${GO_FN}" "/example/put?sub=alice&id=cold-1&value=v1" 200 '.ok == true' \
    "a Server Action through the generated glue reaches the cold Go function"
  expect_zone "a query through the generated glue reads it back from the woken pod" \
    "/example/get?sub=alice&id=cold-1" 200 '.ok == true and .value == "v1"'
  if [ "${WITH_RUST}" = 1 ]; then
    await_zero "${RUST_FN}"
    cold_call "${RUST_FN}" "/inventory/put?sub=alice&id=cold-1&value=v1" 200 '.ok == true' \
      "a call with a zone token reaches the cold Rust function"
    expect_zone "a read reaches the woken Rust pod" \
      "/inventory/get?sub=alice&id=cold-1" 200 '.ok == true and .value == "v1"'
  fi
}

# ---------------------------------------------------------------- phase: trailers

phase_trailers() {
  log "trailers: a failed call's code survives the cold activator path"
  [ -n "${ZONE_HOST}" ] || start_forwards
  # The Connect protocol (h2c on a Node zone) carries a unary error as the HTTP
  # status and a JSON error body, not as gRPC trailers; the zone's glue turns it
  # back into a ConnectError. NotFound is what the function raises for a missing
  # item, so a code lost or rewritten on the way (502, Unavailable, Unknown) reds.
  await_zero "${GO_FN}"
  cold_call "${GO_FN}" "/example/get?sub=alice&id=missing" 404 '.ok == false and .code == "NotFound"' \
    "a missing item read through the generated glue comes back NotFound from the cold Go function"
  expect_zone "warm control: the same read on the warm pod comes back NotFound" \
    "/example/get?sub=alice&id=missing" 404 '.ok == false and .code == "NotFound"'
  if [ "${WITH_RUST}" = 1 ]; then
    await_zero "${RUST_FN}"
    cold_call "${RUST_FN}" "/inventory/get?sub=alice&id=missing" 404 '.ok == false and .code == "not_found"' \
      "a missing item read comes back not_found from the cold Rust function"
    expect_zone "warm control: the same read on the warm Rust pod comes back not_found" \
      "/inventory/get?sub=alice&id=missing" 404 '.ok == false and .code == "not_found"'
  fi
}

# ---------------------------------------------------------------- phase: grpctrailers

# grpc_probe <description> <rpc> <query> <want code> <want grpc-status> <want source>: one call over the
# gRPC protocol (HTTP/2), made by the zone through createGrpcTransport. The zone reports the
# code its client derived AND the raw grpc-status the wire carried. Fails closed: a call with
# no grpc-status, a status that disagrees with the code, or the wrong code, fails the phase.
# <want source> is where the grpc-status must have come from: 'trailer' (the HTTP/2 trailers)
# or 'any' (trailer or header; a trailers-only error carries it in the headers). A success
# must be 'trailer': status 0 after a message is the case a proxy could apply twice. The
# source is always reported. Sets GP_CODE, GP_STATUS and GP_SOURCE.
grpc_probe() {
  local desc=$1 rpc=$2 query=$3 want_code=$4 want_status=$5 want_source=$6
  zone_call "/example/grpc?rpc=${rpc}&sub=alice&${query}"
  [ "${ZC_STATUS}" = 200 ] || fail "${desc}: the zone answered ${ZC_STATUS}, want 200 (body: ${ZC_BODY})"
  jq -e '.protocol == "grpc"' <<<"${ZC_BODY}" >/dev/null || fail "${desc}: the call was not made over the gRPC protocol (body: ${ZC_BODY})"
  GP_CODE="$(jq -r '.code' <<<"${ZC_BODY}")"
  GP_STATUS="$(jq -r '.grpcStatus // "none"' <<<"${ZC_BODY}")"
  GP_SOURCE="$(jq -r '.source // "none"' <<<"${ZC_BODY}")"
  [ "${GP_STATUS}" != none ] \
    || fail "${desc}: no grpc-status trailer reached the client (it reported code ${GP_CODE}); the trailer was lost on the way"
  case "${want_source}" in
    trailer) [ "${GP_SOURCE}" = trailer ] || fail "${desc}: grpc-status ${GP_STATUS} came from the ${GP_SOURCE}, want the HTTP/2 trailer" ;;
    any) case "${GP_SOURCE}" in trailer | header) ;; *) fail "${desc}: the grpc-status source is '${GP_SOURCE}', want trailer or header" ;; esac ;;
    *) fail "${desc}: unknown want source '${want_source}'" ;;
  esac
  [ "${GP_STATUS}" = "${want_status}" ] || fail "${desc}: grpc-status ${GP_STATUS}, want ${want_status} (code ${GP_CODE})"
  [ "${GP_CODE}" = "${want_code}" ] \
    || fail "${desc}: the client's code is ${GP_CODE}, want ${want_code}: it does not match the grpc-status ${GP_STATUS} the wire carried"
}

# grpc_cold <description> <rpc> <query> <want code> <want grpc-status>: grpc_probe against
# a function with no pod at all, which must have a pod afterwards (the call woke it).
grpc_cold() {
  local fn=$GO_FN desc=$1 started elapsed
  [ "$(all_pods "${fn}")" = 0 ] || fail "${desc}: ${fn} has a pod before the call, so the call would not be cold"
  started=${SECONDS}
  grpc_probe "$@"
  elapsed=$((SECONDS - started))
  [ -n "$(pod_uids "${fn}")" ] || fail "${desc}: the call was answered but ${fn} has no pod: it did not go through a cold start"
  ok "${desc} (cold, grpc-status ${GP_STATUS} from the ${GP_SOURCE}, code ${GP_CODE}, ${elapsed}s through the activator)"
}

phase_grpctrailers() {
  log "grpctrailers: the gRPC status trailer survives the cold activator path (HTTP/2, not Connect)"
  [ -n "${ZONE_HOST}" ] || start_forwards
  # A success first: the call wakes the function, and its trailer carries grpc-status 0.
  await_zero "${GO_FN}"
  grpc_cold "a gRPC write to the cold Go function succeeds with grpc-status 0" \
    PutItem "id=grpc-1&value=v1" OK 0 trailer
  # Then the error: NotFound is what the function raises for a missing item, and over gRPC
  # it travels ONLY as the grpc-status trailer (5), not as an HTTP status or a JSON body.
  await_zero "${GO_FN}"
  grpc_cold "a gRPC read of a missing item through the cold activator comes back NotFound from the grpc-status trailer" \
    GetItem "id=missing" NotFound 5 any
  local cold_code=$GP_CODE cold_status=$GP_STATUS
  grpc_probe "warm control: the same gRPC read on the warm pod" GetItem "id=missing" NotFound 5 any
  [ "${GP_CODE}" = "${cold_code}" ] && [ "${GP_STATUS}" = "${cold_status}" ] \
    || fail "the cold call came back ${cold_code} (grpc-status ${cold_status}) but the warm control ${GP_CODE} (grpc-status ${GP_STATUS})"
  ok "the cold and the warm call agree: ${GP_CODE} from grpc-status ${GP_STATUS}"
  grpc_probe "a warm gRPC write carries grpc-status 0" PutItem "id=grpc-2&value=v2" OK 0 trailer
  ok "the status trailer survives the activator on the gRPC protocol (success 0, NotFound 5)"
}

# ---------------------------------------------------------------- phase: zerozone

# zone_min_is <n>: the zone's Knative Service is Ready on a revision rendered
# with min-scale <n>, and has caught up with its spec.
zone_min_is() {
  k -n "${NS}" get ksvc "${ZONE}" -o json | jq -e --arg n "$1" '
    (.spec.template.metadata.annotations["autoscaling.knative.dev/min-scale"] // "") == $n
    and .status.observedGeneration == .metadata.generation
    and .status.latestReadyRevisionName == .status.latestCreatedRevisionName' >/dev/null
}

# set_zone_min <n>: set the zone's spec.scaling.minScale and wait for the revision.
set_zone_min() {
  k -n "${NS}" patch nextapp "${ZONE}" --type merge -p "{\"spec\":{\"scaling\":{\"minScale\":$1}}}" >/dev/null
  wait_until 300 3 "the zone runs a revision with min-scale $1" "zone_min_is $1"
}

phase_zerozone() {
  log "zerozone: the zone and its function both at zero; one call wakes both, the function over h2c"
  [ -n "${ZONE_HOST}" ] || start_forwards
  # h2c is what the operator renders, read from the objects rather than assumed:
  # the function's Knative port is named h2c (so the activator and queue-proxy
  # speak HTTP/2 cleartext to it), and the URL injected into the zone is plain
  # http to the function's cluster-local name.
  local port url
  port="$(k -n "${NS}" get ksvc "${GO_FN}" -o json | jq -r '[.spec.template.spec.containers[].ports[]?.name] | join(",")')"
  [ "${port}" = h2c ] || fail "${GO_FN}: its Knative Service port is '${port}', want h2c"
  url="$(k -n "${NS}" get ksvc "${ZONE}" -o json \
    | jq -r '[.spec.template.spec.containers[] | select(.name == "user-container") | .env[]? | select(.name == "EXAMPLE_SERVICE_URL") | .value] | first // ""')"
  [ "${url}" = "http://${GO_FN}.${NS}.svc.cluster.local" ] \
    || fail "the zone's EXAMPLE_SERVICE_URL is '${url}', want http://${GO_FN}.${NS}.svc.cluster.local"
  # An explicit <NAME>_SERVICE_HTTP_VERSION wins over the Node default (h2c), so
  # 1.1 here would make the zone's leg HTTP/1.1.
  local hv
  hv="$(k -n "${NS}" get ksvc "${ZONE}" -o json \
    | jq -r '[.spec.template.spec.containers[] | select(.name == "user-container") | .env[]? | select(.name == "EXAMPLE_SERVICE_HTTP_VERSION") | .value] | first // "unset"')"
  case "${hv}" in unset | 2) ;; *) fail "the zone's EXAMPLE_SERVICE_HTTP_VERSION is '${hv}', want unset or 2" ;; esac
  ok "${GO_FN} is served on an h2c port, and the zone dials it at ${url} (HTTP version ${hv})"

  set_zone_min 0
  await_zero "${ZONE}"
  await_zero "${GO_FN}"
  # Both still at zero right before the call: await_zero on the function can
  # take minutes after the zone got there.
  [ "$(all_pods "${ZONE}")" = 0 ] || fail "the zone has a pod again before the call"
  [ "$(all_pods "${GO_FN}")" = 0 ] || fail "${GO_FN} has a pod again before the call"
  # ONE request, not zone_call: zone_call retries a timed-out request (000) as a
  # dropped port-forward, and a retry would be answered by pods the first woke.
  local started elapsed out
  ensure_forward
  started=${SECONDS}
  out="$(curl -s -m 120 -H "Host: ${ZONE_HOST}" -w '\n%{http_code}' \
    "http://127.0.0.1:${INTERNAL_PORT}/example/put?sub=alice&id=zero-1&value=v1" 2>/dev/null)" || out=$'\n000'
  elapsed=$((SECONDS - started))
  ZC_STATUS="${out##*$'\n'}"
  ZC_BODY="${out%$'\n'*}"
  [ "${ZC_STATUS}" = 200 ] || fail "zone and function at zero: status ${ZC_STATUS}, want 200 (body: ${ZC_BODY})"
  jq -e '.ok == true' <<<"${ZC_BODY}" >/dev/null || fail "zone and function at zero: body ${ZC_BODY}"
  [ -n "$(pod_uids "${ZONE}")" ] || fail "the call succeeded but the zone has no pod: it did not wake from zero"
  [ -n "$(pod_uids "${GO_FN}")" ] || fail "the call succeeded but ${GO_FN} has no pod: it did not wake from zero"
  ok "zone and function both at zero: one call woke both and was answered (${elapsed}s)"
  # The woken zone says which transport it chose for the function (once per
  # binding, on its first call): h2c, not an HTTP/1.1 fallback.
  local zlog
  zlog="$(k -n "${NS}" logs -l "serving.knative.dev/service=${ZONE}" -c user-container --tail=-1)"
  grep -qF 'knext: example function: transport h2c (HTTP/2 cleartext)' <<<"${zlog}" \
    || fail "the woken zone did not log an h2c transport for the example function"
  ! grep -qF 'knext: example function: transport HTTP/1.1' <<<"${zlog}" \
    || fail "the woken zone logged an HTTP/1.1 transport for the example function"
  ok "the woken zone called ${GO_FN} over h2c (its transport notice)"
  expect_zone "a read through the woken zone comes back from the woken function" \
    "/example/get?sub=alice&id=zero-1" 200 '.ok == true and .value == "v1"'

  set_zone_min 1
  wait_until 300 3 "the zone settled warm again" zone_settled
}

# ---------------------------------------------------------------- phase: rollout

# set_served <version>: stamp the Go function with <version> and wait until the
# zone runs a revision that sees it. The zone was generated against contract
# 1.0.0; the served version reaches it only through its env.
set_served() {
  local v=$1 before after rolled want=1
  # A bump to the version already served changes nothing (a rerun after an
  # aborted phase), so it must roll nothing.
  [ "$(k -n "${NS}" get backendservice "${GO_FN}" -o jsonpath='{.status.servedProtoVersion}')" = "${v}" ] && want=0
  before="$(zone_revisions)"
  k -n "${NS}" patch backendservice "${GO_FN}" --type merge -p "{\"spec\":{\"protoVersion\":\"${v}\"}}" >/dev/null
  wait_until 600 3 "${GO_FN} serves ${v}" \
    "[ \"\$(k -n ${NS} get backendservice ${GO_FN} -o jsonpath='{.status.servedProtoVersion}')\" = ${v} ]"
  wait_until 600 3 "the zone runs with EXAMPLE_SERVICE_PROTO_VERSION=${v}" "zone_sees_version ${v}"
  # Hold: a second re-render that lands after the first would show up here.
  sleep 20
  after="$(zone_revisions)"
  rolled="$(comm -13 <(printf '%s\n' "${before}") <(printf '%s\n' "${after}") | grep -c . || true)"
  [ "${rolled}" = "${want}" ] \
    || fail "${GO_FN} ${v}: the bump rolled ${rolled} zone revision(s), want exactly ${want}"
  ok "${GO_FN} serves ${v}, the zone's pod sees it, and the bump rolled exactly ${want} zone revision(s)"
}

zone_revisions() { # the zone's revision names, sorted
  k -n "${NS}" get revisions -l "serving.knative.dev/service=${ZONE}" -o json | jq -r '.items[].metadata.name' | sort
}

zone_sees_version() { # <version>: the zone's single ready pod carries the served version
  local pod
  pod="$(pod_json "${ZONE}")" || return 1
  jq -e --arg v "$1" '
    .status.phase == "Running" and ([.status.containerStatuses[]? | .ready] | all)
    and ([.spec.containers[] | select(.name == "user-container") | .env[]?
          | select(.name == "EXAMPLE_SERVICE_PROTO_VERSION") | .value] == [$v])' <<<"${pod}" >/dev/null || return 1
  zone_call /api/health
  [ "${ZC_STATUS}" = 200 ]
}

phase_rollout() {
  log "rollout: an old zone may call a newer function; a newer zone may not call an older one"
  [ -n "${ZONE_HOST}" ] || start_forwards
  # The rule (function-first rollout): the zone's glue refuses a function whose
  # served contract is OLDER than the one the zone was generated against
  # (1.0.0 here), and calls one that is the same or newer.
  set_served 1.1.0
  expect_zone "an old zone (1.0.0) calls a newer function (1.1.0): accepted" \
    "/example/put?sub=alice&id=roll-1&value=v" 200 '.ok == true'
  set_served 0.9.0
  expect_zone "a zone (1.0.0) newer than its function (0.9.0): refused before the call" \
    "/example/get?sub=alice&id=roll-1" 502 '.ok == false and .code == "FailedPrecondition"'
  set_served 1.0.0
  expect_zone "back on the same contract (1.0.0): accepted again" \
    "/example/put?sub=alice&id=roll-2&value=v" 200 '.ok == true'
}

# ---------------------------------------------------------------- phase: sovereignty

SOV_ZONE=ledger
OTHER_ZONE=payroll

sov_condition() { # <function>: "<status>/<reason>" of SovereigntyCompliant
  k -n "${NS}" get backendservice "$1" -o json \
    | jq -r '.status.conditions[]? | select(.type == "SovereigntyCompliant") | "\(.status)/\(.reason)"'
}

phase_sovereignty() {
  log "sovereignty: a function may not take another zone's Secret, through any source"
  local go_img zone_img
  go_img="$(image_ref function-go)"
  zone_img="$(image_ref zone-caller)"
  # Two Secrets, marked for two zones. Neither holds a credential: the lane
  # proves the operator's refusal, it does not need a database.
  k -n "${NS}" apply --validate=strict -f - <<YAML >/dev/null
apiVersion: v1
kind: Secret
metadata:
  name: ${OTHER_ZONE}-creds
  namespace: ${NS}
  labels:
    apps.kn-next.dev/zone: ${OTHER_ZONE}
stringData:
  token: not-a-real-credential
---
apiVersion: v1
kind: Secret
metadata:
  name: ${SOV_ZONE}-creds
  namespace: ${NS}
  labels:
    apps.kn-next.dev/zone: ${SOV_ZONE}
stringData:
  token: not-a-real-credential
YAML

  # The zone lists every function, so a refused one is refused BY THE ALLOWLIST:
  # an unlisted function would not be rendered anyway, and its absence would
  # prove nothing.
  local fn fns="sov-env sov-envfrom sov-volume sov-own" docs=""
  for fn in ${fns}; do
    local secret="${OTHER_ZONE}-creds" extra
    [ "${fn}" = sov-own ] && secret="${SOV_ZONE}-creds"
    case "${fn}" in
      sov-env) extra="  env:
    - name: TOKEN
      valueFrom:
        secretKeyRef:
          name: ${secret}
          key: token" ;;
      sov-envfrom) extra="  envFrom:
    - secretRef:
        name: ${secret}" ;;
      sov-volume) extra="  volumes:
    - name: creds
      mountPath: /var/run/creds
      secret:
        secretName: ${secret}" ;;
      # The control takes its own zone's Secret through all three sources.
      sov-own) extra="  env:
    - name: TOKEN
      valueFrom:
        secretKeyRef:
          name: ${secret}
          key: token
  envFrom:
    - secretRef:
        name: ${secret}
  volumes:
    - name: creds
      mountPath: /var/run/creds
      secret:
        secretName: ${secret}" ;;
    esac
    docs="${docs}---
apiVersion: apps.kn-next.dev/v1alpha1
kind: BackendService
metadata:
  name: ${fn}
  namespace: ${NS}
spec:
  zone: ${SOV_ZONE}
  image: ${go_img}
  language: go
  port: 8080
  protoVersion: 1.0.0
  wakeAhead: false
  scaling:
    minScale: 0
    maxScale: 1
${extra}
"
  done
  k apply --validate=strict -f - <<YAML
apiVersion: apps.kn-next.dev/v1alpha1
kind: NextApp
metadata:
  name: ${SOV_ZONE}
  namespace: ${NS}
spec:
  image: ${zone_img}
  healthCheckPath: /api/health
  scaling:
    minScale: 0
    maxScale: 1
  backends:
    - name: env
      service: sov-env
    - name: envfrom
      service: sov-envfrom
    - name: volume
      service: sov-volume
    - name: own
      service: sov-own
${docs}
YAML

  wait_until 300 3 "the control function sov-own is Ready" \
    "k -n ${NS} wait --for=condition=Ready --timeout=2s backendservice/sov-own"
  [ "$(sov_condition sov-own)" = True/Compliant ] || fail "sov-own: SovereigntyCompliant is $(sov_condition sov-own), want True/Compliant"
  k -n "${NS}" get ksvc sov-own >/dev/null 2>&1 || fail "sov-own: its own zone's Secret was accepted but no Knative Service was rendered"
  ok "control: a function taking its own zone's Secret (env, envFrom, volume) is compliant and rendered"

  for fn in sov-env sov-envfrom sov-volume; do
    wait_until 120 3 "${fn} refused by the allowlist" "[ \"\$(sov_condition ${fn})\" = False/SecretNotAllowed ]"
  done
  # Hold for a while: a refusal that flaps to rendering is not one.
  sleep 20
  for fn in sov-env sov-envfrom sov-volume; do
    [ "$(sov_condition "${fn}")" = False/SecretNotAllowed ] || fail "${fn}: SovereigntyCompliant is $(sov_condition "${fn}") after the hold"
    # --ignore-not-found: an API error must fail the lane, not read as "absent".
    [ -z "$(k -n "${NS}" get ksvc "${fn}" --ignore-not-found -o name)" ] || fail "${fn}: refused, but its Knative Service exists"
    [ "$(all_pods "${fn}")" = 0 ] || fail "${fn}: refused, but it has a pod"
    ok "${fn}: another zone's Secret is refused (SecretNotAllowed), no Knative Service and no pod"
  done
}

# ---------------------------------------------------------------- phase: crosszone

XZ_OWNER=xz-owner
XZ_LISTING=xz-listing
XZ_FN=xz-fn

cond_of() { # <kind> <name> <type>: "<status>/<reason>" of that condition
  k -n "${NS}" get "$1" "$2" -o json | jq -r --arg t "$3" '.status.conditions[]? | select(.type == $t) | "\(.status)/\(.reason)"'
}

phase_crosszone() {
  log "crosszone: a zone lists a function that names another zone; neither side binds it"
  local go_img zone_img
  go_img="$(image_ref function-go)"
  zone_img="$(image_ref zone-caller)"
  # The function's own zone exists and does not list it; the listing zone is
  # another zone. So the refusal is the zone rule, not a missing zone.
  k apply --validate=strict -f - <<YAML
apiVersion: apps.kn-next.dev/v1alpha1
kind: NextApp
metadata:
  name: ${XZ_OWNER}
  namespace: ${NS}
spec:
  image: ${zone_img}
  healthCheckPath: /api/health
  scaling:
    minScale: 0
    maxScale: 1
---
apiVersion: apps.kn-next.dev/v1alpha1
kind: NextApp
metadata:
  name: ${XZ_LISTING}
  namespace: ${NS}
spec:
  image: ${zone_img}
  healthCheckPath: /api/health
  scaling:
    minScale: 0
    maxScale: 1
  backends:
    - name: xz
      service: ${XZ_FN}
---
apiVersion: apps.kn-next.dev/v1alpha1
kind: BackendService
metadata:
  name: ${XZ_FN}
  namespace: ${NS}
spec:
  zone: ${XZ_OWNER}
  image: ${go_img}
  language: go
  port: 8080
  protoVersion: 1.0.0
  wakeAhead: false
  scaling:
    minScale: 0
    maxScale: 1
YAML

  wait_until 120 3 "${XZ_LISTING} reports the cross-zone entry" \
    "[ \"\$(cond_of nextapp ${XZ_LISTING} BackendBindings)\" = False/CrossZoneBinding ]"
  wait_until 120 3 "${XZ_FN} reports it is not listed by its zone" \
    "[ \"\$(cond_of backendservice ${XZ_FN} Bound)\" = False/ZoneNotListed ]"
  wait_until 300 3 "${XZ_LISTING} has a Knative Service" \
    "[ -n \"\$(k -n ${NS} get ksvc ${XZ_LISTING} --ignore-not-found -o name)\" ]"
  # Hold for a while: a refusal that flaps to rendering is not one.
  sleep 20
  [ "$(cond_of nextapp "${XZ_LISTING}" BackendBindings)" = False/CrossZoneBinding ] \
    || fail "${XZ_LISTING}: BackendBindings is $(cond_of nextapp "${XZ_LISTING}" BackendBindings) after the hold"
  [ "$(cond_of backendservice "${XZ_FN}" Bound)" = False/ZoneNotListed ] \
    || fail "${XZ_FN}: Bound is $(cond_of backendservice "${XZ_FN}" Bound) after the hold"
  [ "$(cond_of backendservice "${XZ_FN}" Ready)" = False/ZoneNotListed ] \
    || fail "${XZ_FN}: Ready is $(cond_of backendservice "${XZ_FN}" Ready), want False/ZoneNotListed"
  # --ignore-not-found: an API error must fail the lane, not read as "absent".
  [ -z "$(k -n "${NS}" get ksvc "${XZ_FN}" --ignore-not-found -o name)" ] \
    || fail "${XZ_FN}: refused, but its Knative Service exists"
  [ "$(all_pods "${XZ_FN}")" = 0 ] || fail "${XZ_FN}: refused, but it has a pod"
  # The env check selects the user-container: it must exist, or the check is vacuous.
  [ "$(k -n "${NS}" get ksvc "${XZ_LISTING}" -o json | jq '[.spec.template.spec.containers[] | select(.name == "user-container")] | length')" = 1 ] \
    || fail "${XZ_LISTING}: no single user-container in its Knative Service"
  [ -z "$(k -n "${NS}" get ksvc "${XZ_LISTING}" -o json \
    | jq -r '.spec.template.spec.containers[] | select(.name == "user-container") | .env[]? | select(.name | startswith("XZ_SERVICE_")) | .name')" ] \
    || fail "${XZ_LISTING}: the cross-zone entry was rendered into the zone's env"
  ok "cross-zone: the listing zone is CrossZoneBinding with no URL rendered; the function is ZoneNotListed, not Ready, with no Knative Service and no pod"
}

# ---------------------------------------------------------------- phase: wake

now_ms() { python3 -c 'import time; print(int(time.time() * 1000))'; }

fn_wake_ahead() { # <service>: the BackendService's spec.wakeAhead ("true" when unset; not `//`, which maps false to the default)
  k -n "${NS}" get backendservice "$1" -o json | jq -r 'if .spec.wakeAhead == null then true else .spec.wakeAhead end'
}

# zone_runs <roll tag> <want KNEXT_WAKE_FUNCTIONS, "" for none>: the zone's single
# live pod is Ready, carries the roll tag, and the wake list the operator rendered.
zone_runs() {
  local pod
  pod="$(pod_json "${ZONE}")" || return 1
  jq -e --arg r "$1" --arg w "$2" '
    .status.phase == "Running" and ([.status.containerStatuses[]? | .ready] | all)
    and ([.spec.containers[] | select(.name == "user-container") | .env[]?] as $e
         | ([$e[] | select(.name == "Z10_ROLL") | .value] == [$r])
           and (([$e[] | select(.name == "KNEXT_WAKE_FUNCTIONS") | .value] | first // "") == $w))' \
    <<<"${pod}" >/dev/null || return 1
  zone_call /api/health
  [ "${ZC_STATUS}" = 200 ]
}

# zone_roll <image> <roll tag> <want wake list>: start a new zone process (a new
# revision) on <image>; /api/health calls no function, so nothing but the zone's
# own start can wake one.
zone_roll() {
  k -n "${NS}" patch nextapp "${ZONE}" --type merge \
    -p "{\"spec\":{\"image\":\"$1\",\"env\":{\"Z10_ROLL\":\"$2\"}}}" >/dev/null
  wait_until 300 3 "the zone runs revision ${2}" "zone_runs ${2} '${3}'"
}

# timed_call <path>: the zone call's wall time in ms, in TIMED_MS.
timed_call() {
  local t0
  t0="$(now_ms)"
  zone_call "$1"
  TIMED_MS=$(($(now_ms) - t0))
}

phase_wake() {
  log "wake: a starting zone wakes its bound functions; an opted-out one stays at zero"
  [ -n "${ZONE_HOST}" ] || start_forwards
  local wimg off_ms on_ms end
  wimg="$(image_ref zone-caller-wake)"

  # Opted out (set here too, so a rerun after an aborted phase starts clean): the
  # zone starts, nothing wakes.
  k -n "${NS}" patch backendservice "${GO_FN}" --type merge -p '{"spec":{"wakeAhead":false}}' >/dev/null
  [ "$(fn_wake_ahead "${GO_FN}")" = false ] || fail "${GO_FN} did not take wakeAhead: false"
  await_zero "${GO_FN}"
  zone_roll "${wimg}" wake-off ""
  end=$((SECONDS + 30))
  while [ "${SECONDS}" -lt "${end}" ]; do
    [ "$(all_pods "${GO_FN}")" = 0 ] || fail "${GO_FN} is opted out of wake-ahead, but a pod started with the zone"
    sleep 3
  done
  ok "opted out: the zone started and ${GO_FN} stayed at zero for 30 s"
  timed_call "/example/get?sub=alice&id=missing"
  [ "${ZC_STATUS}" = 404 ] || fail "opted out: the first call returned ${ZC_STATUS}, want 404 (body: ${ZC_BODY})"
  off_ms=${TIMED_MS}
  ok "opted out: the zone's first call paid the cold start (${off_ms} ms)"

  # Opted in, with the function at zero first: the operator renders
  # KNEXT_WAKE_FUNCTIONS=example into the zone, which starts a new zone process,
  # and that start must wake the function before any call.
  await_zero "${GO_FN}"
  k -n "${NS}" patch backendservice "${GO_FN}" --type merge -p '{"spec":{"wakeAhead":true}}' >/dev/null
  wait_until 300 3 "a new zone process with KNEXT_WAKE_FUNCTIONS=example" "zone_runs wake-off example"
  wait_until 60 2 "${GO_FN} has a pod, woken by the zone's start (no call made)" \
    '[ "$(all_pods "${GO_FN}")" -ge 1 ]'
  ok "opted in: the zone's start woke ${GO_FN} before any call"
  timed_call "/example/get?sub=alice&id=missing"
  [ "${ZC_STATUS}" = 404 ] || fail "opted in: the first call returned ${ZC_STATUS}, want 404 (body: ${ZC_BODY})"
  on_ms=${TIMED_MS}
  [ "${on_ms}" -lt "${off_ms}" ] \
    || fail "wake-ahead did not shorten the zone's first call: ${on_ms} ms on, ${off_ms} ms off"
  ok "opted in: the zone's first call took ${on_ms} ms, against ${off_ms} ms opted out"

  k -n "${NS}" patch backendservice "${GO_FN}" --type merge -p '{"spec":{"wakeAhead":false}}' >/dev/null
}

# ---------------------------------------------------------------- main

use_cluster
k get crd backendservices.apps.kn-next.dev >/dev/null 2>&1 \
  || fail "the cluster has no BackendService CRD: run the Z7 lane's up phase first (PHASES=up ${Z7}/run.sh)"
for phase in ${PHASES}; do
  case "${phase}" in
    images | deploy | cold | trailers | grpctrailers | zerozone | rollout | sovereignty | crosszone | wake) ;;
    *) fail "unknown phase '${phase}' (images deploy cold trailers grpctrailers zerozone rollout sovereignty crosszone wake)" ;;
  esac
done
has_phase images && phase_images
has_phase deploy && phase_deploy
has_phase cold && phase_cold
has_phase trailers && phase_trailers
has_phase grpctrailers && phase_grpctrailers
has_phase zerozone && phase_zerozone
has_phase rollout && phase_rollout
has_phase sovereignty && phase_sovereignty
has_phase crosszone && phase_crosszone
has_phase wake && phase_wake
log "Z10 lane: ${PHASES} passed"
