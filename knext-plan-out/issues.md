# knext — Proposed issues (ready to open)

_Drafted by the knext Architect-Planner run (date: today). Each issue is independently shippable,
names real files, and sits on the sanctioned architecture path (the Go operator is the single
source of truth for cluster state; no new second cluster writers). They are ordered by priority —
see `assessment.md` §3 for the rationale. They deliberately do **not** duplicate existing board
items (#66 image opt, #68 Node CLI, #53 npm, #33/#67 control-plane consolidation, #41 compat
matrix, #30 observability salvage)._

> **Terminology used below** (defined once, for cold readers):
> - **Operator** — the Go/Kubebuilder controller in `packages/kn-next-operator/` that watches a
>   `NextApp` custom resource and creates the real Kubernetes objects for it.
> - **`NextApp` CR** — the custom resource (a YAML object of `kind: NextApp`) the CLI applies; it is
>   the user's desired state. The operator reconciles it into a Knative Service + ServiceAccount +
>   PersistentVolumeClaim (PVC) + optional KafkaSource.
> - **Reconcile** — the operator's core loop: read the `NextApp`, make the cluster match it.
> - **Knative Service (ksvc)** — the scale-to-zero serverless workload object knext deploys onto.
> - **envtest** — the Kubebuilder test harness that runs a real Kubernetes API server locally so
>   controller logic can be tested without a full cluster.
> - **Finalizer** — a marker on a Kubernetes object that pauses its deletion until the operator runs
>   cleanup logic, then removes the marker to let deletion complete.
> - **ADR-0001** — the project decision that only the operator may write cluster state.

---

## Issue 1 — Operator: assert reconcile output (Knative Service / SA / PVC / KafkaSource) in controller tests

**Suggested labels:** `tier-A`, `test` · **Suggested milestone:** Tier A (correctness)

### Context
The Go operator (`packages/kn-next-operator/`) is, by ADR-0001, the single source of truth for what
knext puts on the cluster. Its reconcile loop (`internal/controller/nextapp_controller.go`) creates
a Knative Service, a ServiceAccount, a bytecode-cache PVC (when `Spec.Cache.EnableBytecodeCache` is
set), and an optional KafkaSource, and sets `Status.Conditions`.

### Problem
The only controller test, `internal/controller/nextapp_controller_test.go` (~88 lines), asserts that
`Reconcile()` returns without error. It does **not** assert that any child object was created, nor
that the objects carry the right spec (image, scaling annotations, PVC mount, env vars). There are
**no error-path tests** (e.g. missing image, KafkaSource creation failure). A regression that, say,
stops mounting the bytecode-cache PVC or drops the digest-pinned image would pass CI today.

This directly violates a stated hard rule — _"gate every parity claim on tests; unverified
correctness is not done"_ (`.claude/rules/architecture.md`) — at the most important layer.

### Proposed change
Extend the envtest-based controller suite so that, after reconciling a representative `NextApp`, it
fetches the created child objects from the test API server and asserts their key fields:
- **Knative Service:** name/namespace; container image equals `Spec.Image` (digest-pinned);
  autoscaling annotations match `Spec.Scaling` (`min-scale`, `max-scale`, container concurrency);
  `containerConcurrency` and request timeout match spec/defaults; ServiceAccount is referenced.
- **ServiceAccount:** created and owner-referenced by the `NextApp`.
- **PVC:** created **only when** `Spec.Cache.EnableBytecodeCache` is true; correct size
  (`Spec.Cache.BytecodeCacheSize` or the documented default) and mounted into the ksvc.
- **KafkaSource:** created **only when** `Spec.Revalidation` is configured; absent otherwise.
- **Error paths:** an invalid `NextApp` (e.g. tag-only/`:latest` image) ends with a `Degraded`/not-
  `Ready` condition and no malformed children; a transient child-create failure surfaces as an error
  result (so it is requeued) rather than a false success.

### Acceptance criteria (testable)
- [ ] New/extended tests in `internal/controller/` create a `NextApp` via envtest and assert the
      ksvc, ServiceAccount, and (conditionally) PVC and KafkaSource exist with the fields above.
- [ ] A test asserts the PVC is **not** created when `EnableBytecodeCache` is false, and **is** when
      true.
- [ ] At least one error-path test asserts a rejected/invalid `NextApp` results in a non-`Ready`
      condition and no orphaned children.
- [ ] `make test` runs the new tests in CI (they already run via the operator test job); coverage of
      `nextapp_controller.go` measurably increases.

### Components & files touched
- `packages/kn-next-operator/internal/controller/nextapp_controller_test.go` (extend)
- `packages/kn-next-operator/internal/controller/suite_test.go` (envtest setup, if helpers needed)

### Architecture notes & risks
- envtest does not run the Knative or Kafka controllers, so assert on the **objects the operator
  creates**, not on downstream effects (no ksvc will actually become Ready). That is the correct
  scope for a controller unit test.
- Keep representative-CR fixtures small; do not re-test field round-tripping already covered by
  `api/v1alpha1/nextapp_types_test.go`.

---

## Issue 2 — Operator: NextApp deletion finalizer that clears external storage/cache, and retire `cleanup.ts`'s direct cluster writes

**Suggested labels:** `tier-A` · **Suggested milestone:** Tier A (control-plane consolidation)

### Context
ADR-0001 says only the operator may write cluster state. Issue #33 consolidated the **deploy** path:
`packages/kn-next/src/cli/deploy.ts:225` now applies **only** the `NextApp` CR. But the **teardown**
path was never consolidated: `packages/kn-next/src/cli/cleanup.ts` still runs `kubectl delete`
against cluster objects directly **and** clears object storage itself — the same "second cluster
writer" violation #33 fixed for deploy, but for deletion.

Separately, when a `NextApp` is deleted, its owned Kubernetes children (ksvc, SA, PVC) are garbage-
collected via owner references, but **external state is orphaned**: assets the app uploaded to
GCS/S3 and the app's Redis keyspace (`REDIS_KEY_PREFIX`) are left behind. There is no finalizer —
the operator's RBAC declares the `finalizers` verb but no finalizer logic is implemented.

### Problem
Two coupled gaps: (a) deletion is still done out-of-band by the CLI, contradicting ADR-0001; and
(b) nothing cleans the app's external storage/cache on delete, so repeated deploy/delete cycles leak
object-store data and Redis keys.

### Proposed change
- Implement a **finalizer** on `NextApp` in the operator. On deletion, before removing the finalizer,
  the operator deletes the app's external state it is responsible for: the object-store prefix for
  that app (per `Spec.Storage`) and the Redis keyspace under the app's `Spec.Cache.KeyPrefix` (per
  `Spec.Cache`). Owned k8s children continue to be removed by ownerRef GC.
