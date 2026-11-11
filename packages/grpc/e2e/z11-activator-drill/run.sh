#!/usr/bin/env bash
# Z11: the activator-path drill for zone functions, on kind with Calico.
#
# A function at zero is reached through Knative's activator, so its NetworkPolicy's
# peer is the activator, not the zone, and the policy cannot tell the zone from any
# other caller. This drill proves what holds on that path:
#
#   token     a pod in ANOTHER namespace calls the cold function through its
#             cluster-local URL (so through the activator) with no token, then with
#             a garbage token: both are refused by the function (401 unauthenticated),
#             and the call did wake the function. Control: the zone's own call
#             through its generated glue reaches the function (NotFound for a
#             missing item, not 401).
#   direct    the same foreign pod dials the WARM function pod directly (its user
#             port and queue-proxy's port): Calico drops both. Mutation: with the
#             function's NetworkPolicy switched off (spec.security.networkPolicy:
#             false), the direct dial to the user port connects, so the refusal is
#             the policy's doing.
#   noauth    mutation: the function rebuilt WITHOUT its token interceptor answers
#             the foreign no-token call (not_found, not 401). The token, not the
#             network, is the control on the activator path.
#
# Phases (PHASES, space-separated; default all): up deploy token direct noauth.
#   up        a kind cluster with the default CNI disabled and Calico installed,
#             then the Z7 lane's up phase on it (registry, cert-manager, Knative,
#             the operator from this checkout)
#   deploy    the Z10 lane's images and deploy phases (the zone warm, the Go function
#             at minScale 0, wake-ahead off), the no-interceptor image, and a caller
#             pod in a second namespace
#
# Environment: KIND_CLUSTER (knext-z11-drill), REGISTRY_NAME (knext-z11-registry),
# REGISTRY_PORT (5002), Z11_NAMESPACE (z11-e2e), PHASES, INTERNAL_PORT (18100).
#
# The script never deletes a cluster. It deletes the caller namespace only when it
# carries this drill's label, and the zone namespace only through the Z10 lane's
# deploy phase, which checks that namespace's own label.

set -euo pipefail
# Never trace: the lane must not print what it reads.
set +x
umask 077

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG="$(cd "${HERE}/../.." && pwd)"
REPO="$(cd "${PKG}/../.." && pwd)"
Z7="${PKG}/e2e/z7-identity-kind"
Z10="${PKG}/e2e/z10-zone-functions-kind"

CLUSTER="${KIND_CLUSTER:-knext-z11-drill}"
REG_NAME="${REGISTRY_NAME:-knext-z11-registry}"
REG_PORT="${REGISTRY_PORT:-5002}"
NS="${Z11_NAMESPACE:-z11-e2e}"
FOREIGN="${NS}-foreign"
PHASES="${PHASES:-up deploy token direct noauth}"
INTERNAL_PORT="${INTERNAL_PORT:-18100}"
CURL_IMAGE='curlimages/curl:8.11.1@sha256:c1fe1679c34d9784c1b0d1e5f62ac0a79fca01fb6377cdd33e90473c6f9f9a69'

ZONE=storefront
GO_FN=example-go
FN_URL="http://${GO_FN}.${NS}.svc.cluster.local"
GET_ITEM="/example.v1.ExampleService/GetItem"
ZONE_HOST=""

WORK="$(mktemp -d "${TMPDIR:-/tmp}/knext-z11-drill.XXXXXX")"
STATE="${TMPDIR:-/tmp}/knext-z11-drill-state-${CLUSTER}"
mkdir -p "${STATE}"
export KUBECONFIG="${WORK}/kubeconfig"
PF_PIDS="${WORK}/pf.pids"
IMAGE_PREFIX=z11
# shellcheck source=../lib/kind-lane.sh
source "${HERE}/../lib/kind-lane.sh"

