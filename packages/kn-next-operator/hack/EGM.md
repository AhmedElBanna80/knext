# hack

## Overview
Bash helpers for the operator's supply-chain and release workflow (digest pinning, signature verification, release immutability, release channels, Marketplace image index), plus bundle tweaks and mutation proofs. `boilerplate.go.txt` is the controller-gen license header. Files ending in `.bats.sh` are self-contained test harnesses for the scripts beside them.

## Interface
- `check-no-latest.sh`: CI guard that fails if any operator deployment manifest, Makefile or kustomization references `:latest` or a bare non-digest tag.
- `check-published-digest.sh [bundle ...]`: published-context guard (default file `dist/install.yaml`). The all-zeros placeholder digest and any `:latest` image must not survive into a release bundle, and a missing bundle file is a failure.
- `check-release-immutable.sh`: fails (exit 1) if a release for the given `operator-vX.Y.Z` tag already carries an `install.yaml` asset. Exits 0 when the release does not exist and 2 on any other `gh release view` failure.
- `cosign-verify.sh <image-ref>`: verifies the keyless cosign signature of a digest-pinned published operator image. Requires `cosign` on PATH.
- `marketplace-index-build.sh`: derives an attestation-free OCI image index from the gated layout without rebuilding.
- `marketplace-index-assert.sh`: asserts against the registry (`crane manifest`, overridable via `CRANE`) that the Marketplace index has no attestations and has the same platform, config and layer digests as the gated index.
- `release-channel.sh <ref> <ref_name>`: prints `publish`, `release_tag`, `version`, `is_stable` and `is_version_tag` lines for `$GITHUB_OUTPUT`. `refs/heads/main` maps to `operator-edge`; an `operator-vX.Y.Z[-pre]` tag maps to itself, with `is_stable=true` (so `operator-latest` moves) only when there is no prerelease suffix. A malformed operator tag exits 1; any other ref prints `publish=false`.
- `path-relevant.sh <before-sha> <after-sha> <repo-dir>`: prints `true` when the diff touches `packages/kn-next-operator/` or `.github/workflows/operator-supply-chain.yml`, else `false`. An all-zeros `before` SHA prints `true`. It is called only for `main` pushes; tag pushes are treated as relevant by the calling workflow, not by this script.
- `set-ingress-class.sh <bundle> [class]`: rewrites the Knative `config-network` ingress-class in a built bundle (for example net-istio or Contour). The class defaults to `$INGRESS_CLASS`, else `kourier.ingress.networking.knative.dev`. Exits 2 without a bundle argument and 1 when the file or its `ingress-class:` key is missing.
- `stamp-release-version.sh`: stamps the release version into `config/manager/kustomization.yaml` (`newTag: vX.Y.Z@sha256:...`) and the `app.kubernetes.io/version` label in `config/manager/manager.yaml`.
- `mutation-prove-webhook-down.sh`: deletes each protected webhook-down behaviour in turn and requires its guard test to go red.
- Test harnesses: `check-no-latest.bats.sh` (digest-pinned manager manifests and the `newTag` digest substitution) and `check-trivy-baseimage.bats.sh` (the Dockerfile builder is pinned to a patched Go point release).

## Invariants
- `check-release-immutable.sh`: only `operator-vX.Y.Z` releases are immutable. `operator-edge` and `operator-latest` are mutable by design.
- `marketplace-index-build.sh`: the Marketplace index references the same platform manifests (same digests) as the gated image. Nothing is rebuilt.
- `stamp-release-version.sh`: refuses to stamp unless there is exactly one `newTag: vX.Y.Z@sha256:<digest>` line and exactly two `app.kubernetes.io/version: unreleased` labels, keeps the digest, and aborts unless the tag stamp took effect and the new version label occurs exactly twice.
- `mutation-prove-webhook-down.sh`: never uses `perl`, every mutation anchor must occur exactly once, and the file must be byte-identical after restore (checked with `shasum -a 256`).
- Every script runs under `set -uo pipefail` or `set -euo pipefail`.

## Side Effects
- `stamp-release-version.sh` and `set-ingress-class.sh` rewrite files in the working tree.
- `check-release-immutable.sh` calls the GitHub API (`gh release view`). `cosign-verify.sh` contacts Sigstore. `marketplace-index-assert.sh` reads the container registry.
- `mutation-prove-webhook-down.sh` temporarily edits source files and runs tests.

## Verification
- Run: `bash hack/check-no-latest.bats.sh` and `bash hack/check-trivy-baseimage.bats.sh` (from `packages/kn-next-operator`). `make check-baseimage-pin` and `make test` cover the rest.
