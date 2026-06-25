# knext — Postgres scaling & scale-to-zero: assessment + ready-made-solution survey

> **Scope of this run.** "Start thinking about Postgres scaling and scale-to-zero; search for
> ready-made solutions." This assesses the real gap in the repo, surveys the existing tools that
> solve it (grounded in their docs), and recommends a path reconciled against knext's north star
> (`CLAUDE.md`, `.claude/rules/scs-zones.md`, ADR-0001). knext is **the scale-to-zero Next.js
> adapter for Knative — not a PaaS**, and it **does not provision databases**: a zone reaches its
> own Postgres via `DATABASE_URL` from a Kubernetes Secret, and zone databases are **PostgreSQL via
> CloudNativePG (CNPG)** (`.claude/rules/scs-zones.md`). That boundary frames every recommendation.

---

## First, a clarification that the whole plan turns on

"Postgres scale-to-zero" means two very different things, and conflating them causes bad designs:

1. **The app scales to zero; the database stays up (the real, default case).** In knext, the
   *Next.js zone* (compute) scales to zero on Knative. Its CNPG Postgres backend is a **persistent,
   always-on** StatefulSet — it does **not** suspend. So the actual problem is **not** "the DB
   sleeping," it is: when the zone scales `0 → N` instances under load, each instance opens its own
   connection pool → a **connection storm** that can exhaust Postgres `max_connections`; and each
   cold instance pays pool-establish latency on top of the bytecode-cache cold start.

2. **The database also scales to zero (the aspirational case).** Only a **serverless Postgres**
   (Neon, Aurora Serverless v2, …) actually suspends its compute when idle and resumes on the next
   query. CNPG does not do this. This is an *option a zone can choose* (knext just binds a different
   `DATABASE_URL`), not the default.

**The default knext answer is case 1.** Case 2 is a documented option with a lock-in tradeoff.

---

## The gap in the repo today (verified on `main`, this run)

| Component | State | Evidence |
|---|---|---|
| App-side DB pool | **Bare, unbounded, never drained** | `packages/lib/src/clients.ts` — `getDbPool()` is `new Pool({ connectionString: process.env.DATABASE_URL })` with **no `max`, no idle timeout, no `pool.end()`**. |
| Graceful shutdown | **Drains HTTP + `after()`, never the DB pool** | `packages/kn-next/src/adapters/shutdown.ts` (drain logic) + `node-server.ts:30` (`SHUTDOWN_GRACE_MS`, default `25_000`). No `pool.end()` step. |
| Autoscaler knobs | **Exist** (this is fine) | operator `spec.scaling.{minScale,maxScale,containerConcurrency}` defaults `0 / 10 / 100` (`reconcile_output_test.go:138`). |
| Connection pooler | **None anywhere** | grep across repo: zero PgBouncer / CNPG `Pooler` / connection-pool code or manifests. |
| Health check | Pings the DB on readiness | `packages/lib/src/health` (`checkDeepHealth`). |
| Issues filed | **None** | No Postgres-scaling / pooler / connection issue on the board. The earlier drafts **E1** (DB drain + sizing) and **PG2** (CNPG recipe) were never filed. |

**Quantified risk (defaults):** one zone can open up to `maxScale (10) × pool_max` backend
connections; with a bare pool defaulting to ~10, that's ~100 connections for a single zone, and a
21-zone ERP suite against one Postgres trivially blows past a default `max_connections` of 100–200.
In-flight `submit`/GL transactions are also cut on scale-down because the pool is never drained.

---

## Ready-made solutions — the survey (grounded in vendor docs)

The good news: **this is a thoroughly solved problem.** knext should adopt established tooling, not
invent. Three layers, in order of leverage.

### Layer 1 — A transaction-mode connection pooler in front of Postgres (the core fix)

A pooler multiplexes many short-lived client connections onto a small, bounded set of real Postgres
connections. In **transaction mode**, a server connection is held only for the duration of a
transaction, then returned — exactly right for a scale-to-zero, high-churn runtime.

| Solution | What it is | Fit for knext | Notes |
|---|---|---|---|
| **CloudNativePG `Pooler` CRD** ⭐ | A native PgBouncer deployment the CNPG operator manages (`apiVersion: postgresql.cnpg.io/v1, kind: Pooler`): `spec.cluster.name`, `instances`, `type: rw\|ro`, `pgbouncer.poolMode: session\|transaction`, `parameters.{max_client_conn, default_pool_size}`. Exposes a Service on `:5432`; ships Prometheus metrics (`cnpg_pgbouncer_*`). Requires PgBouncer ≥ 1.19. | **Best — recommended default.** knext already mandates CNPG for zone DBs, so the pooler is *one CRD in the same namespace*, self-hosted, no lock-in. The zone binds `DATABASE_URL` to the pooler Service instead of the `-rw` primary. | `spec.cluster` is immutable (re-create to repoint). One `Pooler` per zone keeps data sovereignty intact. |
| **Supabase Supavisor** | OSS multi-tenant pooler (Elixir); transaction mode on `:6543`. | Viable in-cluster alternative; heavier/multi-tenant-oriented. Supabase itself routes serverless traffic through it. | More moving parts than the CNPG-native `Pooler`. |
| **pgcat** | OSS PgBouncer-alternative (Rust) with load-balancing/sharding. | Alternative if you outgrow PgBouncer features. | Not CNPG-native. |
| **AWS RDS Proxy / GCP Cloud SQL pooler** | Managed poolers for cloud-managed Postgres. | For teams on RDS/Cloud SQL instead of CNPG. | Cloud-specific; not portable. |

