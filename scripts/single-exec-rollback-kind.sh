#!/usr/bin/env bash
# single-exec-rollback-kind.sh — the way back from a single executable (#2445,
# ADR-0070 criterion C7), proved on a real cluster.
#
# One NextApp is deployed three times, changing only its artifact shape:
#
#   sc    runtime bun, selfContained: true   one compiled executable, no command
#   disk  runtime bun, selfContained: false  the standalone tree, `bun run server.js`
#   node  runtime node                       the standalone tree, the image default
#
# Each deploy rolls a new revision. Then traffic is pinned back and forth
# between them (`knext rollback --to`, a canary, and back to latest). The
# script fails unless:
#
#   - every revision answers 200 on /api/health, /build-mark, /rb-stamp and
#     /tagged, a pinned revision is the one that serves (the mark on /build-mark),
#     and a 50 % canary reaches both sides;
#   - the operator rendered each revision's own command (`kubectl get revision`),
#     never the previous revision's;
#   - after each deploy that switches the shape, the new revision's first
#     /tagged is the ISR entry a previous build stored in the shared Redis (its
#     build mark is a previous shape's), not a fresh render: the switch does not
#     lose the page cache. (The rollback pins return to revisions that already
#     served; they are checked for the serving build, not for the page cache.)
#
# It also REPORTS, without asserting, the unstable_cache entry /rb-stamp reads
# on every request under each shape. Measured on kind: that data-cache entry is
# not shared across shapes (selfContained Bun and Node read one Redis key,
# disk-mode Bun another), so a switch can start the data cache cold. That is a
# finding being chased separately, not something this lane certifies.
#
# Side effects: it overwrites ${APP_DIR}/knext.config.ts, and writes
# /tmp/rb-body-* and /tmp/pf-rb.log.
#
# Expects a cluster with Knative + Kourier, the operator, a Redis Service named
# `redis` in $APP_NS, and a registry the node pulls from. The workflow
# (.github/workflows/single-exec-rollback-kind-e2e.yml) sets all of that up.
#
# Env:
#   APP_DIR    the staged cdn-kind-app fixture (its own node_modules)
#   CLI        packages/kn-next/dist/cli/kn-next.js
#   APP_NS     the namespace (must exist, with the redis Service)
#   REGISTRY   the registry deploys push to (default localhost:5001)
#   TAG        a per-run tag prefix (default: now)
#   PF_PORT    local port for the kourier-internal port-forward (default 18491)
set -euo pipefail

: "${APP_DIR:?}" "${CLI:?}" "${APP_NS:?}"
REGISTRY="${REGISTRY:-localhost:5001}"
TAG="${TAG:-$(date +%s)}"
PF_PORT="${PF_PORT:-18491}"
APP=rb
SHAPES=(sc disk node)

# The current kubectl context throughout: `knext deploy` has no --context flag.
kc() { kubectl "$@"; }
fail() { echo "::error::single-exec-rollback: $*" >&2; exit 1; }
say() { echo "single-exec-rollback: $*"; }

# want_command <shape>: the container command the operator must render.
want_command() {
  case "$1" in
    sc | node) echo "" ;;
    disk) echo '["bun","run","server.js"]' ;;
    *) fail "unknown shape $1" ;;
  esac
}

write_config() { # <shape>
  local runtime=bun sc=false
  case "$1" in
    sc) sc=true ;;
    disk) ;;
    node) runtime=node ;;
  esac
  cat > "${APP_DIR}/knext.config.ts" <<EOF
const config = {
  name: "${APP}",
  runtime: "${runtime}",
  selfContained: ${sc},
  registry: "${REGISTRY}",
  healthCheckPath: "/api/health",
  cache: { provider: "redis", url: "redis://redis.${APP_NS}.svc.cluster.local.:6379", keyPrefix: "${APP}" },
  scaling: { minScale: 1, maxScale: 1, memoryRequest: "256Mi", memoryLimit: "768Mi" },
};
export default config;
EOF
}

latest_ready() { kc -n "$APP_NS" get ksvc "$APP" -o jsonpath='{.status.latestReadyRevisionName}' 2>/dev/null || true; }
latest_created() { kc -n "$APP_NS" get ksvc "$APP" -o jsonpath='{.status.latestCreatedRevisionName}' 2>/dev/null || true; }

