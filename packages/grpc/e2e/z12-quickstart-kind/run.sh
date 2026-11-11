#!/usr/bin/env bash
# Z12: the zone-functions quickstart, run for real on kind.
#
# A real Next.js zone made the way the docs say: `knext create`, `knext add
# function`, `knext generate`, `knext deploy function`, `knext deploy`. It then
# calls the function through the zone's generated glue from a Route Handler, on
# a production build. This is the lane that catches what the Node stand-in zone
# of the Z7/Z10 lanes cannot: the Next.js build, its cache and its runtime loader.
#
# Prerequisite: a kind cluster with Knative and the operator from this checkout,
# which the Z7 lane's `up` phase builds:
#   PHASES=up packages/grpc/e2e/z7-identity-kind/run.sh
#
# Phases (PHASES, space-separated; default all):
#   pack      build @getknext/{lib,db,core,grpc} from this checkout and pack them,
#             with one shared e2e version stamped into the packed manifests
#   scaffold  knext create (node, --cache-components), install the packs,
#             knext add function orders --lang go, an authorize() and a route
#             handler that read and write through the glue, knext generate
#   function  build and push the function image; knext deploy function with no
#             --proto-version (the served version comes from the contract)
#   zone      bind the function (backends + the printed specDigest) and knext deploy
#   calls     a write through the generated action (a Route Handler) that wakes the
#             cold function, a read of it, a NotFound that keeps its code through
#             'use cache', a refused caller
#   wake      a new zone revision carries the function in KNEXT_WAKE_FUNCTIONS (what
#             knext's process-start loader reads), and the function wakes before any call
#
# Environment: KIND_CLUSTER (default knext-z7-e2e), REGISTRY_PORT (5001),
# Z12_NAMESPACE (z12-e2e), PHASES, INTERNAL_PORT (18092), Z12_ZERO_TIMEOUT (600).
#
# The script never deletes a cluster. It deletes only the namespace it created
# (stamped with a label; a namespace without the label is refused).

set -euo pipefail
set +x
# No umask 077 here: knext deploy COPYs the app (under STATE) into an image that runs
# as a non-root user and keeps the host file modes, so the app's files must stay
# world-readable. WORK is still private: mktemp -d creates it 0700.

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG="$(cd "${HERE}/../.." && pwd)"
REPO="$(cd "${PKG}/../.." && pwd)"

CLUSTER="${KIND_CLUSTER:-knext-z7-e2e}"
REG_PORT="${REGISTRY_PORT:-5001}"
NS="${Z12_NAMESPACE:-z12-e2e}"
PHASES="${PHASES:-pack scaffold function zone calls wake}"
INTERNAL_PORT="${INTERNAL_PORT:-18092}"
ZERO_TIMEOUT="${Z12_ZERO_TIMEOUT:-600}"
OPERATOR_NS='kn-next-operator-system'
E2E_VERSION='2.0.0-e2e.0'

ZONE=shop
FN=orders
ZONE_HOST=""
ROLL_TAG=""

WORK="$(mktemp -d "${TMPDIR:-/tmp}/knext-z12-e2e.XXXXXX")"
# Survives between runs: the packs, the scaffolded app and the recorded digests.
STATE="${TMPDIR:-/tmp}/knext-z12-e2e-state-${CLUSTER}"
mkdir -p "${STATE}"
APP="${STATE}/shop"
export KUBECONFIG="${WORK}/kubeconfig"
PF_PIDS="${WORK}/pf.pids"
# shellcheck disable=SC2034 # read by build_push in kind-lane.sh
IMAGE_PREFIX=z12
# shellcheck source=../lib/kind-lane.sh
source "${HERE}/../lib/kind-lane.sh"

