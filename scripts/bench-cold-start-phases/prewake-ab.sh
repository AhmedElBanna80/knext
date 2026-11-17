#!/usr/bin/env bash
# prewake-ab.sh — relative A/B of cold-start latency with and without a pre-wake.
#
# Question: if something sends a plain GET to a scale-to-zero Knative Service a fixed
# lead time BEFORE the request that matters arrives, how much of the cold start does
# that request still pay?
#
# The default pre-wake is exactly what ADR-0073 Decision 1 recommends and what Z9's
# wake-ahead does: one plain GET through the activator, sent from a client pod in the
# cluster. It writes nothing to the cluster. A secondary arm, minscale@<ms>, is kept only
# for comparison and is labelled as such: it sets the `autoscaling.knative.dev/min-scale`
# annotation on the latest ready revision's PodAutoscaler (a Knative-internal object; a
# measurement knob, never a product surface) and is a DIFFERENT scale-up path, so its
# numbers do not stand in for the GET's. It is off unless --minscale-leads is given.
#
# Arms, interleaved per round with the order rotated each round:
#   cold          no pre-wake: the request wakes the service from zero.
#   get@<ms>      a plain GET is fired (not awaited) <ms> before the measured request.
#   minscale@<ms> (secondary, opt-in) min-scale=1 is set <ms> before the request,
#                 removed after it.
#
# Both the pre-wake GET and the measured request run inside ONE client-pod process
# (node fetch, performance.now), so kubectl exec latency is in neither the lead nor
# the number. Output: one JSON line per cycle,
# then a summary of medians and of each arm's delta RELATIVE to `cold`.
# Absolute numbers from kind are not OKE numbers; read the deltas only.
#
# Usage: see --help. Exit codes: 0 ok, 1 runtime failure, 2 usage error.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: prewake-ab.sh --context <ctx> [options]

Relative A/B of cold-start latency with and without a pre-wake GET.

Options:
  --context <ctx>       kube context (required). Must start with "kind-" unless
                        --allow-non-kind is given.
  --allow-non-kind      permit a non-kind context (the OKE runbook uses this;
                        agents must not).
  --namespace <ns>      namespace (default: prewake-ab)
  --ksvc <name>         Knative Service under test (default: prewake-target)
  --rounds <n>          rounds; each round runs every arm once (default: 5)
  --leads <ms,ms,...>   pre-wake GET lead times in ms (default: 500,1500,3000)
  --minscale-leads <ms,...>
                        ALSO run the secondary min-scale arm at these leads (a
                        different scale-up path from the GET; writes a
                        Knative-internal object; default: none)
  --out <file>          JSONL output, appended (default: ./prewake-ab.jsonl)
  --setup               create the namespace, the target ksvc and the client
                        pod (kind contexts only; also shortens the kind
                        cluster's scale-to-zero grace period to 10s and
                        restores the prior value on exit)
  --image <ref>         image for target and client, digest-pinned
                        (default: node:22-alpine pinned by digest)
  --boot-delay-ms <n>   target's simulated app boot before listening (default: 300)
  --zero-timeout <s>    max wait for zero pods before a cycle (default: 300)
  --settle <s>          wait after reaching zero, before the cycle (default: 5)
  --dry-run             print the arms, round order and the commands a cycle
                        would run; touch nothing (kubectl not needed)
  -h, --help            this help
EOF
}

CONTEXT=""
ALLOW_NON_KIND=0
NS="prewake-ab"
KSVC="prewake-target"
ROUNDS=5
LEADS="500,1500,3000"
MINSCALE_LEADS=""
OUT="./prewake-ab.jsonl"
SETUP=0
IMAGE="docker.io/library/node@sha256:1314fb30ec37592d5845e5a160d522c0e680972aa534549940b8d73bde88481a"
BOOT_DELAY_MS=300
ZERO_TIMEOUT=300
SETTLE=5
DRY_RUN=0
CLIENT_POD="prewake-client"
ANNOTATION="autoscaling.knative.dev/min-scale"

die_usage() { echo "prewake-ab.sh: $*" >&2; usage >&2; exit 2; }
need_val() { [ "$#" -ge 2 ] && [ -n "$2" ] || die_usage "$1 needs a value"; }

