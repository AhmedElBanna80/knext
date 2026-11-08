# internal/controller

## Overview
The operator's reconcilers. This package is the single source of truth for cluster state.

- `NextAppReconciler` turns a `NextApp` into a Knative Service and its owned children (ServiceAccount, Knative `caching` Image, NetworkPolicy, opt-in image-prewarm DaemonSet, retained KafkaSource, zone signing key and JWKS). It writes one computed status.
- `BackendServiceReconciler` renders a zone function as a cluster-local h2c Knative Service with its own ServiceAccount and NetworkPolicy.
- `KnextPlatformReconciler` maintains the platform singleton's status.

A reconcile pass fetches the object, reconciles its children, computes a pure status verdict (`status_verdict.go:computeStatusVerdict`) and applies it.

## Interface
- `setup.go:SetupControllers(mgr, cleaner ExternalCleaner, opts ...SetupOption) error`, with `SetupOption` and `WithZoneSigningKeyConfig(ZoneSigningKeyConfig)`.
- `nextapp_controller.go:NextAppReconciler`: fields `Client`, `Scheme`, `APIReader`, `Recorder`, `Cleaner`, `RedisDialer`, `Clock`, `PlatformCRDPresent`, `BackendServiceCRDPresent` and `ZoneSigningKey`. Methods are `Reconcile` and `SetupWithManager`.
- `backendservice_controller.go:BackendServiceReconciler`: fields `Client`, `Scheme`, `APIReader` and `Recorder`. Methods are `Reconcile` and `SetupWithManager`. Also defines `BackendServiceFinalizer = "apps.kn-next.dev/backendservice-cleanup"`.
- `platform_controller.go:KnextPlatformReconciler`: `Reconcile` and `SetupWithManager`.
- `finalizer.go`: `ExternalCleanupFinalizer = "apps.kn-next.dev/external-cleanup"`, the `ExternalCleaner` interface (`CleanupStorage`, `CleanupCache`), and `StorageTarget` / `CacheTarget`.
- `external_cleaner.go`: `DefaultCleaner` and `NewDefaultCleaner()`. Storage cleanup uses the S3 API for providers `s3` and `minio`; any other provider is a no-op with a warning. Cache cleanup uses go-redis.
- Renderers exported for `cmd/policygen`:
  - `nextapp_networkpolicy.go:DesiredNetworkPolicy(appName, namespace)`;
  - `backendservice_render.go:RenderFunctionObjects(bs, zoneRetention)` and `DesiredFunctionNetworkPolicy(function, zone, namespace)`;
  - the name helpers `FunctionServiceAccountName` and `FunctionNetworkPolicyName`;
  - `VisibilityClusterLocalLabelValue`.
