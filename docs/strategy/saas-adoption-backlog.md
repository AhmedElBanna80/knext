# knext -> SaaS-adoptable: dependency-ordered ticket backlog

> Derived from `docs/strategy/saas-adoption-plan.md` (master plan -- not re-derived here) and
> `docs/strategy/saas-viability.md`. Two tracks: **T0** (DevOps multi-repo org split) and reliability
> epics **E1-E6**. Sizes: S < 1d, M 1-3d, L > 3d. `repo` in core=`knext`, `knext-docs`,
> `knext-examples`, `org`. **blocked-on**: "--" = none; otherwise the human action gating it.
>
> Locked decisions: new GitHub org, **3 repos** -- `knext` (TS CLI/adapter + Go operator + lib/ui,
> operator lives IN core), `knext-docs`, `knext-examples` (consume published `@knext/*`).
>
> **NOW = executable today in the current monorepo before the org exists.**
> **USER = blocked on a human action (org creation / npm auth / repo push).**

## Status legend
| tag | meaning |
|-----|---------|
| NOW | start immediately in current `knext` repo |
| NOW-prep | scaffold now in current repo; activates after split/auth |
| USER | blocked on org creation, npm publish auth, or repo push |

---

## T0 -- DevOps: multi-repo org split (foundational)

| id | goal | exit criteria | deps | size | blocked-on | repo | tag |
|----|------|---------------|------|------|------------|------|-----|
| T0-1 | Create org + 3 empty repos; branch protection, CODEOWNERS, conventional-commit + PR/issue templates | repos exist; `main` protected; required checks named | -- | S | user: create org | org | USER |
| T0-2a | **Dry-run** the history-preserving carve plan: enumerate subtrees -> target repos (git filter-repo path specs for core / `pocs/knext-docs`->docs / `apps/*`->examples) | `docs/strategy/split-map.md` lists every path -> repo; command set reviewed; no pushes | -- | M | -- | core | NOW |
| T0-2b | Execute the history-preserving carve into the 3 repos; push initial history | each repo builds from a clean clone; subtree history retained | T0-1, T0-2a | L | user: repo push | org | USER |
| T0-3a | Author per-repo CI workflows staged in current repo (core=lint+test+compat-smoke+operator-codegen+SBOM/Trivy/cosign; docs=build+link-check+deploy; examples=build each app vs published `@knext/*`) | workflow YAML committed + actionlint-clean; green vs current tree | -- | M | -- | core | NOW |
| T0-3b | Land CI in each split repo; first green run on clean checkout | green CI on clean checkout of all 3 repos | T0-2b, T0-3a | M | user: repo push | org | USER |
| T0-4a | Release automation scaffold: **changesets** (`@knext/*`) + **GoReleaser/ko** operator image (digest-pinned, cosign) + **Helm chart** skeleton; tag-driven, dry-run only | `changeset version` dry-runs; `goreleaser --snapshot` builds; `helm lint` passes; nothing published | -- | M | -- | core | NOW-prep |
| T0-4b | Activate publishing: `npm publish --provenance`, push operator image by digest, publish Helm chart on tag | `npm i @knext/core` works from a tag; operator image pullable by digest; `helm repo add` works | T0-4a, E1-1 | M | user: npm auth + repo push | org | USER |
| T0-5 | Cross-repo wiring: examples pin published core; docs reference versioned APIs; renovate/dependabot bumps via PR | a core release opens bump PRs in examples + docs | T0-2b, T0-4b | M | user: repo push | org | USER |

## E1 -- Release & distribution (#1 adoption blocker)

