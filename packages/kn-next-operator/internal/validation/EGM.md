# internal/validation

## Overview
The single authoritative validation logic for `NextApp` and `KnextPlatform` specs. The admission webhook (`internal/webhook/v1alpha1`) and the reconciler (`internal/controller`) both call these functions, so an object rejected at write time is the same object the reconciler refuses to act on.

## Interface
- `validate.go:ValidateImageRef(image string) error`: the digest-pinning rule.
- `validate.go:ValidateNextAppSpec(spec)` / `ValidateNextAppSpecWithBudget(spec, budget int)`: the shared spec validation.
- `validate.go:ValidateNextAppSpecCreate` / `ValidateNextAppSpecCreateWithBudget`: create-time admission. Adds unratcheted env-collision rejection.
- `validate.go:ValidateNextAppSpecUpdate` / `ValidateNextAppSpecUpdateWithBudget(oldSpec, newSpec, budget)`: update-time admission with ratcheting.
- `validate.go:DatabaseEnvMapCollisions`, `EnvMapReservedCollisions` and `ReservedOperatorEnvNames(spec)`: env-name collision helpers.
- `validate.go:CDNRendersEnv(spec) bool`.
- `cache_prefix.go:DerivedCacheKeyPrefix(namespace, name)`, `IsPlatformKeyspace(prefix)`, `CacheKeyPrefixViolation(namespace, name, prefix) string` (empty when allowed), `ValidateNextAppCacheKeyPrefix(namespace, name, spec) error`, `EnvRedisKeyPrefix` (`REDIS_KEY_PREFIX`), `EnvKeyPrefixViolation(namespace, name, value) string` and `ValidateNextAppEnvKeyPrefix(namespace, name, oldSpec, newSpec) error`: the reserved Redis key prefixes. The webhook uses all of them; the reconciler uses `CacheKeyPrefixViolation` only (`internal/controller/redis_acl_reconcile.go`), never the env rule.
- `validate.go:OperatorAlwaysWinsEnvNames` (`HOSTNAME`) and `EnvMapUserAlwaysWinsEnvNames`.
- `validate.go:MaxConnections = 100` (documents Postgres `max_connections`) and `MaxAppConnections = defaults.ConnectionBudget` (the enforced budget).
- `platform.go:ValidatePlatformSpec(*KnextPlatformSpec) error` and `ValidateEffectiveResources(cpuReq, cpuLim, memReq, memLim) (field, error)`.
- `quantity.go:ParseQuantityBounded(value) (resource.Quantity, error)`, with `MaxQuantityExponent = 9999` and `MaxQuantityLength = 64`.
- `retention.go:LongestRenderedRetention(values ...string) time.Duration`.