- Zone identity (`zone_signing_key.go`): `ZoneSigningKeyConfig{PropagationBound, RotationInterval}`, `ValidateZoneSigningKeyConfig`, `ZoneIssuer` (`knext:zone:<namespace>/<zone>`), `FunctionAudience` (`knext:fn:<namespace>/<function>`), `ZoneKeyID` (base64url of the first 16 bytes of SHA-256 over the public key), `RotateSigningKeyAnnotation = "apps.kn-next.dev/rotate-signing-key"`, `DefaultZoneKeyPropagationBound`, `MinZoneKeyPropagationBound` (90s, `ZoneKeyKubeletRefreshWorstCase`), `ZoneKeyOverlap = time.Hour`, `ZoneSigningKeyMountDir = "/var/run/knext/signing-key"`, `ZoneSigningKeyVolumeName`, `ZoneIssuerEnv = "KNEXT_ZONE_ISSUER"`, and `FunctionTokenEnvPrefix = "KNEXT_TOKEN_"` with `FunctionTokenIssuerEnv` / `FunctionTokenAudienceEnv`.
- Sovereignty (`backendservice_sovereignty.go`): `ZoneJWKSConfigMapName` (`<zone>-knext-jwks`), `ZoneSigningKeySecretName` (`<zone>-knext-signing-key`), `ZoneLabel = "apps.kn-next.dev/zone"`, `FunctionLabel = "apps.kn-next.dev/function"`, `ZoneJWKSFileName = "jwks.json"` and `ZoneJWKSMountDir = "/var/run/knext/jwks"`.
- Function rendering constants (`backendservice_render.go`): `ProtoVersionAnnotation = "apps.kn-next.dev/proto-version"` and `FunctionJWKSVolumeName = "knext-zone-jwks"`. `FunctionServiceAccountName` is `<function>-function` and `FunctionNetworkPolicyName` is `<function>-function-ingress`.
- Database binding (`database_binding.go`): `DefaultDatabaseURLKey = "DATABASE_URL"` and `DefaultDatabaseURLROKey = "DATABASE_URL_RO"`.
- Platform status conditions (`platform_controller.go`): `PlatformConditionAccepted`, `PlatformConditionDefaultsPropagated` and `PlatformConditionReady`.
- Binding env contract (`backend_bindings.go`): `WakeFunctionsEnv = "KNEXT_WAKE_FUNCTIONS"`, `BindingURLEnv(name)` (`<NAME>_SERVICE_URL`) and `BindingProtoVersionEnv(name)` (`<NAME>_SERVICE_PROTO_VERSION`).
- `identity.go:OperatorFieldManager = "kn-next-operator"`: the UserAgent and field manager recorded for every operator write.
- Redis ACL user (`redis_acl.go` pure, `redis_acl_ownership.go` who owns a prefix, `redis_acl_reconcile.go` I/O): `reconcileCacheCredentials` runs before the Knative Service render and returns a `cacheCredentialsState`; `injectCacheCredentialsEnv` binds `REDIS_URL` to the operator-owned Secret in memory; `RedisCredentialsSecretName(zone)` is `<zone>-redis-credentials`; `RedisProvisioner` / `RedisProvisionerDialer` are the injectable Redis view; `appRedisCommands()` is the granted command list; `redisACLUsername(clusterIdentity, app)` is `knext-app-<8 hex>-<12 hex>`; `CacheCredentialsReady` reasons are the `ReasonCache*` constants.
- Condition types, defined as `Condition*` constants across the package:
  - always-relevant: `Ready`, `Reconciling`, `Degraded`, `DatabaseReady`, `ImageCacheReady`, `ZoneSigningKey`, `BackendBindings`;
  - network and exposure: `NetworkPolicyEnforced`, `NetworkPolicyDisabled`, `PrivateExposure`, `PodCreationBlocked`;
  - platform and spec: `PlatformDefaultsApplied`, `RevalidationDeferred`, `EnvMapCollision`, `DatabaseHostLint`, `CDNAdvisory`, `CDNReservedEnvIgnored`;
  - zone functions: `Bound`, `JWKSTrusted`, `SovereigntyCompliant`;
  - cache: `CacheCredentialsReady`, present only while isolation is requested or in force.

## Invariants
- `nextapp_controller.go:Reconcile` validates with `validation.ValidateNextAppSpecWithBudget`, the same code the webhook uses. The reconciler is fail-closed, as defense in depth.
- New status, condition, event or requeue logic goes in `status_verdict.go:computeStatusVerdict`, which is pure with no I/O. Never add it as a new branch in `Reconcile`.
- `nextapp_controller.go:Reconcile` writes status once, and only when the computed status differs from the observed status. This prevents an idle reconcile hot-loop.
- `nextapp_controller.go:SetupWithManager` applies `GenerationChangedPredicate` (OR `rotationRequestChanged`) only to the primary `For(&NextApp{})` watch. The `Owns` watches (Knative Service, ServiceAccount, NetworkPolicy, DaemonSet) are unfiltered so drift is repaired. It also watches Revisions, DomainMappings (only when the `serving.knative.dev/v1beta1` DomainMapping kind is served), BackendServices (only when that CRD is present) and the KnextPlatform (only when that CRD is installed, which also sets `PlatformCRDPresent`).
- `setup.go:SetupControllers` always registers the NextApp reconciler, and refuses an invalid `ZoneSigningKeyConfig` before registering anything.
- `nextapp_controller.go` (step 4c): an image-prewarm DaemonSet failure degrades only `ImageCacheReady`. It never aborts the pass.
- `nextapp_controller.go` (KafkaSource step): unreachable on purpose, because `revalidationDeferred` is true for every `queue: kafka` app.
- `setup.go:SetupControllers` registers the BackendService and KnextPlatform reconcilers only when discovery reports the CRDs are installed. A discovery error other than no-match fails start-up.
- `finalizer.go`: external cleanup is best-effort and bounded by `externalCleanupTimeout = 30s`.
  - The storage scope is exactly `appStoragePrefix` (`<app.Name>/`), never bucket-wide. This must stay in step with the CLI uploader's `appKeyPrefix()`.
  - The Redis scope is `SCAN MATCH "<KeyPrefix>:*"` (the prefix glob-escaped) with batched DEL, never FLUSHDB. A cache provider other than `redis` is a no-op.
  - The legacy shared fallback prefix is never reaped (`redis_key_prefix.go:legacySharedRedisKeyPrefix`).
