# kind-manifests

## Overview
Shared "fetch, verify, pin, apply" helpers for installing cert-manager, Knative Serving, Kourier and Calico into a cluster. The kind-based CI workflows and `scripts/prereqs/install.sh` use the first three; Calico is used only by the manual Z11 drill. `image-digest-pins.json` holds the table of mutable-tag images and their pinned digests, Calico's three included.

## Interface
- `apply-cert-manager.sh`: fetches the cert-manager `CERT_MANAGER_VERSION` (`v1.16.2`) release manifest, verifies its checksum, pins its images with `pin-known-images.sh --expect 3`, and runs `kubectl apply -f`.
- `apply-knative-kourier.sh <knative-version>`: fetches, verifies, pins and applies the Knative Serving CRDs, Serving core and net-kourier manifests. `PINNED_KNATIVE_VERSION` (`knative-v1.16.0`) names the one supported version. Only the Kourier manifest is pinned (`--expect 1`); the CRDs are applied first, then Serving core, then Kourier.
- `apply-calico.sh`: fetches the Calico `CALICO_VERSION` (`v3.28.2`) manifest, verifies its checksum, pins its three images (`docker.io/calico/{cni,node,kube-controllers}`) with `pin-known-images.sh --expect 3`, runs `kubectl apply -f`, then waits up to 300 s for `daemonset/calico-node` in `kube-system`. The cluster must have been created with the default CNI disabled. Only `packages/grpc/e2e/z11-activator-drill/run.sh` calls it; no CI workflow does.
- `pin-known-images.sh <manifest-file> [--expect N]`: rewrites the images listed in `image-digest-pins.json` to their digests, in place.
- `wait-for-webhook-ready.sh`: waits until `kn-next-operator-validating-webhook-configuration`'s first webhook has a non-empty `caBundle`. It then retries a `kubectl apply --dry-run=server` of a minimal NextApp in namespace `default` until it succeeds. Each phase has a 120 s deadline (`CABUNDLE_TIMEOUT_S`, `PROBE_TIMEOUT_S`) and polls every 3 s; on timeout it dumps the webhook configuration, the webhook service endpoints and the controller-manager logs, then exits 1.

## Invariants
- Each download is checked with `sha256sum -c` against a checksum hard-coded in the script. A checksum mismatch is never retried. Only the curl download retries: `fetch()` uses `--retry 5 --retry-connrefused --retry-delay $KIND_MANIFEST_RETRY_DELAY` (default 5 s), and its outer loop retries only curl exit codes 56, 52 and 35, at most 5 attempts.
- `apply-knative-kourier.sh` exits 1 when the requested version differs from `PINNED_KNATIVE_VERSION`. The version and the three sha256 values must change together.
- `pin-known-images.sh` fails (exit 1, `::error::`) if any `image:` is still not digest-pinned after pinning. The test is `digest_pinned`, which requires the value to end in `@sha256:<64 hex>`. With `--expect N` it also fails unless exactly N pins were applied.
- `wait-for-webhook-ready.sh` creates no cluster resource, because `--dry-run=server` validates and discards the probe.

## Side Effects
- Network downloads with curl. Writes the downloaded manifests under `${TMPDIR:-/tmp}` (`cert-manager.yaml`, `serving-crds.yaml`, `serving-core.yaml`, `kourier.yaml`, `calico-v3.28.2.yaml`). Runs `kubectl apply` against the current or shimmed context (cert-manager, Knative, Kourier, Calico).
- `pin-known-images.sh` edits the manifest file it is given (`sed -i`), reading the table with `jq`. `wait-for-webhook-ready.sh` writes two `mktemp` files and removes them on exit.

## Verification
- Run: `node scripts/bun-test.mjs tests/kind-manifest-checksum-pin.test.ts tests/kind-manifest-fetch-retry.test.ts tests/prereqs-bundle.test.ts tests/prereqs-bundle-safety.test.ts tests/z11-activator-drill.test.ts` (from the repo root). `tests/z11-activator-drill.test.ts` guards `apply-calico.sh`'s checksum and `--expect 3`.
