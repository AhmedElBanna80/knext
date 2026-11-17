#!/usr/bin/env bash
# prewake-ab.sh — relative A/B of cold-start latency with and without a pre-wake.
#
# Question: if something raises a scale-to-zero Knative Service's min-scale to 1
# a fixed lead time BEFORE the request arrives, how much of the cold start does
# the request still pay? The pre-wake uses an existing knob only: the
# `autoscaling.knative.dev/min-scale` annotation, set on the latest ready
# revision's PodAutoscaler (same name as the revision). The annotation on the
# Revision itself is NOT copied to an existing PodAutoscaler (measured on kind,
# Knative v1.16: no pod in 12 s), so the harness annotates the PodAutoscaler.
# That object is Knative-internal; this is a measurement knob, not a product
# surface. No knext CRD field or operator change is involved; this is evidence
# for a Proposed ADR.
#
# Arms, interleaved per round with the order rotated each round:
#   cold          no pre-wake: the request wakes the service from zero.
#   prewake@<ms>  min-scale=1 is set <ms> before the request, removed after it.
#
# The request is timed INSIDE a client pod (node fetch, performance.now), so
# kubectl exec latency is not in the number. Output: one JSON line per cycle,
# then a summary of medians and of each arm's delta RELATIVE to `cold`.
# Absolute numbers from kind are not OKE numbers; read the deltas only.
#
# Usage: see --help. Exit codes: 0 ok, 1 runtime failure, 2 usage error.
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: prewake-ab.sh --context <ctx> [options]

Relative A/B of cold-start latency with and without a min-scale pre-wake.

Options:
  --context <ctx>       kube context (required). Must start with "kind-" unless
                        --allow-non-kind is given.
  --allow-non-kind      permit a non-kind context (the OKE runbook uses this;
                        agents must not).
  --namespace <ns>      namespace (default: prewake-ab)
  --ksvc <name>         Knative Service under test (default: prewake-target)
  --rounds <n>          rounds; each round runs every arm once (default: 5)
  --leads <ms,ms,...>   pre-wake lead times in ms (default: 500,1500,3000)
  --out <file>          JSONL output, appended (default: ./prewake-ab.jsonl)
  --setup               create the namespace, the target ksvc and the client
                        pod (kind contexts only; also shortens the kind
                        cluster's scale-to-zero grace period to 10s)
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
    --out) need_val "$@"; OUT="$2"; shift 2 ;;
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
[[ "${BOOT_DELAY_MS}" =~ ^[0-9]+$ ]] || die_usage "--boot-delay-ms must be an integer"
[[ "${ZERO_TIMEOUT}" =~ ^[1-9][0-9]*$ ]] || die_usage "--zero-timeout must be a positive integer"
[[ "${SETTLE}" =~ ^[0-9]+$ ]] || die_usage "--settle must be an integer (seconds)"
case "${IMAGE}" in
  *@sha256:*) ;;
  *) die_usage "--image must be pinned by digest (name@sha256:...)" ;;
esac

ARMS=(cold)
IFS=',' read -r -a LEAD_LIST <<<"${LEADS}"
for l in "${LEAD_LIST[@]}"; do ARMS+=("prewake@${l}"); done

# Round r runs the arms rotated left by (r-1) mod n.
round_order() {
  local r="$1" n="${#ARMS[@]}" i
  for ((i = 0; i < n; i++)); do printf '%s ' "${ARMS[$(((i + r - 1) % n))]}"; done
}

k() { kubectl --context "${CONTEXT}" "$@"; }

TARGET_URL="http://${KSVC}.${NS}.svc.cluster.local/"
# The request, timed inside the client pod. Prints "<ms> <status>".
CLIENT_JS='const u=process.argv[1];const t=performance.now();fetch(u,{signal:AbortSignal.timeout(120000)}).then(async r=>{await r.text();console.log(Math.round(performance.now()-t),r.status)}).catch(e=>{console.log(Math.round(performance.now()-t),"ERR")})'

