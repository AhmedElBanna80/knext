# packages/kn-next-operator

## Overview
The knext Go operator (controller-runtime / kubebuilder). It reconciles `NextApp`, `BackendService` and `KnextPlatform` custom resources into Knative Serving objects and their supporting resources. Leader election keeps exactly one active writer (`cmd/main.go:buildManagerOptions`). The module root has no direct Go source. The manager entry point is in `cmd/`. Kustomize bundles are in `config/`. Most of it is plain YAML, but two parts are a tested contract: the admission policy `config/admission/secret-configmap-writes.yaml` (kept in lockstep with the operator's own Secret and ConfigMap writes, including the `-redis-credentials` suffix; pinned by `internal/writepolicy/canonical_test.go` and `internal/controller/operator_write_inventory_test.go`) and the write-policy reader role `config/rbac/write_policy_reader_role.yaml` (pinned by `internal/controller/write_policy_reader_rbac_test.go`); and operator runbooks are in `docs/`. `test/` holds e2e helpers (`test/utils`) and the NetworkPolicy enforcement drill (`test/networkpolicy-enforcement-drill.sh`); it has no contract of its own.

## Subdirectories & Boundaries
- api: [./api/EGM.md](./api/EGM.md) - CRD Go types: `apps.kn-next.dev/v1alpha1` (`NextApp`, `BackendService`) and the cluster-scoped `platform.kn-next.dev/v1alpha1` `KnextPlatform` singleton, with their CEL validation rules.
- cmd: [./cmd/EGM.md](./cmd/EGM.md) - The `main` manager binary: flags, a stable leader-election Lease ID, webhook registration gated on `--webhook-cert-path`, health and readiness checks, and the write-policy monitor. Its `policygen` subcommand renders the operator's NetworkPolicy for the enforcement drill.
- internal: [./internal/EGM.md](./internal/EGM.md) - Reconcilers, shared validation, the admission webhook, the built-in defaults, the write-policy self-check and the metric-contract scanner.
- hack: [./hack/EGM.md](./hack/EGM.md) - Supply-chain and release bash helpers (digest-pin guards, cosign verification, release immutability and channels, Marketplace index), bundle tweaks and mutation proofs.

## Verification
- Run: `make test` (in `packages/kn-next-operator`). This runs `manifests generate fmt vet setup-envtest` and then the Go test suite. `go test ./...` runs the same packages if envtest assets are already set up.
