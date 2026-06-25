# knext — Phase plan: package deployment · Postgres-per-SCS isolation · cross-zone table-copy fabric

> **Scope of this run.** Three asks: (1) **package deployment** so an outside client can actually
> install and run knext; (2) **Postgres per SCS isolation + foreign-table copies via RisingWave**
> (a spike); (3) **Postgres scaling**. Everything below is grounded in the real repo + the live
> board, and reconciled against the north star (`CLAUDE.md`, `ROADMAP.md`, `docs/adr/`,
> `.claude/rules/`). Where an ask brushes the "narrow Next.js+Knative adapter, **not** a PaaS"
> positioning (`CLAUDE.md` §1/§8) or the "**zones stay app-level until after Tier-A correctness**"
> sequencing (`.claude/rules/scs-zones.md`), this flags it rather than absorbing scope.

---

## The two themes have very different roadmap fit — read this first

| Theme | Roadmap fit | Verdict |
|-------|-------------|---------|
| **A. Package deployment** (publish `@knext/*`, installable operator bundle, `npx kn-next` for outsiders) | **Track P — promotion.** Fully sanctioned; it *is* the named next phase (`ROADMAP.md` Track P, `docs/maturity/BACKLOG.md` P1-x). Infra is already built. | **Do now.** Lead the priority list here — it is the lowest-risk, highest-adoption work and contradicts nothing. |
| **B. Postgres-per-SCS + the cross-zone table-copy fabric (RisingWave) + Postgres scaling** | **Data-plane / SCS.** The rules sequence zones-into-core **after Tier-A**, and ADR-0001's action items put stateful infra (Postgres) **out of the `NextApp` CR** ("operator-external… a future `InfrastructureSpec` CRD or side-car"). Adding a replication fabric is **PaaS-adjacent**. | **Design now, build after Tier-A, as an opt-in module.** The founder has **decided** to build the table-copy fabric (see below); it is designed end-to-end in the draft ADR, amends the sovereignty rule on a narrow published-tables-only path, and ships opt-in (like the gRPC module) — **not** in the core path. Postgres scaling stays a CNPG **recipe**. |

The honest framing: **Theme A is the next phase. Theme B is design-now / build-after-Tier-A.** Its
most ambitious piece — the cross-zone table-copy fabric — is now a **decided design** (the
data-sovereignty rule is amended on a narrow path, not violated), captured as an opt-in module.

---

## Theme A — Package deployment: maturity read

Good news up front: **most of the machinery already exists and the Bun blocker is gone.** What
remains is correctness polish, an end-to-end proof, and the operational first-publish.

### What's already done (do NOT re-propose)
- **CLI runs on plain Node.** Issue **#68** *closed*, PR **#71** *merged*: the CLI entrypoint is now
  `#!/usr/bin/env node` with **zero** `bun`/`Bun.*` imports (verified by grep). `npx kn-next` will
  work for outsiders once published. *(Older docs/notes describing the CLI as "Bun-only" are stale.)*
