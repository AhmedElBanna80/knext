# Draft ADR — Cross-zone table copies: a platform-managed replication fabric

> **Status:** DRAFT for review (not yet filed in `docs/adr/`). Founder has chosen the three core
> options below. This records the design so it can be filed as a numbered ADR and amend
> `.claude/rules/scs-zones.md`.

## Context

knext deploys each SCS (Self-Contained System) zone as an independent Next.js app with its **own**
PostgreSQL database. Today `.claude/rules/scs-zones.md` states cross-zone data flows **"only via
async Kafka domain events"** and a zone **"must not read another zone's database."** That rule was
written to prevent the two real SCS anti-patterns: a **shared database**, and a zone making **live
synchronous reads** into another zone's DB.

But copying *is* a first-class SCS pattern: a consuming zone is meant to keep **its own copy** of the
data it needs from other zones. The gap is that knext provides **no infrastructure** to maintain
those copies — teams are left to hand-build event consumers per field. The founder's direction: knext
should provide a **managed table-copy fabric** where a zone declares its **local (owned) tables** and
its **foreign (copied-in) tables**, and the platform keeps the foreign copies fresh.

## Decision

Provide an **opt-in, platform-managed cross-zone table-copy fabric**, backed by **RisingWave** (a
PostgreSQL-wire-compatible streaming database that ingests PostgreSQL CDC, maintains incremental
materialized views, and sinks to PostgreSQL). The contract, per the founder's choices:

1. **Producer-published tables (encapsulation preserved).** A producer zone **explicitly publishes**
   a table — ideally a **view** over its internal schema — as its stable *data contract*. Only
   published tables are copyable; internal tables stay private. A column rename behind the view does
   not break consumers.
2. **CDC-fed by the platform fabric.** RisingWave's `postgres-cdc` source reads **only the published
   tables** from the producer's Postgres (via a **dedicated, least-privilege replication credential**
   — never the producer app's credential), materializes them, and **sinks read-only copies into the
   consuming zone's own Postgres**.
3. **Copies live in the consumer's own database.** The fabric writes each foreign copy as an ordinary
   read-only table (e.g. `_copy_customers`) in the consumer zone's Postgres, so the app does **normal
   local SQL joins** and remains self-contained and resilient if the producer or fabric is down.

**This amends `scs-zones.md`** (see "Rule amendment" below): the hard rule "a zone never connects to
another zone's DB" **still holds** — only the *platform fabric* connects, and only to *published*
tables; a zone still reads **only its own local copy**.

## Why this is still SCS-faithful (the reconciliation)

| SCS invariant | Preserved? | How |
|---------------|-----------|-----|
| No shared database | ✅ | Every zone keeps its **own** copy in its **own** DB. The fabric duplicates, never shares. |
| A zone never reads another zone's DB | ✅ | Only the **platform fabric** (a distinct actor, not a zone) connects to the producer — like a backup or physical-replication system. Zones read only their local copies. |
| Producer encapsulation | ✅ | Consumers can copy **only explicitly-published** tables/views; internal schema stays private and refactorable. |
| Async / decoupled | ✅ | Copies are **eventually consistent**; a consumer keeps serving its last good copy if the producer is unavailable. |

The distinction that makes the amendment safe: **the fabric is platform infrastructure, not a zone**,
and it touches **only published tables** through a **separate replication credential**.

## Options considered

| Decision point | Chosen | Alternatives rejected (why) |
|----------------|--------|------------------------------|
| Feed mechanism | **CDC from published tables** | *Kafka-events-only* — purest, no amendment, but forces producers to emit events for everything copyable (heavy app work; not "infra provides the copies"). *Both* — larger surface; defer until demand. |
| Copy location | **Consumer's own Postgres** | *Served from RisingWave directly* — app needs a 2nd connection, can't join locally in one query, and reads now depend on RisingWave uptime. |
| Exposure control | **Producer-published only** | *Any table copyable* — couples consumers to producers' physical schema; internal refactors silently break downstream. |
| Where it's reconciled | **A dedicated `TableCopy` CRD + a fabric controller** (recommended) | *Fields buried in one zone's NextApp* — a copy spans **two** zones + RisingWave, so it isn't a single-zone concern. Producer's `published` set stays on the producer NextApp (single-zone); the cross-zone wiring is its own object. |

