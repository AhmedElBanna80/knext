#!/bin/sh
# Per-patch behaviour checks for the patched base: each patch's repro must behave FIXED on the
# patched binary and BROKEN on stock Bun of the same release (the negative control). A check that
# passes on both binaries does not discriminate and proves nothing, so the control is mandatory.
#
#   sh smoke-patches.sh <patched-bun> <stock-bun>     (musl binaries: run it in Alpine)
#
# Run by .github/workflows/bun-base-build.yml in its Alpine smoke step. POSIX sh (Alpine has no
# bash). Exits non-zero on the first check that does not hold, naming it.
set -eu
BUN="$1"
STOCK="$2"
t="$(mktemp -d)"
fail() { echo "smoke-patches: FAIL: $1" >&2; exit 1; }
"$BUN" --revision
"$STOCK" --revision

# ── 001-bun-45007-const-assign (oven-sh/bun#45010) ──────────────────────────────────────────────
# An assignment to a `const` in code that never runs must not stop the module from loading (Node
# defers it to a runtime TypeError). Two shapes: the module run directly, and the shape the compat
# lane hit — a compiled executable (compiled by STOCK Bun, with the binary under test as its base)
# loading a chunk from disk at run time, as Next's standalone server loads Turbopack chunks.
mkdir -p "$t/chunks"
printf 'if (process.argv[2] === "x") { const e = 1; e = 2 }\nconsole.log("loaded")\n' >"$t/chunks/c.js"
printf 'require(require("path").resolve(process.argv[2]));\n' >"$t/main.js"
cd "$t"
"$STOCK" build --compile --compile-executable-path="$BUN" --target=bun-linux-x64-musl main.js --outfile app-patched >/dev/null
"$STOCK" build --compile --compile-executable-path="$STOCK" --target=bun-linux-x64-musl main.js --outfile app-stock >/dev/null
set +e
"$BUN" chunks/c.js >p.out 2>&1
p=$?
"$STOCK" chunks/c.js >s.out 2>&1
s=$?
"$BUN" chunks/c.js x >px.out 2>&1
px=$?
./app-patched chunks/c.js >cp.out 2>&1
cp=$?
./app-stock chunks/c.js >cs.out 2>&1
cs=$?
set -e
echo "const-assign: patched exit $p, stock exit $s; compiled on patched base exit $cp, on stock base exit $cs; patched with the assignment reached exit $px"
[ "$p" = 0 ] && grep -qx loaded p.out || fail "patched Bun did not load the const-assign module (exit $p)"
[ "$s" = 1 ] && grep -q 'Cannot assign to "e" because it is a constant' s.out || fail "stock Bun loaded the const-assign module (exit $s): the control no longer discriminates — has the fix shipped?"
[ "$cp" = 0 ] && grep -qx loaded cp.out || fail "a compiled exec on the patched base did not load the chunk from disk (exit $cp)"
[ "$cs" = 1 ] || fail "a compiled exec on the stock base loaded the chunk (exit $cs): the control no longer discriminates"
# When the assignment DOES run it must still throw — at run time, as a TypeError.
[ "$px" != 0 ] && grep -q TypeError px.out || fail "patched Bun did not throw a TypeError when the assignment ran (exit $px)"

echo "SMOKE_PATCHES_OK"
