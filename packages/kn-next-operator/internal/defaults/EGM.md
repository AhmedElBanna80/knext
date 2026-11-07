# internal/defaults

## Overview
The operator's single table of built-in values: what a NextApp gets for a field it leaves unset when no KnextPlatform says otherwise. The reconciler and the admission validator both read it, so the two never hold separate copies of the same number.

## Interface
- `defaults.go:ContainerConcurrency = 20`: per-pod concurrency soft target when `spec.scaling.containerConcurrency` is unset.
- `defaults.go:CPURequest = "250m"`, `CPULimit = "1000m"`, `MemoryRequest = "512Mi"`, `MemoryLimit = "1Gi"`: container resources when `spec.resources` is unset.
- `defaults.go:TimeoutSeconds = 300`: Knative request timeout when `spec.timeoutSeconds` is unset.
- `defaults.go:ConnectionBudget = 80`: the budget that `maxScale x poolMax` must fit within.
- `defaults.go:MaxAppsPerMinute = 10`: bound on platform-triggered re-renders. It acts only when a KnextPlatform exists.

## Invariants
- `defaults.go`: the values are `const`, so nothing can mutate the table at runtime.
- Every value is the pre-platform-layer behaviour. Changing one changes behaviour for every cluster that has not opted in, and both the pin test beside this file and the zero-diff golden in `internal/controller` fail on any change.

## Side Effects
- None.

## Verification
- Run: `go test ./internal/defaults/...` (in `packages/kn-next-operator`).