## High-level design

### Zone-facing declarative contract

Producer zone — what it exposes (single-zone; on the producer's config → `NextApp`):
```yaml
spec:
  data:
    published:
      - name: customers_public            # the contract name consumers reference
        view: "SELECT id, name, email, status FROM customers"   # a VIEW = stable contract
        primaryKey: [id]
```

Consumer zone — what it copies in (cross-zone; a `TableCopy` object reconciled by the fabric):
```yaml
apiVersion: data.kn-next.dev/v1alpha1
kind: TableCopy
metadata: { name: sales-customers-into-billing, namespace: erpnext }
spec:
  source:   { zone: sales,   published: customers_public }
  target:   { zone: billing, table: _copy_customers }       # read-only table in billing's DB
  # optional: projection / filter / refreshPolicy
```

### Control + data flow

```
producer Postgres (published view)
        │  CDC (dedicated replication credential, TLS)
        ▼
   RisingWave  ──  CREATE SOURCE postgres-cdc  →  (optional) MATERIALIZED VIEW
        │  postgres SINK
        ▼
consumer Postgres: _copy_customers (read-only)   ← app does local JOINs
```

The **fabric controller** reconciles each `TableCopy` into the three RisingWave objects (source,
optional MV, sink), and tears them down on delete (including the producer's replication slot).

### Component boundaries
- **knext core (operator/CLI):** validates the `published` contract + `TableCopy` CRD; emits them.
  Stays the narrow adapter.
- **Fabric controller (new, opt-in module):** the only component that talks to RisingWave; reconciles
  CRDs → RisingWave SQL. Analogous to the opt-in `BackendService` controller (ADR-0004).
- **RisingWave (cluster infra):** the always-on replication engine. **Not knext code.**

## Consequences

**Positive:** zones get maintained, queryable local copies with near-real-time freshness; producers
keep encapsulation; consumers stay self-contained and resilient; the heavy lifting is declarative.

**Negative / risks (must be designed for):**
- **Scope expansion.** knext gains a data-replication capability — PaaS-adjacent. Mitigate by shipping
  it as an **opt-in module**, sequenced **after Tier-A** (like the gRPC layer), never in the core path.
- **RisingWave is always-on.** It does **not** scale to zero — a real tension with knext's
  scale-to-zero north star. The fabric is persistent platform infra; document this explicitly.
- **Replication-slot WAL bloat.** Each CDC source holds a logical-replication slot on the producer; a
  stuck/lagging consumer prevents WAL cleanup and can fill the producer's disk. **Slot lifecycle +
  lag monitoring + alerting are mandatory**, not optional.
- **Schema-contract drift.** A breaking change to a published view breaks consumers — treat published
  tables as a versioned API (additive changes; deprecation policy).
- **Network + secrets.** The fabric needs network paths to producer **and** consumer Postgres, which
  the default-on zone `NetworkPolicy` denies cross-namespace — the fabric is a **named exception**.
  Replication credentials are least-privilege (REPLICATION + SELECT on published views only), TLS
  (`ssl.mode=verify-full`), in K8s Secrets.
- **Read-only enforcement.** The consumer app must never write `_copy_*` tables; enforce via grants.

## Rule amendment (to `.claude/rules/scs-zones.md`)

Add a sanctioned third mechanism alongside Kafka events + browser composition:

> **Platform-managed table copies.** Cross-zone data may also be replicated by knext's managed
> table-copy fabric. A producer zone **explicitly publishes** a table (preferably a view) as its data
> contract; the fabric reads **only published tables** via a **dedicated least-privilege replication
> credential** and writes a **read-only copy** into the consuming zone's own database. **A zone still
> never connects to another zone's database — only the platform fabric does, and only to published
> tables.** A consuming zone reads **only its own local copy**. Copies are eventually consistent.

## Action items
1. File this as a numbered ADR; amend `scs-zones.md` with the clause above.
2. Define the `published` contract schema + the `TableCopy` CRD (`data.kn-next.dev/v1alpha1`).
3. Build the fabric controller (opt-in module) reconciling CRDs → RisingWave source/MV/sink + slot
   teardown.
4. Security: replication-credential provisioning, NetworkPolicy exception, slot-lag monitoring.
5. Sequence all build work **after Tier-A**; ship as an optional install, not core.
