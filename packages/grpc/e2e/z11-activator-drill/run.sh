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
#   policyoff  with the function's NetworkPolicy switched OFF (so no policy object
#             exists), a token-less call is still refused by the function itself:
#             through the activator while cold, and by a direct dial to the warm
#             pod's user port (which the policy would otherwise have dropped). The
#             in-process token check is the control, not the network.
#   noauth    mutation: the function rebuilt WITHOUT its token interceptor answers
#             the foreign no-token call (not_found, not 401). The token, not the
#             network, is the control on the activator path. With the policy also
#             off, a direct no-token dial to that pod still reaches the handler:
#             with both controls gone nothing refuses it.
#
#   rotcold   the zone's signing key is rotated, switched and retired WHILE the function
#             is at zero. The cold pod that wakes afterwards reads the new JWKS: it
#             refuses a token signed by the retired key (401 unauthenticated) and, after
#             another scale to zero, accepts one signed by the new key. Control: before
#             the rotation a cold pod accepts the old key.
#   held      a call the activator holds for longer than the token's life (a pod that
#             cannot be scheduled, so the activator buffers the request) is refused by
#             the function as 401 unauthenticated "token rejected", never accepted.
#             Control: the same hold for 30 s, inside the token's life, is accepted, so
#             the refusal is the token's age. Afterwards a fresh token is accepted and a
#             garbage token is still refused.
#   heldwarm  the combined case ADR-0004 names: warm pods that cached the OLD key set, the
#             zone's key rotated and retired under them, and a call held longer than the
#             token's life. Two warm pods each load the old set with one call and get no
#             other. A new-key token held 30 s on pod A is accepted (404 not_found): a pod
#             holding the old set finds the new key. The same held 80 s on pod B, in the same
#             state, is refused (401 unauthenticated "token rejected"). Only the target pod is
#             re-attached for each call, and the pod set is checked unchanged. The verifier
#             re-reads its JWKS at the start of every call older than 10 s, looks the kid up,
#             checks the signature and only then the expiry; a refusal says "token rejected"
#             for every cause and is not logged, so the drill proves the pair above, not which
#             check fired.
#
# How a call is held (held and heldwarm), with no node cordoned: a ResourceQuota in the
# function's namespace admits no new pod, so the pod the activator is waiting for cannot be
# created (cold hold). For the warm hold the live pods are also detached from their Service
# (their revisionUID label is changed), so the activator has no endpoint while the pods, and the
# key sets they cached, stay alive; with the quota in place the ReplicaSet cannot replace them.
# Release re-attaches only the target pod, then (after the answer) the rest, and only then deletes
# the quota; a cold release deletes the quota and nudges the ReplicaSet so it does not sit in its
# retry backoff. Only this namespace is touched.
#
# Phases (PHASES, space-separated; default all): up deploy token direct policyoff noauth
# rotcold held heldwarm.
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
PHASES="${PHASES:-up deploy token direct policyoff noauth rotcold held heldwarm}"
INTERNAL_PORT="${INTERNAL_PORT:-18100}"
# How long the held call stays outstanding. A token lives 60 s and the verifier allows
# 5 s of skew, so anything below 66 s would not prove the refusal is the expiry.
HELD_SECONDS="${Z11_HELD_SECONDS:-80}"
# The control hold: the same mechanism, shorter than the token's life, so its token is still
# valid when the activator releases the call. It must be ACCEPTED.
CONTROL_HELD_SECONDS="${Z11_CONTROL_HELD_SECONDS:-30}"
CURL_IMAGE='curlimages/curl:8.11.1@sha256:c1fe1679c34d9784c1b0d1e5f62ac0a79fca01fb6377cdd33e90473c6f9f9a69'

ZONE=storefront
GO_FN=example-go
RUST_FN=inventory-rust
FN_URL="http://${GO_FN}.${NS}.svc.cluster.local"
RUST_URL="http://${RUST_FN}.${NS}.svc.cluster.local"
GET_ITEM="/example.v1.ExampleService/GetItem"
ZONE_HOST=""
FN_HOST="${GO_FN}.${NS}.svc.cluster.local"
Z7_PROBE="${Z7}/probe.ts"
ISSUER="knext:zone:${NS}/${ZONE}"
KEY_SECRET="${ZONE}-knext-signing-key"
JWKS_CM="${ZONE}-knext-jwks"
OPERATOR_NS='kn-next-operator-system'

WORK="$(mktemp -d "${TMPDIR:-/tmp}/knext-z11-drill.XXXXXX")"
STATE="${TMPDIR:-/tmp}/knext-z11-drill-state-${CLUSTER}"
mkdir -p "${STATE}"
export KUBECONFIG="${WORK}/kubeconfig"
PF_PIDS="${WORK}/pf.pids"
IMAGE_PREFIX=z11
# shellcheck source=../lib/kind-lane.sh
source "${HERE}/../lib/kind-lane.sh"
# shellcheck source=answering-pod.sh
source "${HERE}/answering-pod.sh"

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
RESTORE_RUST_POLICY=0
RESTORE_IMAGE=""
# Set while a hold has the namespace's pod quota in place: a kept cluster must admit pods again.
RESTORE_QUOTA=0
# "<pod>=<revisionUID label> ..." while a warm hold has pods detached from their Service.
RESTORE_DETACH=""
# Set while heldwarm has the function on minScale 1: put it back to 0.
RESTORE_MINSCALE=0
HOLD_QUOTA=z11-hold
# The background held call's pid is written here, so an abort never leaves it running.
HELD_PIDFILE="${WORK}/held.pid"

