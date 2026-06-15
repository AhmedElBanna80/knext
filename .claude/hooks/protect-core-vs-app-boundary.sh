#!/usr/bin/env bash
# PostToolUse / Edit|Write — advisory (exit 0 always). The scope boundary (scs-zones rule): knext
# core is the DEPLOYMENT layer. Service-Worker / SWI / BroadcastChannel / Module-Federation runtime
# code is an APP-LEVEL recipe (pwa-zones) and must not land in core packages — that turns a focused
# adapter into an MFE platform. Warn if such runtime code appears under a core package.
set -uo pipefail

input=$(cat)
path=$(printf '%s' "$input" | jq -r '.tool_input.file_path // ""' 2>/dev/null || echo "")
content=$(printf '%s' "$input" | jq -r '.tool_input.new_string // .tool_input.content // ""' 2>/dev/null || echo "")
[ -z "$path" ] && exit 0

# Is this a core package (not the app template)?
case "$path" in
  *packages/kn-next/*|*packages/cli/*|*packages/kn-next-operator/*) : ;;
  *) exit 0 ;;
esac

# Does the content carry micro-frontend / PWA-stitch runtime machinery?
if printf '%s' "$content" | grep -qiE 'serviceWorker|service-worker|navigator\.serviceWorker|serwist|workbox|BroadcastChannel|Service Worker Includes|\bSWI\b|module[- ]?federation|ModuleFederation|navigation\.intercept|NavigateEvent'; then
  echo "ADVISORY (protect-core-vs-app-boundary / scs-zones): this file is in a knext CORE package but
contains Service-Worker / SWI / BroadcastChannel / Module-Federation runtime code. Per the scope
boundary, that machinery belongs in the OPT-IN app-level pwa-zones template, not core (packages/
kn-next, packages/cli, the operator). knext core owns deploy + App-Shell serving + precache-manifest
generation only. Move it to the app template. See .claude/rules/scs-zones.md + the pwa-zones skill." >&2
fi
exit 0
