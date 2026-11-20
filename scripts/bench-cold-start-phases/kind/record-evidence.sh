#!/usr/bin/env bash
# Record, for one arm, what it was built with and proof that bytecode (bun) or the V8 compile cache
# (node) is really in the image it deploys and in the process that runs it. Read from the pushed image
# and the kind node, not from the build recipe.
#
#   record-evidence.sh <arm> <runtime> <build> <app> <image> <build-log> <out-dir> <kind-node> <kind-node-pid>
#
# Writes <out-dir>/evidence-<arm>.json and exits non-zero (writing nothing) when the proof is absent,
# so an arm that would have measured a bytecode-less image fails the job instead of producing a row.
# Exit 0 evidence written; 1 the proof is absent or wrong; 2 bad arguments (unknown runtime or build,
# missing argument, non-numeric pid). <kind-node> is the kind node container and <kind-node-pid> the pid,
# in the kind node's pid namespace (what `crictl inspect` reports), of the arm's live main process.
#
# ORDER MATTERS. The pod lives only about 40 s after Ready (stable window plus grace period) and then
# scales to zero, so every live /proc read happens FIRST, before the image pull, the file copies and the
# 100 MB bytecode scan. A /proc read that fails therefore means "the pod scaled away before the live
# check", and that is what the error says. Only then are the image and its files checked.
#
# Live checks (the supervisor is the main process; its child is the real server):
#   node, turbopack -> a CHILD of the supervisor (the Next server) must have NODE_COMPILE_CACHE equal to
#                      the cache directory in its /proc/<child>/environ; the supervisor's own environ is
#                      not what the cache serves.
#   node, vinext    -> single process: NODE_COMPILE_CACHE in /proc/<pid>/environ.
#   bun,  turbopack -> a child of the supervisor must be the compiled executable. It matches on the
#                      argv[0] basename, OR the basename of the /proc/<child>/exe link, OR comm (the
#                      kernel truncates comm to 15 characters), because Next sets process.title and
#                      that can rewrite cmdline; the evidence records which one matched.
#   bun,  vinext    -> nothing live here (the workflow checks the process is /app/server).
# Children are read from /proc/<pid>/task/<pid>/children, the MAIN THREAD's list. That assumes the
# supervisor spawns from its main thread (node and bun both do); a child spawned from another thread
# would be listed under that thread's own task directory and not seen here. It also needs
# CONFIG_PROC_CHILDREN, which the Ubuntu runner kernel has.
#
# Image checks:
#   node  -> the compile cache directory is copied out of the image; its byte and file counts must
#            clear the same floor the Dockerfile's bake enforces, and the image's own
#            NODE_COMPILE_CACHE must name that directory (a cache nothing points at does nothing).
#            The `compile cache baked: N bytes` line from the build log is quoted when present.
#   bun   -> turbopack: the compiled executable is copied out and verified through its per-build
#            marker (verify-bytecode.mjs standalone), and the image's STANDALONE_SERVER_EXEC must name
#            it (without that the supervisor silently falls back to an uncompiled `bun server.js`).
#            vinext: the compiled /app/server carries no marker and `knext build` does not verify it,
#            so it is checked by the pragma-count differential against $BYTECODE_BASELINE, a probe
#            compiled without bytecode (required).
set -euo pipefail

arm="${1:?arm}"; runtime="${2:?runtime}"; build="${3:?build}"; app="${4:?app}"
image="${5:?image}"; buildlog="${6:?build log}"; outdir="${7:?out dir}"
knode="${8:?kind node container}"; kpid="${9:?kind-node pid of the live main process}"
case "$kpid" in '' | *[!0-9]*) echo "record-evidence: kind-node pid '$kpid' is not a number" >&2; exit 2 ;; esac
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

case "$runtime" in node | bun) ;; *) echo "record-evidence: unknown runtime '$runtime'" >&2; exit 2 ;; esac
case "$build" in turbopack | vinext) ;; *) echo "record-evidence: unknown build '$build'" >&2; exit 2 ;; esac

if [ "$runtime" = node ]; then
  if [ "$build" = vinext ]; then
    cachedir=/app/.compile-cache; floor=65536
  else
    cachedir=/app/.next/standalone/.next/compile-cache; floor=262144
  fi
elif [ "$build" = vinext ]; then
  binpath=/app/server
else
  binpath=/app/.next/standalone/knext-standalone-exec
fi

tmp="$(mktemp -d)"
cid=""
cleanup() {
  [ -z "$cid" ] || docker rm -f "$cid" >/dev/null 2>&1 || true
  # Only the mktemp directory made above, never a caller-supplied path.
  rm -r -f -- "$tmp"
}
trap cleanup EXIT