if [ "${DRY_RUN}" = 1 ]; then
  echo "prewake-ab dry run (nothing is touched)"
  echo "context=${CONTEXT} namespace=${NS} ksvc=${KSVC} rounds=${ROUNDS} out=${OUT}"
  echo "arms: ${ARMS[*]}"
  for ((r = 1; r <= ROUNDS; r++)); do echo "round ${r}: $(round_order "${r}")"; done
  echo "per cycle:"
  echo "  wait until ksvc ${KSVC} has 0 pods (timeout ${ZERO_TIMEOUT}s)"
  echo "  prewake@<ms>: kubectl annotate podautoscaler <latest-ready> ${ANNOTATION}=1 --overwrite; sleep <ms>"
  echo "  kubectl exec ${CLIENT_POD} -- node -e <timed fetch> ${TARGET_URL}"
  echo "  prewake@<ms>: kubectl annotate podautoscaler <latest-ready> ${ANNOTATION}-"
  [ "${SETUP}" = 1 ] && echo "setup: namespace ${NS}, ksvc ${KSVC} (boot delay ${BOOT_DELAY_MS} ms), client pod, config-autoscaler grace 10s"
  exit 0
fi

command -v kubectl >/dev/null || { echo "prewake-ab.sh: kubectl not found" >&2; exit 1; }
command -v python3 >/dev/null || { echo "prewake-ab.sh: python3 not found" >&2; exit 1; }

setup() {
  k create namespace "${NS}" --dry-run=client -o yaml | k apply --validate=strict -f - >/dev/null
  # kind only: a shorter grace period so each cycle reaches zero sooner.
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
  local round="$1" arm="$2" lead="" rev res ms status
  rev="$(revision)"
  [ -n "${rev}" ] || { echo "prewake-ab.sh: ${KSVC} has no ready revision" >&2; exit 1; }
  wait_zero
  if [ "${arm}" != cold ]; then
    lead="${arm#prewake@}"
    PINNED_PA="${rev}"
    k -n "${NS}" annotate podautoscaler "${rev}" "${ANNOTATION}=1" --overwrite >/dev/null
    python3 -I -c "import time; time.sleep(${lead}/1000)"
  fi
  res="$(k -n "${NS}" exec "${CLIENT_POD}" -- node -e "${CLIENT_JS}" "${TARGET_URL}")"
  if [ "${arm}" != cold ]; then
    k -n "${NS}" annotate podautoscaler "${rev}" "${ANNOTATION}-" >/dev/null
    PINNED_PA=""
  fi
  ms="${res%% *}"
  status="${res##* }"
  printf '{"round":%s,"arm":"%s","lead_ms":%s,"request_ms":%s,"status":"%s","context":"%s","revision":"%s"}\n' \
    "${round}" "${arm}" "${lead:-null}" "${ms}" "${status}" "${CONTEXT}" "${rev}" | tee -a "${OUT}" "${RUN_OUT}"
}

summarize() { # <jsonl>
  python3 -I - "$1" <<'PY'
import json, statistics, sys
rows = [json.loads(l) for l in open(sys.argv[1]) if l.strip()]
ok = [r for r in rows if r["status"] == "200"]
bad = len(rows) - len(ok)
by = {}
for r in ok:
    by.setdefault(r["arm"], []).append(r["request_ms"])
if "cold" not in by:
    sys.exit("no successful cold cycles; cannot compute relative deltas")
cold = statistics.median(by["cold"])
print("arm            n  median_ms  delta_vs_cold_ms  relative")
def key(a):
    return -1 if a == "cold" else int(a.split("@")[1])
for arm in sorted(by, key=key):
    m = statistics.median(by[arm])
    print(f"{arm:<13}{len(by[arm]):>3}  {m:>9.0f}  {m - cold:>16.0f}  {m / cold:>8.2f}")
if bad:
    print(f"non-200 cycles excluded: {bad}")
print("kind absolute numbers are not OKE numbers; read the relative column.")
PY
}

[ "${SETUP}" = 1 ] && setup
k -n "${NS}" get pod "${CLIENT_POD}" >/dev/null || { echo "prewake-ab.sh: client pod ${CLIENT_POD} missing (run with --setup on kind)" >&2; exit 1; }

RUN_OUT="$(mktemp "${TMPDIR:-/tmp}/prewake-ab.XXXXXX")"
PINNED_PA=""
# An aborted cycle must not leave the service pinned at min-scale 1.
cleanup() {
  rm -f "${RUN_OUT}"
  if [ -n "${PINNED_PA}" ]; then
    k -n "${NS}" annotate podautoscaler "${PINNED_PA}" "${ANNOTATION}-" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT
for ((r = 1; r <= ROUNDS; r++)); do
  for arm in $(round_order "${r}"); do
    cycle "${r}" "${arm}" # in the main shell, so the EXIT trap sees PINNED_PA
  done
done
summarize "${RUN_OUT}"