- Make the **CLI teardown emit intent, not mutate the cluster**: `cleanup.ts` should `kubectl delete`
  **only the `NextApp` CR** (mirroring how `deploy.ts` applies only the CR) and stop deleting
  individual k8s objects or clearing storage directly. The operator's finalizer becomes the single
  authority for teardown.
- Make external cleanup **best-effort and observable**: if the object store / Redis is unreachable,
  log and emit a warning condition/event but do not block CR deletion indefinitely (document the
  chosen behavior, e.g. a bounded retry then proceed).

### Acceptance criteria (testable)
- [ ] envtest test: creating then deleting a `NextApp` adds the finalizer on create and removes it on
      delete; the object is gone only after the finalizer runs.
- [ ] Unit test of the cleanup routine: given a fake/mock object-store and Redis client, deleting a
      `NextApp` calls the expected delete operations scoped to that app's prefix/keyspace (and never a
      different app's prefix).
- [ ] `cleanup.ts` no longer issues `kubectl delete` against ksvc/SA/PVC or storage SDK calls; a test
      (mirroring the existing CLI tests) asserts it issues only a `NextApp` CR delete.
- [ ] Documented behavior for unreachable external stores (does not hang deletion).

### Components & files touched
- `packages/kn-next-operator/internal/controller/nextapp_controller.go` (+ a `finalizer.go`)
- `packages/kn-next-operator/internal/controller/*_test.go`
- `packages/kn-next/src/cli/cleanup.ts` (remove direct cluster/storage writes)
- `packages/kn-next/src/__tests__/` (CLI teardown test)

### Architecture notes & risks
- **Cross-app safety is critical:** cleanup must be scoped strictly to the deleting app's storage
  prefix and `KeyPrefix`. A wildcard delete could wipe another zone's data — this intersects the
  data-sovereignty rule (`.claude/rules/scs-zones.md`). The cross-app test above guards this.
- Best-effort external cleanup is a deliberate trade-off: never wedge a CR in `Terminating` because
  Redis is down. Document it as such.
- This is the natural completion of #33; consider linking them so the maintainer can confirm #33's
  deploy half is done and scope #33 to closure.

---

## Issue 3 — CLI: extend asset-upload verification to S3/MinIO/Azure and add tests for the data-plane path

