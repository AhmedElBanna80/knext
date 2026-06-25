# knext ⇄ erpnext-ts — Runtime-Substrate Gap Analysis

> **What this document is.** erpnext-ts (a faithful TypeScript port of ERPNext, built as 21
> independent Payload v3 + Next.js 15 module apps + an `apps/main` proxy = 22 Next.js apps)
> now treats knext as its deployment substrate. This assesses, for each of erpnext-ts's eight
> runtime-contract requirements, what knext supports **today** — grounded in the real repo —
> and reconciles every gap against knext's own north star (`CLAUDE.md`, `ROADMAP.md`,
> `docs/adr/`, `.claude/rules/`). **knext's north star wins.** Where a requirement would drag
> knext toward a general PaaS, or jump ahead of its stated sequencing, this says so plainly and
> proposes a path rather than absorbing the scope.

---

## The one framing that governs everything

knext is **the scale-to-zero Next.js adapter for Knative — not a PaaS** (`CLAUDE.md` §1, §8;
`.claude/rules/architecture.md` §5). That single positioning decides three of erpnext-ts's
asks before we even score them:

- **knext injects connection *secrets*; the cluster provisions the *stateful infra*.** A zone
  reaches its own Postgres via `DATABASE_URL` from a Kubernetes Secret
  (`.claude/rules/scs-zones.md`). knext binds that Secret into the pod. It does **not** run your
  database. Postgres is **CloudNativePG**'s job; a Kafka broker is **Strimzi/managed Kafka**'s
  job. This is deliberate, not a missing feature.
- **The operator is the single source of truth** (ADR-0001). Every proposal below lands on the
  `NextApp` CR + operator, or it is flagged as out-of-band.
- **Zones stay app-level until after Tier-A correctness** (`ROADMAP.md`, `.claude/rules/scs-zones.md`).
  Anything that promotes routing/zone-generation into core today **conflicts with sequencing**
  and is marked as such.

The good news: because erpnext-ts is already built as proper SCS (own DB per zone, async events,
no cross-zone DB reads), it fits knext's model *better than a monolith would*. Most "gaps" are
**guidance + small contract additions + ergonomics**, not missing primitives.

---

## Gap analysis — the eight requirements

Legend: **Supported** = works today with real components · **Partial** = a primitive exists but
is incomplete/ISR-scoped/undocumented · **Missing** = no implementation · **Out-of-scope** =
deliberately not knext's job per the north star (knext provides the binding, not the thing).

### Req 1 — Multi-zone routing / SCS composition → **Partial (app-level, works today)**
- **What exists.** Multi-zone routing is an **app-level Next.js `rewrites()` pattern**
  (`README-MULTI-ZONE.md`), with each zone owning a `basePath` (`/<zone>`) and `assetPrefix`
  (`/<zone>-static`). `assetPrefix` is injected at deploy time via the `ASSET_PREFIX` env var
  (`apps/file-manager/next.config.ts:11`), wired by the CLI. A Turborepo Plop generator scaffolds
  zone app templates (`turbo/generators/config.ts`).
- **What's missing.** There is **no route/path-prefix field on the `NextApp` CR**
  (`nextapp_types.go` has no `basePath`/`route`/`rewrites`) and **no operator-managed gateway**.
  The `apps/main` proxy is an *app-level pattern* (a Next.js app each team writes), not a checked-in
  app or a core primitive.
- **Verdict for erpnext-ts.** This already works: deploy each of the 21 zones as its own
  `NextApp`, and deploy an `apps/main`-style rewrites proxy (a **documented pattern** in
  `README-MULTI-ZONE.md`, not a shipped app — only `apps/file-manager` and
  `apps/spike-bun-bytecode` are checked in) as the 22nd `NextApp`, whose `rewrites()` point at the
  other zones' in-cluster Knative URLs. **No new knext primitive is required to ship.** A CR-native
  routing primitive would be nice but **conflicts with "zones stay app-level until after Tier-A"**
  — flag, defer (Issue E5).

### Req 2 — Per-zone isolated Postgres + secret injection → **Secret injection: Supported · DB provisioning: Out-of-scope**
- **Supported.** `spec.secrets.envFrom` (`[]string`, whole-Secret) and `spec.secrets.envMap`
  (`map[string]{secretName, secretKey}`) inject `DATABASE_URL` and `PAYLOAD_SECRET` from
  Kubernetes Secrets into each pod (`nextapp_types.go` SecretsSpec;
  `nextapp_controller.go` env injection). Secrets never live in config/images/URLs — satisfies
  `security.md`. 22 zones → 22 `NextApp` CRs, each binding its own DB Secret.
