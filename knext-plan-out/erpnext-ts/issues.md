# Proposed knext issues — closing the erpnext-ts substrate gaps

> Seven ready-to-open issues, sequenced. Each is independently shippable, has testable acceptance
> criteria, names real components/paths, and flags architecture tradeoffs. They reconcile with
> knext's roadmap: **E1–E2 first** (Tier-A-aligned reliability + DX, no scope drift), **E6** cheap
> clarification, **E3/E4/E7** Tier-B hardening/ergonomics, **E5 deferred** (conflicts with
> zones-after-Tier-A). Two erpnext-ts asks — provisioning a database and provisioning a Kafka
> broker — are intentionally **not** proposed as knext work; see assessment.md "out-of-scope".
>
> Labels reuse the live taxonomy: `tier-A`, `tier-B`, `tier-C`, `track-P`, `security`,
> `enhancement`, `documentation`, `spike`.

---

## E1 — Database-connection lifecycle under scale-to-zero: SIGTERM pool drain + a published sizing model

**Labels:** `tier-A`, `enhancement` · **Milestone:** Tier A — correctness

### Context
knext's headline is scale-to-zero. A downstream app that holds a PostgreSQL connection pool per
instance (e.g. any Payload v3 / Prisma / `pg` app) hits two problems knext does not currently
address: (1) on scale-up, pool-per-instance multiplies into a **connection storm** against Postgres;
(2) on scale-down (SIGTERM), the pool is **never drained**, so in-flight transactions can be cut off.
This is the single biggest blocker for stateful Next.js apps adopting knext.

### Problem
- `getDbPool()` (`packages/lib/src/clients.ts`) constructs a bare `pg.Pool` from `DATABASE_URL`
  with no `max`, no idle timeout, and **no `pool.end()` anywhere**.
- The graceful-shutdown path (`packages/kn-next/src/adapters/shutdown.ts`, hard-capped by
  `SHUTDOWN_GRACE_MS` — default `25_000` ms, set in `packages/kn-next/src/adapters/node-server.ts:30`)
  forwards SIGTERM to the Next child and drains HTTP + Next.js `after()` callbacks, but has **no
  database-drain step**.
- Autoscaler defaults (`containerConcurrency: 100`, `maxScale: 10`;
  `packages/kn-next-operator/internal/controller/reconcile_output_test.go:138`) mean one zone can
  open up to `maxScale × pool_max` backend connections; there is **no documented bounding model**.

### Proposed change
1. **Add a DB-drain step to the shutdown contract.** Extend `shutdown.ts` so that, on SIGTERM, after
   HTTP drain begins, any registered pool-drain hook (`getDbPool().end()` or an app-provided
   callback) runs and is awaited *within* the existing grace window — and verify the window stays
   below the pod's `terminationGracePeriodSeconds`. The drain must let in-flight transactions
   commit-or-rollback before the pool closes (correctness for ledger/GL-style writes).
2. **Give `getDbPool()` scale-to-zero-sane defaults** (small `max`, finite idle timeout) and make
   them overridable by env, with the rationale documented inline.
3. **Publish the sizing model** as a first-class doc (`docs/operator/postgres-scale-to-zero.md`):
   small per-instance pool (`max: 2–5`); a transaction-mode pooler (PgBouncer / CNPG pooler / RDS
   Proxy) between app and Postgres as **cluster-provided infra (not knext)**; and the bounding rule
   `peak_clients ≈ scaling.maxScale × pool_max ≤ pooler_client_limit`, tuned via the existing
   `spec.scaling.maxScale` / `spec.scaling.containerConcurrency` CR fields.

### Acceptance criteria
- A unit test in `packages/kn-next/src/__tests__/shutdown.test.ts` asserts that on SIGTERM a
  registered DB-drain hook is invoked and awaited before process exit, and that exit still respects
  the grace cap.