diagnostics() {
  echo "---- diagnostics (no Secret is read) ----" >&2
  k -n "${NS}" get nextapp,backendservice,ksvc,networkpolicy,pods -o wide 2>&1 | tail -40 >&2 || true
  k -n "${FOREIGN}" get pods -o wide 2>&1 | tail -5 >&2 || true
  k -n kube-system get pods -l k8s-app=calico-node 2>&1 | tail -5 >&2 || true
}

# Set while a mutation has the function in an unsafe state, so the EXIT trap puts it
# back even when the drill aborts in between: a kept cluster must never stay with
# the policy off or on the image without its token check.
RESTORE_POLICY=0
RESTORE_IMAGE=""

cleanup() {
  local rc=$?
  if [ "${RESTORE_POLICY}" = 1 ]; then
    k -n "${NS}" patch backendservice "${GO_FN}" --type merge -p '{"spec":{"security":{"networkPolicy":true}}}' >/dev/null 2>&1 \
      || echo "WARNING: could not turn ${GO_FN}'s NetworkPolicy back on" >&2
  fi
  if [ -n "${RESTORE_IMAGE}" ]; then
    k -n "${NS}" patch backendservice "${GO_FN}" --type merge -p "{\"spec\":{\"image\":\"${RESTORE_IMAGE}\"}}" >/dev/null 2>&1 \
      || echo "WARNING: could not put ${GO_FN} back on ${RESTORE_IMAGE}" >&2
  fi
  if [ -f "${PF_PIDS}" ]; then
    while read -r pid; do kill "${pid}" 2>/dev/null || true; done <"${PF_PIDS}"
  fi
  if [ "${rc}" -ne 0 ]; then diagnostics; fi
  rm -rf "${WORK}"
  exit "${rc}"
}
trap cleanup EXIT

lane_env() { # the environment the Z7 and Z10 lanes need to run against this cluster
  KIND_CLUSTER="${CLUSTER}" REGISTRY_NAME="${REG_NAME}" REGISTRY_PORT="${REG_PORT}" \
    Z10_NAMESPACE="${NS}" Z10_WITH_RUST=0 INTERNAL_PORT="${INTERNAL_PORT}" "$@"
}

all_pods() { # <service>: every pod of a function, terminating ones included
  k -n "${NS}" get pods -l "serving.knative.dev/service=$1" -o json | jq '.items | length'
}

await_zero() { # <service>: no pod at all (a draining pod could serve a "cold" call)
  local end=$((SECONDS + 300))
  until [ "$(all_pods "$1")" = 0 ]; do
    [ "${SECONDS}" -lt "${end}" ] || fail "timed out after 300s waiting for: $1 scaled to zero"
    sleep 5
  done
  ok "$1 has scaled to zero"
}

start_forwards() {
  ensure_forward
  ZONE_HOST="$(k -n "${NS}" get nextapp "${ZONE}" -o jsonpath='{.status.url}' 2>/dev/null | sed -E 's#^https?://##')"
  [ -n "${ZONE_HOST}" ] || fail "nextapp/${ZONE} has no status.url yet"
}

# foreign_get <authorization header value or "">: the foreign pod calls GetItem on the
# function's cluster-local URL (through Kourier and, at zero, the activator). Sets
# FC_STATUS (HTTP status, 000 if no response) and FC_CODE (the Connect error code).
foreign_get() {
  local auth=$1 out
  local args=(curl -s -m 60 -o /tmp/body -w '%{http_code}' -X POST
    -H 'content-type: application/json' -H 'connect-protocol-version: 1')
  [ -n "${auth}" ] && args+=(-H "authorization: ${auth}")
  args+=(-d '{"id":"missing"}' "${FN_URL}${GET_ITEM}")
  out="$(k -n "${FOREIGN}" exec caller -- "${args[@]}" 2>/dev/null)" || out=000
  FC_STATUS="${out}"
  local body
  body="$(k -n "${FOREIGN}" exec caller -- cat /tmp/body 2>/dev/null || true)"
  FC_CODE="$(jq -r '.code // ""' <<<"${body}" 2>/dev/null || true)"
  FC_MESSAGE="$(jq -r '.message // ""' <<<"${body}" 2>/dev/null || true)"
}