**Suggested labels:** `tier-A`, `test` · **Suggested milestone:** Tier A (correctness)

### Context
`packages/kn-next/src/utils/asset-upload.ts` (`uploadAssets`) uploads the built static assets (the
`_next/static` bundle and public files) to the configured object store (GCS, S3, MinIO, or Azure)
during deploy. These assets are what the running app serves to browsers, so a partial or failed
upload produces an app that 404s its own JS/CSS/images.

### Problem
Verification is **inconsistent across providers, and there are no tests at all**:
- The **GCS** branch already does the right thing: after the bulk `gsutil` copy it lists the bucket,
  diffs against the local file set, and re-uploads any missing files (`asset-upload.ts:52-90`).
- The **S3** (`aws s3 sync`), **MinIO** (`mc cp`), and **Azure** (`az storage blob upload-batch`)
  branches are a bare bulk command with **no post-upload verification and no retry**
  (`asset-upload.ts:92-101`). A partial upload on those providers ships a broken app with no
  deploy-time signal.
- `asset-upload.ts` has **no unit tests**, so neither the working GCS path nor the unverified
  branches are protected against regression.

### Proposed change
- **Extend the GCS verification pattern to S3, MinIO, and Azure:** after the bulk upload, list the
  remote prefix, diff against the local file set, re-upload missing objects, and **fail the deploy
  loudly** (non-zero exit) with the list of still-missing keys if any remain.
- Factor the "list remote → diff against local → report/retry" logic into a shared helper so all four
  providers verify the same way and the logic is unit-testable.
- Improve **error reporting**: log per-file failures with the object key and the underlying error,
  not just an aggregate count.
- Add **unit tests** (mocking the shell/storage calls) covering, for at least GCS and one
  S3-compatible provider: a fully successful upload; a partial failure that is surfaced (deploy fails
  naming the missing keys); and verification detecting a missing object. GCS + an S3-compatible store
  are the two real data planes per CLAUDE.md §9.

### Acceptance criteria (testable)
- [ ] The S3, MinIO, and Azure branches perform a verification pass after upload and throw/exit
      non-zero with the offending keys when objects are missing (matching the GCS branch).
- [ ] The verify-and-retry logic is a shared helper used by all four providers.
- [ ] Per-file errors are logged with key + error message.
- [ ] New tests in `packages/kn-next/src/__tests__/` mock the shell/storage calls and assert, for
      GCS and one S3-compatible provider: success path uploads the expected keys; partial-failure
      path fails the deploy and names the missing keys; verification catches a missing object.
- [ ] Tests run in the existing vitest CI job.

### Components & files touched
- `packages/kn-next/src/utils/asset-upload.ts`
- `packages/kn-next/src/__tests__/asset-upload.test.ts` (new)

### Architecture notes & risks
- Verification adds a remote `ls` + diff at deploy time — negligible cost, large reliability win;
  keep it to a bounded check (full list compare is fine for typical `_next/static` sizes).
- Uploads shell out to provider CLIs (`gsutil`/`aws`/`mc`/`az`) via Bun's `$`; mock the shell layer
  in tests — do not require live cloud credentials in CI.
- This is correctness-tier because a broken upload defeats goal #1/#4 (the deployed app doesn't
  serve) — it is not cosmetic polish.

---

## Issue 4 — Publish and sign the operator image, and ship an installable operator bundle (replace the placeholder digest)

**Suggested labels:** `track-P`, `tier-B` · **Suggested milestone:** Track P (promotion / adoption)