# await_new_revision <previous>: the latest created revision is new and Ready.
await_new_revision() {
  local prev="$1" created ready
  for _ in $(seq 1 180); do
    created="$(latest_created)"; ready="$(latest_ready)"
    if [ -n "$created" ] && [ "$created" != "$prev" ] && [ "$ready" = "$created" ]; then
      echo "$created"; return 0
    fi
    sleep 2
  done
  kc -n "$APP_NS" get nextapp,ksvc,revision,pods -o wide >&2 || true
  kc -n "$APP_NS" describe ksvc "$APP" >&2 || true
  fail "no new Ready revision after ${prev:-<none>} (created=${created:-} ready=${ready:-})"
}

HOST=""
start_pf() {
  kc -n kourier-system port-forward svc/kourier-internal "${PF_PORT}:80" >/tmp/pf-rb.log 2>&1 &
  PF_PID=$!
  trap 'kill "$PF_PID" 2>/dev/null || true' EXIT
  for _ in $(seq 1 30); do
    # Our own forward must be the listener: a port something else already holds
    # would answer, and every probe would then test the wrong thing.
    kill -0 "$PF_PID" 2>/dev/null || fail "the port-forward exited (port ${PF_PORT} in use?): $(cat /tmp/pf-rb.log)"
    (exec 3<>"/dev/tcp/127.0.0.1/${PF_PORT}") 2>/dev/null && return 0
    sleep 1
  done
  fail "kourier-internal port-forward did not come up: $(cat /tmp/pf-rb.log)"
}

# get <path> <outfile>: the status code; the body lands in outfile.
get() {
  curl -s -m 30 -o "$2" -w '%{http_code}' -H "Host: ${HOST}" "http://127.0.0.1:${PF_PORT}$1" || true
}

# probe <label>: 200 on the routes; prints "<build mark> <stamp> <tagged mark>".
# /build-mark is rendered on every request, so its mark names the build that
# served. /rb-stamp's stamp is the unstable_cache entry it reads per request.
# /tagged is ISR HTML shared across builds: its mark names the build that
# STORED the page, which is how the ISR check below sees the shared entry.
# Call it as an assignment (`out="$(probe x)"`) so a failure stops the script.
probe() {
  local code body=/tmp/rb-body mark stamp tmark
  for path in /api/health /build-mark /rb-stamp /tagged; do
    code="$(get "$path" "${body}${path//\//-}")"
    [ "$code" = 200 ] || fail "$1: GET $path answered $code, want 200: $(head -c 300 "${body}${path//\//-}")"
  done
  mark="$(sed -n 's/.*<p id="build">\([^<]*\)<\/p>.*/\1/p' "${body}-build-mark" | head -n1)"
  stamp="$(sed -n 's/.*<p id="stamp">\([^<]*\)<\/p>.*/\1/p' "${body}-rb-stamp" | head -n1)"
  [ -n "$mark" ] || fail "$1: /build-mark carries no build mark: $(head -c 300 "${body}-build-mark")"
  tmark="$(sed -n 's/.*<p id="build">\([^<]*\)<\/p>.*/\1/p' "${body}-tagged" | head -n1)"
  [ -n "$stamp" ] || fail "$1: /rb-stamp carries no stamp: $(head -c 300 "${body}-rb-stamp")"
  [ -n "$tmark" ] || fail "$1: /tagged carries no build mark: $(head -c 300 "${body}-tagged")"
  echo "$mark $stamp $tmark"
}

assert_command() { # <revision> <shape>
  local got want
  got="$(kc -n "$APP_NS" get revision "$1" -o jsonpath='{.spec.containers[0].command}')"
  want="$(want_command "$2")"
  [ "$got" = "$want" ] || fail "revision $1 ($2) renders command '${got}', want '${want}'"
  say "revision $1 ($2): command '${got}'"
}

# await_traffic <revision> <percent> [<latest percent>]: the ksvc's programmed split.
await_traffic() {
  local want="$1=$2" got
  [ -n "${3:-}" ] && want="${want} latest=$3"
  for _ in $(seq 1 90); do
    got="$(kc -n "$APP_NS" get ksvc "$APP" -o json | jq -r '
      [.status.traffic[]? | if .latestRevision then "latest=\(.percent)" else "\(.revisionName)=\(.percent)" end]
      | sort | join(" ")')"
    [ "$(tr ' ' '\n' <<<"$got" | sort | paste -sd' ' -)" = "$(tr ' ' '\n' <<<"$want" | sort | paste -sd' ' -)" ] && return 0
    sleep 2
  done
  fail "ksvc traffic is '${got}', want '${want}'"
}

rollback() { node "$CLI" rollback "$APP" -n "$APP_NS" "$@"; }

declare -A REV MARK STAMP
SEEN_MARKS=" "
# A re-run against an app that already exists must not accept its old revision.
prev="$(latest_created)"
for shape in "${SHAPES[@]}"; do
  say "deploy shape ${shape}"
  write_config "$shape"
  ( cd "$APP_DIR" && node "$CLI" deploy --registry "$REGISTRY" --namespace "$APP_NS" --tag "${TAG}-${shape}" )
  rev="$(await_new_revision "$prev")"
  REV[$shape]="$rev"
  assert_command "$rev" "$shape"
  if [ -z "$HOST" ]; then
    HOST="$(kc -n "$APP_NS" get nextapp "$APP" -o jsonpath='{.status.url}')"
    HOST="${HOST#*://}"
    [ -n "$HOST" ] || fail "nextapp status.url is empty"
    start_pf
  fi
  out="$(probe "$shape")"
  read -r mark stamp tmark <<<"$out"
  MARK[$shape]="$mark"
  STAMP[$shape]="$stamp"
  # The page cache survives the switch: the new revision's first /tagged is a
  # page an earlier shape stored in the shared Redis, not its own render.
  if [ "$SEEN_MARKS" != " " ]; then
    case "$SEEN_MARKS" in
      *" ${tmark} "*) ;;
      *) fail "shape ${shape}: its first /tagged came from build ${tmark}, not from an earlier shape's entry in the shared Redis (${SEEN_MARKS}): the page cache was lost across the switch" ;;
    esac
  fi
  SEEN_MARKS="${SEEN_MARKS}${mark} "
  say "shape ${shape}: revision ${rev}, build ${mark}, /tagged from ${tmark}, data-cache stamp ${stamp}"
  prev="$rev"