- **Out-of-scope (by design).** The operator has **no database provisioning** (grep for
  `postgres` in the operator returns nothing; ADR-0001 action items explicitly defer
  `postgres.yaml`/`redis.yaml`/`minio.yaml` to "operator-external"). knext will **not** create 22
  logical databases — that is **CloudNativePG**'s job, per `.claude/rules/scs-zones.md`. knext
  binds the CNPG-generated Secret (e.g. `<cluster>-app` with key `uri`) via `envMap`.
- **Verdict.** Fully workable today; the only deliverable is a **reference doc** showing the
  CNPG-Secret → `envMap` → `DATABASE_URL` binding (Issue E2). Do **not** build DB provisioning
  into knext.

### Req 3 — Node.js server runtime (not edge) → **Supported**
- `spec.runtime: node` (default) makes the operator run the standalone server as a **full Node
  process** (`adapters/node-server.ts` spawns `.next/standalone/server.js`); `runtime: bun` is the
  only alternative. There is **no edge/isolate runtime** in knext at all — long-lived TCP Postgres
  sockets, the Payload admin UI, and server-side request transactions all work. Nothing to build.

### Req 4 — Database connections under scale-to-zero → **Partial → the make-or-break gap**
- **What exists.** `getDbPool()` (`packages/lib/src/clients.ts`) is a **bare `pg.Pool`** built from
  `DATABASE_URL` with **no max-pool config, no idle reaping, and no `pool.end()` on shutdown**. The
  graceful-shutdown path (`adapters/shutdown.ts`; hard cap `SHUTDOWN_GRACE_MS`, default `25_000` ms,
  set in `adapters/node-server.ts:30`) forwards SIGTERM to the Next child and drains
  **HTTP + `after()`** — but **never drains the DB pool**. Autoscaler defaults:
  `minScale=0`, `maxScale=10`, `containerConcurrency=100` (`reconcile_output_test.go:138`).
- **The risk, quantified.** Pool-per-instance × scale-up is a **connection storm**:
  with the defaults, one zone can open up to `maxScale (10) × pool-max` Postgres connections;
  21 active zones against one Postgres instance trivially exhausts `max_connections`. Scale-to-zero
  adds cold-start pool re-establish latency on top of the bytecode-cache cold start.
- **What knext must do (and what it must not).** knext must **not** ship a database or a managed
  pooler (PaaS scope). It **must**:
  1. **Extend the shutdown contract** so a Postgres-backed app drains its pool inside the grace
     window (documented `pool.end()` in the app's SIGTERM/`after()`, plus confirming
     `SHUTDOWN_GRACE_MS` < `terminationGracePeriodSeconds`). (Issue E1)
  2. **Publish the sizing model** as first-class guidance: a **small per-instance pool** (e.g.
     `max: 2–5`), a **transaction-mode PgBouncer** (or RDS Proxy / Neon pooler) between zones and
     Postgres, and the **bounding rule**: `total_conns ≈ maxScale × pool_max ≤ db_max_connections`,
     tuned via the *already-exposed* `scaling.maxScale` / `scaling.containerConcurrency` knobs.
     (Issue E1)
- **Verdict.** This is the #1 item. It is **mostly guidance + a small app-side drain contract**,
  not a new knext component — which is exactly why it fits the north star. Spelled out in full in
  the next section.

