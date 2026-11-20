#!/usr/bin/env bash
# Record, for one arm, what it was built with and proof that bytecode (bun) or the V8 compile cache
# (node) is really in the image it deploys. Read from the pushed image, not from the build recipe.
#
#   record-evidence.sh <arm> <runtime> <build> <app> <image> <build-log> <out-dir>
#
# Writes <out-dir>/evidence-<arm>.json and exits non-zero (writing nothing) when the proof is absent,
# so an arm that would have measured a bytecode-less image fails the job instead of producing a row.
#
#   node  -> the compile cache directory is copied out of the image; its byte and file counts must
#            clear the same floor the Dockerfile's bake enforces, and the image's own
#            NODE_COMPILE_CACHE must name that directory (a cache nothing points at does nothing).
#            The `compile cache baked: N bytes` line from the build log is quoted when present.
#   bun   -> turbopack: the compiled executable is copied out and verified through its per-build
#            marker (verify-bytecode.mjs standalone). vinext: the compiled /app/server carries no
#            marker and `knext build` does not verify it, so it is checked by the pragma-count
#            differential against $BYTECODE_BASELINE, a probe compiled without bytecode (required).
set -euo pipefail

arm="${1:?arm}"; runtime="${2:?runtime}"; build="${3:?build}"; app="${4:?app}"
image="${5:?image}"; buildlog="${6:?build log}"; outdir="${7:?out dir}"
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
  envval="$(docker inspect --format '{{range .Config.Env}}{{println .}}{{end}}' "$image" | sed -n 's/^NODE_COMPILE_CACHE=//p' | head -n1)"
  if [ "$envval" != "$cachedir" ]; then
    echo "record-evidence: arm $arm image has NODE_COMPILE_CACHE='${envval}', want '$cachedir'" >&2; exit 1
  fi
  bake="$(grep -h 'compile cache baked:' "$buildlog" 2>/dev/null | tail -n1 || true)"
  proof="$(jq -n --arg dir "$cachedir" --argjson bytes "$bytes" --argjson files "$files" \
    --argjson floor "$floor" --arg env "$envval" --arg bake "$bake" \
    '{kind: "v8-compile-cache", cache_dir: $dir, bytes: $bytes, files: $files, floor: $floor, env_NODE_COMPILE_CACHE: $env, bake_line: $bake}')"
else
  if [ "$build" = vinext ]; then
    binpath=/app/server
  else
    binpath=/app/.next/standalone/knext-standalone-exec
  fi
  docker cp "$cid:$binpath" "$tmp/exe" >/dev/null \
    || { echo "record-evidence: arm $arm has no $binpath in its image: no compiled executable" >&2; exit 1; }
  size="$(wc -c < "$tmp/exe" | tr -d ' ')"
  if [ "$build" = vinext ]; then
    method=pragma-differential
    : "${BYTECODE_BASELINE:?record-evidence: vinext+bun needs BYTECODE_BASELINE, a probe compiled without bytecode}"
    verdict="$(node "$here/verify-bytecode.mjs" pragma "$tmp/exe" "$BYTECODE_BASELINE")"
  else
    method=marker
    verdict="$(node "$here/verify-bytecode.mjs" standalone "$tmp/exe")"
  fi
  proof="$(jq -n --arg bin "$binpath" --argjson size "$size" --arg method "$method" --arg verdict "$verdict" \
    '{kind: "bun-bytecode", binary: $bin, size_bytes: $size, method: $method, verdict: $verdict}')"
fi

mkdir -p "$outdir"
jq -n --arg arm "$arm" --arg runtime "$runtime" --arg build "$build" --arg app "$app" --arg image "$image" \
  --argjson proof "$proof" \
  '{arm: $arm, runtime: $runtime, build_target: $build, app: $app, image: $image, bytecode: $proof}' \
  > "$outdir/evidence-${arm}.json"
echo "arm ${arm}: evidence $(jq -c '.bytecode' "$outdir/evidence-${arm}.json")"
