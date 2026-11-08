# api/platform/v1alpha1

## Overview
Go types for the cluster-scoped `platform.kn-next.dev/v1alpha1` API group: the `KnextPlatform` singleton. It carries cluster-wide defaults that inheriting `NextApp`s get for fields they leave unset (the platform layer).

## Interface
- `groupversion_info.go:GroupVersion`: `schema.GroupVersion{Group: "platform.kn-next.dev", Version: "v1alpha1"}`, with `SchemeBuilder` and `AddToScheme`.
- `groupversion_info.go:CRDInstalled(meta.RESTMapper) (bool, error)`: a discovery probe for the KnextPlatform kind.
- `knextplatform_types.go:KnextPlatform` / `KnextPlatformList`: cluster scope, short name `kplatform`, status subresource. Print columns are Profile, Accepted, Ready and Age.
- `knextplatform_types.go:KnextPlatformSpec`: `Profile`, `Scaling` (`PlatformScaling`, `PlatformScalingDefaults`), `Resources` (`PlatformResources`, `PlatformResourceDefaults`), `Limits` (`PlatformLimits`), `Database` (`PlatformDatabase.ConnectionBudget`), `Rollout` (`PlatformRollout.MaxAppsPerMinute`) and `Cache` (`PlatformCache`: `ClusterID` and `RedisEndpoints[]` of `RedisEndpoint{Endpoint, ProvisionerSecretRef}`; the endpoints that may get per-app Redis ACL users; `ProvisionerSecretRef` names a Secret in the operator's namespace).
- `knextplatform_types.go:KnextPlatformStatus`: `ObservedGeneration`, `Conditions` and `Rollout` (`PlatformRolloutStatus{Pending, Applied, Held}`).
- Constants: `SingletonName = "default"`, `ProfileDefault = "default"`, `ProfileFastColdStart = "fastColdStart"`.

## Invariants
- `knextplatform_types.go:KnextPlatform`: a CEL rule requires `metadata.name == 'default'`, because only the singleton is honoured.
- `knextplatform_types.go:KnextPlatformSpec`: every field is optional and there are deliberately no schema-level defaults. An empty spec must render the same as having no KnextPlatform, so "unset" is never turned into "set".
- `knextplatform_types.go:RedisEndpoint.Endpoint` is the canonical in-cluster form `<service>.<namespace>.svc.cluster.local:<port>` (schema pattern); `RedisEndpoints` is a map list keyed by `endpoint`, at most 16.
- `knextplatform_types.go:KnextPlatformSpec.Profile` is the enum `default;fastColdStart`. `ProfileFastColdStart` is accepted but sets no value in this release.
- `knextplatform_types.go` schema bounds: `PlatformRollout.MaxAppsPerMinute`, `PlatformDatabase.ConnectionBudget` and `PlatformScalingDefaults.ContainerConcurrency` have `Minimum=1`; `PlatformLimits.TimeoutSeconds` is `1..3600`; `TargetBurstCapacity` has `Minimum=-1`, `PanicWindowPercentage` is `1..100` and `PanicThresholdPercentage` has `Minimum=110`; `ScaleDownDelay` has `MaxLength=16`.
- `knextplatform_types.go:PlatformResourceDefaults`: each of `cpuRequest`, `cpuLimit`, `memoryRequest` and `memoryLimit` is at most 32 characters and must match the Kubernetes `resource.Quantity` grammar (`Pattern`).
- `knextplatform_types.go:PlatformRolloutStatus`: `Pending`, `Applied` and `Held` are always serialized (no `omitempty`).
- `knextplatform_types.go:KnextPlatformStatus`: the operator writes only status and never the spec.
- `groupversion_info.go:CRDInstalled`: a no-match error means absent. Any other discovery error is returned, and callers fail start-up on it.

## Side Effects
- `knextplatform_types.go:init` registers the kinds on `SchemeBuilder` (process-local).
- `CRDInstalled` makes one RESTMapper discovery lookup.

## Verification
- Run: `go test ./api/...` (in `packages/kn-next-operator`), or `make test`.