diagnostics() {
  echo "---- diagnostics (no Secret is read) ----" >&2
  k -n "${NS}" get nextapp,backendservice,ksvc,pods -o wide 2>&1 | tail -40 >&2 || true
  k -n "${NS}" logs -l "serving.knative.dev/service=${ZONE}" -c user-container --tail=40 >&2 2>&1 || true
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

# The zone's own CLI, from its install (what a user runs).
knext() { (cd "${APP}" && npx --no-install knext "$@"); }

# ---------------------------------------------------------------- phase: pack

phase_pack() {
  log "pack: @getknext/{lib,db,core,grpc} from this checkout, stamped ${E2E_VERSION}"
  local p
  for p in lib db kn-next grpc; do
    (cd "${REPO}/packages/${p}" && bun run build >"${WORK}/build-${p}.log" 2>&1) \
      || { tail -20 "${WORK}/build-${p}.log" >&2; fail "building packages/${p} failed"; }
  done
  rm -rf "${STATE}/packs" && mkdir -p "${STATE}/packs"
  for p in lib db kn-next grpc; do
    (cd "${REPO}/packages/${p}" && bun pm pack --destination "${WORK}/raw" >/dev/null) \
      || fail "packing packages/${p} failed"
  done
  # One version for the set: core and grpc must match, and grpc's peer range is the
  # 2.x line. The tracked manifests are never edited; only the packed copies are.
  local tgz name
  for tgz in "${WORK}"/raw/*.tgz; do
    rm -rf "${WORK}/x" && mkdir -p "${WORK}/x"
    tar -xzf "${tgz}" -C "${WORK}/x"
    node -e '
      const f = process.argv[1], v = process.argv[2];
      const j = JSON.parse(require("fs").readFileSync(f, "utf8"));
      j.version = v;
      for (const k of ["dependencies", "peerDependencies", "optionalDependencies"])
        for (const d of Object.keys(j[k] ?? {}))
          if (d.startsWith("@getknext/")) j[k][d] = v;
      require("fs").writeFileSync(f, JSON.stringify(j, null, 2) + "\n");
    ' "${WORK}/x/package/package.json" "${E2E_VERSION}"
    name="$(node -p 'require(process.argv[1]).name.replace("@","").replace("/","-")' "${WORK}/x/package/package.json")"
    tar -czf "${STATE}/packs/${name}-${E2E_VERSION}.tgz" -C "${WORK}/x" package
  done
  ok "packed: $(ls "${STATE}/packs" | tr '\n' ' ')"
}

# ---------------------------------------------------------------- phase: scaffold

phase_scaffold() {
  log "scaffold: knext create, add function, generate"
  rm -rf "${APP}"
  node "${REPO}/packages/kn-next/dist/cli/kn-next.js" create "${APP}" --yes --runtime node --cache-components \
    >"${WORK}/create.log" 2>&1 || { tail -20 "${WORK}/create.log" >&2; fail "knext create failed"; }
  grep -q 'cacheComponents: true,' "${APP}/next.config.ts" || fail "the scaffold did not turn on Cache Components"
  (cd "${APP}" && npm i --no-audit --no-fund --loglevel=error "${STATE}"/packs/*.tgz >"${WORK}/npm.log" 2>&1) \
    || { tail -20 "${WORK}/npm.log" >&2; fail "installing the packs failed"; }
  knext add function "${FN}" --lang go >"${WORK}/add.log" 2>&1 || { tail -20 "${WORK}/add.log" >&2; fail "knext add function failed"; }

  # A real app verifies its session here; this one takes the user id from a header.
  cat >"${APP}/src/knext/authorize.ts" <<'TS'
import { headers } from 'next/headers';
import type { AuthorizeContext, Principal } from '@getknext/grpc/runtime';

export async function authorize(_ctx: AuthorizeContext): Promise<Principal> {
  const sub = (await headers()).get('x-sub');
  if (!sub) throw new Error('no signed-in user');
  return { sub };
}
TS
  mkdir -p "${APP}/src/app/api/orders"
  cat >"${APP}/src/app/api/orders/route.ts" <<'TS'
import { Code, ConnectError } from '@connectrpc/connect';
import { putItem } from '../../../generated/grpc/orders/v1/orders_knext_actions';
import { getItem } from '../../../generated/grpc/orders/v1/orders_knext_server';

function failure(err: unknown): Response {
  const e = ConnectError.from(err);
  const status = e.code === Code.NotFound ? 404 : e.code === Code.Unknown ? 500 : 502;
  return Response.json({ ok: false, code: Code[e.code], message: e.rawMessage }, { status });
}

export async function GET(req: Request): Promise<Response> {
  try {
    const r = await getItem({ id: new URL(req.url).searchParams.get('id') ?? '' });
    return Response.json({ ok: true, value: r.value });
  } catch (err) {
    return failure(err);
  }
}

// A Route Handler calling the generated Server Action: the write must come back.
export async function POST(req: Request): Promise<Response> {
  const q = new URL(req.url).searchParams;
  try {
    await putItem({ id: q.get('id') ?? '', value: q.get('value') ?? '' }, { idempotencyKey: crypto.randomUUID() });
    return Response.json({ ok: true });
  } catch (err) {
    return failure(err);
  }
}
TS
  knext generate >"${WORK}/generate.log" 2>&1 || { tail -20 "${WORK}/generate.log" >&2; fail "knext generate failed"; }
  ok "scaffolded ${APP}: Cache Components on, the ${FN} function added, glue generated"
}

# ---------------------------------------------------------------- phase: function

phase_function() {
  log "function: build, push, knext deploy function (no --proto-version)"
  build_push "${FN}" "${APP}/functions/${FN}"
  local image
  image="$(image_ref "${FN}")"
  if k get namespace "${NS}" >/dev/null 2>&1; then
    [ "$(k get namespace "${NS}" -o json | jq -r '.metadata.labels["e2e.kn-next.dev/z12-owned"] // ""')" = true ] \
      || fail "namespace ${NS} exists and this harness did not create it; refusing to delete it"
    k delete namespace "${NS}" --wait=true --timeout=600s
  fi
  # Created with its label in one step: a label added afterwards can fail and leave
  # a namespace every later run refuses as not its own.
  k create namespace "${NS}" --dry-run=client -o json \
    | jq '.metadata.labels["e2e.kn-next.dev/z12-owned"] = "true"' | k apply -f - >/dev/null
  knext deploy function "${FN}" --zone "${ZONE}" --namespace "${NS}" --image "${image}" >"${STATE}/deploy-fn.log" 2>&1 \
    || { cat "${STATE}/deploy-fn.log" >&2; fail "knext deploy function failed"; }
  grep -q "serving contract version 1.0.0 (from functions/${FN}/proto" "${STATE}/deploy-fn.log" \
    || { cat "${STATE}/deploy-fn.log" >&2; fail "deploy function did not take the served version from the function's contract"; }
  [ "$(k -n "${NS}" get backendservice "${FN}" -o jsonpath='{.spec.protoVersion}')" = 1.0.0 ] \
    || fail "spec.protoVersion is not 1.0.0"
  sed -n "s/.*specDigest: '\(sha256:[0-9a-f]\{64\}\)'.*/\1/p" "${STATE}/deploy-fn.log" | head -1 >"${STATE}/spec-digest"
  [ -s "${STATE}/spec-digest" ] || fail "deploy function printed no specDigest pin"
  ok "${FN} applied with spec.protoVersion 1.0.0, from its contract"
}

# ---------------------------------------------------------------- phase: zone

phase_zone() {
  log "zone: bind ${FN} and knext deploy"
  local pin
  [ -s "${STATE}/spec-digest" ] || fail "no specDigest pin recorded (run the function phase)"
  pin="$(cat "${STATE}/spec-digest")"
  node -e '
    const fs = require("fs"); const f = process.argv[1];
    let s = fs.readFileSync(f, "utf8");
    s = s.replace(/registry: "[^"]*",/, `registry: "localhost:${process.argv[2]}",`);
    // A later run after a function rebuild re-binds to the new pin.
    s = s.replace(/\n  backends: \[[^\n]*\],\n/, "\n");
    s = s.replace(/\n};\n\nexport default config;/, `\n  backends: [{ name: "${process.argv[3]}", specDigest: "${process.argv[4]}" }],\n};\n\nexport default config;`);
    fs.writeFileSync(f, s);
  ' "${APP}/knext.config.ts" "${REG_PORT}" "${FN}" "${pin}"
  grep -q "specDigest: \"${pin}\"" "${APP}/knext.config.ts" || fail "could not bind ${FN} in knext.config.ts"
  knext deploy --namespace "${NS}" --tag "e2e-$(date +%s)" >"${STATE}/deploy.log" 2>&1 \
    || { tail -30 "${STATE}/deploy.log" >&2; fail "knext deploy failed"; }
  wait_until 600 5 "nextapp/${ZONE} Ready" "k -n ${NS} wait --for=condition=Ready --timeout=2s nextapp/${ZONE}"
  [ "$(k -n "${NS}" get nextapp "${ZONE}" -o jsonpath='{.status.conditions[?(@.type=="BackendBindings")].status}')" = True ] \
    || fail "the zone's BackendBindings condition is not True"
  ok "the zone is Ready and ${FN} is bound"
}