- `backendservice_controller.go:BackendServiceReconciler` writes only the BackendService's metadata (owner reference and finalizer), its status, and its owned children. It never writes the BackendService spec, the zone's NextApp, or the zone's Knative Service.
- `backendservice_controller.go`: a function without a two-sided binding is rendered as nothing, and anything previously rendered for it is deleted (fail closed).
- `backendservice_render.go`: function Knative Services carry `networking.knative.dev/visibility: cluster-local` and an `h2c` container port.
- `backendservice_sovereignty.go`: a function may reference only allowlisted credentials, and never a `*-knext-signing-key` Secret. The database-host check is a lint and never rejects.
- `zone_signing_key.go` rotation order:
  1. Stage a new key and publish it in the JWKS.
  2. Wait for `PropagationBound` (default 120s).
  3. Switch signing to the new key.
  4. Drop the old key after a 1h overlap.

  Key material never leaves the Secret and the derived JWKS ConfigMap.
- `zone_signing_key.go:ValidateZoneSigningKeyConfig` refuses a bound below `MinZoneKeyPropagationBound`, a negative rotation interval, and a non-zero interval that does not exceed the bound plus `ZoneKeyOverlap`.
- `redis_acl.go:appRedisCommands` must equal `MINIMAL_COMMANDS` in `scripts/redis-acl-spike.mjs` plus `client|setinfo` (`TestAppRedisCommandsMatchTheSpike`). `INFO`, `KEYS`, `FLUSHALL`, `ACL` and pub/sub are never granted.
- `redis_acl_reconcile.go:reconcileCacheCredentials`: the provisioner credential is dialled only for an endpoint registered on the KnextPlatform and equal to the app's canonical `spec.cache.url`. An isolated app fails closed (REDIS_URL points at the operator-owned Secret, which may not exist) on every refusal; it never falls back to the shared URL. The Secret is written before `ACL SETUSER`, and a re-assert reuses the Secret's password. The provisioner Secret must canonicalise to exactly the registered endpoint (else `ProvisionerRefused`, no dial) and is dialled at the registered form, never at the Secret's own spelling.
- `redis_acl_ownership.go`: who owns a prefix is decided by rule, never by arrival (ADR-0071 D6a rule 2). Over the NextApps on one canonical endpoint that could actually be issued a user (isolation is not `none`, the spec passes `cacheLocalRefusal`), claims are ranked: the app whose prefix is its own derived prefix, then the oldest `creationTimestamp` (one-second resolution), then the smallest `uid`. Each claim wins unless a claim that already won overlaps it (equal, or nested at a `:`); a loser fails closed with `PrefixConflict` naming the owner and has its own ACL user removed. The owner removes the user of a visible loser. A user nobody visible owns (an orphan, another cluster's) that overlaps is a `PrefixConflict` and is never deleted. The check runs again after `ACL SETUSER`, so two claimants that wrote at the same moment from different views do not both keep a user: this app's is removed and it fails closed. `reservedCachePrefix` (the platform keyspace, and the derived shape that is not the app's own, nestings included) is `validation.CacheKeyPrefixViolation`, shared with admission; a refused squat also has its earlier user removed.
- `redis_acl_reconcile.go:sharedPathLive`: `CacheCredentialsReady` says `isolation not in force: shared credential live` unless the endpoint's own state shows nothing that can reach an app's keys. The decision is per endpoint, from server state: the provisioner must not be the `default` user; every user other than the provisioner and `knext-app-*` is read with `ACL GETUSER` (root patterns and selectors), and an enabled one whose key pattern can address a key under any app prefix on the endpoint (`patternMayCoverPrefix`, which errs toward "covers") holds the claim back; so does a same-endpoint app with `isolation: none` or a credential in its spec; a failed read is never a claim; then the two probes (no credential, `AUTH default` with an unissued password) must both be refused. The probes are necessary and not sufficient: under `requirepass` both are refused while the shared password still holds every key. No condition, event or message may say the app is isolated before that.
- `nextapp_controller.go:Reconcile`: a `reconcileCacheCredentials` error is not returned. `transientCacheCredentials` turns it into a fail-closed `ProvisionerRefused` state and `computeStatusVerdict` reports it and owns the requeue (`cacheResyncInterval` while ready, `cacheRetryInterval` for `ProvisionerRefused`, `AclUnsupported` and `PrefixConflict`), so a `Provisioned` condition from an earlier pass cannot outlive a pass that could not confirm it. `reconcile_fatality_guard_test.go` lists the step on its non-fatal allowlist for that reason.
- `redis_acl_reconcile.go:writeCredentialsSecret` is the only writer of `<app>-redis-credentials`: create with the NextApp as controller, or update. Never patch or delete; the owner reference collects it. A Secret of that name the NextApp does not control is never written.
- `finalizer.go:cleanupExternalState`: an app that has a `<app>-redis-credentials` Secret it controls takes `redis_acl_reconcile.go:cleanupIsolatedCache`; any other app takes `cleanupPlainCache` with the credential in `spec.cache.url`. The Secret decides, never `status.cache`, which is cleared on every pass that is not ready. In order: when the app owns its prefix (`ownsPrefixForCleanup`: not reserved, not outranked by an overlapping owner, whatever its own isolation setting), re-assert its ACL user from the Secret (a Redis restart may have lost it), sweep as the app's own user; then `ACL DELUSER`. A losing app is neither given a user nor allowed to sweep. When the endpoint is no longer registered the sweep still runs with the app's own credential and the returned error names the ACL user left behind. `cleanupPlainCache` never sweeps a reserved prefix.
- `zone_signing_key_reconcile.go`: the signing-key Secret and JWKS ConfigMap get a controller owner reference to the zone's NextApp at create only, so they are garbage-collected with it and the operator needs no delete on Secrets.
- `backendservice_controller.go:functionNetworkPolicyEnabled`: a function's NetworkPolicy is default-on and is skipped only on an explicit `spec.security.networkPolicy: false`. `RenderFunctionObjects` follows the same rule.
- `pod_hardening.go:nextAppRunAsNonRoot`: `runAsNonRoot` is rendered unless `spec.security.runAsNonRoot` is explicitly false.
- `platform_controller.go:KnextPlatformReconciler` writes only the KnextPlatform status subresource.
- `platform_rollout.go:rolloutLimiter` hands out re-render slots spaced `60/maxAppsPerMinute` seconds apart. Idle time does not bank capacity.
- `pod_hardening.go:restrictedContainerSecurityContext` is set at container level, never pod level. It sets `allowPrivilegeEscalation: false`, `capabilities.drop: [ALL]`, `seccompProfile: RuntimeDefault` and `runAsNonRoot: true` (unless opted out).
- `nextapp_networkpolicy.go:appMetricsPort = 9464` is the only app metrics port the default NetworkPolicy admits.

## Side Effects
- Kubernetes writes are made with `controllerutil.CreateOrUpdate`, `Patch`, `Delete` and `Status().Update`. The kubebuilder RBAC markers grant:
  - Knative serving `services` (full CRUD);
  - `serviceaccounts`, `networkpolicies`, `apps/daemonsets`, `caching.internal.knative.dev/images` and `sources.knative.dev/kafkasources`;
  - Secrets and ConfigMaps limited to `get;create;update` (zone key) or `get`;
  - `events` (`create;patch`);
  - NextApp, BackendService and KnextPlatform status, the NextApp and BackendService `finalizers` subresources, `nextapps` (full CRUD), `backendservices` (no create) and `knextplatforms` (`get;list;watch`).
- Read-only access to Knative `revisions`, `routes` and `domainmappings`, core `services`, `persistentvolumeclaims` and `apps/deployments`.
- `external_cleaner.go:DefaultCleaner` calls S3-compatible ListObjectsV2 and DeleteObjects (batches of 1000), and Redis SCAN and DEL, against external stores during NextApp deletion.
- Emits Kubernetes Events through `nextapp-controller` and `backendservice-controller`.
- Prometheus metrics on `metrics.Registry`:
  - from `metrics.go`: `knext_nextapp_reconcile_total`, `knext_nextapp_reconcile_errors_total`, `knext_nextapp_reconcile_duration_seconds`, `knext_nextapp_image_prewarm_errors_total`, `knext_platform_apps_held`, `knext_platform_holds_total`, `knext_platform_rollout_pending` and `knext_platform_rollout_wait_seconds`;
  - from `backendservice_metrics.go`: `knext_backendservice_reconcile_total`, `knext_backendservice_refusals_total` and `knext_backendservice_secrets_unverified_since_timestamp_seconds`.
- Generates Ed25519 keypairs (`zone_signing_key.go`) and stores them in the `<zone>-knext-signing-key` Secret. The public halves go in the `<zone>-knext-jwks` ConfigMap.

## Verification
- Run: `make test` (in `packages/kn-next-operator`). This package's envtest suites need `setup-envtest`. Pure unit tests also run via `go test ./internal/controller/...`.