**The transaction-mode caveat (must document — it bites ORMs).** PgBouncer transaction mode breaks
session-scoped features: `SET`/`RESET`, `LISTEN`/`NOTIFY`, `WITH HOLD` cursors, **SQL-level
`PREPARE`/`DEALLOCATE`**, session advisory locks, and `PRESERVE/DELETE ROWS` temp tables.
**Protocol-level prepared statements DO work** on PgBouncer ≥ 1.21 with `max_prepared_statements`
set. This matters because Payload v3 / Prisma / Drizzle lean on prepared statements — the recipe
must tell users to either set `max_prepared_statements` or disable client-side statement caching.
(Neon, which is just managed PgBouncer in transaction mode, documents the identical caveat list.)

### Layer 2 — App-side bounded pool + SIGTERM drain (knext code; always needed)

Regardless of the pooler, the in-pod `pg.Pool` must be **small** (many small pools, not few large —
a scale-to-zero runtime wants `max: 2–5` per instance) and must **drain on SIGTERM** so in-flight
transactions commit-or-rollback before the pod dies. This is the one piece that is **knext's own
code** (`getDbPool` + the shutdown contract) and is buildable now — it is **Issue PGS-1**.

### Layer 3 — Serverless Postgres that itself scales to zero (an option, not the default)

| Solution | What it is | Fit for knext |
|---|---|---|
| **Neon** | Serverless Postgres: compute **suspends after ~5 min idle, resumes in a few hundred ms**; built-in PgBouncer pooler (`-pooler` endpoint, up to 10k client conns); a **serverless driver** (HTTP/WebSocket) for connection-per-request from edge/serverless. | **Supported option, flagged for lock-in.** Conceptually aligned with knext's scale-to-zero ethos (the DB sleeps too), and a zone adopts it by pointing `DATABASE_URL`/the pooled endpoint at Neon — **zero knext code change**. But it is a managed vendor, which cuts against the self-host / no-lock-in stance, so it is an *option*, never the default. |
| **Aurora Serverless v2 / CockroachDB Serverless** | Cloud-managed autoscaling Postgres-compatible DBs. | Same shape as Neon: option via `DATABASE_URL`, vendor tradeoff. |

---

## Recommendation (reconciled with the north star)

1. **Default (self-host, no lock-in): CloudNativePG `Pooler` (transaction mode), one per zone.** It
   is the most *ready-made* answer for knext because the CNPG operator the rules already mandate
   ships it as a CRD. The zone binds `DATABASE_URL` (via `spec.secrets.envMap`) to the pooler
   Service. **knext documents this recipe and binds the secret — it does not provision it** (ADR-0001:
   stateful infra is operator-external). → **Issue PGS-2 (recipe + the ready-made survey).**
2. **Always: bound `getDbPool` + drain on SIGTERM.** knext's own code; Tier-A reliability;
   buildable now; the make-or-break. → **Issue PGS-1.**
3. **Option: serverless Postgres (Neon).** Documented in the recipe as the "DB also scales to zero"
   path, with the lock-in flag. No code change.
4. **Deferred design question: should the operator optionally reconcile a `Pooler` from the
   `NextApp` CR?** That would make knext *manage* DB-adjacent infra — a scope expansion that brushes
   "not a PaaS" and is post-Tier-A. → **Issue PGS-3 (spike/ADR, do not build now).**

### Sequencing & conflict flags
- **PGS-1** is **Tier-A** (graceful-shutdown correctness — an in-flight GL transaction cut on
  scale-down is a data-integrity bug). It is buildable now and leads the priority list.
- **PGS-2** is a **Tier-B recipe/doc**: knext binds the secret; the cluster runs Postgres + the
  pooler. **Scope-honesty flag:** never present knext as *provisioning* Postgres or the pooler.
- **PGS-3** is a **flagged scope question** (operator-reconciled `Pooler`): it contradicts neither an
  ADR outright nor the sequencing if kept as a *spike/ADR* now and any build deferred to post-Tier-A
  as an opt-in module (mirrors the gRPC/`BackendService` precedent, ADR-0004). Flagged for the
  maintainer rather than silently built.

### Relationship to earlier drafts (not re-proposing)
This realizes and supersedes the unfiled drafts **E1** (`knext-plan-out/erpnext-ts/issues.md` — DB
drain + sizing) and **PG2** (`knext-plan-out/package-deploy-postgres/issues.md` — CNPG recipe),
now grounded in the actual tool docs. PGS-1 = E1's code half; PGS-2 = PG2 + the ready-made survey.

---

## Bottom line
The gap is real and currently unaddressed in code, but it is a **solved problem with ready-made
tooling**. The headline answer for knext is **CloudNativePG's built-in PgBouncer `Pooler` in
transaction mode** (native, self-hosted, no lock-in), plus a **small bounded app pool that drains on
SIGTERM** (the one piece of real knext code, buildable now), with **Neon-style serverless Postgres**
as a documented option for teams that want the database to scale to zero too. knext stays the narrow
adapter: it binds the secret and writes the recipe; the cluster runs the database and the pooler.
