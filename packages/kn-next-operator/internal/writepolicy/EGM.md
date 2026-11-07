# internal/writepolicy

## Overview
Answers one question at runtime: is the ValidatingAdmissionPolicy that confines the operator's cluster-wide Secret and ConfigMap writes actually in force for the identity the operator runs as? It publishes the answer as a gauge and logs a warning when the answer changes. The same verdict is computed by the `knext doctor` write-policy check (`packages/kn-next/src/cli/doctor/checks/write-policy.ts`), and both are held to `testdata/verdict-cases.json`.

## Interface
- `verdict.go:Evaluate(policy, binding, operatorUsername) Verdict`: the pure verdict.
- `verdict.go:Verdict{Enforced bool; Reason Reason; Detail string}`.
- `verdict.go:Reason` constants: `ReasonEnforced`, `ReasonPolicyMissing`, `ReasonBindingMissing`, `ReasonIdentityUnknown`, `ReasonPolicyFailsOpen`, `ReasonPolicyScope`, `ReasonPolicyModified`, `ReasonIdentityUnparseable`, `ReasonIdentityMismatch`, `ReasonBindingPolicyMismatch`, `ReasonBindingNotDeny`, `ReasonBindingScoped`, `ReasonUnverifiable`.
- `monitor.go:Source` interface: `Policy`, `Binding`, `OperatorUsername`.
- `monitor.go:Check(ctx, src, name) Verdict`: reads the identity, policy and binding, then calls `Evaluate`.
- `monitor.go:Monitor{Source, Name, Interval, Log}`: a manager Runnable with `Start`, `CheckOnce` and `NeedLeaderElection() == false`.
- `monitor.go:DefaultInterval = 5 * time.Minute`.
- `source.go:ClientSource` / `NewClientSource(*rest.Config)`: a client-go-backed `Source`.
- `canonical.go:canonicalCEL` / `policyCEL`: the canonical CEL variables and validations a policy must match to count as unmodified.

## Invariants
- `monitor.go:Check`: any read failure gives `ReasonUnverifiable`, which counts as not enforced. The gauge reports "on" only when enforcement was actually observed.
- `monitor.go:Monitor.Start` never returns an error for a failed check and never blocks start-up. It returns nil when `ctx` is cancelled.
- `monitor.go:Monitor.NeedLeaderElection` returns false, so every replica reports the gauge.
- `monitor.go:Monitor.CheckOnce` logs one line per verdict change, not one per check.
- `source.go:ClientSource.Policy` and `Binding` return `nil, nil` on NotFound.
- The package never writes policy objects. Its only create call is the `SelfSubjectReview` in `source.go:OperatorUsername`.

## Side Effects
- `monitor.go:enforcedGauge` is `knext_operator_write_policy_enforced` (unlabelled, 0 or 1), registered on `metrics.Registry` in `init`.
- `source.go`: GETs `ValidatingAdmissionPolicies` and `ValidatingAdmissionPolicyBindings` by name, and creates a `SelfSubjectReview` (authentication.k8s.io/v1) to learn the operator's own username.
- `monitor.go:Monitor.Start` runs a ticker loop at `Interval` (default `DefaultInterval`).

## Verification
- Run: `go test ./internal/writepolicy/...` (in `packages/kn-next-operator`). The envtest-backed tests need `make test` (`setup-envtest`).