### Context
To run knext, a user must run the operator in their cluster. The "fame-first / adoption" track
already tickets the user-facing CLI (#68) and npm publish (#53). The operator has no equivalent.

### Problem
The operator is **not installable today**:
- `packages/kn-next-operator/config/manager/manager.yaml:71` pins an **all-zeros placeholder digest**
  (`…@sha256:0000…`) with a TODO — no real operator image is published anywhere.
- The supply-chain workflow (`.github/workflows/supply-chain.yml`) builds, scans, and signs the
  **app** image, but **not** the operator image.
- There is no single `install.yaml` (CRDs + RBAC + manager Deployment) a user can `kubectl apply` to
  install knext's control plane.

So even with a published CLI and npm packages, an outside user cannot stand up knext.

### Proposed change
- Add a CI job (extending or mirroring `supply-chain.yml`) that **builds the operator image**,
  generates its **SBOM**, **scans** it (Trivy/Grype, fail on HIGH/CRITICAL on `main`), **signs** it
  (cosign keyless) + attestation, and **pushes** it to the registry — the same bar already applied to
  the app image (#48).
- Produce a versioned, **digest-pinned `install.yaml`** bundle (CRDs + RBAC + manager Deployment) as
  a release artifact, with `manager.yaml` referencing the real published digest instead of the
  placeholder.
- Document the one-command install (`kubectl apply -f <release-url>/install.yaml`) in the operator
  README / docs.

### Acceptance criteria (testable)
- [ ] CI builds + SBOMs + scans + signs + pushes the operator image; the run fails on HIGH/CRITICAL
      on `main` (matching the app-image policy).
- [ ] `config/manager/manager.yaml` references a **real digest-pinned** image (no `:latest`, no
      all-zeros placeholder); the existing `:latest` guard passes.
- [ ] A release produces an `install.yaml` bundle whose manager image is digest-pinned, and applying
      it to a kind cluster installs the CRD + RBAC + manager (can reuse the operator's existing
      kind/e2e harness for the smoke check).
- [ ] Operator README documents the install command.

### Components & files touched
- `.github/workflows/` (operator image build/scan/sign job; release bundling)
- `packages/kn-next-operator/config/manager/manager.yaml` (real digest)
- `packages/kn-next-operator/Makefile` (bundle/`install.yaml` target if not present)
- `packages/kn-next-operator/README.md`

### Architecture notes & risks
- Coordinate versioning with the npm/changesets release (#53) so the operator image tag, the
  `install.yaml`, and the CLI version that emits the CR move together (avoid CR-schema/operator skew).
- Keep digest pinning end-to-end — this is itself an ADR-0001 / security invariant (reject `:latest`).
- Signing requires registry + OIDC permissions in CI; document the required secrets/permissions.

---

## Issue 5 — Operator: validating admission webhook to reject invalid `NextApp` CRs at admission time

**Suggested labels:** `tier-B`, `security` · **Suggested milestone:** Tier B (platform)

### Context
The operator enforces digest pinning (rejects `:latest`/tag-only images) and other invariants inside
its reconcile loop (`internal/controller/validate_image.go`, #34). The Kubebuilder scaffold for an
admission webhook + cert-manager exists but is disabled — `cmd/main.go:146` has the commented-out
cert-manager wiring.

### Problem
Because validation runs only during reconcile, the Kubernetes API server **accepts an invalid
`NextApp`** (e.g. an unpinned image or a malformed spec); the user sees success on `kubectl apply`,
and the failure surfaces only later as a controller log / `Degraded` condition. There is no
admission-time gate that rejects a bad CR at write time with a clear error.

### Proposed change
- Implement a **validating admission webhook** for `NextApp` that enforces, at admission:
  digest-pinned image (no `:latest`/tag-only — reuse the existing `validate_image.go` logic), and
  basic spec sanity (required `Image`; non-negative scaling; `MinScale ≤ MaxScale`; recognized
  `Storage.Provider` / `Cache.Provider` / `Revalidation.Queue` values).
- Wire the webhook + cert-manager (uncomment/complete the `cmd/main.go` scaffold and the
  `config/webhook` + `config/certmanager` kustomize overlays).
- Share the validation code path between the webhook and the reconciler so the two cannot drift.

### Acceptance criteria (testable)
- [ ] Applying a `NextApp` with a `:latest` or tag-only image is **rejected by the API server** with
      a clear message (test via envtest webhook support or an e2e kind test).
- [ ] Applying a spec-invalid `NextApp` (e.g. `MinScale > MaxScale`, missing image) is rejected at
      admission.
- [ ] A valid `NextApp` is admitted and reconciles as before.
- [ ] cert-manager / webhook config is enabled in the install bundle and covered by the e2e harness.

### Components & files touched
- `packages/kn-next-operator/internal/webhook/` (new validating webhook)
- `packages/kn-next-operator/cmd/main.go` (enable webhook + cert-manager)
- `packages/kn-next-operator/config/webhook/`, `config/certmanager/` (kustomize overlays)
- shared validation in `internal/controller/validate_image.go` (refactor to reuse)

### Architecture notes & risks
- This is **defense-in-depth**, not a fix for a current hole — reconcile is already fail-closed on
  digest pinning. Prioritized below the Tier-A items accordingly.
- A webhook adds a hard dependency on cert-manager and a serving cert; a misconfigured webhook can
  block all `NextApp` writes. Use `failurePolicy: Fail` only after the e2e harness proves the cert
  path; document the dependency. Coordinate with the install bundle (Issue 4).

---

## Issue 6 — Security: remove the mutating `GET /api/cache/invalidate` handler (a GET must be side-effect-free)

**Suggested labels:** `tier-B`, `security` · **Suggested milestone:** Tier B (platform)

### Context
`apps/file-manager/src/app/api/cache/invalidate/route.ts` exposes both `POST` and `GET` handlers.
Both call `revalidateTag(tag, 'max')` — i.e. **both mutate cache state**. Both are Bearer-auth
fail-closed (good), and the file's own comment says: _"A mutating GET is a smell; retire this handler
once callers move to POST."_

### Problem
A `GET` with side effects violates HTTP semantics and is a security/operational hazard even when
auth-gated: GETs are prefetchable by browsers/crawlers, link-triggerable, loggable with their query
string, and cacheable by intermediaries. A token that ever appears in a URL (logs, history,
referrer) is far more exposed than one in a header-only POST. The project's hard rule is _"no
unauthenticated mutating endpoints"_; this is the adjacent rule — _mutations must be POST/DELETE,
not GET_.

### Proposed change
- **Remove the `GET` handler** from `invalidate/route.ts`; keep the authenticated `POST` as the only
  invalidation entrypoint.
- If a query-string convenience is genuinely needed for testing, fold it into the `POST` (accept the
  `tag` from JSON body only) rather than re-introducing a mutating GET.
- Grep the repo/docs/scripts for callers of the GET form (`/api/cache/invalidate?tag=`) and update
  them to POST (the compat-smoke script and any docs).

### Acceptance criteria (testable)
- [ ] `invalidate/route.ts` exports no `GET` handler; `GET /api/cache/invalidate` returns 405.
- [ ] A test asserts the `GET` is gone (405) and `POST` (authorized) still invalidates.
- [ ] No remaining references to `GET /api/cache/invalidate?tag=` in app code, scripts, or docs.

### Components & files touched
- `apps/file-manager/src/app/api/cache/invalidate/route.ts`
- any caller in `apps/file-manager/scripts/` or docs
- a test under `apps/file-manager/src/app/api/cache/invalidate/`

### Architecture notes & risks
- Low risk: the POST path already exists and is tested; this removes surface area.
- If external automation relies on the GET form, this is a breaking change for it — call it out in
  the changeset/PR so any operator runbooks switch to POST.

---

## Issue 7 — Operator: emit Kubernetes Events and controller metrics on reconcile

**Suggested labels:** `tier-B` · **Suggested milestone:** Tier B (platform)

### Context
The app side has Prometheus metrics and Pino logging, and #30 tracks salvaging further app
observability. The **operator** itself has neither Kubernetes Events nor custom controller metrics —
its only output is `logger.Info/Error` lines in `internal/controller/nextapp_controller.go`.

### Problem
When a `NextApp` fails to reconcile (bad image, KafkaSource failure, API error), the only signal is a
controller log line. A user running `kubectl describe nextapp <name>` sees no **Events**, and an
operator has no metrics for reconcile **count / duration / error rate** to alert on. This makes
debugging and SLO-style monitoring of the control plane hard.

### Proposed change
- Use the controller-runtime **EventRecorder** to emit Events on key transitions: reconcile
  started/succeeded, each child created/updated, and each failure (with reason + message), attached
  to the `NextApp` so `kubectl describe` surfaces them.
- Register **custom Prometheus metrics** via controller-runtime's metrics registry: reconcile total
  (by result), reconcile duration histogram, and reconcile error counter. (controller-runtime
  already exposes a metrics endpoint; this adds knext-specific series.)

### Acceptance criteria (testable)
- [ ] envtest test asserts an Event is recorded on a successful reconcile and on a failure path
      (using the fake recorder).
- [ ] The operator registers the new metrics; a test asserts the reconcile-total counter increments
      after a reconcile.
- [ ] `kubectl describe nextapp <name>` shows knext Events (verify in the kind e2e harness).
- [ ] The new metrics appear on the operator's metrics endpoint.

### Components & files touched
- `packages/kn-next-operator/internal/controller/nextapp_controller.go` (EventRecorder + metrics)
- `packages/kn-next-operator/internal/metrics/` (new, metric definitions)
- `packages/kn-next-operator/internal/controller/*_test.go`

### Architecture notes & risks
- Lowest-priority of the set: it improves operability but fixes no correctness or security hole.
- Keep cardinality low (label by result/reason, never by per-object name) to avoid metric explosion.
- Complements, does not overlap, #30 (which is about app/runtime observability, not the operator).
