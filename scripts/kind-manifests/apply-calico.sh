#!/usr/bin/env bash
# Install Calico, a NetworkPolicy-enforcing CNI, on a kind cluster created with
# `networking.disableDefaultCNI: true` and podSubnet 192.168.0.0/16.
#
# Checksum-pinned AND image-digest-pinned, the same discipline as
# apply-cert-manager.sh and apply-knative-kourier.sh: a moved or edited release
# asset fails the checksum, and Calico's three images
# (docker.io/calico/{cni,node,kube-controllers}:v3.28.2) are tag-only releases, so
# pin-known-images.sh rewrites each to its digest.
set -euo pipefail

CALICO_VERSION="v3.28.2"
CALICO_SHA256="be59408bf990e96276f631d2f9285c2a0f9802194c0ad1cecdb6d9c52623a1c8"
OUT="${TMPDIR:-/tmp}/calico-${CALICO_VERSION}.yaml"

# Bounded retries: a transient upstream 5xx must not red the whole job. Only the
# DOWNLOAD retries; the checksum below is unchanged and a mismatch is never retried.
fetch() { # <url> <sha256> <file>
  local delay="${KIND_MANIFEST_RETRY_DELAY:-5}" attempt=1 rc
  while :; do
    if curl -fsSL --retry 5 --retry-connrefused --retry-delay "$delay" -o "$3" "$1"; then
      break
    else
      rc=$?
    fi
    case "$rc" in
      56 | 52 | 35)
        if [ "$attempt" -ge 5 ]; then return "$rc"; fi
        attempt=$((attempt + 1))
        sleep "$delay"
        ;;
      *) return "$rc" ;;
    esac
  done
  echo "$2  $3" | sha256sum -c -
}

fetch "https://raw.githubusercontent.com/projectcalico/calico/${CALICO_VERSION}/manifests/calico.yaml" \
  "$CALICO_SHA256" "$OUT"

"$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/pin-known-images.sh" "$OUT" --expect 3

kubectl apply -f "$OUT"
kubectl -n kube-system rollout status daemonset/calico-node --timeout=300s