### Req 5 — Cross-zone eventing (Kafka) → **Partial (ISR-only) · general bus: Out-of-scope**
- **What exists.** `spec.revalidation{queue: kafka, kafkaBrokerUrl, provisionKafkaSource}` and an
  operator-provisioned `KafkaSource` — but it is **ISR-revalidation-scoped**, the `<app>-revalidator`
  consumer is **unbuilt and gated off by default** (ADR-0016, issue #95), and there is **no general
  `KafkaEventBus` / domain-event transport** in the repo (the Plop `event` generator is a stub).
- **Out-of-scope (by design).** A general cross-zone domain-event bus + broker provisioning is
  **app-level + cluster-infra**, not core (mirrors the Postgres boundary; `.claude/rules/scs-zones.md`
  keeps cross-zone eventing app-level until the framework absorbs it post-Tier-A). knext's job is to
  **inject broker credentials** as a Secret so erpnext-ts's own `@erpnext-ts/events` `KafkaEventBus`
  (KafkaJS consumers, idempotent transactional handlers) can connect to a **cluster Kafka
  (Strimzi/managed)**.
- **Verdict.** erpnext-ts runs its own producers/consumers; knext injects `KAFKA_BROKERS` via
  `secrets.envMap`. Deliverable is **clarifying documentation** that the operator's `revalidation.kafka`
  is *not* the domain-event bus (Issue E6). Do **not** build a domain-event bus into knext now.

### Req 6 — Build & deploy at fleet scale → **Partial**
- **Supported.** Per-image **digest pinning is enforced CLI-side** (`cr-builder.ts:301` rejects any
  ref without `@sha256:`) and at admission (operator webhook rejects `:latest`,
  `validation/validate.go`). Non-root is satisfied (`node` uid 1000 in the example Dockerfile).
- **Missing / partial.** (a) The CLI is **single-app per invocation** — it loads one
  `kn-next.config.ts` from `cwd` (`cli/shared.ts:23`); there is **no workspace/matrix iteration**.
  22 apps = 22 invocations (scriptable, which erpnext-ts's CI matrix already does). (b) The example
  app image is `node:22-alpine`, **not distroless** — `security.md` calls for a distroless runtime.
- **Verdict.** Works today via a CI loop; two ergonomics/hardening gaps: fleet-deploy convenience
  (Issue E3) and a distroless app base (Issue E4). Both are independently shippable and low-risk.

### Req 7 — Lifecycle & hardening → **Partial**
- **Supported.** Readiness + liveness probes are auto-injected by the operator (HTTP GET to
  `spec.healthCheckPath`, default `/api/health`; `nextapp_controller.go`), and the health endpoint
  deep-checks Postgres + Redis. Graceful **HTTP** drain + `after()` on SIGTERM is shipped (#44).
  Default-on L3/L4 `NetworkPolicy` isolates pods (`spec.security.networkPolicy`).
- **Missing.** (a) **DB drain** on shutdown (the GL-integrity concern — same as Req 4). (b)
  **Gateway rate limiting / payload-size limits** — `security.md` names a reverse proxy for these,
  but **no implementation exists in core**. (c) Probe *tuning* for slow Payload cold starts may be
  needed (the readiness `initialDelaySeconds: 2` is tight for a cold Payload boot).
- **Verdict.** DB drain rolls into Issue E1; ingress rate/payload limits become Issue E7
  (Tier-B/security); probe tuning is a config note in E2.

### Req 8 — IaC developer experience (NextApp CR) → **Supported (with two known field gaps)**
- A zone can already be declared as a single `NextApp` CR expressing image (digest-pinned),
  scaling bounds, resources, secrets (DB + Payload + Kafka creds), cache + bytecode, runtime,
  health path, and network policy — the operator reconciles it (ADR-0001). **The minimal authoring
  CR is shown below and in Issue E2.** The two missing expressions are **route/path-prefix** (Req 1,
  handled app-level) and **DB binding as a first-class concept** (Req 2, handled via `secrets.envMap`).

### Scorecard

| # | Requirement | Status | Where it lands |
|---|-------------|--------|----------------|
| 1 | Multi-zone routing | **Partial** (app-level works) | Ship app-level; CR-native = deferred (E5) |
| 2 | Per-zone Postgres + secrets | **Secret: Supported · DB provision: Out-of-scope** | Doc the CNPG→envMap binding (E2) |
| 3 | Node runtime (not edge) | **Supported** | — |
| 4 | DB connections under scale-to-zero | **Partial — make-or-break** | Drain contract + sizing guide (E1) |
| 5 | Cross-zone Kafka eventing | **Partial (ISR-only) · bus Out-of-scope** | Doc app-level bus + cred injection (E6) |
| 6 | Build/deploy at fleet scale | **Partial** | Fleet-deploy ergonomics (E3) + distroless (E4) |
| 7 | Lifecycle & hardening | **Partial** | DB drain (E1) + ingress limits (E7) |
| 8 | IaC DX / NextApp CR | **Supported** | Reference CR (E2) |

---

## Req 4 spelled out — the scale-to-zero + Postgres connection strategy

This is the make-or-break item, so here is the concrete, repo-grounded recommendation.

**The problem.** Each Payload instance holds its own `pg.Pool`. Knative scales instances on
concurrency. With knext defaults (`containerConcurrency: 100`, `maxScale: 10`) a single zone can
burst to 10 instances; if each pool opens, say, 10 connections, that's 100 connections for one
zone, ×21 zones = far past a default Postgres `max_connections` (100–200). Scale-to-zero then adds
fresh-pool latency to every cold start.

**The strategy — three layers, none of which make knext a PaaS:**

1. **Small per-instance pools (app-side).** Configure Payload/`pg` with `max: 2–5` per instance.
   A scaled-to-zero, high-concurrency runtime wants *many small pools*, not *few large* ones.
2. **A transaction-mode pooler in front of Postgres (cluster-infra).** PgBouncer (in-cluster, e.g.
   the CNPG-bundled pooler), RDS Proxy, or a Neon-style serverless pooler. Zones connect to the
   pooler's service DNS via `DATABASE_URL`; the pooler multiplexes the storm down to a bounded set
   of real backend connections. This is **infra erpnext-ts/cluster owns**, exactly like the database
   itself — knext injects the pooler's Secret, no knext code.
3. **Bound the fan-out with knext's existing knobs.** The bounding rule is
   `peak_pooler_clients ≈ maxScale × pool_max`. Set `spec.scaling.maxScale` and
   `spec.scaling.containerConcurrency` per zone so the product stays under the pooler's client
   limit. For an ERP write-zone (accounting/GL) prefer **lower `maxScale` + higher
   `containerConcurrency`** (fewer instances, each handling more concurrent requests) to keep
   connection count predictable and transaction ordering sane.

**What knext must add (Issue E1), all small and on-strategy:**
- **Drain the pool on SIGTERM.** Today `shutdown.ts` drains HTTP + `after()` but never the DB pool.
  Establish a documented contract: the app registers a drain that calls `pool.end()` within the
  grace window, and knext guarantees `SHUTDOWN_GRACE_MS` (default 25s) is honored and sits below
  `terminationGracePeriodSeconds`. For GL integrity, in-flight submit/posting transactions must
  commit-or-rollback before the pool closes — this is the immutability/consistency guarantee an ERP
  needs across restarts.
- **Ship the sizing model as first-class docs** (the three layers above), not tribal knowledge.

**erpnext-ts's side of the bargain** (see "What erpnext-ts should change"): adopt the shared
pooler, set small `max`, and make consumers/handlers safe to interrupt mid-grace.

---

## The minimal NextApp CR an erpnext-ts zone authors today

Every field below is real (`nextapp_types.go`). This is the `accounting` zone:

```yaml
apiVersion: apps.kn-next.dev/v1alpha1
kind: NextApp
metadata:
  name: accounting                 # the zone slug; apps/main rewrites /accounting → this service
  namespace: erpnext
spec:
  image: REG/erpnext-ts/accounting@sha256:<digest>   # digest-pinned (required; :latest rejected)
  runtime: node                    # Payload v3 needs full Node, not edge
  healthCheckPath: /api/health     # deep-checks Postgres + Redis; drives readiness/liveness probes
  scaling:
    minScale: 0                    # scale-to-zero
    maxScale: 6                    # bound DB fan-out: maxScale × pool_max ≤ pooler client limit
    containerConcurrency: 80       # fewer, busier instances → predictable connection count
  resources:
    cpuRequest: "250m"
    memoryRequest: "512Mi"
    cpuLimit: "1000m"
    memoryLimit: "1Gi"
  cache:
    provider: redis
    url: redis://redis.erpnext.svc:6379
    keyPrefix: accounting          # app-scoped; finalizer cleans only this prefix on delete
    enableBytecodeCache: true      # NODE_COMPILE_CACHE on a PVC → sub-second cold starts
  secrets:
    envMap:
      DATABASE_URL:                # points at the PgBouncer service, NOT the raw primary
        secretName: accounting-pooler-app   # e.g. a CloudNativePG pooler Secret
        secretKey: uri
      PAYLOAD_SECRET:
        secretName: accounting-payload
        secretKey: payload-secret
      KAFKA_BROKERS:               # erpnext-ts's own KafkaEventBus connects with this
        secretName: erpnext-kafka
        secretKey: brokers
  security:
    networkPolicy: true            # default-on L3/L4 isolation
```

An `apps/main`-style proxy (the `README-MULTI-ZONE.md` pattern — a Next.js app you write, not a
shipped artifact) is the 22nd `NextApp` (same shape, minimal `secrets`), whose Next `rewrites()`
route `/<zone>` and `/<zone>-static` to each zone's in-cluster Knative URL. **No route field on the
CR is needed for this to work today.**

---

## Reconciliation with knext's roadmap — conflicts called out

| erpnext-ts ask | knext stance | Conflict? | Resolution |
|----------------|-------------|-----------|------------|
| Provision a Postgres DB per zone | knext is not a PaaS; DB is CNPG's job | **Yes (scope)** | knext injects the Secret only; document binding (E2) |
| Provision a Kafka broker | broker is Strimzi/managed; operator Kafka is ISR-only | **Yes (scope)** | inject creds; app runs its own bus (E6) |
| CR-native multi-zone routing primitive | zones stay app-level until after Tier-A | **Yes (sequencing)** | keep app-level now; design spike deferred (E5) |
| Drain DB on shutdown / sizing guide | reliability + graceful-shutdown is Tier-A | No | **do now** (E1) |
| Reference CR + DB-binding doc | Track-P docs / DX | No | do now (E2) |
| Fleet deploy ergonomics | DX, Tier-B | No | enhancement (E3) |
| Distroless app image | security.md hardening, Tier-B | No | enhancement (E4) |
| Ingress rate/payload limits | security.md runtime hardening, Tier-B | No | enhancement (E7) |

**Sequencing recommendation.** Do **E1** (DB-under-scale-to-zero drain + sizing) and **E2**
(reference CR + binding doc) first — they are Tier-A-aligned reliability/DX and unblock erpnext-ts
immediately without any scope drift. **E6** (eventing clarification) is cheap and prevents a wrong
turn. **E3/E4/E7** are Tier-B hardening/ergonomics. **E5** (CR-native routing) is explicitly
**deferred** — building it now would violate the zones-after-Tier-A rule.

---

## What erpnext-ts should change on its side to fit knext better

1. **Adopt a shared transaction-mode pooler (PgBouncer/CNPG pooler) and small per-instance pools
   (`max: 2–5`).** This is the single highest-leverage change; it makes scale-to-zero safe (Req 4).
   Point `DATABASE_URL` at the pooler service, not the Postgres primary.
2. **Register a DB-pool drain** in each zone's shutdown so `pool.end()` runs inside knext's
   25s grace window, and ensure submit/GL transactions are commit-or-rollback safe on SIGTERM
   (ERP immutability/consistency).
3. **Externalize Payload media to the GCS/S3 adapter**, not pod-local disk or the DB. knext already
   namespaces object storage per app (ADR-0008); Payload uploads should target the object store so
   media survives scale-to-zero and pod churn.
4. **Run your own Kafka producers/consumers** (`@erpnext-ts/events`) against a cluster Kafka, with
   broker creds injected via `secrets.envMap` — do **not** wait for a knext domain-event bus.
   Keep idempotent, transactional consumers (processed-event mark in the same DB txn as the effect).
5. **Tune per-zone scaling**: write-heavy zones (accounting/GL) → lower `maxScale`, higher
   `containerConcurrency`; read-heavy zones → the inverse. Bound `maxScale × pool_max` under the
   pooler's client limit.
6. **Enable `cache.enableBytecodeCache: true`** on every zone to amortize the 22-app cold-start tax.

---

## Bottom line

erpnext-ts is a *good* fit for knext precisely because it is already proper SCS. Of the eight
requirements, **three are supported today** (Node runtime, IaC CR, secret injection), **three are
documentation/ergonomics** (routing app-level, fleet deploy, eventing clarification), and **one is
the real engineering item** (DB connections under scale-to-zero — and even that is mostly a drain
contract + a sizing guide, not a new subsystem). The two things erpnext-ts most wants knext to *be*
— a database provisioner and a message-broker provisioner — are exactly the two things knext has
deliberately decided **not** to be. knext binds the secrets; the cluster brings the infra. That
boundary holds, and erpnext-ts ships on it.
