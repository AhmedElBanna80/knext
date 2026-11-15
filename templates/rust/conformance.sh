#!/usr/bin/env bash
# Run the Connect conformance suite against the connectrpc version this
# template locks. connect-rust is pre-1.0, so its pin is gated by the suite.
#
#   ./conformance.sh <connect-rust checkout> <connectconformance binary>
#
# The checkout must be the release commit of the connectrpc version in
# Cargo.lock (CI checks it out by SHA). Its own conformance server is built
# with the protocol stack this template ships: buffa, hyper, hyper-util and h2
# are held to the versions in this template's Cargo.lock. Then every server
# test runs, on every protocol (Connect, gRPC, gRPC-Web).
#
# Then the same suite runs against the function's OWN stack: the template's
# accept loop, timeouts, body bound and layers, assembled by the same function
# as the binary's, with only the token check left out (the runner sends no
# zone identity token; src/rpc/conformance.rs, which never builds in release).
# The upstream ConformanceService implementation is reused unchanged:
# everything in its server.rs above `main` is kept, and conformance/main.rs
# replaces `main`. conformance/config.yaml lists what a function serves.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CHECKOUT="$(cd "$1" && pwd)"
RUNNER="$(cd "$(dirname "$2")" && pwd)/$(basename "$2")"

# The version of package $1 in this template's Cargo.lock (exactly one).
locked() {
  local versions
  versions="$(awk -v name="$1" '$0 == "name = \"" name "\"" { getline; gsub(/"/, "", $3); print $3 }' "${HERE}/Cargo.lock")"
  if [ "$(printf '%s\n' "${versions}" | grep -c .)" != "1" ]; then
    echo "conformance.sh: Cargo.lock holds '${versions}' for $1, want exactly one version" >&2
    exit 2
  fi
  printf '%s\n' "${versions}"
}

want="$(locked connectrpc)"
have="$(awk '/^\[package\]/ { p = 1 } p && /^version = / { gsub(/"/, "", $3); print $3; exit }' "${CHECKOUT}/connectrpc/Cargo.toml")"
if [ "${want}" != "${have}" ]; then
  echo "conformance.sh: the checkout is connectrpc ${have}; Cargo.lock locks ${want}" >&2
  exit 2
fi
echo "connectrpc ${have} (locked ${want})"

cd "${CHECKOUT}"
# connect-rust commits no Cargo.lock: resolve one, then hold the protocol
# stack to the template's versions.
[ -f Cargo.lock ] || cargo generate-lockfile --quiet
for crate in buffa hyper hyper-util h2; do
  version="$(locked "${crate}")"
  cargo update --quiet -p "${crate}" --precise "${version}"
  echo "${crate} ${version}"
done
cargo build --release --locked -p connectrpc-conformance --bin conformance-server
RUST_LOG=warn "${RUNNER}" --mode server -- target/release/conformance-server

# ---- the function's own stack ----
SRC="conformance/src/bin/server.rs"
OUT="conformance/src/bin/function-stack-server.rs"
main_at="$(grep -n '^async fn main() -> Result<()> {$' "${SRC}" | cut -d: -f1 || true)"
if [ "$(printf '%s\n' "${main_at}" | grep -c .)" != "1" ] \
  || [ "$(sed -n "$((main_at - 1))p" "${SRC}")" != '#[tokio::main]' ] \
  || [ "$(tail -n 1 "${SRC}")" != '}' ] \
  || [ "$(sed -n "${main_at},\$p" "${SRC}" | grep -c '^}$')" != "1" ]; then
  echo "conformance.sh: ${SRC} no longer ends in one '#[tokio::main] async fn main'; re-check the splice" >&2
  exit 2
fi
{
  echo '#![allow(unused_imports, dead_code)]'
  head -n "$((main_at - 2))" "${SRC}"
  cat "${HERE}/conformance/main.rs"
} >"${OUT}"
# Once per checkout: a rerun on the same checkout finds the wiring in place.
if ! grep -qx 'name = "function-stack-server"' conformance/Cargo.toml; then
  # The wiring appends whole tables; refuse a checkout that already has them.
  if grep -qx '\[features\]' conformance/Cargo.toml || grep -qx '\[patch.crates-io\]' Cargo.toml; then
    echo "conformance.sh: the checkout already has [features] or [patch.crates-io]; re-check the wiring" >&2
    exit 2
  fi
  cat >>conformance/Cargo.toml <<TOML

[[bin]]
name = "function-stack-server"
path = "src/bin/function-stack-server.rs"
required-features = ["function-stack"]