# dial_rc <ip> <port>: curl's exit code for an HTTP request from the foreign pod to
# <ip>:<port> with a 5 s limit. 0 is an HTTP answer of any status; 28 is a timeout,
# which is what a Calico DROP produces. Anything else (7 refused, a kubectl exec
# failure) proves nothing about the policy.
dial_rc() {
  local rc=0
  k -n "${FOREIGN}" exec caller -- curl -s -o /dev/null -m 5 "http://$1:$2/" >/dev/null 2>&1 || rc=$?
  echo "${rc}"
}

fn_pod_ip() {
  k -n "${NS}" get pods -l "serving.knative.dev/service=${GO_FN}" -o json \
    | jq -r '[.items[] | select(.metadata.deletionTimestamp == null and .status.phase == "Running"
              and ([.status.conditions[]? | select(.type == "Ready") | .status] == ["True"]))] | .[0].status.podIP // ""'
}

# fn_ready_on <image>: the function's LATEST READY revision runs <image>. A Ready
# condition alone can be a stale one from the previous revision.
fn_ready_on() {
  local rev
  rev="$(k -n "${NS}" get ksvc "${GO_FN}" -o jsonpath='{.status.latestReadyRevisionName}')"
  [ -n "${rev}" ] || return 1
  [ "$(k -n "${NS}" get revision "${rev}" -o jsonpath='{.spec.containers[0].image}')" = "$1" ]
}

# ---------------------------------------------------------------- phase: up

phase_up() {
  log "kind cluster ${CLUSTER} with the default CNI disabled, and Calico"
  if ! kind get clusters 2>/dev/null | grep -qx "${CLUSTER}"; then
    cat <<'YAML' | kind create cluster --name "${CLUSTER}" --wait 0s --config=-
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
networking:
  disableDefaultCNI: true
  podSubnet: "192.168.0.0/16"
containerdConfigPatches:
- |-
  [plugins."io.containerd.grpc.v1.cri".registry]
    config_path = "/etc/containerd/certs.d"
YAML
  fi
  use_cluster
  if ! k -n kube-system get daemonset calico-node >/dev/null 2>&1; then
    "${REPO}/scripts/kind-manifests/apply-calico.sh"
  fi
  k -n kube-system rollout status daemonset/calico-node --timeout=300s
  k wait --for=condition=Ready nodes --all --timeout=180s
  ok "Calico is the CNI: NetworkPolicy is enforced on this cluster"
  lane_env env PHASES=up "${Z7}/run.sh"
}

# ---------------------------------------------------------------- phase: deploy

phase_deploy() {
  lane_env env PHASES="images deploy" "${Z10}/run.sh"

  log "the Go function without its token interceptor (mutation image for the noauth phase)"
  local src="${WORK}/go-noauth" anchor='		auth.NewInterceptor(verifier),'
  cp -R "${REPO}/templates/go" "${src}"
  [ "$(grep -cxF -- "${anchor}" "${src}/internal/rpc/rpc.go")" = 1 ] \
    || fail "templates/go/internal/rpc/rpc.go no longer has exactly one '${anchor}' line to remove"
  grep -vxF -- "${anchor}" "${src}/internal/rpc/rpc.go" >"${src}/rpc.go.new"
  mv "${src}/rpc.go.new" "${src}/internal/rpc/rpc.go"
  build_push function-go-noauth "${src}"

  log "a caller pod in another namespace (${FOREIGN})"
  if k get namespace "${FOREIGN}" >/dev/null 2>&1; then
    [ "$(k get namespace "${FOREIGN}" -o json | jq -r '.metadata.labels["e2e.kn-next.dev/z11-owned"] // ""')" = true ] \
      || fail "namespace ${FOREIGN} exists and this drill did not create it; refusing to delete it"
    k delete namespace "${FOREIGN}" --wait=true --timeout=300s
  fi
  # Created WITH its label in one object, so an abort cannot leave an unlabelled
  # namespace this drill would then refuse to delete.
  k apply --validate=strict -f - >/dev/null <<YAML
apiVersion: v1
kind: Namespace
metadata:
  name: ${FOREIGN}
  labels:
    e2e.kn-next.dev/z11-owned: "true"
YAML
  k -n "${FOREIGN}" run caller --image="${CURL_IMAGE}" --restart=Never --command -- sleep 86400
  k -n "${FOREIGN}" wait --for=condition=Ready pod/caller --timeout=180s
  ok "foreign caller ready"
}

