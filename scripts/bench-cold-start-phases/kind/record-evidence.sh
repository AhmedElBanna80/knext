#!/usr/bin/env bash
# Record, for one arm, what it was built with and proof that bytecode (bun) or the V8 compile cache
# (node) is really in the image it deploys. Read from the pushed image, not from the build recipe.
#
#   record-evidence.sh <arm> <runtime> <build> <app> <image> <build-log> <out-dir> <kind-node> <host-pid>
#
# Writes <out-dir>/evidence-<arm>.json and exits non-zero (writing nothing) when the proof is absent,
# so an arm that would have measured a bytecode-less image fails the job instead of producing a row.
# Exit 0 evidence written; 1 the proof is absent or wrong; 2 bad arguments (unknown runtime or build,
# missing argument). <kind-node> and <host-pid> name the kind node container and the host pid of the
# arm's live main process, so the image's static proof is tied to what is actually running.
#
#   node  -> the compile cache directory is copied out of the image; its byte and file counts must
#            clear the same floor the Dockerfile's bake enforces, and the image's own
#            NODE_COMPILE_CACHE must name that directory (a cache nothing points at does nothing),
#            and so must the NODE_COMPILE_CACHE in /proc/<pid>/environ of the running process.
#            The `compile cache baked: N bytes` line from the build log is quoted when present.
#   bun   -> turbopack: the compiled executable is copied out and verified through its per-build
#            marker (verify-bytecode.mjs standalone). The image's STANDALONE_SERVER_EXEC must name
#            that executable, and a child of the live supervisor must have it as argv[0]: without
#            both, the supervisor silently falls back to an uncompiled `bun server.js`.
#            vinext: the compiled /app/server carries no
#            marker and `knext build` does not verify it, so it is checked by the pragma-count
#            differential against $BYTECODE_BASELINE, a probe compiled without bytecode (required).
set -euo pipefail

arm="${1:?arm}"; runtime="${2:?runtime}"; build="${3:?build}"; app="${4:?app}"
image="${5:?image}"; buildlog="${6:?build log}"; outdir="${7:?out dir}"
knode="${8:?kind node container}"; hostpid="${9:?host pid of the live main process}"
case "$hostpid" in '' | *[!0-9]*) echo "record-evidence: host pid '$hostpid' is not a number" >&2; exit 2 ;; esac
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

case "$runtime" in node | bun) ;; *) echo "record-evidence: unknown runtime '$runtime'" >&2; exit 2 ;; esac
case "$build" in turbopack | vinext) ;; *) echo "record-evidence: unknown build '$build'" >&2; exit 2 ;; esac

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

docker pull "$image" >/dev/null
cid="$(docker create "$image")"
[ -n "$cid" ] || { echo "record-evidence: docker create gave no container for $image" >&2; exit 1; }

if [ "$runtime" = node ]; then
  if [ "$build" = vinext ]; then
    cachedir=/app/.compile-cache; floor=65536
  else
    cachedir=/app/.next/standalone/.next/compile-cache; floor=262144
  fi
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
  # The running process, not just the image config: the cache only works if the live process has it.
  liveenv="$(dx cat "/proc/${hostpid}/environ" | tr '\0' '\n' | awk 'index($0, "NODE_COMPILE_CACHE=") == 1 { print substr($0, 20); exit }')"
  if [ "$liveenv" != "$cachedir" ]; then
    echo "record-evidence: arm $arm live process (pid ${hostpid}) has NODE_COMPILE_CACHE='${liveenv}', want '$cachedir'" >&2; exit 1
  fi
  bake="$(grep -h 'compile cache baked:' "$buildlog" 2>/dev/null | tail -n1 || true)"
  proof="$(jq -n --arg dir "$cachedir" --argjson bytes "$bytes" --argjson files "$files" \
    --argjson floor "$floor" --arg env "$envval" --arg liveenv "$liveenv" --arg bake "$bake" \
    '{kind: "v8-compile-cache", cache_dir: $dir, bytes: $bytes, files: $files, floor: $floor, env_NODE_COMPILE_CACHE: $env, live_env_NODE_COMPILE_CACHE: $liveenv, bake_line: $bake}')"
else
  if [ "$build" = vinext ]; then
    binpath=/app/server
  else
    binpath=/app/.next/standalone/knext-standalone-exec
  fi
  docker cp "$cid:$binpath" "$tmp/exe" >/dev/null \
    || { echo "record-evidence: arm $arm has no $binpath in its image: no compiled executable" >&2; exit 1; }
  size="$(wc -c < "$tmp/exe" | tr -d ' ')"
  extra='{}'
  if [ "$build" = vinext ]; then
    method=pragma-differential
    : "${BYTECODE_BASELINE:?record-evidence: vinext+bun needs BYTECODE_BASELINE, a probe compiled without bytecode}"
    verdict="$(node "$here/verify-bytecode.mjs" pragma "$tmp/exe" "$BYTECODE_BASELINE")"
  else
    method=marker
    verdict="$(node "$here/verify-bytecode.mjs" standalone "$tmp/exe")"
    # No silent fallback: the supervisor runs the compiled executable only when STANDALONE_SERVER_EXEC
    # names it, and otherwise spawns an uncompiled `bun server.js`. Check the image config AND the
    # live process tree (a child of the supervisor, argv[0] = the executable).
    serverexec="$(image_env STANDALONE_SERVER_EXEC)"
    if [ "$serverexec" != "$binpath" ]; then
      echo "record-evidence: arm $arm image has STANDALONE_SERVER_EXEC='${serverexec}', want '$binpath'" >&2; exit 1
    fi
    children="$(dx cat "/proc/${hostpid}/task/${hostpid}/children" || true)"
    child=""; childargv0=""
    for c in $children; do
      argv0=""
      IFS= read -r -d '' argv0 < <(dx cat "/proc/${c}/cmdline" 2>/dev/null) || true
      if [ "${argv0##*/}" = "${binpath##*/}" ]; then child="$c"; childargv0="$argv0"; break; fi
    done
    if [ -z "$child" ]; then
      echo "record-evidence: arm $arm supervisor (pid ${hostpid}) has no child running ${binpath##*/} (children: ${children:-none}); it fell back to an uncompiled server" >&2; exit 1
    fi
    extra="$(jq -n --arg se "$serverexec" --argjson pid "$child" --arg argv0 "$childargv0" \
      '{server_exec_env: $se, live_child_pid: $pid, live_child_argv0: $argv0}')"
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