# Read one /proc file of a process on the kind node (the app image is distroless: nothing is exec'd
# into the app container).
dx() { docker exec "$knode" "$@"; }
# One variable of the image's own ENV.
image_env() { docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$image" | awk -v k="$1" 'index($0, k "=") == 1 { print substr($0, length(k) + 2); exit }'; }
# A /proc file as text, NULs turned into newlines IN the pipeline (a bash command substitution would drop
# them and run the entries together). Fails when the read fails (pipefail), i.e. when the process is gone.
proc_text() { dx cat "$1" 2>/dev/null | tr '\0' '\n'; }
# A variable out of the text of a /proc/<pid>/environ.
environ_var() { awk -v k="$1" 'index($0, k "=") == 1 { print substr($0, length(k) + 2); exit }'; }
scaled_away() {
  echo "record-evidence: arm $arm: pod scaled away before the live check ($1)" >&2
  exit 1
}

# ------------------------------------------------------------------------------------------------
# LIVE PHASE: every /proc read, before anything slow.
# ------------------------------------------------------------------------------------------------
live='{}'

children_of() {
  # Prints the pids of the main thread's children, or exits the script when the pod is gone.
  local out
  out="$(dx cat "/proc/${kpid}/task/${kpid}/children" 2>/dev/null)" \
    || scaled_away "cannot read /proc/${kpid}/task/${kpid}/children on ${knode}"
  printf '%s\n' "$out"
}

if [ "$runtime" = node ] && [ "$build" = vinext ]; then
  environ="$(proc_text "/proc/${kpid}/environ")" \
    || scaled_away "cannot read /proc/${kpid}/environ on ${knode}"
  liveenv="$(printf '%s' "$environ" | environ_var NODE_COMPILE_CACHE)"
  if [ "$liveenv" != "$cachedir" ]; then
    echo "record-evidence: arm $arm live process (pid ${kpid}) has NODE_COMPILE_CACHE='${liveenv}', want '$cachedir'" >&2
    exit 1
  fi
  live="$(jq -n --argjson pid "$kpid" --arg env "$liveenv" \
    '{live_pid: $pid, live_via: "main-process", live_env_NODE_COMPILE_CACHE: $env}')"

elif [ "$runtime" = node ]; then
  children="$(children_of)"
  [ -n "$children" ] || { echo "record-evidence: arm $arm supervisor (pid ${kpid}) has no child process: no Next server to check" >&2; exit 1; }
  found=""; liveenv=""; unreadable=0
  for c in $children; do
    if ! environ="$(proc_text "/proc/${c}/environ")"; then unreadable=1; continue; fi
    v="$(printf '%s' "$environ" | environ_var NODE_COMPILE_CACHE)"
    if [ "$v" = "$cachedir" ]; then found="$c"; liveenv="$v"; break; fi
  done
  if [ -z "$found" ]; then
    [ "$unreadable" = 0 ] || scaled_away "cannot read the environ of a child of pid ${kpid} on ${knode}"
    echo "record-evidence: arm $arm no child of the supervisor (pid ${kpid}; children: ${children//$'\n'/ }) has NODE_COMPILE_CACHE='$cachedir'" >&2
    exit 1
  fi
  live="$(jq -n --argjson pid "$found" --arg env "$liveenv" \
    '{live_pid: $pid, live_via: "supervisor-child", live_env_NODE_COMPILE_CACHE: $env}')"

elif [ "$build" = turbopack ]; then
  children="$(children_of)"
  [ -n "$children" ] || { echo "record-evidence: arm $arm supervisor (pid ${kpid}) has no child process: the compiled executable is not running" >&2; exit 1; }
  want_base="${binpath##*/}"
  child=""; matched=""; c_argv0=""; c_exe=""; c_comm=""; unreadable=0; seen=""
  for c in $children; do
    argv0=""; exe=""; comm=""
    cmdline_ok=0
    if cmd="$(proc_text "/proc/${c}/cmdline")"; then
      cmdline_ok=1
      argv0="${cmd%%$'\n'*}"
    fi
    exe="$(dx readlink "/proc/${c}/exe" 2>/dev/null || true)"
    comm="$(dx cat "/proc/${c}/comm" 2>/dev/null || true)"
    comm="${comm%$'\n'}"
    if [ "$cmdline_ok" = 0 ] && [ -z "$exe" ] && [ -z "$comm" ]; then unreadable=1; continue; fi
    seen="$seen ${c}:argv0='${argv0}',exe='${exe}',comm='${comm}'"
    how=""
    if [ -n "$argv0" ] && [ "${argv0##*/}" = "$want_base" ]; then how="argv0"
    elif [ -n "$exe" ] && [ "${exe##*/}" = "$want_base" ]; then how="exe"
    elif [ -n "$comm" ] && [ "$comm" = "${want_base:0:15}" ]; then how="comm"
    fi
    if [ -n "$how" ]; then child="$c"; matched="$how"; c_argv0="$argv0"; c_exe="$exe"; c_comm="$comm"; break; fi
  done
  if [ -z "$child" ]; then
    [ "$unreadable" = 0 ] || [ -n "$seen" ] || scaled_away "cannot read any child of pid ${kpid} on ${knode}"
    echo "record-evidence: arm $arm supervisor (pid ${kpid}) has no child running ${want_base} (${seen# }); it fell back to an uncompiled server" >&2
    exit 1
  fi
  live="$(jq -n --argjson pid "$child" --arg argv0 "$c_argv0" --arg exe "$c_exe" --arg comm "$c_comm" --arg how "$matched" \
    '{live_child_pid: $pid, live_child_argv0: $argv0, live_child_exe: $exe, live_child_comm: $comm, live_child_matched_by: $how}')"
fi

# ------------------------------------------------------------------------------------------------
# IMAGE PHASE: pull, copy out, scan.
# ------------------------------------------------------------------------------------------------
docker pull "$image" >/dev/null
cid="$(docker create "$image")"
[ -n "$cid" ] || { echo "record-evidence: docker create gave no container for $image" >&2; exit 1; }

if [ "$runtime" = node ]; then
  docker cp "$cid:$cachedir" "$tmp/cache" >/dev/null \
    || { echo "record-evidence: arm $arm has no $cachedir in its image: no compile cache" >&2; exit 1; }
  bytes="$(find "$tmp/cache" -type f -exec cat {} + | wc -c | tr -d ' ')"
  files="$(find "$tmp/cache" -type f | wc -l | tr -d ' ')"
  if [ "$bytes" -lt "$floor" ]; then
    echo "record-evidence: arm $arm compile cache is $bytes bytes, below the floor of $floor" >&2; exit 1
  fi
  envval="$(image_env NODE_COMPILE_CACHE)"
  if [ "$envval" != "$cachedir" ]; then
    echo "record-evidence: arm $arm image has NODE_COMPILE_CACHE='${envval}', want '$cachedir'" >&2; exit 1
  fi
  bake="$(grep -h 'compile cache baked:' "$buildlog" 2>/dev/null | tail -n1 || true)"
  proof="$(jq -n --arg dir "$cachedir" --argjson bytes "$bytes" --argjson files "$files" \
    --argjson floor "$floor" --arg env "$envval" --arg bake "$bake" --argjson live "$live" \
    '{kind: "v8-compile-cache", cache_dir: $dir, bytes: $bytes, files: $files, floor: $floor, env_NODE_COMPILE_CACHE: $env, bake_line: $bake} + $live')"
else
  docker cp "$cid:$binpath" "$tmp/exe" >/dev/null \
    || { echo "record-evidence: arm $arm has no $binpath in its image: no compiled executable" >&2; exit 1; }
  size="$(wc -c < "$tmp/exe" | tr -d ' ')"
  extra="$live"
  if [ "$build" = vinext ]; then
    method=pragma-differential
    : "${BYTECODE_BASELINE:?record-evidence: vinext+bun needs BYTECODE_BASELINE, a probe compiled without bytecode}"
    verdict="$(node "$here/verify-bytecode.mjs" pragma "$tmp/exe" "$BYTECODE_BASELINE")"
  else
    method=marker
    verdict="$(node "$here/verify-bytecode.mjs" standalone "$tmp/exe")"
    # No silent fallback: the supervisor runs the compiled executable only when STANDALONE_SERVER_EXEC
    # names it, and otherwise spawns an uncompiled `bun server.js`. The live child was checked above.
    serverexec="$(image_env STANDALONE_SERVER_EXEC)"
    if [ "$serverexec" != "$binpath" ]; then
      echo "record-evidence: arm $arm image has STANDALONE_SERVER_EXEC='${serverexec}', want '$binpath'" >&2; exit 1
    fi
    extra="$(jq -n --arg se "$serverexec" --argjson live "$live" '{server_exec_env: $se} + $live')"
  fi
  proof="$(jq -n --arg bin "$binpath" --argjson size "$size" --arg method "$method" --arg verdict "$verdict" --argjson extra "$extra" \
    '{kind: "bun-bytecode", binary: $bin, size_bytes: $size, method: $method, verdict: $verdict} + $extra')"
fi

mkdir -p "$outdir"
jq -n --arg arm "$arm" --arg runtime "$runtime" --arg build "$build" --arg app "$app" --arg image "$image" \
  --argjson proof "$proof" \
  '{arm: $arm, runtime: $runtime, build_target: $build, app: $app, image: $image, bytecode: $proof}' \
  > "$outdir/evidence-${arm}.json"
echo "arm ${arm}: evidence $(jq -c '.bytecode' "$outdir/evidence-${arm}.json")"