# ---------------------------------------------------------------- calls

# zone_req <method> <path?query> [sub]: ZC_STATUS / ZC_BODY from the zone. Like
# zone_call, a 000 (a dropped port-forward, never the zone's answer) is retried;
# the write here is idempotent in effect (the same id and value).
zone_req() {
  local out _ sub_header="x-knext-z12: none"
  [ -n "${3:-}" ] && sub_header="x-sub: $3"
  for _ in 1 2 3; do
    ensure_forward
    out="$(curl -s -m 60 -X "$1" -H "Host: ${ZONE_HOST}" -H "${sub_header}" -w '\n%{http_code}' "http://127.0.0.1:${INTERNAL_PORT}$2" 2>/dev/null)" || out=$'\n000'
    [ "${out##*$'\n'}" = 000 ] || break
  done
  ZC_STATUS="${out##*$'\n'}"
  ZC_BODY="${out%$'\n'*}"
}

expect_req() { # <description> <method> <path> <sub|""> <status> <jq filter>
  zone_req "$2" "$3" "$4"
  [ "${ZC_STATUS}" = "$5" ] || fail "$1: status ${ZC_STATUS}, want $5 (body: ${ZC_BODY})"
  jq -e "$6" <<<"${ZC_BODY}" >/dev/null || fail "$1: body does not satisfy $6 (body: ${ZC_BODY})"
  ok "$1"
}

