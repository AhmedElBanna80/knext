#!/usr/bin/env bash
#
# scripts/lib/e2e-verify-intentional-500.sh <next.js checkout root>
#
# Fails (naming each entry) when an entry of the empty-dir intentional-500
# allowlist (ed_intentional_500_entries in e2e-empty-dir.sh) no longer matches
# the pinned vercel/next.js checkout: its fixture file is gone, or no longer
# contains the string the entry matches on. A stale entry would otherwise
# linger as dead code — or worse, keep exempting a fixture that was renamed
# into something that should be held to the strict non-5xx check. Run by the
# compat-vinext workflow right after the pinned checkout (#2615).
set -euo pipefail

# shellcheck source=e2e-empty-dir.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/e2e-empty-dir.sh"

ed_verify_intentional_500_allowlist "${1:-}"
