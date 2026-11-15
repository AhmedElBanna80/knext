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
main_at="$(grep -n '^async fn main() -> Result<()> {$' "${SRC}" | cut -d: -f1)"
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
  # The function crate names connectrpc and connectrpc-health from crates.io:
  # build both from this checkout, so the router the function serves is the
  # conformance service's own type and the version is the one checked above.
  cat >>Cargo.toml <<'TOML'

[patch.crates-io]
connectrpc = { path = "connectrpc" }
connectrpc-health = { path = "connectrpc-health" }
TOML
fi
# The new dependency grows the graph, so this build resolves without
# --locked; the protocol stack pinned above (buffa, hyper, hyper-util, h2)
# stays where it was.
cargo build -p connectrpc-conformance --features function-stack --bin function-stack-server
# known-failing.txt lists the cases the function's whole-body bound refuses on
# purpose; any other failure, or one of those passing, fails the run.
RUST_LOG=warn "${RUNNER}" --mode server --conf "${HERE}/conformance/config.yaml" \
  --known-failing "@${HERE}/conformance/known-failing.txt" -- target/debug/function-stack-server
