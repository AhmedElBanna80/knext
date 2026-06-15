---
name: scs-zones
description: Self-Contained Systems (SCS) + Next.js Multi-Zones architecture on knext — autonomous vertical slices that own UI+logic+data, deployed as independent Knative zones with their own PostgreSQL (CloudNativePG), integrating ONLY via async Kafka events + browser/UI composition. Use this skill whenever the user mentions zones, multi-zone, self-contained systems, SCS, domain boundaries, micro-frontends, splitting an app into independent deployables, per-zone databases, data sovereignty, or "how do zones talk to each other" — even if they don't say "SCS". The hard rules here (no shared DB, no cross-zone DB reads, no SQLite/Knex shortcuts) are non-negotiable.
---

# SCS + Zones on knext

> Contract (always-on): `.claude/rules/scs-zones.md`. The PWA stitching layer that makes zones
> feel like one SPA is a **separate, opt-in** skill: `pwa-zones`. knext is the **deployment
> layer**, not the micro-frontend runtime (see Scope boundary below).

## What knext is (context)
A **scale-to-zero Next.js deployment framework for Knative** (TypeScript + Go). Data plane:
**Postgres + Redis + GCS**. **Zone databases are PostgreSQL via CloudNativePG (CNPG).** The Go
operator is the single source of truth for cluster state (ADR-0001).

## Self-Contained Systems (SCS) — definition
An **SCS** is an autonomous web application that owns a complete vertical slice of a business
domain — its **UI, business logic, and data** — and keeps working even if other systems fail. It
is the larger-grained alternative to microservices: the unit is a **domain capability**, not a
single function. (Origin: scs-architecture.org; Simon Martinelli.)

### The five tenets every SCS must satisfy
1. **Autonomous web application** — fulfils its own use cases; survives adjacent-system failure.
2. **Domain-driven ownership** — one team owns it end-to-end (DB → UI); no shared release train.
3. **Data sovereignty** — owns its data store; **no shared database**. Needs another system's
   data? Receive a **redundant copy via async events** — never read the other system's DB.
4. **UI encapsulation** — renders its own UI; a logic change and its UI ship as **one unit**.
5. **Asynchronous integration** — minimise/eliminate synchronous cross-system calls; integrate
   via async backend messaging and via the **browser** (hyperlinks, UI composition).

### Why SCS for knext
It keeps each vertical slice **whole** (vs. a monolithic frontend coupled to many services),
giving independent deploy + blast-radius containment. And it bounds a full slice in one place —
which fits an **AI agent's context window** far better than a feature scattered across repos.

## Zones — the macro-architecture (each zone = one SCS)
**Next.js Multi-Zones:** a **host** zone routes path prefixes to independently-deployed zone apps
via `rewrites` (e.g. `/catalog/*` → the catalog zone). Each zone sets a unique **`assetPrefix`**
so compiled assets never collide on the shared domain (also a `basePath` for its routes).

### Per-zone stack on the knext cluster
```
Next.js zone app   →   its gRPC BackendService(s)   →   its own PostgreSQL
(Knative Service,       (cluster-local h2c, NO           (CNPG Cluster + Pooler; read-replica/HPA;
 scale-to-zero)          public ingress — ADR-0004)        hibernate idle zones)

cross-zone: async Kafka domain events + UI composition ONLY — never a shared DB.
```
- The zone app reaches its backend(s) over h2c via `<NAME>_SERVICE_URL` (operator-injected; see
  the `grpc-services` + `knative-kubernetes` skills).
- The zone's own DB is reached via **`DATABASE_URL` injected from a K8s Secret** — never a
  hardcoded host.

### Cross-zone integration (HARD RULE)
Data flows **async** (Kafka domain events; each consuming zone keeps its **own copy** of what it
needs) and via the **browser** (links, UI composition). A zone **must not** query another zone's
database service — i.e. never connect to another zone's CNPG `-rw` (primary) or `-ro` (replica)
service. Transient cross-zone UI state (auth/theme/cart) syncs via **BroadcastChannel** (see
`pwa-zones`), not a shared store.

> A hook (`protect-zone-data-sovereignty.sh`) blocks writing a hardcoded `*-rw`/`*-ro` CNPG host
> into source — that's the cross-zone-DB-read anti-pattern. Use a Kafka event instead.

### Adding a zone (recipe)
1. **Scaffold the Next.js app** with a unique `basePath` + `assetPrefix`.
2. **Add host `rewrites`** routing `/<zone>/*` to the new zone.
3. **Declare its `ZoneDatabase`** (a CNPG `Cluster` + `Pooler`) — its own store.
4. **Define its `BackendService`(s)** with **proto contracts** (proto = SSOT; see `grpc-services`).
5. **Wire cross-zone needs as Kafka events** (publish/consume; keep a local projection) — not a
   sync call or DB read.
6. **Deploy as its own Knative Service** (scale-to-zero; operator reconciles).

### Anti-patterns (reject these)
- Shared database, or **cross-zone DB reads** (connecting to another zone's `-rw`/`-ro`).
- **Synchronous cross-zone chains** for core user flows (couples availability; defeats
  autonomy). Async events + local copies instead.
- **Sharing runtime business logic** across zones (a code dependency re-couples them). Build-time
  **design tokens / static UI kit** are fine; runtime shared services are not.
- SQLite/Knex "just for now" shortcuts in a zone — zones use CNPG Postgres.

## Scope boundary (load-bearing)
knext is the **deployment layer**, not the micro-frontend runtime. knext **owns**:
Knative/scale-to-zero, the official Next.js adapter, per-zone deploy, `assetPrefix` wiring,
serving the App Shell, and generating the precache manifest. knext does **NOT** own the Service
Worker / SWI / BroadcastChannel / Module-Federation machinery — those are **app-level patterns**
shipped as an **optional "SCS/PWA zones" template/recipe** (`pwa-zones`), never framework core.
(Why: keep knext a focused adapter, not an enterprise MFE platform.)

## Sequencing
Fame-first phase: SCS/zones/PWA stay **design + optional template**, not core. Gated **after** the
official-adapter migration (Phase 0) and Tier-A correctness; per-zone DB + PWA template are
Tier B/C / optional-module material (see `ROADMAP.md`). North star remains verified-adapter status.

## Related
`pwa-zones` (the stitching layer), `grpc-services`, `knative-kubernetes`, `postgres`,
`nextjs-deployment-adapter`. Contract: `.claude/rules/scs-zones.md`.
