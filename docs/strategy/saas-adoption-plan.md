# knext → SaaS-adoptable: org split + reliability plan

> Goal: make knext reliable enough that a SaaS company would adopt it into its stack. Two tracks:
> **(T0) DevOps — multi-repo org split** (the user is creating the org), and **(E1–E6) reliability
> epics** that close the adoption blockers identified in `adoption.md` / `saas-viability.md`.
> Reconciles with CLAUDE.md §2 (fame-first; verified-adapter is the north star).

## Assumptions (correct me)
- GitHub org: **`getknext-dev`** — repo MOVED to `github.com/getknext-dev/knext` (2026-06-21).
- **3 repos:**
  - **`knext`** — the framework (core). TS + Go monorepo: `packages/kn-next` (CLI/adapter),
    `packages/kn-next-operator` (Go operator), `packages/lib`, `packages/ui`. Publishes `@knext/*`
    to npm + the operator image + a Helm chart. **This is the product.**
  - **`knext-docs`** — the docs site (already drafted in `pocs/knext-docs`). Dogfooded on knext.
  - **`knext-examples`** — demo apps (`file-manager` + future). Consumes the **published** `@knext/*`,
    never workspace-links into core. Proves the published artifacts actually work end-to-end.
- Operator stays in the `knext` core monorepo (CLI + operator version and ship together).

---

## T0 — DevOps: the multi-repo org split (do FIRST; foundational)

| id | task | exit criteria |
|----|------|---------------|
| T0-1 | Create org + 3 empty repos with branch protection, CODEOWNERS, conventional-commit + PR templates, issue templates | repos exist; main protected; required checks defined |
| T0-2 | **History-preserving split** of the current monorepo: `git filter-repo` to carve `knext` (core), extract `pocs/knext-docs` → `knext-docs`, extract `apps/*` → `knext-examples` | each repo builds from a clean clone; history retained for its subtree |
| T0-3 | Per-repo CI: `knext` (lint+test+compat-smoke+operator codegen+SBOM/Trivy/cosign), `knext-docs` (build+link-check+deploy), `knext-examples` (build each app against the **published** `@knext/*`) | green CI on a clean checkout of each repo |
| T0-4 | Release automation: **changesets** (npm `@knext/*`) + **GoReleaser/ko** (operator image, digest-pinned, cosign-signed) + **Helm chart** publish; tag-driven | `npm i @knext/core` works from a tagged release; operator image pullable by digest |
| T0-5 | Cross-repo wiring: examples pin a published core version; docs reference versioned APIs; a `renovate`/dependabot bot bumps them | version bump flows core → examples/docs via PR |

**Why repos this way:** core is the unit of release + the thing adopters depend on; examples must consume
the *published* artifact (catches packaging bugs the monorepo hides — we already hit `@knext/lib` ships-only-dist);
docs version independently and dogfood the deploy path.

---

## E1 — Release & distribution (the #1 adoption blocker)
- Publish `@knext/core`, `@knext/lib`, `@knext/ui` to npm (semver, changelog, provenance).
- `npx kn-next` works for an outside user.
- Operator: published image + **Helm chart** (and/or OLM bundle) so adopters `helm install`.
- **Exit:** a stranger installs + deploys a Next.js app from published artifacts in < 30 min.

## E2 — Verified-adapter status (credibility)
- A3-2: full official Next.js deploy-test harness (nightly + dispatch), per ADR-0007.
- Publish the compat matrix; pursue the Next.js-docs adapter listing.
- **Exit:** compat suite green on a pinned Next version; matrix linked in README.

## E3 — Operator GA hardening (the reliability core)
- Finalizers + cascade cleanup (delete NextApp → ksvc/PVC/SA removed).
- Populate full `status.Conditions` (Reconciling/Ready/Degraded with reasons), not just `status.url`.
- Validating + defaulting webhooks (reject `:latest`, bad image refs, scale invariants at admission).
- Failure-mode reconcile + table-driven controller tests asserting the ksvc shape from a CR.
- **Collapse the dual CR→ksvc translation** (arch review #1) — operator owns the one mapping; CLI emits CR only.
- API `v1alpha1` → `v1beta1` + conversion webhook.
- **Exit:** chaos/failure tests pass; one source of truth for ksvc shape; GA API.

## E4 — Security & isolation (table stakes for a SaaS adopter)
- Fix the open `POST /api/cache/invalidate` (signed token / internal-only NetworkPolicy).
- Service-to-service authz; secrets only in K8s Secrets.
- Multi-tenant primitives: per-app namespace, NetworkPolicy, ResourceQuota, non-root/distroless (mostly done).
- Finish supply chain: SBOM + Trivy (fail on HIGH) + cosign + provenance (B2 started) → enforced on release.
- Short threat model in `docs/security/`.
- **Exit:** no unauthenticated mutating endpoints; signed images; threat model published.

## E5 — Operability (day-2)
- Previews, instant rollback, skew protection (Tier B).
- Observability: Prometheus metrics (have :9091) + Grafana dashboards + RUM hooks; SLOs + runbooks.
- Graceful shutdown (done, A5) verified under load; connection draining.
- **Exit:** rollback in one command; dashboards ship; documented SLOs.

## E6 — Adoption surface (lower the bar to "yes")
- `ADOPTION.md` decision matrix (who should/shouldn't adopt — already drafted).
- Getting-started + "migrate from Vercel" guide; support policy; Discord/Discussions; issue/PR templates.
- A second real reference app in `knext-examples` beyond file-manager.
- **Exit:** a platform team can self-serve from zero to deployed without talking to a maintainer.

---

## Sequencing
1. **T0 (split + release automation)** — unblocks everything; do first.
2. **E1 + E2** in parallel — release + verified-adapter = the credibility funnel.
3. **E3 + E4** — operator GA + security = the actual "reliable enough to adopt" bar.
4. **E5 + E6** — day-2 ops + adoption surface.

**What's executable NOW (in the current monorepo, before the org exists):** E2 (A3-2 harness), E3 (operator
hardening + arch #1 dedup), E4 (security fixes + finish supply chain), E1 prep (changesets config + publish
workflow), E6 docs. **Blocked on the user:** creating the org, `npm publish` auth, the actual repo push.

## Decisions
- ✅ **Org handle = `getknext-dev`** (`github.com/getknext-dev/knext`, moved). npm scope stays **`@knext/*`** (verified free),
  CLI stays `kn-next`. Suggested domain: **getknext.dev**. (GitHub `knext` was taken; npm `@knext` is not.)
- ✅ **Operator lives in the `knext` core monorepo** (CLI + operator version/ship together).
- Repo names: `knext` (core), `knext-docs`, `knext-examples`.

## Open decisions for the user
1. Split mechanic: history-preserving `git filter-repo` (recommended) vs fresh repos.
2. Helm chart vs OLM bundle (or both) for operator distribution.
