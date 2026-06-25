# Proposed knext issues — Postgres scaling & scale-to-zero

> Three ready-to-open issues. **PGS-1** is the buildable make-or-break (knext's own code, Tier-A).
> **PGS-2** is the ready-made-solution recipe (CloudNativePG `Pooler` + Neon option, Tier-B doc).
> **PGS-3** is a flagged design spike (should the operator manage a pooler?). Each is independently
> shippable, has testable acceptance criteria, names real components/paths, and flags tradeoffs.
> Grounding: knext does **not** provision databases — a zone binds its own Postgres via
> `DATABASE_URL` from a Kubernetes Secret, and zone DBs are **CloudNativePG (CNPG)**
> (`.claude/rules/scs-zones.md`); stateful infra is operator-external (ADR-0001). Labels reuse the
> live taxonomy: `tier-A`, `tier-B`, `tier-C`, `documentation`, `enhancement`, `spike`, `security`.

---

## PGS-1 — Bound the database pool and drain it on SIGTERM (Postgres-safe scale-to-zero)

**Labels:** `tier-A`, `enhancement` · **Milestone:** Tier A — correctness

### Context
A knext zone is a Next.js app deployed on Knative that **scales to zero** — Knative removes all pods
when idle and spins up new ones (`0 → N`) under load. Any zone that talks to PostgreSQL holds a
connection pool **per pod**. Two failure modes follow directly:
1. **Connection storm:** as the zone scales up, each new pod opens its own pool, multiplying the
   number of connections hitting Postgres. With knext's autoscaler defaults
   (`spec.scaling.containerConcurrency: 100`, `maxScale: 10`) one zone can open up to
   `maxScale × pool_max` connections, exhausting Postgres `max_connections` (often 100–200).
2. **Cut transactions on scale-down:** when Knative sends `SIGTERM` to drain a pod, in-flight
   database transactions can be severed mid-write, risking inconsistent state (for an ERP, a
   half-applied ledger posting).

### Problem
- `packages/lib/src/clients.ts` — `getDbPool()` constructs `new Pool({ connectionString:
  process.env.DATABASE_URL })` with **no `max`, no idle timeout, and no `pool.end()` anywhere**.
- `packages/kn-next/src/adapters/shutdown.ts` drains HTTP and runs Next.js `after()` callbacks on
  `SIGTERM` (within `SHUTDOWN_GRACE_MS`, default `25_000`, from `node-server.ts:30`) but has **no
  database-drain step** — the pool is never closed.

### Proposed change
1. **Give `getDbPool()` scale-to-zero-sane, overridable defaults.** A small `max` (e.g. default
   `5`, env-overridable via something like `DB_POOL_MAX`) and a finite idle timeout, with the
   rationale documented inline ("many small pools, not few large — a transaction-mode pooler in
   front bounds the real backend connections; see the Postgres-under-scale-to-zero guide"). Do not
   hardcode in a way that can't be tuned per zone.
2. **Add a database-drain step to the shutdown contract.** Extend the shutdown path so that on
   `SIGTERM`, after HTTP drain begins, a registered DB-drain hook (`getDbPool().end()` or an
   app-provided callback) is invoked and **awaited within the existing grace window**, letting
   in-flight transactions commit-or-rollback before the pool closes. Cap the awaited drain (like the
   existing HTTP-drain cap) and fall through to forced exit on timeout, keeping the total under the
   pod's `terminationGracePeriodSeconds`.
3. Keep it provider-agnostic: this is the app-side half and is correct whether or not a pooler is in
   front (Issue PGS-2).

### Acceptance criteria
- `getDbPool()` sets a bounded default `max` and idle timeout; a unit test asserts the defaults and
  that an env override wins.
- A unit test in `packages/kn-next/src/__tests__/shutdown.test.ts` asserts that on `SIGTERM` a
  registered DB-drain hook is invoked **and awaited before process exit**, and that exit still
  respects the grace cap (i.e. a hanging drain cannot exceed it).
- No change to the `NextApp` CRD schema (the autoscaler knobs already exist) — verified by diffing
  `packages/kn-next-operator/api/v1alpha1/nextapp_types.go`.
- The repo test suite stays green.

### Components & files touched
`packages/lib/src/clients.ts`, `packages/kn-next/src/adapters/shutdown.ts`,
`packages/kn-next/src/adapters/node-server.ts` (wiring), `packages/kn-next/src/__tests__/shutdown.test.ts`,
new/updated lib test for the pool defaults.

### Architecture notes & risks
- **On-strategy:** this is *app-side reliability code*, not a managed pooler or a database — it stays
  inside "narrow adapter, not a PaaS." It is the make-or-break item for any stateful zone.
- **Tier-A justification:** a transaction cut on scale-down is a data-integrity bug, which is
  correctness, not a platform nicety.
- Risk: the drain hook must not deadlock the grace window — reuse the existing HTTP-drain cap
  pattern. Builds on the merged graceful-shutdown work; does **not** touch the operator.

---

## PGS-2 — Guide + recipe: Postgres under scale-to-zero (CloudNativePG `Pooler`, with a serverless-Postgres option)

**Labels:** `tier-B`, `documentation` · **Milestone:** Tier B — platform

### Context
knext mandates **CloudNativePG (CNPG)** for zone databases and binds `DATABASE_URL` from a
Kubernetes Secret (`.claude/rules/scs-zones.md`); it does **not** provision the database. Teams need
an authoritative, ready-made answer for running Postgres safely under a scale-to-zero zone, rather
than discovering the connection-storm problem in production. The answer is established tooling, not
anything knext must build.

### Problem
There is no doc that (a) explains the connection-storm/scale-to-zero problem, (b) shows the
**ready-made** fix — a transaction-mode connection pooler — using the CNPG-native `Pooler` CRD, and
(c) documents the option of a serverless Postgres that itself scales to zero. The pooler's
transaction-mode caveats (which break ORM features if unhandled) are also undocumented.

### Proposed change
Add `docs/operator/postgres-scale-to-zero.md` (cluster-infra recipe — explicitly *not* knext
provisioning):
- **The problem**, with the bounding rule: `peak_backend_conns ≈ maxScale × app_pool_max`; bound it
  via the existing `spec.scaling.maxScale` / `containerConcurrency` knobs **and** a pooler.
- **Recommended default — CloudNativePG `Pooler`:** a copy-pasteable `Pooler` manifest
  (`apiVersion: postgresql.cnpg.io/v1, kind: Pooler`, `type: rw`, `pgbouncer.poolMode: transaction`,
  `parameters.{max_client_conn, default_pool_size}`), and binding the zone's `DATABASE_URL` (via
  `spec.secrets.envMap`) to the **pooler Service** instead of the `-rw` primary. Note PgBouncer ≥ 1.19
  requirement and the built-in `cnpg_pgbouncer_*` Prometheus metrics.
- **The transaction-mode caveat (must include):** transaction pooling breaks `SET`/`RESET`,
  `LISTEN`/`NOTIFY`, SQL-level `PREPARE`/`DEALLOCATE`, session advisory locks, and `WITH HOLD`
  cursors; **protocol-level prepared statements work on PgBouncer ≥ 1.21 with
  `max_prepared_statements` set**. Tell users to set `max_prepared_statements` or disable client
  statement caching (Payload v3 / Prisma / Drizzle rely on prepared statements).
- **App-side settings:** small `max` per instance + the SIGTERM drain (cross-link PGS-1).
- **Option — serverless Postgres (DB also scales to zero):** a short section on **Neon** (compute
  suspends after idle, resumes in a few hundred ms; built-in pooler `-pooler` endpoint; HTTP/WS
  serverless driver) and equivalents (Aurora Serverless v2), adopted by pointing `DATABASE_URL` at
  the provider — **zero knext code change** — with an explicit **lock-in / not-the-default** flag.
- A worked example: a write-heavy zone (low `maxScale`, higher `containerConcurrency`) vs a
  read-heavy zone (a CNPG read replica + an `ro` pooler).

### Acceptance criteria
- `docs/operator/postgres-scale-to-zero.md` exists; every CNPG `Pooler` field and `NextApp` field
  cited is real (verified against CNPG's CRD and `nextapp_types.go`); no invented fields.
- The doc states plainly that knext does **not** provision Postgres or the pooler; the cluster does.
- The transaction-mode caveat list + the prepared-statement guidance are present and correct.
- The serverless-Postgres option is documented with the lock-in flag.
- Passes a `docs-guard` accuracy pass; cross-links PGS-1.

### Components & files touched
New `docs/operator/postgres-scale-to-zero.md`; cross-links `.claude/rules/scs-zones.md`, PGS-1, and
(if present) the per-zone provisioning recipe.

### Architecture notes & risks
- **Scope honesty (flag):** a recipe, not a feature — knext binds the secret; the cluster owns the
  database and the pooler. Never present knext as provisioning either.
- **Sequencing:** documentation is fine now; promoting any of it into core is post-Tier-A.

---

## PGS-3 — [SPIKE] Should the operator optionally reconcile a connection `Pooler` from the `NextApp` CR?

**Labels:** `spike`, `tier-C` · **Milestone:** (design — post-Tier-A)

### Context
PGS-2 makes the connection pooler a documented, hand-applied recipe. A natural next question: should
knext go further and let a zone declare, on its `NextApp` CR (e.g. `spec.database.pooler: {...}`), a
desire for a pooler, and have the operator reconcile a CloudNativePG `Pooler` for it — turning a
manual recipe into a one-line, infrastructure-as-code capability (project goal #4)?

### Problem
This is a genuine architecture decision with a real tension, and it should be **decided, not drifted
into**: making the operator manage a `Pooler` means knext starts **managing database-adjacent
infrastructure**, which brushes the "narrow Next.js+Knative adapter, **not** a PaaS" positioning
(`CLAUDE.md`) and the "stateful infra is operator-external" stance (ADR-0001 action items). It is
also data-plane/zone work, which the rules sequence **after Tier-A correctness**.

### Proposed change (design only — NO operator/CRD code in this issue)
A time-boxed spike producing an ADR in `docs/adr/` that weighs:
- **Option A — recipe only (status quo after PGS-2):** the team hand-applies a CNPG `Pooler`. Zero
  knext scope growth; more manual steps.
- **Option B — operator-reconciled `Pooler`:** a `spec.database.pooler` block on `NextApp`; the
  operator creates/owns a CNPG `Pooler` (poolMode, sizing) and wires `DATABASE_URL` to it. Best IaC
  DX; largest scope growth; couples knext to the CNPG `Pooler` API and to a database it otherwise
  does not manage.
- **Option C — opt-in module:** ship it like the gRPC/`BackendService` capability (ADR-0004) — an
  optional, separately-installed controller, not core — so the narrow core stays narrow.
The ADR recommends one (lean: **Option C** if built at all, **after Tier-A**), and explicitly flags
the PaaS-scope + sequencing tension for the maintainer.

### Acceptance criteria
- An ADR in `docs/adr/` compares Options A/B/C on scope, DX, coupling, and sequencing, with a
  recommendation and an explicit "not before Tier-A" note.
- **No** changes to `packages/kn-next-operator` (CRD/reconciler) or `packages/kn-next` as part of the
  spike.

### Components & files touched
New `docs/adr/00NN-operator-managed-connection-pooler.md` only.

### Architecture notes & risks
- Filed now to **capture the decision and the scope tension explicitly** rather than letting a future
  PR quietly expand the operator into database-infra management.
- **Do not start any build until Tier-A exit criteria are met**, and only as an opt-in module if at
  all.

---

## Sequencing summary
1. **PGS-1** (tier-A) — bound the pool + SIGTERM drain. *Buildable now; the make-or-break; do first.*
2. **PGS-2** (tier-B, docs) — the CNPG `Pooler` recipe + serverless-Postgres option (the ready-made survey). *Build on PGS-1; flag scope.*
3. **PGS-3** (spike, tier-C) — ADR on operator-managed pooler. *Design only; post-Tier-A; flag the PaaS-scope tension.*

**Not re-proposed:** the unfiled drafts **E1** (DB drain + sizing) and **PG2** (CNPG recipe) — PGS-1/PGS-2 realize them, now grounded in the actual tool docs. **Not knext's job (deliberate):** running the database or the pooler — that is CloudNativePG / the cluster (or a serverless-Postgres vendor). knext binds the secret and writes the recipe.
