#!/usr/bin/env bash
# hack/check-no-latest.sh — CI guard that FAILS if any operator deployment
# manifest, Makefile, or kustomization file still references a mutable
# (non-digest-pinned) image tag.
#
# This enforces the digest-pinning requirement from ADR-0001 / A1-placeholder:
# the operator's own controller image must be pinned by digest, not by :latest
# or any other bare tag.
#
# Two categories of violation are detected:
#
#   1. ":latest" in image: / IMG= lines  (manager.yaml, Makefile)
#      Pattern: image: foo:latest  or  IMG ?= foo:latest
#
#   2. Bare newTag: in kustomization.yaml  (the effective deploy-time image)
#      A bare newTag is ANY newTag value that does NOT contain @sha256:.
#      e.g. `newTag: latest` and `newTag: a1-test` are BOTH violations.
#      Only `newTag: v1.0.0@sha256:<hash>` (or a `digest:` field) is safe.
#
# Usage:
#   bash hack/check-no-latest.sh          # from packages/kn-next-operator/
#   bash hack/check-no-latest.sh --quiet  # suppress passing-file output
#
# Exit codes:
#   0 — no violations found
#   1 — one or more violations found (fails CI)

set -uo pipefail

QUIET=false
[[ "${1:-}" == "--quiet" ]] && QUIET=true

# Files to inspect — relative to the script's package root.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"

VIOLATIONS=0

# ── Check 1: :latest in image: / IMG= lines ──────────────────────────────────
LATEST_FILES=(
    "$PKG_ROOT/config/manager/manager.yaml"
    "$PKG_ROOT/Makefile"
)

for file in "${LATEST_FILES[@]}"; do
    if [[ ! -f "$file" ]]; then
        echo "WARN: file not found, skipping: $file" >&2
        continue
    fi

    # Match non-comment lines with image:/IMG= ending in :latest.
    matching=$(grep -nE '^\s*(image:|IMG\s*\??=)\s*[^#]*:latest' "$file" || true)

    if [[ -n "$matching" ]]; then
        echo "FAIL: :latest image reference found in $file:"
        echo "$matching" | sed 's/^/  /'
        VIOLATIONS=$((VIOLATIONS + 1))
    else
        $QUIET || echo "OK:   $file"
    fi
done

# ── Check 2: bare newTag: in kustomization files (no @sha256: present) ────────
KUSTOMIZATION_FILES=(
    "$PKG_ROOT/config/manager/kustomization.yaml"
)

for file in "${KUSTOMIZATION_FILES[@]}"; do
    if [[ ! -f "$file" ]]; then
        echo "WARN: file not found, skipping: $file" >&2
        continue
    fi

    # Match non-comment newTag: lines whose value does NOT contain @sha256:.
    # A safe line looks like:  newTag: v1.0.0@sha256:abc...
    # Unsafe lines:            newTag: latest
    #                          newTag: a1-test
    #                          newTag: v1.0.0      (no digest)
    matching=$(grep -nE '^\s*newTag:' "$file" | grep -v '@sha256:' || true)

    if [[ -n "$matching" ]]; then
        echo "FAIL: bare newTag (no @sha256: digest) found in $file:"
        echo "$matching" | sed 's/^/  /'
        echo "      Use 'digest: sha256:<hash>' or 'newTag: <tag>@sha256:<hash>' instead."
        VIOLATIONS=$((VIOLATIONS + 1))
    else
        $QUIET || echo "OK:   $file"
    fi
done

if [[ "$VIOLATIONS" -gt 0 ]]; then
    echo ""
    echo "ERROR: $VIOLATIONS file(s) contain mutable image references."
    echo "       Pin every operator image by digest (@sha256:) before deploying."
    exit 1
fi

echo "All operator manifests are :latest-free and digest-pinned."
