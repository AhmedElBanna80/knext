# prereqs

## Overview
A single pinned command that installs the knext cluster prerequisites: cert-manager, Knative Serving and Kourier. It composes the helpers in [kind-manifests](../kind-manifests/EGM.md), waits for readiness, and can re-check an existing install.

## Interface
- `install.sh` modes:
  - `--context <name>`: install into that context.
  - `--yes`: install into the current context, for CI.
  - No flag: interactive. The script shows the context and asks for confirmation.
  - `--verify`: only asserts that everything is Ready.
  - `--print`: prints the pinned versions and exits.
- Pins: `KNATIVE_VERSION="knative-v1.16.0"`, `CERT_MANAGER_VERSION="v1.16.2"`. `WAIT_TIMEOUT` defaults to `300s` (`PREREQS_WAIT_TIMEOUT`).
- Function `verify()` runs `kubectl wait --for=condition=Available` on the cert-manager, Knative Serving, `net-kourier-controller` and `3scale-kourier-gateway` deployments, then exits 1 unless `config-network`'s `ingress-class` is `kourier.ingress.networking.knative.dev`.
- Exit codes: 2 for a usage error, a refused non-interactive run, no selected context or a declined prompt; 3 for a missing tool.

## Invariants
- A non-interactive run needs `--context` or `--yes`. The target context is always printed first. `--context` reaches every kubectl call, including the helpers' calls, through a PATH shim. The user's current context is never switched (header comment).
- The version pins here must move together with the checksums in the helpers. `tests/prereqs-bundle.test.ts` enforces this.
- Every step is a `kubectl apply` or a merge patch, so re-running the script converges.
- Required tools are `kubectl`, `curl` and `jq` (exit 3 if one is missing), plus `sha256sum` or `shasum`. `PREREQS_FORCE_SHA_FALLBACK=1` forces the `shasum` path.

## Side Effects
- Cluster writes through the helpers' `kubectl apply`, plus `kubectl patch configmap/config-network` (merge patch setting `ingress-class` to Kourier). Writes `kubectl` and `sha256sum` shims into a `mktemp -d` directory, removed on exit. Network downloads through the helpers.

## Verification
- Run: `node scripts/bun-test.mjs tests/prereqs-bundle.test.ts tests/prereqs-bundle-safety.test.ts` (from the repo root)