| id | goal | exit criteria | deps | size | blocked-on | repo | tag |
|----|------|---------------|------|------|------------|------|-----|
| E1-1 | **Changesets + publish workflow scaffold** in current monorepo (`.changeset/`, version/release scripts, npm provenance, `npx kn-next` smoke against a packed tarball) | `pnpm changeset` + `changeset version` work; `npm pack` tarball installs + `npx kn-next --help` runs; publish job present but gated | -- | M | -- | core | NOW |
| E1-2 | Audit/remove duplicate/dead packages (`packages/cli` Go vs TS CLI; `admin`/`knext` drift) -- one CLI of record | dead packages removed or justified; single CLI of record; build green | E1-1 | M | -- | core | NOW |
| E1-3 | Operator distribution: Helm chart (values: image digest, scale, ingress) + install docs | `helm install` stands up operator in kind; CRDs applied | T0-4a | M | -- | core | NOW-prep |
| E1-4 | First real publish: `@knext/core|lib|ui` to npm; `npx kn-next` for outside user; operator image + chart pullable | stranger installs + deploys a Next.js app from published artifacts in <30 min | E1-1, E1-3, T0-4b | L | user: npm auth | org | USER |

## E2 -- Verified-adapter status (credibility)

| id | goal | exit criteria | deps | size | blocked-on | repo | tag |
|----|------|---------------|------|------|------------|------|-----|
| E2-1 | **A3-2 compat harness**: full official Next.js deploy-test harness (`vercel/next.js` `NEXT_TEST_MODE=deploy`) nightly + dispatch, per ADR-0007 | `compat-suite-full` scheduled job green on a pinned Next version | -- | M | -- | core | NOW |
| E2-2 | Publish compat matrix; link in README | `docs/compat-matrix.md` generated from the run + linked in README | E2-1 | S | -- | core | NOW |
| E2-3 | Pursue Next.js-docs verified-adapter listing | submission opened once suite is green | E2-1, E2-2 | M | user: submit listing | core | USER |

## E3 -- Operator GA hardening (reliability core)

| id | goal | exit criteria | deps | size | blocked-on | repo | tag |
|----|------|---------------|------|------|------------|------|-----|
| E3-1 | **Arch-review #1: collapse the dual CR->ksvc translation.** Operator owns the single mapping; CLI emits the `NextApp` CR only -- retire the ksvc shaping in `packages/kn-next/src/generators/knative-manifest.ts` so the reconciler is sole source of truth | one mapping of record; CLI produces no ksvc manifest; table test asserts operator ksvc shape from a CR; existing tests green | -- | M | -- | core | NOW |
| E3-2 | Finalizers + cascade cleanup (delete NextApp -> ksvc/PVC/SA removed) | envtest: deleting CR removes owned resources; finalizer guards | E3-1 | M | -- | core | NOW |
| E3-3 | Populate full `status.Conditions` (Reconciling/Ready/Degraded with reasons) | `kubectl get nextapp -o yaml` shows transitioning + terminal conditions; envtest asserts set | -- | M | -- | core | NOW |
| E3-4 | Validating + defaulting webhooks (reject `:latest`/bad refs, scale invariants at admission) | admission rejects invalid CRs; unit + envtest coverage | E3-1 | M | -- | core | NOW |
| E3-5 | API `v1alpha1` -> `v1beta1` + conversion webhook | both versions served; round-trip conversion test green | E3-3, E3-4 | L | -- | core | NOW |

## E4 -- Security & isolation (table stakes)

| id | goal | exit criteria | deps | size | blocked-on | repo | tag |
|----|------|---------------|------|------|------------|------|-----|
| E4-1 | **Fix open `POST /api/cache/invalidate`** (signed token + internal-only NetworkPolicy) | unauth request -> 401/403 (test); authed -> 200; NetworkPolicy restricts source | -- | M | -- | core | NOW |
| E4-2 | Repo-wide audit: no unauthenticated mutating route/handler/webhook | audit doc + CI check listing mutating endpoints and their auth | E4-1 | M | -- | core | NOW |
| E4-3 | Finish supply chain: SBOM (syft) + Trivy (fail HIGH/CRITICAL) + cosign + provenance, enforced on build | CI fails on HIGH/CRITICAL; signatures verifiable; SBOM per image | -- | M | -- | core | NOW |
| E4-4 | Multi-tenant primitives: per-app namespace, NetworkPolicy, ResourceQuota, non-root/distroless verified | isolation manifests applied by operator; tenant-boundary test | E3-2 | L | -- | core | NOW |
| E4-5 | Short threat model in `docs/security/` | `docs/security/threat-model.md` reviewed | -- | S | -- | core | NOW |