- `getDbPool()` sets a bounded default `max` and idle timeout; a test asserts the defaults and that
  env overrides win.
- `docs/operator/postgres-scale-to-zero.md` exists and states: per-instance pool sizing, the pooler
  recommendation (explicitly marked cluster-infra, not knext-provisioned), and the
  `maxScale × pool_max` bounding rule with a worked example.
- No change to the `NextApp` CRD schema (the knobs already exist) — verified by diffing
  `nextapp_types.go`.

### Components & files touched
`packages/kn-next/src/adapters/shutdown.ts`, `packages/lib/src/clients.ts`,
`packages/kn-next/src/__tests__/shutdown.test.ts`, new `docs/operator/postgres-scale-to-zero.md`.

### Architecture notes & risks
- **On-strategy:** this adds *guidance + a small drain contract*, **not** a managed pooler or a
  database — staying inside "narrow adapter, not a PaaS" (`CLAUDE.md` §1).
- Risk: the drain hook must not deadlock the grace window; cap the awaited drain and fall through to
  forced exit on timeout (mirror the existing HTTP-drain cap).
- Builds on the merged graceful-shutdown work (#44); does not touch the operator.

---

## E2 — Reference: deploy a Postgres-backed SCS zone (the minimal NextApp CR + Secret binding)

**Labels:** `track-P`, `documentation` · **Milestone:** Track P — promotion

### Context
knext deliberately does **not** provision databases — a zone binds its own Postgres via a
Kubernetes Secret (`.claude/rules/scs-zones.md`; ADR-0001 defers infra manifests as
operator-external). Downstream teams (e.g. a Payload v3 ERP) need a single authoritative example of
how to wire `DATABASE_URL` + app secrets into a `NextApp` and route multiple zones — otherwise they
assume the feature is missing.

### Problem
There is no end-to-end doc showing: the minimal `NextApp` CR for a Node/Postgres zone; binding a
CloudNativePG-generated Secret into `DATABASE_URL` via `spec.secrets.envMap`; and composing N zones
behind an `apps/main`-style rewrites proxy. `README-MULTI-ZONE.md` covers routing but not the CR or
the DB/secret binding.

### Proposed change
Add `docs/guides/postgres-scs-zone.md` that documents, with copy-pasteable YAML grounded in real
`nextapp_types.go` fields:
- The minimal `NextApp` CR for a `runtime: node` zone (image digest-pinned, scaling bounds,
  `healthCheckPath`, `cache.enableBytecodeCache`, `security.networkPolicy`).
- Binding `DATABASE_URL` and `PAYLOAD_SECRET` (or any app secret) via `spec.secrets.envMap`
  (`{secretName, secretKey}`) and `spec.secrets.envFrom`, pointed at a CloudNativePG **pooler**
  Secret (cross-link E1).
- Composing zones: each zone = one CR; an `apps/main`-style rewrites proxy (the
  `README-MULTI-ZONE.md` pattern — a Next.js app the team writes, not a checked-in app) = one more
  CR whose Next `rewrites()` target the zones' in-cluster URLs; `ASSET_PREFIX` per zone.
- A note on readiness tuning for slow framework cold starts (the default readiness
  `initialDelaySeconds: 2` may need raising for a heavy app boot).

### Acceptance criteria
- `docs/guides/postgres-scs-zone.md` exists; every CR field used appears in `nextapp_types.go`
  (no invented fields) — reviewer verifies field-by-field.
- The doc explicitly states knext does not provision the database and links the CNPG pattern.
- The multi-zone section shows the `apps/main` rewrites approach and notes there is no CR route
  field today (cross-link E5).
- Passes the `docs-guard` accuracy pass (no unverifiable claims; samples reference real env vars).

### Components & files touched
New `docs/guides/postgres-scs-zone.md`; cross-links to `README-MULTI-ZONE.md`,
`docs/operator/postgres-scale-to-zero.md` (E1).

### Architecture notes & risks
Pure documentation; no code risk. Keeps the user-facing framing that the cluster owns stateful infra.
Must avoid internal jargon/issue numbers per the docs-are-user-facing rule.

---

## E6 — Clarify: the operator's Kafka is ISR-revalidation-only; document the app-level domain-event bus pattern

**Labels:** `tier-B`, `documentation` · **Milestone:** Tier B — platform

### Context
The `NextApp` CR exposes `spec.revalidation{queue: kafka, kafkaBrokerUrl, provisionKafkaSource}` and
the operator provisions a `KafkaSource` for it. A downstream SCS app will reasonably mistake this for
a **general cross-zone domain-event bus** and try to route business events (invoices, stock moves)
through it. It is not that: it is scoped to ISR cache revalidation, the consumer is unbuilt and
gated-off (ADR-0016, #95), and there is no `KafkaEventBus` transport in the repo.

### Problem
No doc draws the line between (a) knext's ISR-revalidation Kafka plumbing and (b) an application's own
domain-event bus. erpnext-ts integrates zones via async domain events (`@erpnext-ts/events`) with
idempotent transactional consumers — that is **app-level + cluster Kafka**, per
`.claude/rules/scs-zones.md`, not a knext primitive.

### Proposed change
Add `docs/operator/eventing-scope.md` stating plainly:
- `spec.revalidation.kafka` exists **only** for ISR/data-cache revalidation; it is not a
  domain-event bus and the consumer is opt-in/deferred.
- Cross-zone domain events are an **application concern**: run your own producers/consumers
  (KafkaJS) against a **cluster Kafka (Strimzi) or managed Kafka**; knext injects broker
  credentials via `spec.secrets.envMap` (`KAFKA_BROKERS`), nothing more.
- The idempotent-consumer contract (mark processed-event in the **same DB transaction** as the
  effect) is the app's responsibility; knext does not provide exactly-once.

### Acceptance criteria
- `docs/operator/eventing-scope.md` exists and explicitly distinguishes ISR-revalidation Kafka from
  an app domain-event bus.
- It shows the `secrets.envMap` broker-credential injection (real CR field) and states no broker is
  knext-provisioned.
- Cross-linked from `README-MULTI-ZONE.md` and the existing Kafka revalidation doc.

### Components & files touched
New `docs/operator/eventing-scope.md`; cross-link `docs/operator/kafka-eventing.md`,
`.claude/rules/scs-zones.md`.

### Architecture notes & risks
Documentation only. Prevents a real architectural wrong-turn (routing business events through an
ISR-scoped, unbuilt path). Reaffirms the SCS rule that eventing stays app-level until the framework
absorbs it post-Tier-A.

---

## E3 — Fleet deploy: drive `kn-next deploy` across a workspace of N apps

**Labels:** `tier-B`, `enhancement` · **Milestone:** Tier B — platform

### Context
The CLI is single-app: `kn-next build` / `kn-next deploy` load exactly one `kn-next.config.ts` from
the current directory (`packages/kn-next/src/cli/shared.ts:23`). A monorepo with many zones (an ERP
suite has ~22) must invoke the CLI once per app. That is scriptable, but there is no first-class,
discoverable way to deploy a fleet, and per-app digest/state handling is left to each caller.

### Problem
No workspace/matrix support: no discovery of `apps/*/kn-next.config.ts`, no `--config <path>` to
point at a non-cwd config, no aggregate summary of which zones deployed at which digest.

### Proposed change
Add fleet ergonomics to the CLI (smallest viable first):
- A `--config <path>` flag so one invocation can target any app's config (not just `cwd`).
- A `kn-next deploy --all [--filter <glob>]` that discovers `apps/*/kn-next.config.ts`, deploys each
  (reusing the existing single-app path + digest pinning + CR emission), and prints a per-app
  summary (name → image digest → applied/failed). Sequential is acceptable for v1; note concurrency
  as a follow-up.

### Acceptance criteria
- `kn-next deploy --config apps/accounting/kn-next.config.ts` deploys that app without `cd`.
- `kn-next deploy --all` discovers and deploys every `apps/*/kn-next.config.ts`, emitting one
  `NextApp` CR per app and a summary table; a unit test covers discovery + per-app CR emission with
  a mocked apply.
- Each emitted CR is still digest-pinned (existing `validateCRImageRef` path;
  `cli/cr-builder.ts:301`) — a test asserts a non-pinned ref still fails per app.
- Single-app `kn-next deploy` behavior is unchanged (regression test).

### Components & files touched
`packages/kn-next/src/cli/deploy.ts`, `packages/kn-next/src/cli/shared.ts`,
`packages/kn-next/src/cli/build.ts`, new tests under `packages/kn-next/src/__tests__/`.

### Architecture notes & risks
- Stays within ADR-0001 (still emits CRs, never raw manifests).
- Risk: partial-fleet failure semantics — define whether `--all` is fail-fast or
  continue-and-report (recommend continue-and-report with non-zero exit if any failed).
- Pure CLI ergonomics; no operator/CRD change.

---

## E4 — Distroless, non-root runtime image for app pods

**Labels:** `tier-B`, `security` · **Milestone:** Tier B — platform

### Context
`security.md` requires a distroless, non-root runtime. The operator image already is
(`gcr.io/distroless/static:nonroot`), but the **app** runtime example
(`apps/file-manager/Dockerfile`) is `node:22-alpine` — non-root, but not distroless, so it carries a
shell and a larger CVE surface. A fleet of 22 ERP zones multiplies that surface.

### Problem
No knext-provided distroless **Node** base/Dockerfile for the standalone server; downstream apps copy
the alpine example and inherit a shell + extra packages.

### Proposed change
Provide a distroless, non-root reference Dockerfile (and/or a published base image) for the
standalone Node server (`gcr.io/distroless/nodejs22-debian12:nonroot` or equivalent), preserving the
`NODE_COMPILE_CACHE` CMD wiring and the metrics sidecar startup. Update the example app to use it and
document the migration.

### Acceptance criteria
- A distroless Dockerfile exists for the app runtime and boots the standalone server (`server.js`)
  as non-root with `NODE_COMPILE_CACHE` honored.
- The example app builds and passes its existing container/e2e checks on the distroless base.
- A Trivy/Grype scan of the new image shows no shell and a reduced HIGH/CRITICAL count vs the alpine
  baseline (cross-links the supply-chain scan gate).

### Components & files touched
`apps/file-manager/Dockerfile` (and/or a new `packages/kn-next/templates/Dockerfile.distroless`),
CI scan workflow reference.

### Architecture notes & risks
- Distroless has no shell — confirm the metrics sidecar and any entrypoint logic don't rely on `sh`
  (the current CMD uses `sh -c`; may need an exec-form entrypoint or a tiny launcher).
- Directly advances the supply-chain security milestone (`security.md`).

---

## E7 — Ingress-level rate limiting + request-payload-size limits

**Labels:** `tier-B`, `security` · **Milestone:** Tier B — platform

### Context
`security.md` (Runtime hardening) calls for a reverse proxy in front for rate limiting,
payload-size limits, and malformed-request handling. For an ERP, unbounded request bodies and
unthrottled endpoints are integrity/DoS risks. No such control exists in core today.

### Problem
There is no knext-managed rate-limit or max-body configuration. Knative's ingress (Kourier/Envoy)
can enforce both, but knext neither sets defaults nor exposes a knob.

### Proposed change
Provide ingress-level limits as a documented, operator-reconcilable control:
- A bounded default request-body size and a basic rate-limit policy at the Kourier/Envoy layer,
  reconciled by the operator (consistent with the ADR-0009 pattern of operator-managed
  `config-network`), **or**, if that is too broad for one issue, ship it first as a documented
  cluster recipe and open a follow-up to promote it into the operator.
- A note on per-zone overrides (write-zones may want stricter limits than read-zones).

### Acceptance criteria
- A request exceeding the configured max body size is rejected at ingress before reaching the pod
  (demonstrated in a kind/e2e check or documented manual verification).
- The rate-limit and max-body settings are documented with their defaults and how to override per
  zone.
- If reconciled by the operator: a controller test asserts the config object is created/updated;
  if doc-only for v1: the follow-up promotion issue is filed.

### Components & files touched
Operator networking config (alongside the ADR-0009 `config-network` handling) **or** a new
`docs/operator/ingress-limits.md`; e2e under the operator suite.

### Architecture notes & risks
- **Scope guard:** keep this to ingress-layer limits (Kourier/Envoy), not a bespoke WAF — a full WAF
  is Tier-C and upstream-gated (`CLAUDE.md` §8). Flag if the issue grows beyond rate/body limits.
- Interacts with scale-from-zero: ensure the activator path is not rate-limited to death on cold
  start (exempt or tune the limit for the activator).

---

## E5 — [DEFERRED — flagged conflict] Design spike: CR-native multi-zone routing

**Labels:** `tier-C`, `spike` · **Milestone:** (none — deferred)

### Context
erpnext-ts asks knext to "deploy N zone apps behind one gateway and route by path prefix." Today this
is an **app-level** Next.js `rewrites()` pattern in an `apps/main` proxy (`README-MULTI-ZONE.md`);
there is no route/path-prefix field on the `NextApp` CR and no operator-managed gateway (and
`apps/main` itself is a documented pattern, not a checked-in app).

### Why this is deferred, not proposed for now
Promoting routing into the operator/CR is **zone-into-core** work, which knext's roadmap explicitly
sequences **after Tier-A correctness** (`.claude/rules/scs-zones.md`, `ROADMAP.md`). Building it now
would contradict the stated sequencing. It is also **not required for erpnext-ts to ship**: the
`apps/main` rewrites proxy already composes the 22 zones today (see assessment.md "Req 1" and the
reference CR in E2).

### Proposed change (when unblocked, post-Tier-A)
A time-boxed design spike (ADR) weighing: a `spec.routing`/`spec.basePath` field on `NextApp` with
the operator reconciling a Knative/`HTTPRoute`/Ingress rule, **vs** keeping routing as a generated
`apps/main` template. Output is an ADR recommending one path — **no implementation** in the spike.

### Acceptance criteria
- An ADR in `docs/adr/` comparing CR-native routing vs the app-level proxy, with a recommendation
  and a sequencing note (post-Tier-A).
- No CRD or operator code change as part of the spike.

### Components & files touched
New `docs/adr/00NN-multi-zone-routing.md` only.

### Architecture notes & risks
Filed now purely to record the deferral and prevent re-proposal. **Do not start until Tier-A exit
criteria are met.** Surfacing it keeps the conflict explicit for the maintainer rather than silently
expanding scope.

---

## Sequencing summary

1. **E1** (Tier-A) — DB drain + sizing model. *The make-or-break; do first.*
2. **E2** (Track-P) — reference CR + Secret-binding guide. *Unblocks erpnext-ts authoring.*
3. **E6** (Tier-B) — eventing-scope clarification. *Cheap; prevents a wrong turn.*
4. **E3** (Tier-B) — fleet deploy ergonomics.
5. **E4** (Tier-B) — distroless app image.
6. **E7** (Tier-B) — ingress rate/payload limits.
7. **E5** (Tier-C/spike) — **deferred** CR-native routing (post-Tier-A).

**Not proposed (deliberate scope holds):** knext provisioning a per-zone database, and knext
provisioning a Kafka broker. Both remain cluster-infra (CloudNativePG / Strimzi); knext injects the
Secret. Building either into knext would breach "narrow Next.js+Knative adapter, not a PaaS."