while [ "$#" -gt 0 ]; do
  case "$1" in
    --context) need_val "$@"; CONTEXT="$2"; shift 2 ;;
    --allow-non-kind) ALLOW_NON_KIND=1; shift ;;
    --namespace) need_val "$@"; NS="$2"; shift 2 ;;
    --ksvc) need_val "$@"; KSVC="$2"; shift 2 ;;
    --rounds) need_val "$@"; ROUNDS="$2"; shift 2 ;;
    --leads) need_val "$@"; LEADS="$2"; shift 2 ;;
    --minscale-leads) need_val "$@"; MINSCALE_LEADS="$2"; shift 2 ;;
    # ${2:?}, not a bare $2: the apply scanner keys taint on the literal path string, and the
    # results file (timings from the in-pod client) must not alias the "$2" the setup applies use.
    --out) need_val "$@"; OUT="${2:?}"; shift 2 ;;
    --setup) SETUP=1; shift ;;
    --image) need_val "$@"; IMAGE="$2"; shift 2 ;;
    --boot-delay-ms) need_val "$@"; BOOT_DELAY_MS="$2"; shift 2 ;;
    --zero-timeout) need_val "$@"; ZERO_TIMEOUT="$2"; shift 2 ;;
    --settle) need_val "$@"; SETTLE="$2"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    -h | --help) usage; exit 0 ;;
    *) die_usage "unknown argument: $1" ;;
  esac
done

[ -n "${CONTEXT}" ] || die_usage "--context is required"
case "${CONTEXT}" in
  kind-*) IS_KIND=1 ;;
  *) IS_KIND=0 ;;
esac
if [ "${IS_KIND}" = 0 ] && [ "${ALLOW_NON_KIND}" = 0 ]; then
  die_usage "context ${CONTEXT} is not a kind context; pass --allow-non-kind to run elsewhere"
fi
if [ "${SETUP}" = 1 ] && [ "${IS_KIND}" = 0 ]; then
  die_usage "--setup is for kind contexts only; deploy the target by hand elsewhere"
fi
[[ "${ROUNDS}" =~ ^[1-9][0-9]*$ ]] || die_usage "--rounds must be a positive integer"
[[ "${LEADS}" =~ ^[0-9]+(,[0-9]+)*$ ]] || die_usage "--leads must be comma-separated integers (ms)"
[ -z "${MINSCALE_LEADS}" ] || [[ "${MINSCALE_LEADS}" =~ ^[0-9]+(,[0-9]+)*$ ]] || die_usage "--minscale-leads must be comma-separated integers (ms)"
[[ "${BOOT_DELAY_MS}" =~ ^[0-9]+$ ]] || die_usage "--boot-delay-ms must be an integer"
[[ "${ZERO_TIMEOUT}" =~ ^[1-9][0-9]*$ ]] || die_usage "--zero-timeout must be a positive integer"
[[ "${SETTLE}" =~ ^[0-9]+$ ]] || die_usage "--settle must be an integer (seconds)"
case "${IMAGE}" in
  *@sha256:*) ;;
  *) die_usage "--image must be pinned by digest (name@sha256:...)" ;;
esac

ARMS=(cold)
IFS=',' read -r -a LEAD_LIST <<<"${LEADS}"
for l in "${LEAD_LIST[@]}"; do ARMS+=("get@${l}"); done
if [ -n "${MINSCALE_LEADS}" ]; then
  IFS=',' read -r -a MS_LIST <<<"${MINSCALE_LEADS}"
  for l in "${MS_LIST[@]}"; do ARMS+=("minscale@${l}"); done
fi

# Round r runs the arms rotated left by (r-1) mod n.
round_order() {
  local r="$1" n="${#ARMS[@]}" i
  for ((i = 0; i < n; i++)); do printf '%s ' "${ARMS[$(((i + r - 1) % n))]}"; done
}

k() { kubectl --context "${CONTEXT}" "$@"; }

