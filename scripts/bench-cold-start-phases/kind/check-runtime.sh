#!/usr/bin/env bash
# Check that a command line runs the expected runtime. Reads NUL-separated argv on stdin (the format
# of /proc/<pid>/cmdline); only argv[0] is judged, and only by its basename, so an argument such as
# /app/bundle.js (contains "bun") or /opt/node_modules/x cannot pass for, or against, a runtime.
#
#   check-runtime.sh <node|bun> [--allow-empty] < cmdline
#
# Exit 0 when basename(argv[0]) equals the runtime. Empty input exits 0 only with --allow-empty (a
# node arm renders no container command and uses the image default). Otherwise exit 1 and print the
# basename found on stderr.
set -euo pipefail

want="${1:?runtime node|bun}"
case "$want" in node | bun) ;; *) echo "unknown runtime '$want'" >&2; exit 2 ;; esac
allow_empty=0
[ "${2:-}" = "--allow-empty" ] && allow_empty=1

IFS= read -r -d '' argv0 || true
if [ -z "$argv0" ]; then
  [ "$allow_empty" = 1 ] && exit 0
  echo "empty command line" >&2
  exit 1
fi
base="${argv0##*/}"
if [ "$base" = "$want" ]; then
  exit 0
fi
echo "argv[0] basename is '${base}', want '${want}'" >&2
exit 1