- **Release machinery exists.** `.changeset/config.json` (`access: public`, ignores `@knext/ui` +
  example apps) and `.github/workflows/release.yml` (changesets → Version PR → `changeset publish`,
  **gated on `NPM_TOKEN`**) are in place (PR **#65**).
- **Build for publish exists.** `@knext/core` bundles via `tsup` (esm, `platform: node`,
  `target: node20`, externals declared); `@knext/lib` compiles via `tsc` to `dist/*.js` + `.d.ts`.
- **Operator supply chain exists.** `.github/workflows/operator-supply-chain.yml` builds + SBOMs
  (syft) + scans (Trivy, fail on HIGH/CRITICAL) + cosign-signs the operator image and regenerates
  `dist/install.yaml` with the real digest on push to main. Issue **#76** *closed*, PR **#88**
  *merged*.

### What still blocks a client install (the real gaps)
1. **The application runtime import surface ships as raw TypeScript and is undeclared.** A
   knext-deployed app does not only *run* the CLI — it **imports knext at runtime**. The example app
   imports `getDbPool`/`getMinioClient` (`@knext/lib/clients`), `checkDeepHealth`
   (`@knext/lib/health`), `resolveOtelOptions` (`@knext/core/adapters/otel-config`), the adapter
   (`@knext/core/adapter`), and the `KnativeNextConfig` type (`@knext/core`). But **every
   `@knext/core` `exports` subpath points at `./src/*.ts`** (not just `main`/`types`), and `tsup`
   builds only the *CLI* entries — so on plain Node, post-publish, those app imports resolve to `.ts`
   files Node can't load. `@knext/lib` is the healthy half (exports → `dist/`). Two issues: the
   surface must be **built** (**PK1**, broader than first scoped) and **proven by an app-import smoke
   test** (**PK2**). Separately, knext has **never declared which subpaths are the supported
   application API vs internal**, nor a semver policy — so every refactor is a silent breaking change
   for clients (**PK5**, new).
2. **No proof the published artifact works for an outside user.** There is no CI step that packs the
   tarball (`npm pack`), installs it into a clean directory on plain Node (no workspace, no
   `bun`), and runs `npx kn-next`. Publishing without this is publishing blind — **PK2**.
3. **The operator bundle has never been bootstrapped.** `packages/kn-next-operator/dist/install.yaml`
   and `config/manager/kustomization.yaml` still carry an **all-zeros placeholder digest**
   (`…@sha256:0000…0000`); the operator image at `ghcr.io/getknext-dev/kn-next-operator` is **not
   published yet** (the supply-chain job replaces the digest only on a real main run). No one has
   verified `kubectl apply -f dist/install.yaml` pulls a real, signed, digest-pinned image on a
   clean cluster — **PK3**.
4. **No outside-user quickstart.** There is no single "install knext and deploy your first app" page
   that an external engineer can follow end-to-end (`npm i` → config → `kn-next deploy` → operator
   reconciles). Adoption needs it — **PK4**.
5. **npm scope drift is open and blocks publish.** Issue **#53** *open* (P1-1/P1-2): code uses
   `@knext/*` but docs/examples still reference `@kn-next/*` and `@knative-next/*`. Publishing before
   reconciling names ships users a contradiction. **#53 already owns scope-resolution + the publish
   itself** — this run does **not** re-propose it; PK1/PK2/PK3/PK4 are the not-yet-filed companions
   that make #53's publish actually usable.
6. **`NPM_TOKEN` is unset** → `release.yml` only opens Version PRs, never publishes. This is an
   operational unlock (a founder action), folded into #53's exit, not a code issue.

### Maturity verdict (Theme A)
**Infrastructure: mature. Last-mile: incomplete.** The components score well on tests/CI, but the
chain has never been exercised end-to-end *as an outside consumer*. The work is small, concrete, and
fully on the Track-P path.

---

## Theme B — Postgres per SCS isolation, scaling, and the RisingWave spike

### Where the data plane stands today (grounded)
- **knext does not provision databases — by design.** Grep for `postgres` in the operator returns
  nothing; ADR-0001 action items explicitly mark `postgres.yaml`/`redis.yaml`/`minio.yaml` as
  *operator-external*. A zone reaches **its own** Postgres via `DATABASE_URL` from a K8s Secret,
  injected through the real CR fields `spec.secrets.envFrom` / `spec.secrets.envMap`
  (`api/v1alpha1/nextapp_types.go`). **Per-SCS isolation is a binding rule, enforced** by the hook
  `hooks/protect-zone-data-sovereignty.sh` and stated in `.claude/rules/scs-zones.md`: *a zone owns
  its store, never reads another zone's DB, and cross-zone data flows **only** via async Kafka
  domain events + the browser.*
- **Connection handling is unfit for scale-to-zero, today.** `packages/lib/src/clients.ts`
  `getDbPool()` is a bare `pg.Pool` from `DATABASE_URL` with **no `max`, no idle reaping, no
  `pool.end()` on shutdown**; `adapters/shutdown.ts` drains HTTP + `after()` but never the DB pool.
  With defaults `containerConcurrency: 100`, `maxScale: 10`, one zone can storm a Postgres with
  `maxScale × pool_max` connections. **This is already captured** in the prior erpnext-ts draft
  **E1** (`knext-plan-out/erpnext-ts/issues.md`) — *this run builds on it, does not duplicate it.*

### "Postgres per SCS isolation" + "Postgres scaling" — what this run adds
These are **mostly documentation + cluster-infra recipes**, because knext deliberately does not run
your database:
- **Per-zone provisioning pattern** with **CloudNativePG** (one `Cluster` per zone, its generated
  Secret bound into the zone's `DATABASE_URL`), the **isolation guarantee** (the
  `protect-zone-data-sovereignty.sh` hook + no shared DB), and **scaling** (a transaction-mode
  pooler — PgBouncer / the CNPG pooler — small per-instance pools, read replicas for read-heavy
  zones, and the bounding rule `peak_clients ≈ maxScale × pool_max ≤ pooler_limit` tuned via the
  existing `spec.scaling.*` knobs). Captured as **PG2**. It **reuses and cross-links** erpnext-ts
  E1 (drain + sizing) and E2 (the CNPG→`envMap` binding) rather than restating them.
- **Conflict to flag:** none — this stays inside the rules (cluster owns infra; knext binds the
  Secret). The only caveat is **scope honesty**: PG2 is a *recipe/doc*, and we must never present
  knext as *provisioning* Postgres.

### The cross-zone table-copy fabric — the decided design

**The ask.** Use **RisingWave** (a Postgres-wire-compatible streaming database that ingests CDC and
Kafka, maintains *incremental* materialized views, and sinks back to Postgres — verified from
RisingWave's docs) to maintain **foreign-table copies**: read-only replicated copies of one zone's
**published** data inside another zone, so a consuming zone queries a **local copy** instead of
calling the producer.

**Two ways to wire it sit on opposite sides of the data-sovereignty rule *as written* — the founder
chose CDC and we resolve the tension by amending the rule on a narrow, published-tables-only path:**

| Path | How it works | Rule fit (as written) → resolution |
|------|--------------|----------|
| **CDC-fed (chosen)** | RisingWave's `postgres-cdc` source reads the producer's Postgres replication slot for **explicitly-published tables only**, via a **dedicated least-privilege credential**, and sinks read-only copies into the consumer's own DB. | **Conflicts with the rule as written** (a *zone* may not connect to another zone's DB) → **resolved by ADR amendment (PG1a):** only the **platform fabric** connects, only to **published** tables; encapsulation is preserved by the producer publishing a *view*, not raw schema. |
| **Kafka-fed (not chosen)** | RisingWave ingests zones' Kafka domain events, materializes, sinks copies. | Compliant without amendment, but pushes per-field event-contract work onto every producer and is not the "infra maintains table copies" model the founder asked for. |

**DECISION (founder, this run).** Cross-zone copying **is** an SCS-blessed pattern, and knext will
provide the infrastructure for it: a **platform-managed table-copy fabric**. The chosen shape —
**B1-as-sanctioned**, not rejected:
- **Producer-published tables.** A producer zone explicitly **publishes** a table (a *view* = stable
  contract); only published tables are copyable, so internal schema stays private (encapsulation).
- **CDC-fed by the platform fabric.** RisingWave's `postgres-cdc` reads **only published tables** via
  a **dedicated least-privilege replication credential** (never the app credential) and **sinks
  read-only copies into the consuming zone's own Postgres**, where the app does normal local joins.
- **This amends `scs-zones.md`.** The hard rule "a zone never connects to another zone's DB" **still
  holds** — only the *platform fabric* (a distinct actor, not a zone) connects, and only to published
  tables; a zone reads **only its own local copy**. Full design + the SCS reconciliation table +
  failure modes + security in `adr-draft-cross-zone-table-copies.md`.

Two honesty flags that shape the sequencing (not blockers — the founder has chosen to build this):
- **Scope expansion.** knext gains a data-replication capability — PaaS-adjacent. Ship it as an
  **opt-in module** (like the gRPC/`BackendService` module, ADR-0002/0004), **after Tier-A**, never in
  the core deploy path.
- **RisingWave is always-on, heavy, stateful cluster infra** — it does **not** scale to zero (a real
  tension with knext's north star) and the CDC slots risk producer **WAL bloat**. These are designed
  for in the ADR (PG1a) and hardened in PG1c, but they are the cost of the capability.

Captured as **PG1a** (ADR + contract + rule amendment), **PG1b** (the fabric controller: `TableCopy`
CRD → RisingWave), **PG1c** (credentials, NetworkPolicy exception, slot/lag monitoring).

### Maturity verdict (Theme B)
**Isolation: enforced and healthy. Scaling: a known, documented gap (E1) plus recipes (PG2).
Cross-zone copies: now a *decided design* — the table-copy fabric is sanctioned (amends the
sovereignty rule on the narrow, published-tables-only path), designed end-to-end in the draft ADR, and
sequenced as an opt-in, post-Tier-A module. Build work is PG1a→PG1b→PG1c.**

---

## Prioritization & sequencing (leads with the project's own named gaps)

1. **PK1** — build the full `@knext/core` library surface to `dist` (every `exports` subpath is raw `.ts` today, not just `main`/`types`). *Correctness; unblocks a usable publish + app imports.*
2. **PK2** — CI clean-machine smoke test of **both** the CLI **and** an app import (`@knext/core/adapter`, `@knext/lib/clients`, …). *Proves client-installability; gates publish.*
3. **PK5** — declare the **public application API surface** (which subpaths a client may import) + a semver/stability policy. *Turns an accidental surface into a supported contract; land with PK1.*
4. **PK3** — bootstrap + verify the operator install bundle end-to-end (real signed digest; clean-cluster `kubectl apply`). *The other half of "a client can use it."*
5. **PK4** — outside-user "install & first deploy" quickstart. *Adoption.*
   *(npm scope + the publish itself = existing issue **#53**; `NPM_TOKEN` = founder action.)*
5. **PG2** — per-SCS Postgres provisioning + scaling **recipe** (CNPG + pooler + read replicas), building on erpnext-ts **E1/E2**. *Doc/recipe; flag: knext does not provision Postgres.*
6. **PG1a** — ADR + the published-tables / `TableCopy` contract + the `scs-zones.md` amendment. *Design; gates PG1b/c.*
7. **PG1b** — build the fabric controller (`TableCopy` CRD → RisingWave source/MV/sink). *Opt-in module; post-Tier-A.*
8. **PG1c** — fabric security/operability (least-privilege replication creds, NetworkPolicy exception, slot/lag monitoring). *Hardens PG1b.*

### Conflicts surfaced for the maintainer (decided, not silently absorbed)
- **Sovereignty rule amendment:** the fabric requires amending `scs-zones.md` (cross-zone copies via a platform fabric, published-tables-only). This is an **explicit ADR-gated rule change** (PG1a), not a silent edit; the hard rule "a zone never connects to another zone's DB" is preserved.
- **RisingWave as infra vs "not a PaaS":** the fabric is a real scope expansion. Mitigation: ship it **opt-in, post-Tier-A**, like the gRPC/`BackendService` module — never in the core adapter path. RisingWave is **always-on** cluster infra (does not scale to zero) — a flagged cost.
- **Theme B vs "zones-after-Tier-A":** design now (PG1a + recipes), **build after Tier-A** (PG1b/c). Theme A (packaging) carries no such conflict and should lead.

### Reconciliation with prior drafts
The erpnext-ts run already drafted **E1** (DB-drain + sizing under scale-to-zero) and **E2** (the
CNPG→`secrets.envMap` reference CR). PG2 **extends** them (provisioning pattern, read replicas,
isolation-hook framing) and PG1 **depends on** the same data-sovereignty rule — neither restates E1/E2.

---

## Bottom line
**Package deployment is the right next phase and it is nearly there** — five small, concrete issues
(PK1–PK5) plus finishing the open scope/publish issue **#53** make knext genuinely installable *and
importable* by a client (the CLI **and** the runtime/adapter surface an app depends on). **The cross-zone table-copy fabric is now a decided design**, not a question: producers
**publish** tables (a view contract), the platform **CDC-replicates** them into **read-only copies in
each consumer's own Postgres**, and `scs-zones.md` is **amended** on that narrow path (a zone still
never connects to another zone's DB — only the fabric does, only to published tables). It is designed
end-to-end in the draft ADR and ships as an **opt-in module, after Tier-A** (PG1a→PG1b→PG1c), with
Postgres scaling handled as a CNPG **recipe** (PG2). That gives erpnext-ts a real cross-zone data
story while keeping the *core* knext a narrow, honest adapter and the rule change explicit.