cleanup() {
  local rc=$? entry
  if [ -s "${HELD_PIDFILE}" ]; then kill "$(cat "${HELD_PIDFILE}")" 2>/dev/null || true; fi
  # Re-attach every detached pod BEFORE the quota goes: with the quota still in place the
  # ReplicaSet cannot create a replacement while it adopts the pods back.
  for entry in ${RESTORE_DETACH}; do
    k -n "${NS}" label pod "${entry%%=*}" "serving.knative.dev/revisionUID=${entry#*=}" --overwrite >/dev/null 2>&1 \
      || echo "WARNING: could not re-attach ${entry%%=*}" >&2
  done
  if [ "${RESTORE_QUOTA}" = 1 ]; then
    k -n "${NS}" delete resourcequota "${HOLD_QUOTA}" --ignore-not-found >/dev/null 2>&1 \
      || echo "WARNING: could not delete the ${HOLD_QUOTA} quota" >&2
  fi
  if [ "${RESTORE_MINSCALE}" = 1 ]; then
    k -n "${NS}" patch backendservice "${GO_FN}" --type merge -p '{"spec":{"scaling":{"minScale":0,"maxScale":1}}}' >/dev/null 2>&1 \
      || echo "WARNING: could not put ${GO_FN} back on minScale 0 and maxScale 1" >&2
  fi
  if [ "${RESTORE_POLICY}" = 1 ]; then
    k -n "${NS}" patch backendservice "${GO_FN}" --type merge -p '{"spec":{"security":{"networkPolicy":true}}}' >/dev/null 2>&1 \
      || echo "WARNING: could not turn ${GO_FN}'s NetworkPolicy back on" >&2
  fi
  if [ "${RESTORE_RUST_POLICY}" = 1 ]; then
    k -n "${NS}" patch backendservice "${RUST_FN}" --type merge -p '{"spec":{"security":{"networkPolicy":true}}}' >/dev/null 2>&1 \
      || echo "WARNING: could not turn ${RUST_FN}'s NetworkPolicy back on" >&2
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

# The propagation bound the operator ships with, from its own contract fixture.
BOUND_FIXTURE="${REPO}/packages/kn-next-operator/internal/controller/testdata/zone-identity-contract.json"
BOUND_SECONDS="$(jq -er '.rotation.propagationBoundSeconds' "${BOUND_FIXTURE}")" \
  || { echo "cannot read .rotation.propagationBoundSeconds from ${BOUND_FIXTURE}" >&2; exit 64; }

lane_env() { # the environment the Z7 and Z10 lanes need to run against this cluster
  KIND_CLUSTER="${CLUSTER}" REGISTRY_NAME="${REG_NAME}" REGISTRY_PORT="${REG_PORT}" \
    Z10_NAMESPACE="${NS}" Z10_WITH_RUST=1 INTERNAL_PORT="${INTERNAL_PORT}" "$@"
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

# await_zero_all <service>...: every service has no pod at all. One shared bound, and the
# services drain at the same time on the cluster, so the wait costs the slowest drain, not the sum.
await_zero_all() {
  local end=$((SECONDS + 300)) svc
  for svc in "$@"; do
    until [ "$(all_pods "${svc}")" = 0 ]; do
      [ "${SECONDS}" -lt "${end}" ] || fail "timed out after 300s waiting for: ${svc} scaled to zero"
      sleep 5
    done
    ok "${svc} has scaled to zero"
  done
}

start_forwards() {
  ensure_forward
  ZONE_HOST="$(k -n "${NS}" get nextapp "${ZONE}" -o jsonpath='{.status.url}' 2>/dev/null | sed -E 's#^https?://##')"
  [ -n "${ZONE_HOST}" ] || fail "nextapp/${ZONE} has no status.url yet"
}

# foreign_get <authorization header value or "">: the foreign pod calls GetItem on the
# function's cluster-local URL (through Kourier and, at zero, the activator). Sets
# FC_STATUS (HTTP status, 000 if no response) and FC_CODE (the Connect error code).
foreign_get() { foreign_post "${FN_URL}${GET_ITEM}" "$1"; }

# foreign_post <url> <authorization header value or "">: the same call to any URL.
foreign_post() {
  local url=$1 auth=$2 out
  local args=(curl -s -m 60 -o /tmp/body -w '%{http_code}' -X POST
    -H 'content-type: application/json' -H 'connect-protocol-version: 1')
  [ -n "${auth}" ] && args+=(-H "authorization: ${auth}")
  args+=(-d '{"id":"missing"}' "${url}")
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
rust_pod_ip() { # the same for the Rust function
  k -n "${NS}" get pods -l "serving.knative.dev/service=${RUST_FN}" -o json \
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

secret_get() { # <field>: one data field of the zone's key Secret, decoded (kids only!)
  k -n "${NS}" get secret "${KEY_SECRET}" -o json | jq -r --arg f "$1" '.data[$f] // empty | @base64d'
}
# jwks_written_at: when the JWKS ConfigMap was last written, by the API server's clock (the
# same clock as the kubelet's on a kind node, so it compares with a pod's startTime).
jwks_written_at() { k -n "${NS}" get configmap "${JWKS_CM}" -o json --show-managed-fields | jq -r '[.metadata.managedFields[]?.time | fromdateiso8601] | max'; }
# fn_pod_started: "<uid> <startTime epoch>" of the function's live pod.
fn_pod_started() {
  k -n "${NS}" get pods -l "serving.knative.dev/service=${GO_FN}" -o json \
    | jq -r '[.items[] | select(.metadata.deletionTimestamp == null)][0] | "\(.metadata.uid) \(.status.startTime | fromdateiso8601)"'
}
jwks_kids() { k -n "${NS}" get configmap "${JWKS_CM}" -o json | jq -r '.data["jwks.json"] | fromjson | [.keys[].kid] | sort | join(",")'; }

# export_key <dir> <slot>: the Secret's <slot>.key/.kid as <dir>/current.key/.kid, the
# layout the Z7 probe's signer reads. Written straight to files; nothing is printed.
export_key() {
  local dir=$1 slot=$2 json
  mkdir -p "${dir}"
  chmod 700 "${dir}"
  json="$(k -n "${NS}" get secret "${KEY_SECRET}" -o json)"
  jq -r --arg s "${slot}.key" '.data[$s] // empty | @base64d' <<<"${json}" >"${dir}/current.key"
  jq -r --arg s "${slot}.kid" '.data[$s] // empty | @base64d' <<<"${json}" >"${dir}/current.kid"
  chmod 600 "${dir}/current.key" "${dir}/current.kid"
  [ -s "${dir}/current.key" ] && [ -s "${dir}/current.kid" ] || fail "the Secret holds no ${slot} key"
}

# fn_probe <key dir> <id>: one VALID-signature call to the function through the gateway
# (so through the activator when it is cold), with a token the Z7 probe signs with the key
# in <key dir>. Sets PR_STATUS and PR_CODE. Exit 2 means nothing answered (a dropped
# port-forward): the call is retried, and only then. A function that ANSWERS is never
# retried, so a refusal stays a refusal.
fn_probe() {
  local attempt rc=0 out
  PR_STATUS=000
  PR_CODE=""
  for attempt in 1 2 3; do
    rc=0
    ensure_forward
    bun "${Z7_PROBE}" --base "http://127.0.0.1:${INTERNAL_PORT}" --host "${FN_HOST}" \
      --issuer "${ISSUER}" --sub alice --rpc get --id "$2" --auth signer --key-dir "$1" \
      --timeout-seconds 60 >"${WORK}/fn-probe.out" 2>/dev/null || rc=$?
    [ "${rc}" = 2 ] || break
  done
  [ "${rc}" = 0 ] || fail "the function did not answer a call (probe exit ${rc})"
  out="$(cat "${WORK}/fn-probe.out")"
  PR_STATUS="$(jq -r .status <<<"${out}")"
  PR_CODE="$(jq -r '.code // ""' <<<"${out}")"
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

# set_rust_policy true|false: the Rust function's NetworkPolicy toggle, then wait for the object
# to match (the same as set_policy, for the Rust function).
set_rust_policy() {
  if [ "$1" = false ]; then RESTORE_RUST_POLICY=1; fi
  k -n "${NS}" patch backendservice "${RUST_FN}" --type merge -p "{\"spec\":{\"security\":{\"networkPolicy\":$1}}}" >/dev/null
  local want=1
  [ "$1" = false ] && want=0
  local end=$((SECONDS + 120))
  until [ "$(k -n "${NS}" get networkpolicy "${RUST_FN}-function-ingress" --ignore-not-found -o name | grep -c .)" = "${want}" ]; do
    [ "${SECONDS}" -lt "${end}" ] || fail "the Rust function's NetworkPolicy did not become present=${want} within 120s"
    sleep 3
  done
  if [ "$1" = true ]; then RESTORE_RUST_POLICY=0; fi
}

# wake_ready: wake the function through the zone with the authenticated call and WAIT,
# bounded, until the call reached the handler (404 not_found) AND a Ready pod exists;
# set WARM_IP. Fails closed when no pod ever becomes Ready, so a direct dial is never
# attempted at a scaled-to-zero function (and never counted as a pass).
wake_ready() {
  local end=$((SECONDS + 180)) ip
  WARM_IP=""
  while [ "${SECONDS}" -lt "${end}" ]; do
    zone_call "/example/get?sub=alice&id=missing"
    ip="$(fn_pod_ip)"
    if [ "${ZC_STATUS}" = 404 ] && [ -n "${ip}" ]; then WARM_IP="${ip}"; return 0; fi
    sleep 3
  done
  fail "no Ready ${GO_FN} pod to dial after waking it through the zone (last status ${ZC_STATUS})"
}

phase_direct() {
  log "direct: a foreign pod's direct dial to the warm function pod is dropped"
  [ -n "${ZONE_HOST}" ] || start_forwards
  # The function may have scaled to zero while earlier phases ran (a slow runner):
  # wake it through the zone and WAIT for a Ready pod before the first lookup.
  local ip port rc
  wake_ready
  ip="${WARM_IP}"
  # 8080 is the function; 8013 is queue-proxy's serving port for an h2c function
  # (8012 is its HTTP/1 port, which an h2c function's queue-proxy does not open).
  for port in 8080 8013; do
    rc="$(dial_rc "${ip}" "${port}")"
    # Only a timeout is a Calico drop. 0 means it connected; anything else (a refused
    # port, a kubectl failure) is not evidence of the policy.
    [ "${rc}" = 28 ] || fail "a foreign pod's direct dial to ${ip}:${port}: curl exit ${rc}, want 28 (dropped)"
  done
  ok "the foreign pod's direct dials to the function pod (8080, 8013) time out: dropped by the policy"

  log "mutation: with the function's NetworkPolicy off, the same direct dials connect"
  set_policy false
  local end=$((SECONDS + 60)) opened=0
  while [ "${SECONDS}" -lt "${end}" ]; do
    ip="$(fn_pod_ip)"
    if [ -n "${ip}" ] && [ "$(dial_rc "${ip}" 8080)" = 0 ] && [ "$(dial_rc "${ip}" 8013)" = 0 ]; then
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

# await_direct_ip: with the policy off, wait until the foreign pod can dial the warm
# function pod's user port, and set DIRECT_IP. Each round keeps the pod warm through
# the zone (the same way phase_direct does), so an idle scale-down cannot race the dial.
# Callers run wake_ready on the line before: it is not called from here so the call chain
# stays shallow enough for the supply-chain scanner to classify it.
await_direct_ip() {
  local end ip
  DIRECT_IP=""
  end=$((SECONDS + 90))
  while [ "${SECONDS}" -lt "${end}" ]; do
    zone_call "/example/get?sub=alice&id=missing"
    ip="$(fn_pod_ip)"
    if [ -n "${ip}" ] && [ "$(dial_rc "${ip}" 8080)" = 0 ]; then DIRECT_IP="${ip}"; return 0; fi
    sleep 3
  done
  fail "policy off: the foreign pod could not reach the warm function pod, so the direct leg proves nothing"
}

# ---------------------------------------------------------------- phase: policyoff

phase_policyoff() {
  log "policyoff: with the NetworkPolicy OFF a token-less call is refused by the function itself"
  [ -n "${ZONE_HOST}" ] || start_forwards
  set_policy false
  # set_policy returned only once the object is gone; assert it again here so this
  # phase's claim never rests on a helper's wait.
  [ "$(k -n "${NS}" get networkpolicy "${GO_FN}-function-ingress" --ignore-not-found -o name | grep -c .)" = 0 ] \
    || fail "the function's NetworkPolicy still exists: the leg would not be a policy-off leg"
  set_rust_policy false
  [ "$(k -n "${NS}" get networkpolicy "${RUST_FN}-function-ingress" --ignore-not-found -o name | grep -c .)" = 0 ] \
    || fail "the Rust function's NetworkPolicy still exists: the Rust leg would not be a policy-off leg"
  # Cold, through the activator. Both functions drain at the same time, so the Rust leg
  # below costs no wait of its own.
  await_zero_all "${GO_FN}" "${RUST_FN}"
  foreign_get ""
  [ "${FC_STATUS}" = 401 ] && [ "${FC_CODE}" = unauthenticated ] && [ "${FC_MESSAGE}" = "missing bearer token" ] \
    || fail "policy off, cold, no token: status ${FC_STATUS} code '${FC_CODE}' message '${FC_MESSAGE}', want 401 unauthenticated 'missing bearer token'"
  [ "$(all_pods "${GO_FN}")" -ge 1 ] || fail "the refused call never woke ${GO_FN}: it did not reach the function"
  ok "policy off: a cold no-token call through the activator woke the function and was refused (401 unauthenticated)"
  # Warm and direct: the dial the policy would drop now connects, and the function answers.
  local ip
  wake_ready
  await_direct_ip
  ip="${DIRECT_IP}"
  foreign_post "http://${ip}:8080${GET_ITEM}" ""
  [ "${FC_STATUS}" = 401 ] && [ "${FC_CODE}" = unauthenticated ] && [ "${FC_MESSAGE}" = "missing bearer token" ] \
    || fail "policy off, direct to the pod, no token: status ${FC_STATUS} code '${FC_CODE}' message '${FC_MESSAGE}', want 401 unauthenticated 'missing bearer token'"
  foreign_post "http://${ip}:8080${GET_ITEM}" "Bearer not-a-token"
  [ "${FC_STATUS}" = 401 ] && [ "${FC_CODE}" = unauthenticated ] && [ "${FC_MESSAGE}" = "token rejected" ] \
    || fail "policy off, direct to the pod, garbage token: status ${FC_STATUS} code '${FC_CODE}' message '${FC_MESSAGE}', want 401 unauthenticated 'token rejected'"
  echo "REFUSED-BY-FUNCTION-WITH-POLICY-OFF: direct ${ip}:8080 no token -> 401 unauthenticated; garbage token -> 401 unauthenticated"
  set_policy true
  ok "policy off: a foreign pod reached the function pod directly and the function itself refused it (policy restored)"
  policyoff_rust
}

# await_rust_ip: with the Rust function's policy off, wait until the foreign pod can dial the
# Rust function pod's user port, and set RUST_IP. Each round keeps the pod warm through its
# own cluster-local URL, so an idle scale-down cannot race the dial.
await_rust_ip() {
  local end ip
  RUST_IP=""
  end=$((SECONDS + 90))
  while [ "${SECONDS}" -lt "${end}" ]; do
    foreign_post "${RUST_URL}${GET_ITEM}" ""
    ip="$(rust_pod_ip)"
    if [ -n "${ip}" ] && [ "$(dial_rc "${ip}" 8080)" = 0 ]; then RUST_IP="${ip}"; return 0; fi
    sleep 3
  done
  fail "policy off: the foreign pod could not reach the warm Rust function pod, so the Rust direct leg proves nothing"
}

# policyoff_rust: the Go policy-off leg, against the Rust template function (its NetworkPolicy
# is already off). Cold through the activator, then direct to the pod: the function itself refuses.
policyoff_rust() {
  log "policyoff (Rust): with the NetworkPolicy OFF the Rust function itself refuses a token-less call"
  [ "$(all_pods "${RUST_FN}")" = 0 ] || fail "${RUST_FN} has a pod before the cold call, so the Rust leg would not be cold"
  foreign_post "${RUST_URL}${GET_ITEM}" ""
  [ "${FC_STATUS}" = 401 ] && [ "${FC_CODE}" = unauthenticated ] && [ "${FC_MESSAGE}" = "missing bearer token" ] \
    || fail "policy off, Rust, cold, no token: status ${FC_STATUS} code '${FC_CODE}' message '${FC_MESSAGE}', want 401 unauthenticated 'missing bearer token'"
  [ "$(all_pods "${RUST_FN}")" -ge 1 ] || fail "the refused call never woke ${RUST_FN}: it did not reach the function"
  ok "policy off: a cold no-token call through the activator woke the Rust function and was refused (401 unauthenticated)"
  await_rust_ip
  foreign_post "http://${RUST_IP}:8080${GET_ITEM}" ""
  [ "${FC_STATUS}" = 401 ] && [ "${FC_CODE}" = unauthenticated ] && [ "${FC_MESSAGE}" = "missing bearer token" ] \
    || fail "policy off, Rust, direct to the pod, no token: status ${FC_STATUS} code '${FC_CODE}' message '${FC_MESSAGE}', want 401 unauthenticated 'missing bearer token'"
  foreign_post "http://${RUST_IP}:8080${GET_ITEM}" "Bearer not-a-token"
  [ "${FC_STATUS}" = 401 ] && [ "${FC_CODE}" = unauthenticated ] && [ "${FC_MESSAGE}" = "token rejected" ] \
    || fail "policy off, Rust, direct to the pod, garbage token: status ${FC_STATUS} code '${FC_CODE}' message '${FC_MESSAGE}', want 401 unauthenticated 'token rejected'"
  echo "REFUSED-BY-RUST-FUNCTION-WITH-POLICY-OFF: direct ${RUST_IP}:8080 no token -> 401 unauthenticated; garbage token -> 401 unauthenticated"
  set_rust_policy true
  ok "policy off: a foreign pod reached the Rust function pod directly and the function itself refused it (policy restored)"
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
  # The same no-interceptor function with the NetworkPolicy OFF, dialled directly: the
  # case ADR-0004 names as having no control at all. The token-less call must reach
  # the handler (404 not_found), because neither the network nor the function refuses it.
  set_policy false
  wake_ready
  await_direct_ip
  local dip="${DIRECT_IP}"
  foreign_post "http://${dip}:8080${GET_ITEM}" ""
  local pstatus=${FC_STATUS} pcode=${FC_CODE}
  set_policy true
  echo "NOAUTH-WITH-POLICY-OFF: direct ${dip}:8080 no token -> ${pstatus} ${pcode}"
  k -n "${NS}" patch backendservice "${GO_FN}" --type merge -p "{\"spec\":{\"image\":\"${good}\"}}" >/dev/null
  wait_until 300 3 "${GO_FN}'s latest ready revision runs its own image again" "fn_ready_on '${good}'"
  RESTORE_IMAGE=""
  [ "${status}" = 404 ] && [ "${code}" = not_found ] \
    || fail "without the interceptor a foreign no-token call got status ${status} code '${code}', want 404 not_found (it should reach the handler)"
  [ "${pstatus}" = 404 ] && [ "${pcode}" = not_found ] \
    || fail "no interceptor and no policy: a direct no-token call got status ${pstatus} code '${pcode}', want 404 not_found (nothing should stop it)"
  ok "no interceptor and no policy: a direct no-token call reaches the handler (404 not_found): with both controls gone nothing refuses it"
  ok "without the interceptor the same foreign call reaches the handler (404 not_found): the token is the control (image restored)"
}

# ---------------------------------------------------------------- phase: rotcold

# The failure mode ADR-0004 names: a rotation that a function pod never saw because it
# did not exist. The pod is at zero for the whole rotation; the pod that wakes afterwards
# mounts the JWKS as it is NOW. The retirement is brought forward the way the Z7 lane does
# it (the switch stamp backdated, the operator restarted to re-read it).
phase_rotcold() {
  log "rotcold: the zone's key is rotated while the function is at zero"
  [ -n "${ZONE_HOST}" ] || start_forwards
  local old_kid new_kid nonce
  old_kid="$(secret_get current.kid)"
  [ -n "${old_kid}" ] || fail "no current key"
  [ -z "$(secret_get next.kid)" ] && [ -z "$(secret_get previous.kid)" ] \
    || fail "a rotation is already in flight; run the deploy phase for a clean zone"
  export_key "${WORK}/key-old" current
  await_zero "${GO_FN}"
  fn_probe "${WORK}/key-old" ctl
  [ "${PR_STATUS}" = 404 ] && [ "${PR_CODE}" = not_found ] \
    || fail "before the rotation a cold pod answered the old key with status ${PR_STATUS} code '${PR_CODE}', want 404 not_found (the harness would prove nothing)"
  ok "control: before the rotation a cold pod accepts the old key ${old_kid} (404 not_found)"

  log "rotcold 1/4: scale to zero, then request the rotation"
  await_zero "${GO_FN}"
  nonce="z11-$(date +%s)"
  k -n "${NS}" annotate nextapp "${ZONE}" "apps.kn-next.dev/rotate-signing-key=${nonce}" --overwrite
  # The operator takes the request and stages the new key in one write, and no key was
  # staged before (checked above), so a staged key is this request's.
  wait_until 60 1 "the operator to take the rotation request" '[ -n "$(secret_get next.kid)" ]'
  new_kid="$(secret_get next.kid)"
  [ -n "${new_kid}" ] && [ "${new_kid}" != "${old_kid}" ] || fail "no new key was staged by the rotation request"
  wait_until 30 1 "the JWKS to publish both keys" \
    '[ "$(jwks_kids)" = "$(printf "%s\n%s\n" "${old_kid}" "${new_kid}" | LC_ALL=C sort | paste -sd, -)" ]'
  export_key "${WORK}/key-new" next

  log "rotcold 2/4: the operator switches signing after the propagation bound (${BOUND_SECONDS}s)"
  wait_until $((BOUND_SECONDS + 150)) 2 "signing to switch to the new key" '[ "$(secret_get current.kid)" = "${new_kid}" ]'
  [ "$(secret_get previous.kid)" = "${old_kid}" ] || fail "the old key is not kept as previous after the switch"

  log "rotcold 3/4: retirement (the switch stamp backdated by two hours, the operator restarted)"
  k -n "${NS}" annotate secret "${KEY_SECRET}" \
    "apps.kn-next.dev/signing-key-switched-at=$(node -p 'new Date(Date.now() - 2 * 3600 * 1000).toISOString()')" --overwrite
  k -n "${OPERATOR_NS}" rollout restart deployment/kn-next-operator-controller-manager
  k -n "${OPERATOR_NS}" rollout status deployment/kn-next-operator-controller-manager --timeout=180s
  wait_until 180 3 "the previous key to leave the Secret" '[ -z "$(secret_get previous.kid)" ]'
  wait_until 30 1 "the JWKS to publish only the new key" '[ "$(jwks_kids)" = "${new_kid}" ]'
  local retired_at old_uid old_start new_uid new_start
  retired_at="$(jwks_written_at)"
  ok "retired: only ${new_kid} remains in the Secret and the JWKS"

  log "rotcold 4/4: the cold pod accepts only the new key"
  # Nothing called the function through the whole rotation: it never existed to cache a key set.
  [ "$(all_pods "${GO_FN}")" = 0 ] || fail "${GO_FN} woke during the rotation: this was not a cold-pod rotation"
  fn_probe "${WORK}/key-old" old
  read -r old_uid old_start <<<"$(fn_pod_started)"
  [ "${old_start}" -ge "${retired_at}" ] \
    || fail "the pod that refused the retired key started at ${old_start}, before the retirement at ${retired_at}: it was not a cold start"
  [ "${PR_STATUS}" = 401 ] && [ "${PR_CODE}" = unauthenticated ] \
    || fail "cold pod, retired key: status ${PR_STATUS} code '${PR_CODE}', want 401 unauthenticated"
  [ "$(all_pods "${GO_FN}")" -ge 1 ] || fail "the refused call never woke ${GO_FN}: it did not reach the function"
  ok "cold pod, retired key ${old_kid}: the function that woke after the rotation refused it (401 unauthenticated)"
  await_zero "${GO_FN}"
  fn_probe "${WORK}/key-new" new
  read -r new_uid new_start <<<"$(fn_pod_started)"
  [ "${new_uid}" != "${old_uid}" ] && [ "${new_start}" -ge "${retired_at}" ] \
    || fail "the pod that accepted the new key (${new_uid}, started ${new_start}) is not a second pod started after the retirement at ${retired_at}"
  [ "${PR_STATUS}" = 404 ] && [ "${PR_CODE}" = not_found ] \
    || fail "cold pod, new key: status ${PR_STATUS} code '${PR_CODE}', want 404 not_found (it should reach the handler)"
  ok "cold pod, new key ${new_kid}: a second cold pod accepted it (404 not_found)"
  echo "ROTCOLD: retired ${old_kid} -> 401 unauthenticated; new ${new_kid} -> 404 not_found (both cold)"
  wait_until 300 3 "the zone's own call to succeed with the new key" \
    '[ "$(zone_status "/example/get?sub=alice&id=missing")" = 404 ]'
  expect_zone "control: after the rotation the zone's own call reaches the function (NotFound, not 401)" \
    "/example/get?sub=alice&id=missing" 404 '.ok == false and .code == "NotFound"'
}

# ---------------------------------------------------------------- phase: held

# fn_pods_ready: "<name> <uid> <revisionUID label>" per live Ready function pod, sorted by uid.
fn_pods_ready() {
  k -n "${NS}" get pods -l "serving.knative.dev/service=${GO_FN}" -o json \
    | jq -r '[.items[] | select(.metadata.deletionTimestamp == null and .status.phase == "Running"
              and ([.status.conditions[]? | select(.type == "Ready") | .status] == ["True"]))]
              | sort_by(.metadata.uid)[] | "\(.metadata.name) \(.metadata.uid) \(.metadata.labels["serving.knative.dev/revisionUID"])"'
}
# fn_pod_uids: the uids of every live function pod, sorted, on one line.
fn_pod_uids() {
  k -n "${NS}" get pods -l "serving.knative.dev/service=${GO_FN}" -o json \
    | jq -r '[.items[] | select(.metadata.deletionTimestamp == null) | .metadata.uid] | sort | join(" ")'
}
# fn_pods_started_max: the latest start time among the live function pods, API server clock.
fn_pods_started_max() {
  k -n "${NS}" get pods -l "serving.knative.dev/service=${GO_FN}" -o json \
    | jq -r '[.items[] | select(.metadata.deletionTimestamp == null) | .status.startTime | fromdateiso8601] | max'
}

# isolate_pods <keep uid>: with the pod quota in place (so nothing replaces them), detach every
# function pod except <keep uid> from the Service and wait until the activator's endpoints hold
# only the kept pod. Used to load the key set into one chosen pod.
isolate_pods() {
  local pod uid label rev end=$((SECONDS + 60))
  RESTORE_QUOTA=1
  k -n "${NS}" create resourcequota "${HOLD_QUOTA}" --hard=pods=0 >/dev/null
  while read -r pod uid label; do
    [ "${uid}" = "$1" ] && continue
    RESTORE_DETACH="${RESTORE_DETACH}${pod}=${label} "
    k -n "${NS}" label pod "${pod}" "serving.knative.dev/revisionUID=detached" --overwrite >/dev/null
  done <<<"$(fn_pods_ready)"
  rev="$(k -n "${NS}" get ksvc "${GO_FN}" -o jsonpath='{.status.latestReadyRevisionName}')"
  until [ "$(k -n "${NS}" get endpoints "${rev}-private" -o json | jq '[.subsets[]?.addresses[]?] | length')" = 1 ]; do
    [ "${SECONDS}" -lt "${end}" ] || fail "timed out after 60s waiting for the activator's endpoints to hold only the kept pod"
    sleep 1
  done
  sleep 3
}

# release_pods: re-attach every detached pod, and only then delete the quota.
release_pods() {
  local entry
  for entry in ${RESTORE_DETACH}; do
    k -n "${NS}" label pod "${entry%%=*}" "serving.knative.dev/revisionUID=${entry#*=}" --overwrite >/dev/null
  done
  RESTORE_DETACH=""
  k -n "${NS}" delete resourcequota "${HOLD_QUOTA}" >/dev/null
  RESTORE_QUOTA=0
}

# hold_call <seconds> [warm <target uid>]: hold ONE call in the activator for <seconds>, then
# release it and take the answer. Sets HELD_STATUS, HELD_CODE, HELD_MESSAGE, HELD_FOR and, for a
# warm hold, HELD_POD_UID: the pod that ANSWERED, read from the queue-proxy request counters of
# every pod before and after the call (answering-pod.sh, kept in HELD_REQ_BEFORE and
# HELD_REQ_AFTER), never taken from the target. Cold (the default): the function is scaled to zero first and a
# ResourceQuota admits no pod, so the pod the activator waits for cannot be created. Warm: every
# live pod is kept, all are detached from the Service (their revisionUID label is changed) so the
# activator has no endpoint, and the quota keeps the ReplicaSet from replacing them. On release
# ONLY the target pod is re-attached, so the call can only be answered by it; the others come
# back after the answer, and the set of pods must be exactly what it was. The call is a direct
# bun call, never the retrying wrapper: a retry would mint a fresh token and prove nothing.
hold_call() {
  local out="${WORK}/held.out" start mode="${2:-cold}" pods="" pod uid label tpod="" tlabel="" uids_before=""
  HELD_POD_UID=""
  HELD_REQ_BEFORE=""
  HELD_REQ_AFTER=""
  if [ "${mode}" = warm ]; then
    pods="$(fn_pods_ready)"
    uids_before="$(fn_pod_uids)"
    while read -r pod uid label; do
      if [ "${uid}" = "${3:-}" ]; then tpod="${pod}"; tlabel="${label}"; fi
    done <<<"${pods}"
    [ -n "${tpod}" ] || fail "the target pod ${3:-} is not a Ready ${GO_FN} pod"
    HELD_REQ_BEFORE="$(request_snapshot)" || fail "cannot read the pods' request counters before the hold"
  else
    await_zero "${GO_FN}"
  fi
  ensure_forward
  RESTORE_QUOTA=1
  k -n "${NS}" create resourcequota "${HOLD_QUOTA}" --hard=pods=0 >/dev/null
  if [ "${mode}" = warm ]; then
    while read -r pod uid label; do
      RESTORE_DETACH="${RESTORE_DETACH}${pod}=${label} "
      k -n "${NS}" label pod "${pod}" "serving.knative.dev/revisionUID=detached" --overwrite >/dev/null
    done <<<"${pods}"
  fi
  start=$SECONDS
  bun "${Z7}/probe.ts" --base "http://127.0.0.1:${INTERNAL_PORT}" --host "${FN_HOST}" \
    --issuer "${ISSUER}" --sub alice --rpc get --id missing --auth signer --key-dir "${WORK}/key-held" \
    --with-message --timeout-seconds 240 >"${out}" 2>"${WORK}/held.err" &
  echo "$!" >"${HELD_PIDFILE}"
  if [ "${mode}" = cold ]; then
    # An inline wait, not wait_until: its eval would add three levels to the call chain the
    # supply-chain scanner follows (limit 6). The activator asking for a pod is the proof that
    # the call reached it and is being held, not answered.
    until [ "$(k -n "${NS}" get deploy -l "serving.knative.dev/service=${GO_FN}" -o json | jq '[.items[].spec.replicas // 0] | max // 0')" -ge 1 ]; do
      [ $((SECONDS - start)) -lt 60 ] || fail "timed out after 60s waiting for the held call to make the activator ask for a pod"
      sleep 1
    done
  fi
  while [ $((SECONDS - start)) -lt "$1" ]; do
    kill -0 "$(cat "${HELD_PIDFILE}")" 2>/dev/null || fail "the held call ended after $((SECONDS - start))s, before $1s: it was not held ($(cat "${out}" "${WORK}/held.err" 2>/dev/null | head -c 300))"
    sleep 2
  done
  if [ "${mode}" = warm ]; then
    [ "$(fn_pod_uids)" = "${uids_before}" ] || fail "the warm pods changed during the hold: now '$(fn_pod_uids)', was '${uids_before}'"
    # The label goes back BEFORE the quota is deleted, and only on the target pod.
    k -n "${NS}" label pod "${tpod}" "serving.knative.dev/revisionUID=${tlabel}" --overwrite >/dev/null
    RESTORE_DETACH="${RESTORE_DETACH/${tpod}=${tlabel} /}"
  else
    [ "$(all_pods "${GO_FN}")" = 0 ] || fail "a ${GO_FN} pod exists while the quota admits none: the call is not being held"
    k -n "${NS}" delete resourcequota "${HOLD_QUOTA}" >/dev/null
    RESTORE_QUOTA=0
    # The ReplicaSet retries a refused pod create with a backoff that grows with every refusal:
    # touching it makes it sync now instead of when the backoff ends.
    k -n "${NS}" annotate replicaset -l "serving.knative.dev/service=${GO_FN}" "apps.kn-next.dev/z11-release=${SECONDS}" --overwrite >/dev/null
  fi
  wait "$(cat "${HELD_PIDFILE}")" || fail "the held call did not get an answer: $(head -c 300 "${WORK}/held.err")"
  : >"${HELD_PIDFILE}"
  HELD_FOR=$((SECONDS - start))
  HELD_STATUS="$(jq -r .status "${out}")"
  HELD_CODE="$(jq -r '.code // ""' "${out}")"
  HELD_MESSAGE="$(jq -r '.message // ""' "${out}")"
  if [ "${mode}" = warm ]; then
    # The pod that answered, observed: the one whose queue-proxy counted this call. Read while
    # the others are still detached, before anything else can reach a pod.
    HELD_REQ_AFTER="$(request_snapshot)" || fail "cannot read the pods' request counters after the hold"
    HELD_POD_UID="$(answering_pod_uid "${HELD_REQ_BEFORE}" "${HELD_REQ_AFTER}")" || fail "the held call cannot be attributed to one pod (before: ${HELD_REQ_BEFORE//$'\n'/; } after: ${HELD_REQ_AFTER//$'\n'/; })"
    release_pods
    # Exactly the pods that were there, and the target among them: nothing was replaced.
    [ "$(fn_pod_uids)" = "${uids_before}" ] || fail "after the answer the pods are '$(fn_pod_uids)', want exactly '${uids_before}'"
  fi
  [ "${HELD_FOR}" -ge "$1" ] || fail "the held call was outstanding only ${HELD_FOR}s, want at least $1s"
}

# The control comes first and uses the same mechanism: a call held ${CONTROL_HELD_SECONDS}s
# (inside the token's life) is ACCEPTED, so what refuses the longer call is its age, not
# the hold itself, a stripped header or a replay. The verifier does not accept a token with
# a longer life, so the control shortens the hold instead of lengthening the token.
phase_held() {
  log "held: a call the activator holds longer than the token's life (${HELD_SECONDS}s), with a shorter hold as control"
  [ -n "${ZONE_HOST}" ] || start_forwards
  export_key "${WORK}/key-held" current
  hold_call "${CONTROL_HELD_SECONDS}"
  echo "HELD-CONTROL: outstanding ${HELD_FOR}s through the activator -> ${HELD_STATUS} ${HELD_CODE}"
  [ "${HELD_STATUS}" = 404 ] && [ "${HELD_CODE}" = not_found ] \
    || fail "control: a call held ${HELD_FOR}s (inside the token's life) got status ${HELD_STATUS} code '${HELD_CODE}', want 404 not_found (the hold itself must not refuse a valid token)"
  ok "control: a call held ${HELD_FOR}s in the activator, inside the token's life, was accepted (404 not_found)"
  hold_call "${HELD_SECONDS}"
  echo "HELD: outstanding ${HELD_FOR}s through the activator -> ${HELD_STATUS} ${HELD_CODE} '${HELD_MESSAGE}'"
  [ "${HELD_STATUS}" = 401 ] && [ "${HELD_CODE}" = unauthenticated ] && [ "${HELD_MESSAGE}" = "token rejected" ] \
    || fail "a call held ${HELD_FOR}s got status ${HELD_STATUS} code '${HELD_CODE}' message '${HELD_MESSAGE}', want 401 unauthenticated 'token rejected' (an expired token must never be accepted, and the header must have reached the function)"
  ok "a call held ${HELD_FOR}s in the activator was refused by the function (401 unauthenticated, token rejected) while the ${CONTROL_HELD_SECONDS}s control with the same mechanism was accepted: the token expired"
  wait_until 120 3 "a Ready ${GO_FN} pod after the hold is released" '[ -n "$(fn_pod_ip)" ]'
  fn_probe "${WORK}/key-held" fresh
  [ "${PR_STATUS}" = 404 ] && [ "${PR_CODE}" = not_found ] \
    || fail "after the hold a fresh token got status ${PR_STATUS} code '${PR_CODE}', want 404 not_found (token validation must still work)"
  foreign_get "Bearer not-a-token"
  [ "${FC_STATUS}" = 401 ] && [ "${FC_CODE}" = unauthenticated ] && [ "${FC_MESSAGE}" = "token rejected" ] \
    || fail "after the hold a garbage token: status ${FC_STATUS} code '${FC_CODE}' message '${FC_MESSAGE}', want 401 unauthenticated 'token rejected'"
  ok "after the hold a fresh token is accepted (404 not_found) and a garbage token is still refused (token validation intact)"
}

# ---------------------------------------------------------------- phase: heldwarm

# The combined case ADR-0004 names, on the verifier as built. Its order on every call is:
# re-read the mounted JWKS when its mtime or size changed or it is older than JWKSRereadInterval
# (10 s), THEN look the kid up (an unknown kid is refused, it is not fetched again), then check
# the signature, and only then the lifetime (exp). So a pod that is idle for more than 10 s always
# re-reads the file at the start of its next call, and a call held for more than 60 s reaches the
# exp check only after the kid and signature checks have passed. The refusal's wire message is
# "token rejected" for every cause and the verifier logs nothing about a refusal, so no log line or
# counter can tell an unknown kid from an expired token: what the drill can prove is the pair
# below, on pods whose in-memory key set is the OLD one.
#
# Two warm pods are kept (minScale and maxScale 2). Each is isolated in turn and given ONE call
# with the old key, so each caches the old set, and neither gets another call. The key is then
# rotated and retired under them. The call that proves the pod finds the new key it does not
# hold (the control) is held 30 s on pod A and must be accepted. The call held 80 s, on pod B,
# which is in the same stale-cache state, must be refused. Only the target pod is re-attached to
# the Service for each call, so it is the one that answers, and the pod set is checked unchanged.
phase_heldwarm() {
  log "heldwarm: warm pods with the old key set cached, the key rotated, one call held past the token's life"
  [ -n "${ZONE_HOST}" ] || start_forwards
  local old_kid new_kid wnonce rev_before wuid_a wuid_b wuids wretired_at bctl_before bctl_after
  [ -z "$(secret_get next.kid)" ] && [ -z "$(secret_get previous.kid)" ] \
    || fail "warm pod: a rotation is already in flight; run the deploy phase for a clean zone"
  old_kid="$(secret_get current.kid)"
  export_key "${WORK}/key-pre" current
  rev_before="$(k -n "${NS}" get ksvc "${GO_FN}" -o jsonpath='{.status.latestReadyRevisionName}')"
  RESTORE_MINSCALE=1
  k -n "${NS}" patch backendservice "${GO_FN}" --type merge -p '{"spec":{"scaling":{"minScale":2,"maxScale":2}}}' >/dev/null
  wait_until 300 3 "two warm ${GO_FN} pods on a new revision, the old one drained" \
    '[ "$(k -n "${NS}" get ksvc "${GO_FN}" -o jsonpath="{.status.latestReadyRevisionName}")" != "${rev_before}" ] && [ "$(all_pods "${GO_FN}")" = 2 ] && [ "$(fn_pods_ready | wc -l | tr -d " ")" = 2 ]'
  wuids="$(fn_pod_uids)"
  read -r wuid_a wuid_b <<<"${wuids}"
  [ -n "${wuid_a}" ] && [ -n "${wuid_b}" ] && [ "${wuid_a}" != "${wuid_b}" ] || fail "want two distinct warm pods, have '${wuids}'"
  isolate_pods "${wuid_a}"
  fn_probe "${WORK}/key-pre" load-a
  [ "${PR_STATUS}" = 404 ] && [ "${PR_CODE}" = not_found ] \
    || fail "the warm pod A answered the current key with status ${PR_STATUS} code '${PR_CODE}', want 404 not_found (it must load the key set)"
  release_pods
  isolate_pods "${wuid_b}"
  fn_probe "${WORK}/key-pre" load-b
  [ "${PR_STATUS}" = 404 ] && [ "${PR_CODE}" = not_found ] \
    || fail "the warm pod B answered the current key with status ${PR_STATUS} code '${PR_CODE}', want 404 not_found (it must load the key set)"
  release_pods
  ok "both warm pods (${wuid_a}, ${wuid_b}) loaded the key set with ${old_kid} (404 not_found) and get no other call until their held one"

  log "heldwarm 1/3: rotate and retire the key while those pods are warm and idle"
  wnonce="z11w-$(date +%s)"
  k -n "${NS}" annotate nextapp "${ZONE}" "apps.kn-next.dev/rotate-signing-key=${wnonce}" --overwrite
  wait_until 60 1 "the operator to take the rotation request under the warm pod" '[ -n "$(secret_get next.kid)" ]'
  new_kid="$(secret_get next.kid)"
  [ -n "${new_kid}" ] && [ "${new_kid}" != "${old_kid}" ] || fail "no new key was staged by the rotation request"
  wait_until $((BOUND_SECONDS + 150)) 2 "signing to switch under the warm pod" '[ "$(secret_get current.kid)" = "${new_kid}" ]'
  k -n "${NS}" annotate secret "${KEY_SECRET}" \
    "apps.kn-next.dev/signing-key-switched-at=$(node -p 'new Date(Date.now() - 7200 * 1000).toISOString()')" --overwrite
  k -n "${OPERATOR_NS}" rollout restart deployment.apps/kn-next-operator-controller-manager
  k -n "${OPERATOR_NS}" rollout status deployment.apps/kn-next-operator-controller-manager --timeout=180s
  wait_until 180 3 "the previous key to leave the Secret under the warm pod" '[ -z "$(secret_get previous.kid)" ]'
  wait_until 30 1 "the JWKS to publish only the new key under the warm pod" '[ "$(jwks_kids)" = "${new_kid}" ]'
  wretired_at="$(jwks_written_at)"
  [ "$(fn_pod_uids)" = "${wuids}" ] && [ "$(fn_pods_started_max)" -lt "${wretired_at}" ] \
    || fail "the pods are '$(fn_pod_uids)' (latest start $(fn_pods_started_max)), want the warm pods '${wuids}' all started before the retirement at ${wretired_at}: the rotation was not done under warm pods"
  ok "retired: only ${new_kid} remains; the two warm pods (started before it) never restarted and served no call since they loaded ${old_kid}"

  log "heldwarm 2/3: control, pod A (old set cached), new-key token held ${CONTROL_HELD_SECONDS}s"
  export_key "${WORK}/key-held" current
  hold_call "${CONTROL_HELD_SECONDS}" warm "${wuid_a}"
  echo "HELDWARM-CONTROL: outstanding ${HELD_FOR}s -> ${HELD_STATUS} ${HELD_CODE}"
  [ "${HELD_STATUS}" = 404 ] && [ "${HELD_CODE}" = not_found ] \
    || fail "warm pod control: a call held ${HELD_FOR}s (inside the token's life) got status ${HELD_STATUS} code '${HELD_CODE}', want 404 not_found (a pod holding the old key set must find the new key)"
  assert_answered_by "${wuid_a}" "${HELD_REQ_BEFORE}" "${HELD_REQ_AFTER}" \
    || fail "warm pod control: the call was not answered by the warm pod ${wuid_a} (the pod whose request counter rose is ${HELD_POD_UID})"
  ok "control: pod A, which cached only the old key set, accepted the new key after a ${HELD_FOR}s hold (404 not_found)"

  log "heldwarm 3/3: pod B, in the same state, new-key token held ${HELD_SECONDS}s, then a fresh token"
  hold_call "${HELD_SECONDS}" warm "${wuid_b}"
  echo "HELDWARM: outstanding ${HELD_FOR}s -> ${HELD_STATUS} ${HELD_CODE} '${HELD_MESSAGE}'"
  [ "${HELD_STATUS}" = 401 ] && [ "${HELD_CODE}" = unauthenticated ] && [ "${HELD_MESSAGE}" = "token rejected" ] \
    || fail "warm pod: a call held ${HELD_FOR}s got status ${HELD_STATUS} code '${HELD_CODE}' message '${HELD_MESSAGE}', want 401 unauthenticated 'token rejected' (an expired token must never be accepted, and the header must have reached the function)"
  assert_answered_by "${wuid_b}" "${HELD_REQ_BEFORE}" "${HELD_REQ_AFTER}" \
    || fail "the held call was not answered by the warm pod ${wuid_b} (the pod whose request counter rose is ${HELD_POD_UID})"
  ok "a call held ${HELD_FOR}s was refused by pod B, in the same stale-cache state pod A accepted it in (401 unauthenticated, token rejected)"
  # Positive control on pod B: the same pod, right after its refusal, accepts a FRESH token. So
  # the refusal was the token's age, and pod B is healthy and still validates. The call is sent
  # to B alone (the others are detached) and the counters confirm B is the pod that answered.
  isolate_pods "${wuid_b}"
  bctl_before="$(request_snapshot)" || fail "cannot read the pods' request counters before pod B's fresh call"
  fn_probe "${WORK}/key-held" fresh-b
  bctl_after="$(request_snapshot)" || fail "cannot read the pods' request counters after pod B's fresh call"
  release_pods
  echo "HELDWARM-FRESH-B: fresh token to pod B -> ${PR_STATUS} ${PR_CODE}"
  [ "${PR_STATUS}" = 404 ] && [ "${PR_CODE}" = not_found ] \
    || fail "warm pod B: a FRESH token right after its refusal got status ${PR_STATUS} code '${PR_CODE}', want 404 not_found (the refusal must have been the token's age, and pod B must be healthy)"
  assert_answered_by "${wuid_b}" "${bctl_before}" "${bctl_after}" \
    || fail "warm pod B: the fresh-token call was not answered by pod B ${wuid_b}"
  ok "positive control: pod B accepts a fresh token (404 not_found) right after refusing the 80s-old one, so the refusal was the token's age"
  foreign_get "Bearer not-a-token"
  [ "${FC_STATUS}" = 401 ] && [ "${FC_CODE}" = unauthenticated ] && [ "${FC_MESSAGE}" = "token rejected" ] \
    || fail "warm pod: after the holds a garbage token: status ${FC_STATUS} code '${FC_CODE}' message '${FC_MESSAGE}', want 401 unauthenticated 'token rejected'"
  k -n "${NS}" patch backendservice "${GO_FN}" --type merge -p '{"spec":{"scaling":{"minScale":0,"maxScale":1}}}' >/dev/null
  RESTORE_MINSCALE=0
  ok "token validation is intact after the holds, and ${GO_FN} is back on minScale 0, maxScale 1"
}

# ---------------------------------------------------------------- main

for phase in ${PHASES}; do
  case "${phase}" in
    up | deploy | token | direct | policyoff | noauth | rotcold | held | heldwarm) ;;
    *) fail "unknown phase '${phase}' (up deploy token direct policyoff noauth rotcold held heldwarm)" ;;
  esac
done
if has_phase up; then phase_up; fi
use_cluster
k -n kube-system get daemonset calico-node >/dev/null 2>&1 \
  || fail "the cluster runs no Calico: NetworkPolicy would not be enforced and the drill would prove nothing"
if has_phase deploy; then phase_deploy; fi
if has_phase token; then phase_token; fi
if has_phase direct; then phase_direct; fi
if has_phase policyoff; then phase_policyoff; fi
if has_phase noauth; then phase_noauth; fi
if has_phase rotcold; then phase_rotcold; fi
if has_phase held; then phase_held; fi
if has_phase heldwarm; then phase_heldwarm; fi
log "Z11 drill: ${PHASES} passed"