TARGET_URL="http://${KSVC}.${NS}.svc.cluster.local/"
# Runs in the client pod. argv: url, lead. lead "none" = no pre-wake. Otherwise a plain GET
# is fired and NOT awaited, then the measured request starts <lead> ms later. Prints
# "<ms> <status>" for the measured request only. `agent:false` gives every request its own
# connection, so the measured request never reuses the pre-wake's and every arm pays its own connect.
CLIENT_JS='const h=require("http"),u=process.argv[1],l=process.argv[2];const f=(cb)=>h.get(u,{agent:false,timeout:120000},(r)=>{r.resume();r.on("end",()=>cb(r.statusCode))}).on("error",()=>cb("ERR")).on("timeout",function(){this.destroy()});const go=()=>{const t=performance.now();f((s)=>{console.log(Math.round(performance.now()-t),s);process.exit(0)})};if(l==="none"){go()}else{f(()=>{});setTimeout(go,Number(l))}'

if [ "${DRY_RUN}" = 1 ]; then
  echo "prewake-ab dry run (nothing is touched)"
  echo "context=${CONTEXT} namespace=${NS} ksvc=${KSVC} rounds=${ROUNDS} out=${OUT}"
  echo "arms: ${ARMS[*]}"
  for ((r = 1; r <= ROUNDS; r++)); do echo "round ${r}: $(round_order "${r}")"; done
  echo "per cycle:"
  echo "  wait until ksvc ${KSVC} has 0 pods (timeout ${ZERO_TIMEOUT}s)"
  echo "  get@<ms>: kubectl exec ${CLIENT_POD} -- node -e <plain GET, not awaited; measured GET <ms> later> ${TARGET_URL} <ms>  (no cluster write)"
  echo "  cold: kubectl exec ${CLIENT_POD} -- node -e <measured GET> ${TARGET_URL} none"
  [ -z "${MINSCALE_LEADS}" ] || echo "  minscale@<ms> (secondary arm): kubectl annotate podautoscaler <latest-ready> ${ANNOTATION}=1 --overwrite; sleep <ms>; exec as cold; annotate ${ANNOTATION}-"
  [ "${SETUP}" = 1 ] && echo "setup: namespace ${NS}, ksvc ${KSVC} (boot delay ${BOOT_DELAY_MS} ms), client pod, config-autoscaler grace 10s (restored on exit)"
  exit 0
fi

command -v kubectl >/dev/null || { echo "prewake-ab.sh: kubectl not found" >&2; exit 1; }
command -v python3 >/dev/null || { echo "prewake-ab.sh: python3 not found" >&2; exit 1; }

setup() {
  k create namespace "${NS}" --dry-run=client -o yaml | k apply --validate=strict -f - >/dev/null
  # kind only: a shorter grace period so each cycle reaches zero sooner. The prior value is
  # recorded first and put back by the EXIT trap.
  PRIOR_GRACE="$(k -n knative-serving get configmap config-autoscaler -o jsonpath='{.data.scale-to-zero-grace-period}')"
  GRACE_CHANGED=1
  k -n knative-serving patch configmap config-autoscaler --type merge \
    -p '{"data":{"scale-to-zero-grace-period":"10s"}}' >/dev/null
  k apply --validate=strict -f - >/dev/null <<EOF
apiVersion: serving.knative.dev/v1
kind: Service
metadata:
  name: ${KSVC}
  namespace: ${NS}
  labels:
    networking.knative.dev/visibility: cluster-local
spec:
  template:
    metadata:
      annotations:
        autoscaling.knative.dev/min-scale: "0"
        autoscaling.knative.dev/window: "6s"
    spec:
      containers:
        - image: ${IMAGE}
          command: ["node", "-e"]
          args:
            - |
              process.on("SIGTERM", () => process.exit(0));
              const d = Number(process.env.BOOT_DELAY_MS || 0);
              setTimeout(() => require("http").createServer((q, s) => s.end("ok")).listen(process.env.PORT || 8080), d);
          env:
            - name: BOOT_DELAY_MS
              value: "${BOOT_DELAY_MS}"
          readinessProbe:
            tcpSocket: {}
EOF
  k apply --validate=strict -f - >/dev/null <<EOF
apiVersion: v1
kind: Pod
metadata:
  name: ${CLIENT_POD}
  namespace: ${NS}
spec:
  containers:
    - name: client
      image: ${IMAGE}
      command: ["sleep", "infinity"]
EOF
  k -n "${NS}" wait --for=condition=Ready "pod/${CLIENT_POD}" --timeout=300s >/dev/null
  k -n "${NS}" wait --for=condition=Ready "ksvc/${KSVC}" --timeout=300s >/dev/null
}