done

# Three builds, three marks: each probe above really reached its own revision.
[ "${MARK[sc]}" != "${MARK[disk]}" ] && [ "${MARK[disk]}" != "${MARK[node]}" ] && [ "${MARK[sc]}" != "${MARK[node]}" ] \
  || fail "the three shapes did not serve three builds: sc=${MARK[sc]} disk=${MARK[disk]} node=${MARK[node]}"

# pinned <shape> <label>: every request is served by that shape's build.
pinned() {
  local mark
  for _ in 1 2 3 4 5; do
    out="$(probe "$2")"
    read -r mark _ _ <<<"$out"
    [ "$mark" = "${MARK[$1]}" ] || fail "$2: served by build ${mark}, want ${1}'s ${MARK[$1]}"
  done
  say "$2: served by ${1} (${MARK[$1]})"
}

# Back to the single executable, then to disk-mode Bun, then a canary, then latest.
rollback --to "${REV[sc]}"
await_traffic "${REV[sc]}" 100
pinned sc "pinned to sc"

rollback --to "${REV[disk]}"
await_traffic "${REV[disk]}" 100
pinned disk "pinned to disk"

rollback --to "${REV[sc]}" --canary 50
await_traffic "${REV[sc]}" 50 50
seen_sc=0; seen_node=0
for _ in $(seq 1 30); do
  out="$(probe "canary")"
  read -r mark _ _ <<<"$out"
  [ "$mark" = "${MARK[sc]}" ] && seen_sc=1
  [ "$mark" = "${MARK[node]}" ] && seen_node=1
  [ "$mark" = "${MARK[sc]}" ] || [ "$mark" = "${MARK[node]}" ] || fail "canary: served by build ${mark}, neither sc nor latest (node)"
done
[ "$seen_sc" = 1 ] && [ "$seen_node" = 1 ] \
  || fail "canary: 30 requests did not reach both sides (sc=${seen_sc}, latest node=${seen_node})"
say "canary: sc and latest (node) both served"

rollback
await_traffic latest 100
pinned node "back to latest"

# Every revision is still there and still renders its own command.
for shape in "${SHAPES[@]}"; do assert_command "${REV[$shape]}" "$shape"; done
# Reported, not asserted (see the header).
if [ "${STAMP[sc]}" = "${STAMP[disk]}" ] && [ "${STAMP[disk]}" = "${STAMP[node]}" ]; then
  say "data cache: one unstable_cache entry under every shape (${STAMP[sc]})"
else
  say "data cache: NOT shared across shapes: sc=${STAMP[sc]} disk=${STAMP[disk]} node=${STAMP[node]}"
fi
say "PASS: sc=${REV[sc]} disk=${REV[disk]} node=${REV[node]}; the ISR page entry survived both shape switches"
