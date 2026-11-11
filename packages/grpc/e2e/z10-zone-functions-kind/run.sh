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
#   rollout   the Go function's served version moves: a newer one (1.1.0) is called by
#             the 1.0.0 zone, an older one (0.9.0) is refused by the zone's glue
#             (FailedPrecondition) before any call, the same one (1.0.0) is called again
#   sovereignty  a second zone lists four functions; three take another zone's Secret
#             (env, envFrom, volume) and are refused (SecretNotAllowed, no Knative Service, no pod),
#             the control takes its own zone's Secret through all three and is rendered
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
PHASES="${PHASES:-images deploy cold trailers rollout sovereignty}"
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

# ---------------------------------------------------------------- phase: rollout

# set_served <version>: stamp the Go function with <version> and wait until the
# zone runs a revision that sees it. The zone was generated against contract
# 1.0.0; the served version reaches it only through its env.
set_served() {
  local v=$1
  k -n "${NS}" patch backendservice "${GO_FN}" --type merge -p "{\"spec\":{\"protoVersion\":\"${v}\"}}" >/dev/null
  wait_until 600 3 "${GO_FN} serves ${v}" \
    "[ \"\$(k -n ${NS} get backendservice ${GO_FN} -o jsonpath='{.status.servedProtoVersion}')\" = ${v} ]"
  wait_until 600 3 "the zone runs with EXAMPLE_SERVICE_PROTO_VERSION=${v}" "zone_sees_version ${v}"
  ok "${GO_FN} serves ${v}, and the zone's pod sees it"
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

# ---------------------------------------------------------------- main

use_cluster
k get crd backendservices.apps.kn-next.dev >/dev/null 2>&1 \
  || fail "the cluster has no BackendService CRD: run the Z7 lane's up phase first (PHASES=up ${Z7}/run.sh)"
for phase in ${PHASES}; do
  case "${phase}" in
    images | deploy | cold | trailers | rollout | sovereignty) ;;
    *) fail "unknown phase '${phase}' (images deploy cold trailers rollout sovereignty)" ;;
  esac
done
# `if`, not `has_phase x && phase_x`: a function called from an && list runs
# with errexit suspended, so a failing command inside a phase would not stop it.
if has_phase images; then phase_images; fi
if has_phase deploy; then phase_deploy; fi
if has_phase cold; then phase_cold; fi
if has_phase trailers; then phase_trailers; fi
if has_phase rollout; then phase_rollout; fi
if has_phase sovereignty; then phase_sovereignty; fi
log "Z10 lane: ${PHASES} passed"