## E5 -- Operability (day-2)

| id | goal | exit criteria | deps | size | blocked-on | repo | tag |
|----|------|---------------|------|------|------------|------|-----|
| E5-1 | Instant rollback via Knative revision traffic split (CR field) | CR shifts traffic to prior revision; e2e demo | E3-1 | M | -- | core | NOW |
| E5-2 | Per-PR ephemeral preview envs | opening a PR deploys isolated env via CR; torn down on close | E3-1 | L | -- | core | NOW |
| E5-3 | Skew protection (BUILD_ID-versioned assets) | old clients fetch matching-BUILD_ID assets; cross-build test | -- | M | -- | core | NOW |
| E5-4 | Observability: Grafana dashboards over existing :9091 metrics + RUM hooks; SLOs + runbooks | dashboards ship; SLO doc + runbook published | -- | M | -- | core | NOW |
| E5-5 | Graceful shutdown (A5, done) verified under load; connection draining | load test shows zero dropped requests on scale-down | -- | M | -- | core | NOW |

## E6 -- Adoption surface (lower the bar to "yes")

| id | goal | exit criteria | deps | size | blocked-on | repo | tag |
|----|------|---------------|------|------|------------|------|-----|
| E6-1 | `ADOPTION.md` decision matrix (who should/shouldn't adopt) | matrix published; linked from README | -- | S | -- | core | NOW |
| E6-2 | Getting-started + "migrate from Vercel" guide; support policy | guides published; runnable end-to-end | E1-1 | M | -- | knext-docs | NOW |
| E6-3 | Docs site content, dogfooded on knext (deploy docs via knext itself) | site builds + deploys via knext; versioned | E1-4 | L | user: repo push | knext-docs | USER |
| E6-4 | Second real reference app beyond file-manager, consuming published `@knext/*` | app builds against published core in CI | E1-4 | M | user: npm auth | knext-examples | USER |
| E6-5 | Community surface: Discussions/Discord, issue/PR templates | templates live; channel linked | T0-1 | S | user: create org | org | USER |

---

## Sequencing / critical path

```
T0 (split + release automation: T0-2a, T0-3a, T0-4a NOW; -2b/-3b/-4b USER)
        |
        +--> E1 (release/dist)  E1-1 NOW - E1-2 NOW - E1-3 --> E1-4 (USER: npm)
        +--> E2 (verified)      E2-1 NOW - E2-2 NOW --> E2-3 (USER: listing)
        +--> E3 (operator GA)   E3-1 NOW(keystone) - E3-2/3/4 --> E3-5
        +--> E4 (security)      E4-1 NOW - E4-2 ; E4-3 NOW ; E4-4(needs E3-2)
        +--> E5 (day-2: needs E3-1)  ||  E6 (E6-1/2 NOW; -3/-4/-5 USER)
```

**Critical path to "an outside company can adopt this":**
`E3-1 (CR->ksvc dedup, single source of truth)` -> `E3-2/-3/-4 (finalizers, conditions, webhooks = GA operator)` ->
`E1-1 (changesets/publish scaffold)` -> `T0-2b + T0-4b (repo split + first npm/image/Helm publish)` -> `E1-4 (stranger deploys from published artifacts)`.
Security gate `E4-1 (open endpoint)` + `E4-3 (supply chain)` must be green before any public release; `E2-1` runs in parallel as the credibility lever. The two USER blockers (org creation, npm auth) are the only things stopping NOW-work from reaching a published, adoptable artifact.

## NOW vs USER summary
- **NOW-executable (current monorepo):** T0-2a, T0-3a, T0-4a(prep), E1-1, E1-2, E1-3(prep), E2-1, E2-2, E3-1..E3-5, E4-1..E4-5, E5-1..E5-5, E6-1, E6-2.
- **USER-blocked:** T0-1, T0-2b, T0-3b, T0-4b, T0-5, E1-4, E2-3, E6-3, E6-4, E6-5 -- gated on **(1) create GitHub org + repos**, **(2) npm publish auth**, **(3) push split repos**.
