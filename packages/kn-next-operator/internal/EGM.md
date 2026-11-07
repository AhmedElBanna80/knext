# internal

## Overview
Private Go packages of the operator module: the reconcilers, the shared validation layer, the admission webhook, the built-in defaults table, the write-policy self-check, and the metric-contract scanner. `internal/install` contains only test files (bundle and workflow guards), so it has no contract.

## Subdirectories & Boundaries
- controller: [./controller/EGM.md](./controller/EGM.md) - The `NextApp`, `BackendService` and `KnextPlatform` reconcilers (`SetupControllers`). They render Knative Services, NetworkPolicies, ServiceAccounts, zone signing keys and JWKS, clean up external storage and Redis on deletion through a finalizer, and compute status in the pure `computeStatusVerdict`.
- validation: [./validation/EGM.md](./validation/EGM.md) - The pure, shared spec validation (`ValidateNextAppSpec*`, `ValidateImageRef`, `ValidatePlatformSpec`, `ParseQuantityBounded`) used by both the webhook and the reconciler.
- webhook: [./webhook/EGM.md](./webhook/EGM.md) - The NextApp validating admission webhook (`failurePolicy=fail`), budget-aware through the KnextPlatform.
- defaults: [./defaults/EGM.md](./defaults/EGM.md) - The constant table of built-in values (concurrency 20, resources 250m/1000m/512Mi/1Gi, timeout 300s, connection budget 80, rollout 10 apps per minute).
- writepolicy: [./writepolicy/EGM.md](./writepolicy/EGM.md) - A runtime check that the Secret/ConfigMap write ValidatingAdmissionPolicy is in force. Publishes `knext_operator_write_policy_enforced`.
- metriccontract: [./metriccontract/EGM.md](./metriccontract/EGM.md) - An AST scanner that produces the golden list of metric families the operator binary registers.
