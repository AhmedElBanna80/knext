# knext Maturity Backlog (sequenced)

> **Status: planning artifact — not yet executed.** Source of truth for *direction* remains
> `CLAUDE.md` / `ROADMAP.md` / `docs/MATURITY_PLAN.md` / `docs/adr/*`. This file sequences those
> into epics → tickets with testable exit criteria. Sizes: S ≈ <1d, M ≈ 1–3d, L ≈ >3d.
> **Two non-negotiable invariants every ticket must preserve: scale-to-zero and cross-cold-start
> bytecode caching.** Grounded against source on 2026-06-18 (post live-OKE validation).

## Current-state ground truth (verified against source, do not regress)
- **Operator already reconciles** ksvc + bytecode-cache PVC (`nextapp_controller.go:201` sets
  `NODE_COMPILE_CACHE=/cache/bytecode/latest`, `:244` mounts a PVC), `min-scale:0` default
  (`:163`/`:184`), and **rejects untagged images** (`:66-69`). So control-plane consolidation is
  *partly built* — the gap is (a) `deploy.ts` still writes cluster state, (b) digest pinning is not
  enforced (`:latest` is only **warned**, `:71-72`), (c) `Status.Conditions` is **defined**
  (`nextapp_types.go:144`) but **not populated** by the reconciler, (d) placeholder images
  `controller:latest` in `config/manager/manager.yaml:66` + `Makefile:2`.
- **`deploy.ts` still `kubectl apply`s raw manifests** (`deploy.ts:153,176`) → **active ADR-0001
  violation**.
- **`infra/knative/`** exists today (kustomize `base/` + `overlays/oke` + `_template`, `install.sh`,
  README) — ADR-0005 partially landed as manifests. **Not yet** operator-managed `KnativeServing`
  verified on a 2nd cloud; ingress-class correctness not yet asserted by a test.
- **No image optimization** — no `sharp`, no `images:` config in `apps/file-manager` (parity gap).
- **CI = `.github/workflows/ci.yml` only** — **no official Next.js compatibility suite** gate.
- **Test-coverage hole**: container `CMD` runtime path had zero tests; the `NODE_COMPILE_CACHE`
  export bug (`f100deb`) shipped through CI + units + 2 reviews, caught only by live OKE test.
- `POST /api/cache/invalidate` (`apps/file-manager/.../route.ts`) — unauthenticated mutating
  endpoint (CLAUDE.md §7 known violation).

---

## Tier A — Correctness (the credibility gate; nothing later ships until this is green)

### Epic A1 — Control-plane consolidation (ADR-0001)  ★ critical path
| id | goal | exit criteria | deps | size | satisfies |
|----|------|---------------|------|------|-----------|
| A1-1 | Audit every cluster mutation in `deploy.ts`/`shared.ts`; map each to a `NextAppSpec` field | Written field-map table in ADR-0001 action items; gaps in `NextAppSpec` listed | — | S | ADR-0001 AI#1 |
| A1-2 | Add missing fields to `NextAppSpec`; regenerate CRD | `make manifests` clean; CRD covers every field A1-1 found; unit test per new field | A1-1 | M | ADR-0001 AI#2 |
| A1-3 | Refactor CLI to **build→push→apply the `NextApp` CR only**; remove raw `kubectl apply` of Knative/infra manifests | `grep kubectl apply deploy.ts` returns only the CR apply; e2e: deploy via CR on a real cluster yields a reachable URL | A1-2 | L | ADR-0001 AI#3, ROADMAP Tier A |
| A1-4 | `--dry-run` prints the rendered `NextApp` CR (no cluster writes) | `kn-next deploy --dry-run` emits valid CR YAML, asserts zero `kubectl` side-effects in test | A1-2 | S | MATURITY Phase 2 exit |
| A1-5 | Enforce **digest pinning**: reject `:latest` and tag-only images lacking `@sha256:` (configurable) in the operator admission path | Reconcile rejects `:latest` (not just warns); unit test for accept(digest)/reject(:latest)/reject(tag-only) | — | M | CLAUDE §4/§7, ROADMAP Tier A |
| A1-6 | Populate `Status.Conditions` (Ready/Reconciling/Degraded) + ksvc URL in reconciler | `kubectl get nextapp -o yaml` shows transitioning + terminal conditions; envtest asserts condition set | — | M | CLAUDE §9 operator gap |
| A1-7 | Fix placeholder images `controller:latest` → digest-pinned in `manager.yaml` + `Makefile` | No `:latest` in operator deploy manifests; CI grep-guard fails on `:latest` | — | S | CLAUDE §4, security.md |