# ---------------------------------------------------------------- phase: token

phase_token() {
  log "token: a foreign pod's call through the activator is refused without a valid token"
  [ -n "${ZONE_HOST}" ] || start_forwards
  await_zero "${GO_FN}"
  foreign_get ""
  [ "${FC_STATUS}" = 401 ] && [ "${FC_CODE}" = unauthenticated ] && [ "${FC_MESSAGE}" = "missing bearer token" ] \
    || fail "a foreign call with no token: status ${FC_STATUS} code '${FC_CODE}' message '${FC_MESSAGE}', want 401 unauthenticated 'missing bearer token'"
  [ "$(all_pods "${GO_FN}")" -ge 1 ] || fail "the refused call never woke ${GO_FN}: it did not reach the function"
  ok "a foreign call with no token woke the function through the activator and was refused (401 unauthenticated)"
  await_zero "${GO_FN}"
  foreign_get "Bearer not-a-token"
  [ "${FC_STATUS}" = 401 ] && [ "${FC_CODE}" = unauthenticated ] && [ "${FC_MESSAGE}" = "token rejected" ] \
    || fail "a foreign call with a garbage token: status ${FC_STATUS} code '${FC_CODE}' message '${FC_MESSAGE}', want 401 unauthenticated 'token rejected'"
  ok "a foreign call with a garbage token, also cold, is refused by the verifier (401 unauthenticated, token rejected)"
  expect_zone "control: the zone's own call through its glue reaches the function (NotFound, not 401)" \
    "/example/get?sub=alice&id=missing" 404 '.ok == false and .code == "NotFound"'
}

# ---------------------------------------------------------------- phase: direct

set_policy() { # true|false: the function's NetworkPolicy toggle, then wait for the object to match
  if [ "$1" = false ]; then RESTORE_POLICY=1; fi
  k -n "${NS}" patch backendservice "${GO_FN}" --type merge -p "{\"spec\":{\"security\":{\"networkPolicy\":$1}}}" >/dev/null
  local want=1
  [ "$1" = false ] && want=0
  local end=$((SECONDS + 120))
  # The operator names it <function>-function-ingress.
  until [ "$(k -n "${NS}" get networkpolicy "${GO_FN}-function-ingress" --ignore-not-found -o name | grep -c .)" = "${want}" ]; do
    [ "${SECONDS}" -lt "${end}" ] || fail "the function's NetworkPolicy did not become present=${want} within 120s"
    sleep 3
  done
  if [ "$1" = true ]; then RESTORE_POLICY=0; fi
}