## Invariants
- `validate.go:ValidateImageRef`: accepts only refs containing `@sha256:`. It rejects `:latest`, tagless refs and tag-only refs.
- `validate.go:ValidateNextAppSpec` also refuses an unknown `spec.cache.isolation` and a `spec.cache.keyPrefix` of `knext` or under `knext:` (the platform keyspace).
- `cache_prefix.go:ValidateNextAppEnvKeyPrefix` refuses a non-empty `spec.env[REDIS_KEY_PREFIX]` that is longer than 63 code points, holds whitespace or one of `* ? [ ] \`, or breaks `CacheKeyPrefixViolation` (`EnvKeyPrefixViolation`). Unlike `spec.cache.keyPrefix`, the shared fallback `kn-next` (and `kn-next:*`) is allowed: pinning it is the documented way to keep the warm cache through an upgrade. It is ratcheted: on update an unchanged value passes. Only the webhook applies it; `ValidateNextAppSpec`, and so the reconciler, does not.
- `cache_prefix.go:CacheKeyPrefixViolation` refuses, for every app, a key prefix that is `knext` or under `knext:`, and a prefix in the derived shape `^kn-[0-9a-f]{12}(:.*)?$` that is not the app's own derived prefix. The own prefix must be equal: a nesting under it is refused too, since `kn-<hash>:isr` is issued `~kn-<hash>:isr:*`, which is the ISR keys of the app the hash derives from. It needs the object's namespace and name, so `ValidateNextAppSpec` (which has neither) applies only the platform-keyspace half and the webhook calls `ValidateNextAppCacheKeyPrefix` for the rest. `DerivedCacheKeyPrefix` must equal the controller's `defaultRedisKeyPrefix` (`TestDerivedPrefixLockstepWithAdmission`).
- `validate.go:ValidateNextAppSpec` checks:
  - the image is required and digest-pinned;
  - `MinScale`, `MaxScale`, `ContainerConcurrency` and `PoolMax` are non-negative, and `MinScale <= MaxScale` when `MaxScale` is set;
  - `maxScale x poolMax <= budget` when a `poolMax` is declared, and a declared `poolMax` with an unbounded `maxScale` (0) is rejected outright;
  - `TargetBurstCapacity` is `-1` or `>= 0`;
  - `PanicWindowPercentage` is in `[1,100]` and `PanicThresholdPercentage` is `>= 110`;
  - `ScaleDownDelay` is delegated to Knative's own annotation validator;
  - each `WarmSchedule` window has a valid 5-field cron `start` and `end` (`validate.go:validateCronExpr`, robfig/cron `ParseStandard`), `replicas >= 1`, and `replicas <= MaxScale` when `MaxScale` is set;
  - the storage provider is one of `gcs`, `s3`, `minio`, `azure` or `local`, the cache provider is `redis` or `memory`, and the revalidation queue is `kafka`;
  - each `spec.resources` value is a positive quantity parsed by `ParseQuantityBounded`, and a request may not exceed its limit when both are set;
  - `spec.database.roSecretRef` requires `secretRef`, and both names are DNS-1123 subdomains;
  - `spec.traffic.canaryPercent` requires `revisionName`, and a `warmSchedule` cannot be combined with a pinned `revisionName`.
- `validate.go:validateNextAppSpec` deliberately does not reject `spec.revalidation.provisionKafkaSource`. The field is inert and reported by the reconciler instead.
- `validate.go:ValidateNextAppSpecWithBudget` with `budget == MaxAppConnections` behaves exactly like `ValidateNextAppSpec`, including the error text.
- `validate.go:ValidateNextAppSpecCreateWithBudget` rejects any `DATABASE_URL(_RO)` collision between `spec.database` and `spec.secrets.envMap`, and any envMap name reserved by the operator ("no silent precedence"). The names in `EnvMapUserAlwaysWinsEnvNames` (`REDIS_URL`, `KAFKA_BROKER_URL`, `OTEL_EXPORTER_OTLP_ENDPOINT`) are never rejected, because their only CR-side source is plaintext.
- `validate.go:ReservedOperatorEnvNames` is a hand-maintained mirror of the reconciler's `buildKsvcEnv`, not a shared call. `internal/controller/reserved_env_names_parity_test.go` holds the two in step.
- `validate.go:CDNRendersEnv` is true when `spec.cdn` is set and `spec.build` is not `vinext`.
- `validate.go:ValidateNextAppSpecUpdateWithBudget` is ratcheted:
  - a collision is rejected only when the update adds it;
  - the connection-budget wall is rejected only when the update raises `maxScale x poolMax` above the budget.
- `quantity.go:ParseQuantityBounded` is the only allowed way to parse a CR-supplied quantity. It bounds the string before calling `resource.ParseQuantity`.
- `platform.go:ValidatePlatformSpec`: a platform that fails here is ignored (built-in defaults apply), never merged. A nil spec is valid. It checks the profile enum, the scaling defaults with the same rules as the app fields (including Knative's scale-down-delay validator), positive bounded resource quantities with request <= limit when both are set, and non-negative timeout, connection budget and rollout rate.
- `platform.go:ValidateEffectiveResources` checks request <= limit on the merged values and skips any pair it cannot parse.
- `retention.go:LongestRenderedRetention` never rejects input. An empty or unparseable value counts as zero.

## Side Effects
- None. These are pure functions with no I/O.

## Verification
- Run: `go test ./internal/validation/...` (in `packages/kn-next-operator`).