### Epic A2 — Runtime/container regression coverage (the bug that escaped)
| id | goal | exit criteria | deps | size | satisfies |
|----|------|---------------|------|------|-----------|
| A2-1 | Container-level test asserting the running node process **has `NODE_COMPILE_CACHE` exported** and the dir fills on cold start | Test builds the image, runs `CMD`, inspects `/proc/1/environ` + cache dir non-empty after first request; red against pre-`f100deb` Dockerfile | — | M | live finding, MATURITY DoD#5 |
| A2-2 | **Cross-cold-start** bytecode-cache regression: scale-to-zero → scale-up reuses populated PVC | e2e: 2nd cold start reads cache (no recompile); asserts PVC persistence across pod restarts | A1-3 | L | core invariant, live finding |
| A2-3 | Scale-to-zero regression test (idle → 0 replicas → request → activates) | e2e asserts replicas reach 0 then serve a request post-activation | A1-3 | M | core invariant |

### Epic A3 — Official Next.js compatibility suite in CI  ★ the verified-adapter lever
| id | goal | exit criteria | deps | size | satisfies |
|----|------|---------------|------|------|-----------|
| A3-1 | ✅ **DONE** (PR #62) — `compat-smoke` gate (Node+Bun) runs on every PR, red on failure; per ADR-0007 | `ci.yml` runs the suite; PR is red on failure | — | L | ROADMAP Tier A, MATURITY Phase 1 |
| A3-2 | Wire the **full** official deploy-test harness (`vercel/next.js` `NEXT_TEST_MODE=deploy`) nightly + dispatch; publish feature matrix | `compat-suite-full` scheduled job + `docs/compat-matrix.md` linked in README | A3-1 | M | MATURITY Phase 1 exit |
| A3-3 | ✅ **DONE (no-op in code, 2026-06-20)** — `node-server.ts` is already Nitro-free (spawns standalone `server.js`; `adapter-migration.test.ts` enforces no `.output/server`). Remaining `nitro/runtime` refs are untracked local cruft, not in git. CLAUDE §9 stale claim corrected. | No `.output/server` references; adapter is sole runtime | A3-1 | M | ROADMAP Phase 0 exit, CLAUDE §9 |

### Epic A4 — Image optimization (biggest functional parity gap)
| id | goal | exit criteria | deps | size | satisfies |
|----|------|---------------|------|------|-----------|
| A4-1 | ADR: image-optimization strategy (sidecar optimizer vs CDN-resize vs re-add `sharp`) | `docs/adr/0006-image-optimization.md` with trade-off table + recommendation | — | S | MATURITY Phase 4, ROADMAP Tier A |
| A4-2 | Implement chosen strategy; `next/image` serves optimized variants | e2e: requesting an image returns resized/format-negotiated output; compat-suite image cases pass | A4-1, A3-1 | L | ROADMAP Tier A, CLAUDE §9 |

### Epic A5 — Graceful shutdown
| id | goal | exit criteria | deps | size | satisfies |
|----|------|---------------|------|------|-----------|
| A5-1 | SIGTERM drains in-flight requests + runs Next.js `after()` callbacks before exit | Test: in-flight request completes + `after()` runs after SIGTERM; no dropped requests on scale-down | — | M | CLAUDE §7, ROADMAP Tier A |

### Epic A6 — Ingress correctness (ADR-0005, finish what landed)
| id | goal | exit criteria | deps | size | satisfies |
|----|------|---------------|------|------|-----------|
| A6-1 | Operator/install sets the `kourier.ingress.networking.knative.dev` class declaratively via `KnativeServing` CR (never hand-fixed) | `install.sh` applies Operator + pinned `KnativeServing`; ingress class asserted post-install; OKE 404 root-cause cannot recur | — | M | ADR-0005 AI#1-2, live finding |
| A6-2 | Verify the *same* manifests stand up a working route on a 2nd cloud (GKE or kind) | Documented green run on kind/GKE; route returns 200 | A6-1 | M | ADR-0005 AI#3, MATURITY Phase 4 |

---

## Tier B — Platform (after Tier A is green)

### Epic B1 — Endpoint auth (no unauthenticated mutating endpoints)
| id | goal | exit criteria | deps | size | satisfies |
|----|------|---------------|------|------|-----------|
| B1-1 | Authenticate `POST /api/cache/invalidate` (signed token + internal-only NetworkPolicy) | Unauthenticated request → 401/403 (test); authed → 200; NetworkPolicy restricts source | — | M | CLAUDE §7, security.md, ROADMAP Tier B |
| B1-2 | Repo-wide audit: no unauthenticated mutating route/handler/webhook | Audit doc + a CI lint/check listing mutating endpoints and their auth | B1-1 | M | security.md hard line |

### Epic B2 — Supply chain (the open security milestone)
| id | goal | exit criteria | deps | size | satisfies |
|----|------|---------------|------|------|-----------|
| B2-1 | SBOM per image (syft) in build | SBOM artifact attached per image in CI | — | S | MATURITY Phase 3, security.md |
| B2-2 | Scan every image (Trivy/Grype), **fail build on HIGH/CRITICAL** | CI fails on HIGH/CRITICAL; triage doc for accepted risk | B2-1 | M | ROADMAP Tier B, security.md |
| B2-3 | Sign images (cosign) + attestation | Signatures verifiable in CI; verify step in pipeline | B2-1 | M | security.md |
| B2-4 | Short threat model in `docs/security/` | `docs/security/threat-model.md` reviewed | — | S | security.md |

### Epic B3 — Deploy lifecycle parity (previews, rollback, skew)
| id | goal | exit criteria | deps | size | satisfies |
|----|------|---------------|------|------|-----------|
| B3-1 | Per-PR ephemeral preview envs | Opening a PR deploys an isolated env via CR; torn down on close | A1-3 | L | ROADMAP Tier B |
| B3-2 | Rollback via Knative revision traffic split | CR field shifts traffic to prior revision; e2e demo | A1-2 | M | ROADMAP Tier B |
| B3-3 | Skew protection (BUILD_ID-versioned assets) | Old clients fetch matching-BUILD_ID assets; test across two builds | — | M | ROADMAP Tier B |
| B3-4 | RUM hook (Prometheus/Grafana-aligned, not Web Analytics) | RUM beacon emitted; dashboard panel documented | — | M | ROADMAP Tier B/§8 bucket 3 |

### Epic B4 — Service-to-service authz (foundation for future backends)
| id | goal | exit criteria | deps | size | satisfies |
|----|------|---------------|------|------|-----------|
| B4-1 | Shared signed-token authz on internal calls; backends cluster-local by default | Internal call without token rejected; cluster-local visibility asserted | B1-1 | M | security.md, ADR-0004 |

---

## Tier C — Edge (mostly upstream-gated; track, don't build yet)

### Epic C1 — Buildable edge
| id | goal | exit criteria | deps | size | satisfies |
|----|------|---------------|------|------|-----------|
| C1-1 | CDN-fronting strategy for static/ISR assets | ADR + demo: CDN in front, cache-control correct, no mutation routes cached | A4-2 | M | ROADMAP Tier C, security (SW cache policy) |
| C1-2 | Multi-region deploy guide (active/active or failover) | Documented + one verified multi-region run | A6-2 | L | ROADMAP Tier C, §8 |

### Epic C2 — Upstream-gated (TRACK, DO NOT BUILD)
| id | goal | status | satisfies |
|----|------|--------|-----------|
| C2-1 | Edge Middleware / Proxy | **track only** — not adapter-standardizable upstream yet | ROADMAP Tier C |
| C2-2 | PPR / Cache Components | **track only** — upstream-gated | ROADMAP Tier C |
| C2-3 | WAF | **track only** — revisit after edge story matures | ROADMAP Tier C |

---

## Track P — Promotion (parallel, fame-first; can run alongside A/B)

### Epic P1 — Packaging & release
| id | goal | exit criteria | deps | size | satisfies |
|----|------|---------------|------|------|-----------|
| P1-1 | Resolve npm scope drift (`@kn-next` vs `@knative-next` vs `@knext`) → one scope | Single scope across packages + docs; CI build green | — | M | CLAUDE §9, MATURITY Phase 5 |
| P1-2 | npm publishing + semver + changesets | `npm i @knext/...` works from a tagged release; `npx kn-next` runs for an outside user | P1-1, A3-3 | M | ROADMAP Track P, MATURITY Phase 5 |
| P1-3 | Audit/remove duplicate/dead packages (`packages/cli` Go vs TS, `admin`/`knext` drift) | Dead packages removed or justified; one CLI of record | A1-3 | M | CLAUDE §9, MATURITY blockers |

### Epic P2 — Docs & listing
| id | goal | exit criteria | deps | size | satisfies |
|----|------|---------------|------|------|-----------|
| P2-1 | Docs site, dogfooded on knext | Site deployed via knext itself; serves docs | A1-3 | L | ROADMAP Track P |
| P2-2 | Fix stale docs (`VINEXT_MIGRATION_PLAN.md`, vinext in `ARCHITECTURE.md`; ISR=Redis not GCS; license MIT vs Apache-2.0) | Stale claims corrected/retired; license consistent | — | S | CLAUDE §9, architecture.md |
| P2-3 | Pursue Next.js-docs verified-adapter listing | Submission opened once A3 suite is green | A3-1, A3-2 | M | CLAUDE §2 north-star lever |

---

## Optional module — gRPC business-logic layer (design done; build LAST, post-Tier-A)
Per ADR-0002/0003/0004 + `docs/design/grpc-layer.md`. **Do not start before core maturity.**
Single ticket-of-record: G1 — one proto → Go + TS service + generated gateway glue, deployed as
cluster-local scale-to-zero Knative service behind the gateway. deps: A3-1, B4-1. size: L.

---

## Sequencing

### Critical path
```
A1-1 → A1-2 → A1-3 ──┬─→ A2-2/A2-3 (cold-start + scale-to-zero e2e)
                     ├─→ B3-1 previews, P1-3 dead-pkg removal, P2-1 docs site
A3-1 (compat suite) ─┴─→ A3-2 matrix → P2-3 listing ; A3-3 vinext retire → P1-2 npm
A4-1 → A4-2 (needs A3-1 to verify)
```
- **A1-3 is the keystone**: removing the second cluster writer unblocks honest e2e (A2-2/A2-3),
  previews (B3-1), dead-package cleanup (P1-3), and the dogfooded docs site (P2-1).
- **A3-1 is the credibility keystone**: the compat suite gates every parity claim (A4-2 verified
  here) and is the prerequisite for the Next.js-docs listing (P2-3) — knext's north-star lever.
- **A5 (graceful shutdown), A6-1 (ingress class), A1-5/A1-6/A1-7 (digest/conditions/placeholder)**
  are independent and parallelizable — no deps; good fillers.
- **Tier B** gated on Tier A green; **B2 supply-chain** independent of A1 and can start once images
  build in CI. **Tier C C2-* = track only**; C1-* wait on A4-2/A6-2.
- **Track P** runs in parallel for fame, but P1-2 (npm) waits on A3-3 (vinext gone) and P2-3 waits
  on A3-1/A3-2.

### What unblocks what (summary)
- A1-2 unblocks A1-3, A1-4, B3-2.
- A1-3 unblocks A2-2, A2-3, B3-1, P1-3, P2-1.
- A3-1 unblocks A3-2, A3-3, A4-2 (verification), P2-3.
- A4-1 unblocks A4-2; A6-1 unblocks A6-2 → C1-2.

---

## Recommended first 3 epics to execute

1. **A1 — Control-plane consolidation (ADR-0001).** The #1 maturity gap confirmed live: everything
   was hand-patched on OKE. The operator already does most reconciliation, so the highest-leverage,
   lowest-surprise work is removing `deploy.ts`'s `kubectl apply` (A1-3) and closing digest/condition
   gaps. Keystone that unblocks previews, dead-pkg cleanup, and the docs site.
2. **A2 — Runtime/container regression coverage.** Cheapest way to stop the *exact class* of bug
   that escaped CI+units+2 reviews (`f100deb`). Locks the two non-negotiable invariants
   (bytecode-cache-across-cold-starts, scale-to-zero) behind tests before any refactor churns them.
3. **A3 — Official compatibility suite in CI.** The verified-adapter lever and knext's entire
   fame-phase thesis. Long lead time, so start early in parallel; gates A4 verification and the
   Next.js-docs listing.

> A6-1 (ingress class) and A1-5/A1-7 (digest pinning + placeholder images) are recommended as
> parallel small wins alongside the above — low risk, directly close live-OKE pain and §7 security.

---

## Proposed GitHub issues (titles + tier label + 1-line body) — DO NOT CREATE YET

- **[tier-A] Operator: make CLI emit `NextApp` CR only; remove `deploy.ts` kubectl apply** — Eliminate the second cluster writer to satisfy ADR-0001 (A1-3).
- **[tier-A] Operator: enforce digest pinning (reject `:latest`, not just warn)** — Close the mutable-tag footgun in the reconciler admission path (A1-5).
- **[tier-A] Operator: populate Status.Conditions in reconciler** — Ready/Reconciling/Degraded conditions for observability (A1-6).
- **[tier-A] Fix `controller:latest` placeholders in operator manager.yaml + Makefile** — Digest-pin operator images; add CI grep-guard (A1-7).
- **[tier-A] Container test: assert NODE_COMPILE_CACHE exported + cache fills (regression for f100deb)** — Cover the untested `CMD` runtime path (A2-1).
- **[tier-A] e2e: bytecode cache reused across scale-to-zero cold starts** — Lock the core invariant on the PVC (A2-2).
- **[tier-A] CI: run official Next.js adapter compatibility suite on every PR** — The verified-adapter gate (A3-1).
- **[tier-A] Retire Vinext/Nitro runtime (node-server.ts)** — Finish Phase 0; adapter is sole runtime (A3-3).
- **[tier-A] ADR + impl: image optimization for next/image** — Close the biggest functional parity gap (A4-1/A4-2).
- **[tier-A] Graceful shutdown: drain + run after() on SIGTERM** — No dropped requests on scale-down (A5-1).
- **[tier-A] Ingress: operator-managed KnativeServing sets kourier ingress-class declaratively** — Prevent the OKE 404 drift recurring (A6-1).
- **[tier-B] Authenticate POST /api/cache/invalidate (signed token + NetworkPolicy)** — Remove the known unauthenticated mutating endpoint (B1-1).
- **[tier-B] Supply chain: SBOM + Trivy/Grype (fail on HIGH) + cosign signing** — The open security milestone (B2-1/2/3).
- **[tier-B] Previews, rollback, skew protection** — Vercel parity bucket-2 wins (B3-*).
- **[tier-C] TRACK ONLY: edge middleware / PPR / WAF** — Upstream-gated; do not build (C2-*).
- **[track-P] Resolve npm scope drift + publish @knext/* with semver** — Unblocks `npx kn-next` for outside users (P1-1/P1-2).
- **[track-P] Fix stale docs + license inconsistency** — ISR=Redis not GCS; MIT vs Apache-2.0 (P2-2).
- **[track-P] Documentation site in a NEW repo, Claude-designed (P2-4)** *(added 2026-06-19)* — a
  standalone, distinctive docs site (NOT inside the knext monorepo), designed with the
  `frontend-design` skill. Scope: landing/hero + docs (getting-started, adapter, operator/CRD,
  scale-to-zero, bytecode caching, multi-cloud), versioned. Eventually **dogfooded on knext** (deploy
  the docs site via knext itself) — but the site/repo is built first. Distinct from P2-1.