fn_pods() { k -n "${NS}" get pods -l "serving.knative.dev/service=${FN}" -o json | jq '.items | length'; }

await_fn_zero() {
  local end=$((SECONDS + ZERO_TIMEOUT))
  until [ "$(fn_pods)" = 0 ]; do
    [ "${SECONDS}" -lt "${end}" ] || fail "timed out after ${ZERO_TIMEOUT}s waiting for ${FN} to scale to zero"
    sleep 5
  done
  ok "${FN} has scaled to zero"
}

zone_host() {
  ZONE_HOST="$(k -n "${NS}" get nextapp "${ZONE}" -o jsonpath='{.status.url}' | sed -E 's#^https?://##')"
  [ -n "${ZONE_HOST}" ] || fail "nextapp/${ZONE} has no status.url"
}

phase_calls() {
  log "calls: through the generated glue, from a Route Handler, on a production build"
  zone_host
  await_fn_zero
  expect_req "a write through the generated Server Action, from a Route Handler, wakes the cold function and returns" \
    POST "/api/orders?id=q1&value=hello" alice 200 '.ok == true'
  [ "$(fn_pods)" -ge 1 ] || fail "the write returned but ${FN} has no pod: the call did not wake it"
  ok "the write woke ${FN} (it has a pod now, and had none before)"
  grep -qE "^ *[\"']use cache[\"'];" "${APP}/src/generated/grpc/${FN}/v1/${FN}_knext_server.ts" \
    || fail "the generated query module has no 'use cache' directive"
  expect_req "a read through the generated 'use cache' query returns it" \
    GET "/api/orders?id=q1" alice 200 '.ok == true and .value == "hello"'
  expect_req "a missing item keeps its NotFound code through 'use cache' in production" \
    GET "/api/orders?id=missing" alice 404 '.ok == false and .code == "NotFound"'
  # authorize() throws a plain Error, which the route reports as Unknown/500; the
  # message pins it to that refusal rather than to any unclassified failure.
  expect_req "a caller authorize() refuses is not served" \
    GET "/api/orders?id=q1" "" 500 '.ok == false and .code == "Unknown" and .message == "no signed-in user"'
}

# The new zone revision's pod is running with Z12_ROLL=<tag>, and the operator has
# rendered the function into its wake list (what knext's process-start loader reads).
zone_wakes_fn() {
  k -n "${NS}" get pods -l "serving.knative.dev/service=${ZONE}" -o json | jq -e --arg r "${ROLL_TAG}" --arg f "${FN}" '
    [.items[] | select(.metadata.deletionTimestamp == null and .status.phase == "Running")
      | .spec.containers[] | select(.name == "user-container") | .env // []
      | select(any(.[]; .name == "Z12_ROLL" and .value == $r))
      | select(any(.[]; .name == "KNEXT_WAKE_FUNCTIONS" and (.value | split(",") | index($f))))]
    | length >= 1' >/dev/null
}

phase_wake() {
  log "wake: a new zone process wakes ${FN} through knext's process-start loader"
  zone_host
  k -n "${NS}" get backendservice "${FN}" >/dev/null || fail "backendservice/${FN} does not exist (run the function phase)"
  [ "$(k -n "${NS}" get backendservice "${FN}" -o jsonpath='{.spec.wakeAhead}')" != false ] \
    || fail "${FN} is opted out of wake-ahead"
  await_fn_zero
  ROLL_TAG="wake-$(date +%s)"
  k -n "${NS}" patch nextapp "${ZONE}" --type merge -p "{\"spec\":{\"env\":{\"Z12_ROLL\":\"${ROLL_TAG}\"}}}" >/dev/null
  wait_until 300 3 "a running zone pod of the new revision lists ${FN} in KNEXT_WAKE_FUNCTIONS" zone_wakes_fn
  wait_until 120 2 "${FN} has a pod, woken by the zone's start (no call made)" '[ "$(fn_pods)" -ge 1 ]'
  ok "the new zone process woke ${FN} before any call"
}

# ---------------------------------------------------------------- main

for phase in ${PHASES}; do
  case "${phase}" in
    pack | scaffold | function | zone | calls | wake) ;;
    *) fail "unknown phase '${phase}' (pack scaffold function zone calls wake)" ;;
  esac
done
use_cluster
k get crd backendservices.apps.kn-next.dev >/dev/null 2>&1 \
  || fail "the cluster has no BackendService CRD: run the Z7 lane's up phase first"
if has_phase pack; then phase_pack; fi
if has_phase scaffold; then phase_scaffold; fi
if has_phase function; then phase_function; fi
if has_phase zone; then phase_zone; fi
if has_phase calls; then phase_calls; fi
if has_phase wake; then phase_wake; fi
log "Z12 lane: ${PHASES} passed"
