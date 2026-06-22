# ADR-0011: Build-id-versioned assets, retention GC, and client→build pinning (skew protection)

- Status: Accepted
- Date: 2026-06-22
- Deciders: knext architect
- Related: ADR-0001 (operator = single source of truth), ADR-0006 (object-store data plane),
  ADR-0008 (app-namespaced assets + deletion finalizer), issue #93 (skew protection),
  issue #92 (rollback / traffic pinning), issue #75 (asset-upload verification)

## Context

*Version skew* happens when a browser still running build **A** (its HTML + chunk graph already
loaded) requests `_next/static/<A>/…` assets after the server has rolled forward to build **B**.
If those assets are gone, the user hits `ChunkLoadError` / hydration failures. Vercel solves this
with "skew protection": each client is pinned to the build it started on, and that build's assets
are retained for a window.

Two facts about knext's current data plane make this tractable:

1. **Assets are served from the durable object store**, not pod-local disk (`assetPrefix =
   <publicUrl>/<app>`, ADR-0008). A cold/scaled-to-zero pod of build B can still serve build A's
   chunks if they exist in the store.
2. **Upload is already additive.** No provider's bulk upload carries a prune/delete/mirror flag
   (`aws s3 sync --delete`, `gsutil rsync -d`, `mc mirror --remove`, …), and Next nests chunks under
   the build id, so a new deploy does **not** clobber a prior build's `_next/static/<A>/…`. A #92
   canary (rev A + rev B) therefore already serves A's chunks.

The real gaps: (1) the additive / build-id-scoped behaviour was unprotected by tests and could
regress; (2) nothing reaped old builds → unbounded storage growth; (3) clients were not pinned to a
build, so a query-string/`deploymentId` mechanism was missing.

## Decision

1. **Build-id scoping is a locked contract.** Static chunks live under
   `<app>/_next/static/<BUILD_ID>/…`. Regression tests assert upload is additive (no prune flag on
   any provider) and that two build-ids coexist after a second deploy.

2. **Client→build pinning via Next `deploymentId`.** `kn-next deploy` sets
   `NEXT_DEPLOYMENT_ID = <BUILD_ID>` **before** `next build`; `next.config.ts` reads it into
   `deploymentId`. Next then appends `?dpl=<id>` to asset/RSC requests and emits a skew signal, so a
   browser on build A keeps requesting build A's assets. The object store **ignores the query
   string** and resolves the content-hashed `_next/static/<A>/…` object, so even an un-pinned older
   client still resolves its build's chunk as long as the prefix is retained. We reuse the image tag
   as the build id, keeping build id ⇔ image ⇔ static prefix in lock-step.

3. **Bounded, build-id-aware, live-aware retention GC.** A pure function
   `selectBuildsToDelete({ remoteBuildIds, timestamps, liveBuildIds, retain })`
   (`packages/kn-next/src/utils/asset-gc.ts`) returns the build-ids safe to delete:

   > **keep iff** (within the newest `retain` window) **OR** (in the live set).

   `retain` defaults to `3`, configurable via `storage.assetRetention`. The **live set** is sourced
   **READ-ONLY** from `NextApp.Status.CurrentTraffic` (populated by the operator's
   `mapTrafficStatus`, #92) via `kubectl get nextapp <n> -o jsonpath={.status.currentTraffic}` — no
   cluster mutation (ADR-0001). This guarantees a **#92 pinned / canary / rolled-back** build is
   **never reaped, even when older than the window**. The deploy-time pruner
   (`pruneOldBuilds`) deletes strictly under `<app>/_next/static/<id>/`, best-effort (a GC failure
   never fails an already-shipped deploy). It never deletes the only/last build and refuses any
   delete URI not scoped to `_next/static/<id>/`.

4. **Authority split (load-bearing).** The ADR-0008 deletion finalizer's bare-`<app>/` delete is
   **TEARDOWN-ONLY** (whole-NextApp removal) and must NEVER be used as a deploy-time prune. The new
   GC is the **sole** build-id-pruning authority, and it only ever touches the
   `_next/static/<id>/` sub-namespace under `<app>/`. The two never overlap, so a deploy can never
   wipe the bare `<app>/` namespace.

## Options considered

| Option | Pins client | Bounded storage | Protects #92 rollback | Verdict |
|---|---|---|---|---|
| Do nothing (rely on additive uploads only) | No | No (unbounded) | Incidentally | Rejected — unbounded growth, no pinning |
| Time-only retention (TTL on objects) | No | Yes | No (could expire a live build) | Rejected — can reap a live build |
| **`deploymentId` + window-OR-live GC (chosen)** | Yes | Yes (keep newest N) | Yes (live set from Status.CurrentTraffic) | **Chosen** |
| Operator-owned GC | Yes | Yes | Yes | Deferred — keeps prune authority in the CLI/data-plane for now; revisit if the operator gains a storage client |

## Consequences

- Old clients keep working across a deploy for the retention window; storage is bounded to ~`retain`
  builds plus any live build.
- A rollback (#92) that pins an *old* revision is safe: its build is in `CurrentTraffic` → kept.
- Storage-cost vs safety is one knob (`storage.assetRetention`).
- The GC is conservative on failure: a listing/parse failure skips GC (keeps everything); the live
  set can only ever *add* keeps, never cause an over-delete.

## Action items / what is NOT covered here (honest scope)

- **Unit-tested now:** additive/no-prune lock, build-id-scoped keys, two-builds coexist, the pure GC
  selection logic, the deploy-time prune argv scoping, `parseLiveBuildIds`, and `deploymentId`
  wiring.
- **Deferred to nightly e2e (#89/#38 harness), NOT a PR gate:** actually serving an old client's
  chunks during a *live* canary in a real browser — that requires a cluster + browser and cannot be
  asserted in a unit test. This ADR does not claim that path is verified by the unit suite.
- Stamping the BUILD_ID into the Knative revision name (so the live-set match is exact rather than
  substring) is a possible follow-up; today `parseLiveBuildIds` returns whole revision-name tokens
  and the GC matches build-ids by membership, which is conservative (over-keep, never over-delete).