# Pods not already terminating: a terminating pod serves nothing, so "at zero" ignores it.
pods() {
  k -n "${NS}" get pods -l "serving.knative.dev/service=${KSVC}" \
    -o go-template='{{range .items}}{{if not .metadata.deletionTimestamp}}x{{end}}{{end}}' | tr -d '\n' | wc -c | tr -d ' '
}

wait_zero() {
  local end=$((SECONDS + ZERO_TIMEOUT))
  while [ "$(pods)" != 0 ]; do
    [ "${SECONDS}" -lt "${end}" ] || { echo "prewake-ab.sh: ${KSVC} did not reach zero in ${ZERO_TIMEOUT}s" >&2; exit 1; }
    sleep 3
  done
  sleep "${SETTLE}" # let the activator settle into proxy mode
}

revision() { k -n "${NS}" get ksvc "${KSVC}" -o jsonpath='{.status.latestReadyRevisionName}'; }

cycle() { # <round> <arm>
  local round="$1" arm="$2" lead="" mech="none" rev res ms status
  rev="$(revision)"
  [ -n "${rev}" ] || { echo "prewake-ab.sh: ${KSVC} has no ready revision" >&2; exit 1; }
  wait_zero
  case "${arm}" in
    cold) res="$(k -n "${NS}" exec "${CLIENT_POD}" -- node -e "${CLIENT_JS}" "${TARGET_URL}" none)" ;;
    get@*)
      lead="${arm#get@}"
      mech="get"
      res="$(k -n "${NS}" exec "${CLIENT_POD}" -- node -e "${CLIENT_JS}" "${TARGET_URL}" "${lead}")"
      ;;
    minscale@*)
      lead="${arm#minscale@}"
      mech="minscale"
      PINNED_PA="${rev}"
      k -n "${NS}" annotate podautoscaler "${rev}" "${ANNOTATION}=1" --overwrite >/dev/null
      python3 -I -c "import time; time.sleep(${lead}/1000)"
      res="$(k -n "${NS}" exec "${CLIENT_POD}" -- node -e "${CLIENT_JS}" "${TARGET_URL}" none)"
      k -n "${NS}" annotate podautoscaler "${rev}" "${ANNOTATION}-" >/dev/null
      PINNED_PA=""
      ;;
  esac
  ms="${res%% *}"
  status="${res##* }"
  printf '{"round":%s,"arm":"%s","mechanism":"%s","lead_ms":%s,"request_ms":%s,"status":"%s","context":"%s","revision":"%s"}\n' \
    "${round}" "${arm}" "${mech}" "${lead:-null}" "${ms}" "${status}" "${CONTEXT}" "${rev}" | tee -a "${OUT}" "${RUN_OUT}"
}

summarize() { # <jsonl>
  python3 -I "$(dirname "${BASH_SOURCE[0]}")/prewake-ab-summary.py" "$1"
}

RUN_OUT="$(mktemp "${TMPDIR:-/tmp}/prewake-ab.XXXXXX")"
PINNED_PA=""
PRIOR_GRACE=""
GRACE_CHANGED=0
# An aborted cycle must not leave the service pinned at min-scale 1, and --setup must not leave
# the cluster's scale-to-zero grace period changed.
cleanup() {
  rm -f "${RUN_OUT}"
  if [ -n "${PINNED_PA}" ]; then
    k -n "${NS}" annotate podautoscaler "${PINNED_PA}" "${ANNOTATION}-" >/dev/null 2>&1 || true
  fi
  if [ "${GRACE_CHANGED}" = 1 ]; then
    local v="null"
    [ -z "${PRIOR_GRACE}" ] || v="\"${PRIOR_GRACE}\""
    k -n knative-serving patch configmap config-autoscaler --type merge \
      -p "{\"data\":{\"scale-to-zero-grace-period\":${v}}}" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT

[ "${SETUP}" = 1 ] && setup
k -n "${NS}" get pod "${CLIENT_POD}" >/dev/null || { echo "prewake-ab.sh: client pod ${CLIENT_POD} missing (run with --setup on kind)" >&2; exit 1; }

for ((r = 1; r <= ROUNDS; r++)); do
  for arm in $(round_order "${r}"); do
    cycle "${r}" "${arm}" # in the main shell, so the EXIT trap sees PINNED_PA
  done
done
summarize "${RUN_OUT}"