# Optional, so the release build of the upstream server above never compiles
# the function's conformance feature (which refuses to build in release).
[features]
function-stack = ["dep:function"]

[dependencies.function]
path = "${HERE}"
default-features = false
features = ["conformance"]
optional = true
TOML
  # The function names connectrpc and connectrpc-health from crates.io: build
  # both from this checkout, so the router the function serves is the
  # conformance service's own type and the version is the one checked above.
  # (The workspace already holds connectrpc-health 0.9.0, so the template's
  # vendored copy, which differs only in leaving zstd out, cannot be used.)
  cat >>Cargo.toml <<'TOML'

[patch.crates-io]
connectrpc = { path = "connectrpc" }
connectrpc-health = { path = "connectrpc-health" }
TOML
fi
# The new dependency grows the graph, so cargo resolves the lockfile again.
# Then every crate the release binary links (the template's own normal
# dependency closure, at its Cargo.lock versions) is held to that version in
# this build, and the build fails if any one differs.
# cargo unifies features across the graph, so the closure may also hold crates
# (or other semver series of a crate) that the release binary does not: the
# upstream conformance crate asks for more features of connectrpc, tokio and
# tracing-subscriber. Those are listed, not compared.
cargo metadata --format-version 1 --features function-stack -q >/dev/null
TEMPLATE_LOCK="$(cd "${HERE}" && cargo tree --locked -e normal --prefix none --format '{p}' \
  | sed -E 's/ \(.*$//; s/ v/ /' | grep -v '^function ' | sort -u)"
[ -n "${TEMPLATE_LOCK}" ] || { echo "conformance.sh: could not list the template's release closure" >&2; exit 2; }
# "<name> <version>" for every crate under `function` in the harness build.
closure() {
  cargo tree -p connectrpc-conformance --features function-stack -e normal \
    --prefix depth --no-dedupe --format '{p}' \
    | awk 'match($0, /^[0-9]+/) {
        d = substr($0, 1, RLENGTH) + 0; split(substr($0, RLENGTH + 1), a, " ")
        v = a[2]; sub(/^v/, "", v)
        if (in_fn && d <= fd) in_fn = 0
        if (a[1] == "function" && !in_fn) { in_fn = 1; fd = d; next }
        if (in_fn) print a[1] " " v
      }' | sort -u
}
# The semver series a version belongs to (0.x for 0.x.y, else the major).
SERIES='function series(v) { sub(/\+.*/, "", v); split(v, p, "."); return p[1] == "0" ? "0." p[2] : p[1] }'
# Closure crates whose series Cargo.lock also has, at a different version:
# "<name> <have> <want>".
drifted() {
  closure | awk "${SERIES}"' NR == FNR { lock[$1 SUBSEP series($2)] = $2; next }
    ((k = $1 SUBSEP series($2)) in lock) && lock[k] != $2 { print $1, $2, lock[k] }' \
    <(printf '%s\n' "${TEMPLATE_LOCK}") -
}
# An empty or partial closure (cargo tree failing quietly) would compare nothing.
built="$(closure)"
for crate in connectrpc tokio hyper tower; do
  grep -q "^${crate} " <<<"${built}" \
    || { echo "conformance.sh: the harness build's closure of the function lacks ${crate}; cannot compare it" >&2; exit 2; }
done
for _ in 1 2 3; do
  pending="$(drifted)"
  [ -n "${pending}" ] || break
  while read -r name have want; do
    cargo update --quiet -p "${name}@${have}" --precise "${want}" || true
  done <<<"${pending}"
done
pending="$(drifted)"
if [ -n "${pending}" ]; then
  echo "conformance.sh: a crate the release binary links differs from its Cargo.lock here (name, built, locked):" >&2
  printf '  %s\n' "${pending}" >&2
  exit 2
fi
extra="$(closure | awk "${SERIES}"' NR == FNR { lock[$1 SUBSEP series($2)] = 1; next }
  !(($1 SUBSEP series($2)) in lock) { print $1 "@" $2 }' <(printf '%s\n' "${TEMPLATE_LOCK}") - | paste -sd ' ' -)"
echo "every crate the release binary links matches its Cargo.lock; feature unification adds: ${extra:-nothing}"
cargo build -p connectrpc-conformance --features function-stack --bin function-stack-server
# known-failing.txt lists the cases the function's whole-body bound refuses on
# purpose; any other failure, or one of those passing, fails the run.
RUST_LOG=warn "${RUNNER}" --mode server --conf "${HERE}/conformance/config.yaml" \
  --known-failing "@${HERE}/conformance/known-failing.txt" -- target/debug/function-stack-server
