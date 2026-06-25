# knext — Maturity & Reliability Assessment

_Produced by the knext Architect-Planner run (date: today). Grounded in the current `main` checkout
and the live issue board (`gh issue list`, `gh pr list`). Judged against the four project goals —
**(1) fluid compute / scale-to-zero, (2) bytecode caching, (3) zones as self-contained systems,
(4) infrastructure-as-code developer experience** — and the canonical strategy in `CLAUDE.md`,
`ROADMAP.md`, `docs/adr/`, and `.claude/rules/`._

---

## 0. Headline

knext has matured fast. The **strategically biggest gaps the project named for itself are already
on the board**: image optimization (#66, incl. the SSRF/`remotePatterns` hardening), the Bun-only
CLI that blocks `npx kn-next` (#68), the npm publish (#53), and control-plane consolidation behind
the operator (#33, #67). Tier-A correctness items like graceful shutdown (#44, closed), the
compat-smoke gate (#40, closed), digest pinning in the operator (#34, closed) and the CLI (#58,
closed) have landed.

So this run does **not** re-propose those. Instead it fills the **next layer of correctness and
reliability holes** that the board does not yet cover — concentrated in three places the recent
work moved fast and left thin:

1. **The operator's lifecycle and test coverage.** The reconciler creates resources well, but its
   core output (Knative Service / ServiceAccount / PVC / KafkaSource) is **not asserted by any
   test**, it has **no deletion/teardown story**, and it has **no admission-time validation**.
2. **The teardown path is still a second cluster writer.** #33/#67 consolidated the *deploy* path
   behind the operator; the *delete* path (`cleanup.ts`) still mutates the cluster and clears
   storage directly — the same ADR-0001 violation, unaddressed.
3. **Adoption plumbing for the operator itself.** Users can't run the operator: its image is an
   all-zeros placeholder digest and there is no installable bundle.

Plus two small, high-confidence security/data-plane hygiene fixes.

---

## 1. Component-by-component maturity

Legend: **🟢 mature** · **🟡 partial / risk** · **🔴 thin / missing**. Tiers/tracks reuse the
project's own labels (`tier-A` = correctness, `tier-B` = platform, `tier-C` = edge, `track-P` =
promotion).

### 1.1 Adapter runtime (`packages/kn-next/src/adapters/`) — 🟢
- `node-server.ts` spawns the standalone `server.js` and runs a Prometheus metrics sidecar on
  :9091; **no Nitro/Vinext code paths remain** (only "removed" NOTE comments). Migration is real.
- Graceful shutdown is genuinely good: `shutdown.ts` is a pure, injectable function with a 25 s hard
  cap kept under the 30 s k8s grace period; covered by `__tests__/shutdown.test.ts`. (#44 closed.)
- `cache-handler.js` (Redis + in-memory fallback) is solid and now loudly warns on the
  `REDIS_KEY_PREFIX` split-keyspace risk (#64 merged).
- **Gap:** image optimization is not in the runtime image yet — but this is **already #66** (object-
  store variant cache + `sharp` in the runner). Not re-proposed.

### 1.2 CLI (`packages/kn-next/src/cli/`) — 🟡
- **Deploy path is ADR-0001-compliant now.** `deploy.ts:225` applies **only** the `NextApp` CR
  (`kubectl apply -f <cr>`); the raw Knative/infra manifests are rendered for information but **not
  applied**. CR construction + digest validation live in `cli/cr-builder.ts`
  (`validateCRImageRef`). **This means #33's deploy half appears largely satisfied** — worth the
  maintainer confirming and narrowing/closing #33 to avoid stale scope.
- **Teardown path is NOT consolidated.** `cli/cleanup.ts` still runs `kubectl delete` directly and
  clears object storage itself — a **second cluster writer**, the same ADR-0001 violation #33 fixed
  for deploy, but for deletion. → **New issue (teardown finalizer).**
- **Bun-only** (`#!/usr/bin/env bun`, `import { $ } from "bun"`) — already **#68**.
- **Data-plane upload is untested and inconsistently verified.** `utils/asset-upload.ts`
  (GCS/S3/MinIO/Azure) has **no tests**. The **GCS** branch does verify (lists the bucket,
  re-uploads any missing files — `asset-upload.ts:52-90`), but the **S3, MinIO, and Azure** branches
  are a bare bulk `sync`/`cp` with **no post-upload verification and no retry**. A silent partial
  upload on those providers ships an app that 404s its own assets, with no deploy-time signal.
  → **New issue (asset-upload reliability + tests).**
- Other untested shell paths: `cleanup.ts`, `validate.ts`, `build.ts` (noted; folded into the two
  issues above rather than padded into separate tickets).

### 1.3 Manifest generation — 🟢 (TS generators already gone)
- There is **no `generators/` directory in tracked TS source** anymore: the full file list under
  `packages/kn-next/src/` is `adapters/`, `cli/` (build, cleanup, cr-builder, deploy, shared,
  validate), `config.ts`, `loader.ts`, and `utils/`. The only tracked `containerConcurrency`
  references are in `cli/deploy.ts` (building the CR) and the operator's `nextapp_types*.go` (the CR
  field). So the raw Knative/infra manifest generators the older notes referred to are **already
  removed from the tracked codebase** — the operator owns those values now (configurable via the
  `NextApp` spec, with defaults set in `internal/controller/nextapp_controller.go`).
- #67 ("retire the deprecated raw-manifest generators") is still open; given the above it may be
  satisfied or down to residual references — worth the maintainer verifying and closing/narrowing it.
  This run proposes **no** new work on this layer (nothing to build on a writer that no longer
  exists), and does not re-source the old hardcoded-value concern against deleted files.

### 1.4 Go operator (`packages/kn-next-operator/`) — 🟡 **(the biggest under-covered area)**
- **Reconcile is feature-complete-ish:** sets `Status.Conditions` (#35 closed), rejects `:latest` /
  enforces digest pinning (`validate_image.go`, #34 closed), provisions the bytecode-cache PVC when
  `Spec.Cache.EnableBytecodeCache`, owns all children via `SetControllerReference`.
- 🔴 **No controller-level test asserts the reconcile output.** `nextapp_controller_test.go` (~88
  lines) only checks that Reconcile returns without error — **nothing asserts the Knative Service,
  ServiceAccount, PVC, or KafkaSource were created with the right spec**, and there are **no
  error-path tests**. The project's north-star rule is "gate every parity claim on tests"; the
  operator's core output is currently ungated. → **New issue (operator controller tests).**
- 🔴 **No deletion/teardown logic.** RBAC declares the `finalizers` verb but no finalizer is
  implemented. Owned k8s children are garbage-collected via ownerRefs, but **external state is
  orphaned on NextApp delete**: uploaded GCS/S3 assets and the app's Redis keyspace
  (`REDIS_KEY_PREFIX`) are never cleaned. → **New issue (teardown finalizer; also retires
  `cleanup.ts` direct cluster writes).**
- 🟡 **No admission webhook.** Digest/spec validation runs only inside Reconcile, so an invalid CR
  is accepted by the API server and only fails later in a controller log. `cmd/main.go:146` still
  has the commented-out cert-manager scaffold. Defense-in-depth, not a hole in the existing
  fail-closed behavior. → **New issue (validating webhook).**
- 🟡 **No operator-level observability.** No Kubernetes Events on reconcile success/failure and no
  custom controller metrics (reconcile count/duration/errors). Distinct from #30 (app-side
  observability salvage). → **New issue (operator events + metrics), lower priority.**
- 🔴 **Operator is not installable/runnable by anyone.** `config/manager/manager.yaml:71` pins an
  **all-zeros placeholder digest** (`@sha256:0000…`) with a TODO; no published, signed operator
  image and no `install.yaml` bundle. This is an **adoption blocker** on par with #68/#53.
  → **New issue (publish + sign operator image + install bundle).**
- `BackendService` CRD is **designed only** (ADR-0004) — correct per sequencing (build after Tier-A).
  Not proposed.

### 1.5 Cache invalidation endpoints (`apps/file-manager/src/app/api/cache/…`) — 🟡
- `POST /api/cache/invalidate` and `DELETE /api/cache/events` are properly **fail-closed Bearer**
  auth with constant-time, length-checked comparison (#47 closed) — good.
- 🟡 **A mutating `GET /api/cache/invalidate?tag=…` handler still exists** (`invalidate/route.ts`).
  It is auth-gated, but a GET with side effects is unsafe by HTTP semantics — prefetchable,
  link-triggerable, and cacheable by intermediaries — and the code's own comment says "retire this
  handler once callers move to POST." Small, high-confidence fix. → **New issue (remove mutating
  GET).**

### 1.6 CI / supply chain (`.github/workflows/`) — 🟢/🟡
- `ci.yml` gates Biome + vitest (+coverage), an operator codegen-drift check, a `:latest` guard,
  and a **compat-smoke** step on Node and Bun (#40). Supply chain (`supply-chain.yml`): SBOM +
  Trivy (fail on main) + cosign (#48 closed). Release (`release.yml`): changesets, gated on
  `NPM_TOKEN`.
- 🟡 The **full official Next.js compatibility suite is not gated** (smoke only) — but ADR-0007
  documents *why* (it requires a `vercel/next.js` checkout + 16-way shard, a nightly/dispatch cost,
  not per-PR) and **#41** tracks publishing the compat matrix. The honest position is already
  captured; not re-proposed. The supply-chain workflow builds/scans/signs the **app** image — it
  does **not** build/sign the **operator** image (see 1.4).

### 1.7 Zones / SCS (goal #3) — 🟡 documented, deliberately deferred
- `README-MULTI-ZONE.md` describes the model; only `apps/file-manager` exists, plus an **untracked**
  `.output/adapters/multi-zone-proxy.ts` build artifact (Nitro/h3 — build cruft, not repo source).
  Per `.claude/rules/scs-zones.md`, zone generation / MFE isolation / the PWA layer **stay
  app-level until after Tier-A correctness.** Proposing to build them now would **contradict the
  stated sequencing**, so this run does not. Flagged here so it is a conscious deferral, not an
  oversight.

---

## 2. Scoring against the four goals

| Goal | State | Evidence | This run's contribution |
|---|---|---|---|
| **1. Fluid compute / scale-to-zero** | 🟢 strong | e2e regression tickets exist (#38/#39); PVC feature flags (#59); shutdown drains (#44) | Indirect: operator teardown + tests harden the control plane that drives it |
| **2. Bytecode caching** | 🟢 strong | `NODE_COMPILE_CACHE` regression test (#37); e2e reuse (#38); PVC (#59) | None needed — well covered |
| **3. Zones as SCS** | 🟡 deferred | docs only; sequencing defers to post-Tier-A | None — proposing now violates sequencing (flagged, not built) |
| **4. IaC developer experience** | 🟡 partial | CLI (#68), npm (#53), docs site (#55) on board | **Operator image + install bundle** (new) closes the "can't actually run the operator" gap |

---

## 3. Prioritization rationale (why the proposed issues, in this order)

The north star is **verified correctness**, and the hard rules put the **operator as the single
source of truth**. The proposed issues are ordered so the highest-leverage correctness/architecture
debt comes first, adoption-enabling work next, then security hygiene, then operability:

1. **Operator controller tests** (`tier-A`) — the operator's core output is unverified; the "gate
   every claim on tests" rule is violated at the most important layer. Highest leverage.
2. **Teardown finalizer + retire `cleanup.ts` cluster writes** (`tier-A`) — completes ADR-0001 for
   the delete path (the mirror of #33) and stops orphaning external storage/cache state.
3. **`asset-upload.ts` reliability + tests** (`tier-A`) — an untested data-plane upload can silently
   ship a broken app; this is correctness, not polish.
4. **Publish + sign the operator image + install bundle** (`track-P`/`tier-B`) — adoption blocker:
   nobody can run the operator today (placeholder digest, no bundle). Peer of #68/#53.
5. **Operator validating webhook** (`tier-B`, security) — defense-in-depth: reject bad CRs at
   admission, not in a controller log. Lower than the above because reconcile is already fail-closed.
6. **Remove the mutating `GET /api/cache/invalidate`** (`tier-B`, security) — small, high-confidence
   HTTP-semantics/security hygiene fix the code already flags.
7. **Operator Events + metrics** (`tier-B`, operability) — improves debuggability; lowest urgency.

All seven are independently shippable, name real files, and sit on the sanctioned path (operator =
sole writer; no new second-writers introduced). None contradicts an ADR or the sequencing; the
control-plane second-writer concern is being closed on the sanctioned path (deploy via #33/#67;
this run adds the missing **teardown** half rather than duplicating the deploy work).