phase_direct() {
  log "direct: a foreign pod's direct dial to the warm function pod is dropped"
  [ -n "${ZONE_HOST}" ] || start_forwards
  # Wake the function through the zone, and require the call to have reached it
  # (NotFound from the handler), so a Ready pod is up to dial.
  zone_call "/example/get?sub=alice&id=missing"
  [ "${ZC_STATUS}" = 404 ] || fail "the zone's wake-up call returned ${ZC_STATUS}, want 404 from the function"
  local ip port rc
  ip="$(fn_pod_ip)"
  [ -n "${ip}" ] || fail "no Ready ${GO_FN} pod to dial"
  for port in 8080 8012; do
    rc="$(dial_rc "${ip}" "${port}")"
    # Only a timeout is a Calico drop. 0 means it connected; anything else (a refused
    # port, a kubectl failure) is not evidence of the policy.
    [ "${rc}" = 28 ] || fail "a foreign pod's direct dial to ${ip}:${port}: curl exit ${rc}, want 28 (dropped)"
  done
  ok "the foreign pod's direct dials to the function pod (8080, 8012) time out: dropped by the policy"

  log "mutation: with the function's NetworkPolicy off, the same direct dials connect"
  set_policy false
  local end=$((SECONDS + 60)) opened=0
  while [ "${SECONDS}" -lt "${end}" ]; do
    ip="$(fn_pod_ip)"
    if [ -n "${ip}" ] && [ "$(dial_rc "${ip}" 8080)" = 0 ] && [ "$(dial_rc "${ip}" 8012)" = 0 ]; then
      opened=1
      break
    fi
    zone_call "/example/get?sub=alice&id=missing"
    sleep 3
  done
  set_policy true
  [ "${opened}" = 1 ] || fail "with the NetworkPolicy off the direct dials still failed: the refusal above was not the policy's doing"
  ok "with the policy off both direct dials connect: the refusal is the policy's doing (policy restored)"
}

# ---------------------------------------------------------------- phase: noauth

phase_noauth() {
  log "noauth: the function WITHOUT its token interceptor answers the foreign call"
  local good bad
  # The image the function runs now (the Z10 phase built and recorded it in its own state).
  good="$(k -n "${NS}" get backendservice "${GO_FN}" -o jsonpath='{.spec.image}')"
  bad="$(image_ref function-go-noauth)"
  [ -n "${good}" ] || fail "${GO_FN} has no spec.image"
  # A previous aborted run could have left the function on the mutation image; taking
  # that as "good" would restore it and report the drill green.
  [ "${good}" != "${bad}" ] || fail "${GO_FN} already runs the no-interceptor image: put it back on its own image first"
  RESTORE_IMAGE="${good}"
  k -n "${NS}" patch backendservice "${GO_FN}" --type merge -p "{\"spec\":{\"image\":\"${bad}\"}}" >/dev/null
  wait_until 300 3 "${GO_FN}'s latest ready revision runs the no-interceptor image" "fn_ready_on '${bad}'"
  await_zero "${GO_FN}"
  foreign_get ""
  local status=${FC_STATUS} code=${FC_CODE}
  k -n "${NS}" patch backendservice "${GO_FN}" --type merge -p "{\"spec\":{\"image\":\"${good}\"}}" >/dev/null
  wait_until 300 3 "${GO_FN}'s latest ready revision runs its own image again" "fn_ready_on '${good}'"
  RESTORE_IMAGE=""
  [ "${status}" = 404 ] && [ "${code}" = not_found ] \
    || fail "without the interceptor a foreign no-token call got status ${status} code '${code}', want 404 not_found (it should reach the handler)"
  ok "without the interceptor the same foreign call reaches the handler (404 not_found): the token is the control (image restored)"
}

# ---------------------------------------------------------------- main

for phase in ${PHASES}; do
  case "${phase}" in
    up | deploy | token | direct | noauth) ;;
    *) fail "unknown phase '${phase}' (up deploy token direct noauth)" ;;
  esac
done
# `if ...; then phase; fi`, never `has_phase x && phase_x`: a function run as part
# of an && list runs with errexit suspended, so a failing command inside it would
# not stop the drill.
if has_phase up; then phase_up; fi
use_cluster
k -n kube-system get daemonset calico-node >/dev/null 2>&1 \
  || fail "the cluster runs no Calico: NetworkPolicy would not be enforced and the drill would prove nothing"
if has_phase deploy; then phase_deploy; fi
if has_phase token; then phase_token; fi
if has_phase direct; then phase_direct; fi
if has_phase noauth; then phase_noauth; fi
log "Z11 drill: ${PHASES} passed"
