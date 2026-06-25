# Proposed knext issues — package deployment + Postgres-per-SCS + cross-zone table-copy fabric

> Eight ready-to-open issues. **PK1–PK4** make knext installable by an outside client (Track P,
> sanctioned, do-now). **PG2** is a per-SCS Postgres provisioning + scaling recipe; **PG1a/PG1b/PG1c**
> are the design→build track for the cross-zone table-copy fabric (RisingWave). Each issue is
> independently shippable, has testable acceptance criteria, names real components/paths, and flags
> tradeoffs. Two things are deliberately
> **not** re-proposed: npm scope-resolution + the publish itself (existing **#53**), and the
> DB-drain/sizing + CNPG reference CR (prior drafts **E1/E2** in
> `knext-plan-out/erpnext-ts/issues.md`). Labels reuse the live taxonomy: `track-P`, `tier-A`,
> `tier-B`, `tier-C`, `security`, `enhancement`, `documentation`, `spike`.

---

## PK1 — Fix `@knext/core` publish entrypoints (ship compiled JS, not raw TypeScript)

**Labels:** `track-P`, `bug` · **Milestone:** Track P — promotion

### Context
knext is preparing its first npm release of the `@knext/*` packages so outside engineers can
`npm i @knext/core` and `npx kn-next`. The CLI is already Node-compatible (issue #68 closed, PR #71
merged) and the release workflow exists. But the package manifest still advertises raw TypeScript as
its library entrypoints, which breaks any consumer importing the package on plain Node.

### Problem
**Every `@knext/core` export subpath points at raw TypeScript, not just `main`.**
`packages/kn-next/package.json` sets `main`/`types` to `./src/config.ts` (lines 6–7) **and** every
`exports` subpath to a `./src/*.ts` file: `.` → `src/config.ts`, `./adapter` →
`src/adapters/next-adapter.ts`, `./adapters/node-server`, `./adapters/cache-handler`,
`./adapters/otel-config`, `./loader`, `./utils/logger`, `./cli/validate`, `./cli/shared`. `tsup`
currently bundles only the **CLI** entries (deploy/build/cleanup/…), so these **library** subpaths
have no `dist` output at all. `files` also ships `src` (lines 33–35).

This is the **application runtime surface** an app actually imports — confirmed in the example app:
`@knext/core/adapters/otel-config` (`apps/file-manager/src/instrumentation.ts:1`) and the
`KnativeNextConfig` type from `@knext/core` (`apps/file-manager/kn-next.config.ts:1`). On plain Node,
post-publish, every one of those imports resolves to a `.ts` file Node cannot load. The CLI works in
isolation; the **library/adapter surface is broken for clients**.

(`@knext/lib` is the healthy half — its exports `.`/`./logger`/`./clients`/`./health` already point
at `dist/`, and the app imports `getDbPool`/`getMinioClient`/`checkDeepHealth` from it — but verify
its runtime deps `pg`/`ioredis`/`minio`/`@cerbos/grpc`/`pino` are declared as install deps.)

### Proposed change
- **Add the library subpaths to the `tsup` build** (adapter, node-server, cache-handler, otel-config,
  loader, utils/logger, config) so each has a real `dist` JS **and** `.d.ts` output.
- Repoint `main`, `module`, `types`, and **every** `exports` subpath at the compiled `dist/*`
  outputs; keep `bin` as-is.
- `./adapters/cache-handler` is a `.js` today — ensure it lands in `dist` and resolves.
- Trim `files` to ship `dist` (+ license/readme) only, unless `src` is kept for source maps (justify
  in a comment).
- Verify `@knext/lib` resolves all 4 subpaths and declares its runtime deps.

### Acceptance criteria
- No `@knext/core` `main`/`types`/`exports` entry references `./src/*.ts`; all point at `dist/*`.
- `npm pack` produces a tarball where **every** `exports` subpath resolves to a file present in the
  tarball (a script loads each subpath and asserts success).
- On a clean Node install of the packed tarball, **both** of these succeed (no `.ts` resolution):
  `import('@knext/core')` (config types) **and** `import('@knext/core/adapter')` /
  `import('@knext/core/adapters/otel-config')`.
- Existing CLI behavior unchanged (`kn-next --help` runs from `dist/cli/kn-next.js`).

### Components & files touched
`packages/kn-next/package.json`, `packages/kn-next/tsup.config.ts` (add library entries +
`.d.ts` emission), `packages/lib/package.json` (verify deps/exports).

### Architecture notes & risks
- Packaging correctness; no runtime logic changes — but it is **broader than `main`/`types`**: the
  whole adapter/config/otel library surface must be built, or apps can't import knext post-publish.
- Risk: an exports subpath without a matching compiled output 404s at install — PK2's app-import
  smoke test is the guard.
- Must land **before** the first publish (#53), or clients get a broken import surface.
- The *contract* of that surface (what's public/stable vs internal) is **PK5** — this issue makes it
  resolvable; PK5 makes it intentional.

---

## PK2 — CI smoke test: install the packed tarballs on a clean machine and exercise BOTH the CLI and an app import

**Labels:** `track-P`, `tier-A`, `enhancement` · **Milestone:** Track P — promotion

### Context
The release pipeline (`.github/workflows/release.yml`, changesets) is ready but has never been
exercised as an **outside consumer** would experience it: a fresh machine with plain Node, no pnpm
workspace, no Bun, installing knext from a tarball. A consumer experiences knext **two ways** — they
run the `kn-next` CLI **and** they `import` the runtime/adapter surface into their app
(`@knext/core/adapter`, `@knext/core/adapters/otel-config`, the `KnativeNextConfig` type,
`@knext/lib/clients`, `@knext/lib/health` — all confirmed in `apps/file-manager`). Publishing without
proving **both** risks shipping a package that runs as a CLI but breaks when an app imports it.

### Problem
There is no CI job that packs `@knext/core` (+ `@knext/lib`), installs the tarballs **outside the
workspace** on plain `npm`/Node, and verifies (a) the CLI runs **and** (b) a minimal app can import
the public library/adapter surface. Workspace resolution (`@knext/lib` is `workspace:*`, package.json
line 68) and the in-repo bundler mask the raw-`.ts` export problem (PK1) until after publish.

### Proposed change
Add a CI job (`install-smoke.yml`) that, in a clean temp dir (no workspace, no Bun on PATH, project
Node version):
1. Builds + `npm pack`s `@knext/lib` and `@knext/core`; installs `@knext/core` with the `@knext/lib`
   tarball resolved locally as its dependency.
2. **CLI check:** runs `npx kn-next --help` and `npx kn-next` against a fixture `kn-next.config.ts`
   through the `validate` path; asserts zero exit + expected output.
3. **App-import check (new):** a tiny script `import`s the public app surface on plain Node —
   `KnativeNextConfig` from `@knext/core`, the adapter from `@knext/core/adapter`,
   `resolveOtelOptions` from `@knext/core/adapters/otel-config`, and `getDbPool`/`checkDeepHealth`
   from `@knext/lib/clients`/`@knext/lib/health` — and asserts each resolves to real JS (no `.ts`).
4. Asserts every published `exports` subpath + `bin` resolves (ties to PK1).

### Acceptance criteria
- A CI job runs on PRs and fails if either the packed CLI cannot run **or** the app-import script
  cannot resolve the public surface, on plain Node outside the workspace.
- The job uses `npm` (not pnpm/bun) and has no `bun` on PATH.
- A deliberately broken `exports` path (fixture) makes the job fail (proves the guard).
- Job runtime is bounded (single-OS, latest LTS Node for v1; note multi-Node as a follow-up).

### Components & files touched
New CI workflow/job; minimal fixture config + an app-import probe script under `packages/kn-next/`
test fixtures.

### Architecture notes & risks
- This is the gate that makes the first publish safe; pair it with PK1 (it catches PK1 regressions)
  and informs PK5 (it exercises exactly the surface PK5 declares public).
- Risk: `workspace:*` deps must be packed/resolved locally, not pulled from the registry (empty).
- Single-OS/Node keeps it cheap; flag the matrix expansion as later hardening.

---

## PK3 — Bootstrap and verify the operator install bundle end-to-end (real signed digest)

**Labels:** `track-P`, `tier-B`, `security` · **Milestone:** Track P — promotion

### Context
A client installs knext in two halves: the npm CLI (PK1/PK2) **and** the Kubernetes operator that
reconciles `NextApp` CRs. The operator supply-chain workflow exists (issue #76 closed, PR #88
merged): it builds, SBOMs, Trivy-scans, cosign-signs the image and regenerates
`packages/kn-next-operator/dist/install.yaml` with the real digest on push to main. But it has never
been bootstrapped — the bundle still ships a placeholder.

### Problem
`packages/kn-next-operator/dist/install.yaml` and `config/manager/kustomization.yaml` carry an
**all-zeros placeholder digest** (`ghcr.io/getknext-dev/kn-next-operator:v0.1.0@sha256:0000…0000`),
and the operator image is **not published** at `ghcr.io/getknext-dev/kn-next-operator`. No one has
confirmed that `kubectl apply -f dist/install.yaml` on a clean cluster pulls a real, signed,
digest-pinned image and the operator becomes Ready. (This also closes the `controller:latest`
placeholder noted in `security.md`.)

### Proposed change
- Run the supply-chain workflow to publish the first operator image and replace the placeholder
  digest in `dist/install.yaml` + `kustomization.yaml` with the real `@sha256:` value.
- Add an end-to-end verification (extend the existing kind/e2e job or add one): on a clean kind
  cluster, `kubectl apply -f dist/install.yaml`, wait for the operator Deployment to be Available,
  apply a sample digit-pinned `NextApp`, and assert it reconciles to a Ready Knative Service.
- Verify the image signature (`cosign verify`) and that the bundle contains **no** `:latest` or
  all-zeros digest (a grep guard in CI).

### Acceptance criteria
- `dist/install.yaml` references a real, published, digest-pinned operator image (no `0000…`,
  no `:latest`); a CI check fails if either reappears.
- `cosign verify` succeeds against the published operator image digest.
- A clean-cluster e2e applies the bundle, the operator goes Available, and a sample `NextApp`
  reconciles to Ready — demonstrated in CI or a documented, reproducible run.

### Components & files touched
`.github/workflows/operator-supply-chain.yml` (run/verify), `packages/kn-next-operator/dist/install.yaml`,
`packages/kn-next-operator/config/manager/kustomization.yaml`, operator e2e suite.

### Architecture notes & risks
- Directly advances the supply-chain security milestone (SBOM + scan + sign + digest pin) in
  `security.md`.
- Risk: first GHCR publish needs org package-write permissions + cosign OIDC — confirm the workflow's
  `packages: write` / `id-token: write` are honored in the org (a founder/CI-config gate).
- On the sanctioned path (ADR-0001): the bundle is how the single-source-of-truth operator is
  installed; nothing here mutates cluster state out-of-band.

---

## PK4 — Outside-user quickstart: install knext and deploy a first app

**Labels:** `track-P`, `documentation` · **Milestone:** Track P — promotion

### Context
Once PK1–PK3 land, a client can install both halves of knext — but there is no single page that walks
an external engineer from zero to a deployed app. Adoption (the point of Track P) needs that path to
be obvious and verified.

### Problem
No end-to-end "getting started for outside users" doc exists that covers: install the operator bundle,
install the CLI (`npm i -g @knext/core` or `npx kn-next`), author a `kn-next.config.ts`, build + push
an image, and `kn-next deploy` so the operator reconciles a scale-to-zero Knative Service. The
existing docs assume an in-repo developer.

### Proposed change
Add a user-facing quickstart (in the docs site / `docs/`) that, using **only published artifacts**,
walks through: prerequisites (a cluster with Knative + the operator bundle), CLI install, a minimal
config, `kn-next build` + `kn-next deploy`, and verifying the app scales to zero and back. Keep it
free of internal references (ADR numbers, issue numbers, strategy jargon) per the docs-are-user-facing
rule.

### Acceptance criteria
- A quickstart page exists and references only published package/image names (no `workspace:*`, no
  placeholder digests).
- Every command is copy-pasteable and every flag/config key used is real (verified against the CLI
  and `nextapp_types.go`); passes a `docs-guard` accuracy pass.
- A reviewer following it on a clean environment reaches a deployed, scale-to-zero app.

### Components & files touched
New quickstart page in the docs site (or `docs/`); cross-links to the config reference and the
operator bundle.

### Architecture notes & risks
- Pure docs; gated on PK1–PK3 actually being published (don't document an unpublished package).
- Must stay user-facing — no internal jargon.

---

## PK5 — Define and document the public application API surface (what a client app may import), with a stability contract

**Labels:** `track-P`, `documentation` · **Milestone:** Track P — promotion

### Context
A knext-deployed app does not only *run* the CLI — it **imports knext at runtime**. The example app
imports `getDbPool`/`getMinioClient` (`@knext/lib/clients`), `checkDeepHealth` (`@knext/lib/health`),
`resolveOtelOptions` (`@knext/core/adapters/otel-config`), the adapter (`@knext/core/adapter`), and
the `KnativeNextConfig` type (`@knext/core`). Once published, every one of those imports is a public
API a client depends on — but knext has **never declared which of its many `exports` subpaths are
supported for application use versus internal**, nor a versioning policy for them. PK1 makes the
surface *resolvable*; PK5 makes it *intentional* and *stable*.

### Problem
`@knext/core` exports 10 subpaths (`.`, `./loader`, `./adapter`, `./adapters/next-adapter`,
`./adapters/node-server`, `./adapters/cache-handler`, `./adapters/otel-config`, `./utils/logger`,
`./cli/validate`, `./cli/shared`) and `@knext/lib` exports 4 — with **no statement** of which are
the supported application surface (e.g. `@knext/core` config types + `./adapter`, `@knext/lib`
`/clients` `/health`) versus internals an app should not import (e.g. `./cli/shared`,
`./adapters/node-server`). Without that line drawn + a semver policy, every internal refactor is a
silent breaking change for clients.

### Proposed change
Using the project's `framework-design` discipline (public-surface + semver + deprecation):
- **Draw the public/internal line:** mark each `exports` subpath of `@knext/core` and `@knext/lib`
  as **public (application-facing)** or **internal**; document the supported import surface
  (config/types, adapter wiring, `getDbPool`, health, logger, otel) in a "Public API" reference.
- **State a stability policy:** the public surface follows semver; breaking changes need a major +
  a deprecation note; internal subpaths carry no guarantee.
- **Make internals discoverable as such** (e.g. an `#internal` import path or a documented prefix),
  so the boundary is visible, not just prose.
- Ensure each **public** subpath has accurate `.d.ts` (ties to PK1) so the typed contract is real.

### Acceptance criteria
- A "Public API" doc lists every supported application import for `@knext/core` and `@knext/lib`,
  with its types, and explicitly names the internal subpaths that are *not* supported.
- Each public subpath named is verified to resolve to real JS + `.d.ts` from the packed tarball
  (overlaps the PK2 app-import probe).
- A written stability/semver policy for the public surface exists (major-for-breaking + deprecation).
- The doc is user-facing (no internal jargon) and passes a `docs-guard` accuracy pass against the
  actual `exports` map.

### Components & files touched
`packages/kn-next/package.json` + `packages/lib/package.json` (public/internal marking), a new
"Public API" reference doc, cross-links to PK1 (build) and PK2 (smoke).

### Architecture notes & risks
- This is a **framework-maturity** step: it converts an accidental export surface into a deliberate,
  versioned contract — the difference between "a client can import it" and "a client can *rely* on it."
- Risk of over-exposing: prefer a **small** public surface (config + adapter + `getDbPool`/health +
  logger); keep server internals (`node-server`, `cli/shared`) internal. Narrow is safer to support.
- Should land with/just after PK1 so the first publish ships an *intentional* surface, not whatever
  happened to be exported.

---

## PG2 — Per-SCS Postgres provisioning + scaling recipe (CloudNativePG, pooler, read replicas)

**Labels:** `tier-B`, `documentation` · **Milestone:** Tier B — platform

### Context
knext's SCS model gives every zone its **own** database (`.claude/rules/scs-zones.md`: no shared DB,
no cross-zone DB reads, enforced by `hooks/protect-zone-data-sovereignty.sh`). knext deliberately does
**not** provision databases — ADR-0001's action items mark Postgres as operator-external. Teams
running many zones (e.g. a 22-app ERP suite) need an authoritative, isolation-correct pattern for
standing up and **scaling** per-zone Postgres under scale-to-zero.

### Problem
There is no single recipe documenting: one **CloudNativePG** `Cluster` per zone, binding its generated
Secret into the zone's `DATABASE_URL` via `spec.secrets.envMap`, a **transaction-mode pooler**
(PgBouncer / CNPG pooler) in front, **read replicas** for read-heavy zones, and how to **bound
connections** under Knative autoscaling. The connection-storm + drain problem is captured in the prior
draft **E1**, and the CNPG→`envMap` binding in **E2**, but there is no end-to-end provisioning +
scaling guide that ties them together with isolation.

### Proposed change
Add `docs/operator/postgres-per-zone.md` (cluster-infra recipe, explicitly *not* knext provisioning):
- **Provision:** one CNPG `Cluster` per zone; bind its `-app`/pooler Secret into `DATABASE_URL`
  (cross-link E2's reference CR).
- **Isolate:** each zone connects to **its own** cluster only; the `protect-zone-data-sovereignty.sh`
  hook + no-shared-DB rule are the guardrail. State plainly that cross-zone data is async-events-only
  (cross-link PG1).
- **Scale:** small per-instance pools (`max: 2–5`), a transaction-mode pooler, read replicas for
  read-heavy zones, and the bounding rule `peak_clients ≈ scaling.maxScale × pool_max ≤ pooler_limit`
  tuned via the existing `spec.scaling.maxScale`/`containerConcurrency` CR fields (cross-link E1 for
  the drain contract).
- A worked example for a write-heavy zone (low `maxScale`, higher `containerConcurrency`) vs a
  read-heavy zone (the inverse + a replica).

### Acceptance criteria
- `docs/operator/postgres-per-zone.md` exists; every CR field cited is real in `nextapp_types.go`;
  every claim about isolation matches `.claude/rules/scs-zones.md` and the hook.
- The doc states explicitly that knext does **not** provision the database and that CNPG/the cluster
  owns it.
- It cross-links E1 (drain/sizing) and E2 (binding) without restating them, and PG1 for cross-zone.
- Passes `docs-guard` (no invented fields, no unverifiable scaling numbers — connection math shown,
  not asserted).

### Components & files touched
New `docs/operator/postgres-per-zone.md`; cross-links `knext-plan-out/erpnext-ts/issues.md` (E1/E2),
`.claude/rules/scs-zones.md`, `hooks/protect-zone-data-sovereignty.sh`.

### Architecture notes & risks
- **Scope honesty (flag):** this is a recipe, not a feature — knext binds the Secret, the cluster
  runs Postgres. Never present knext as provisioning Postgres (`CLAUDE.md` §1/§8).
- **Sequencing (flag):** zone-data work is post-Tier-A per the rules; a *recipe* is fine now,
  promoting it into core is not.

---

## PG1a — ADR + contract: cross-zone table copies (producer-published tables, CDC-fed, consumer-owned copies)

**Labels:** `tier-C`, `documentation` · **Milestone:** (design — post-Tier-A build)

### Context
In SCS, a consuming zone keeps **its own copy** of data it needs from other zones — copying is the
blessed integration pattern; what is forbidden is a **shared DB** or a zone making **live reads** into
another zone's DB. knext provides no infrastructure for these copies today. The decision (recorded in
the draft ADR `knext-plan-out/package-deploy-postgres/adr-draft-cross-zone-table-copies.md`): provide
a **platform-managed table-copy fabric** backed by **RisingWave**, where a producer zone **publishes**
tables (as a stable view contract) and the fabric maintains **read-only copies in each consuming
zone's own Postgres**, fed by **PostgreSQL CDC**. This **amends** `.claude/rules/scs-zones.md`, whose
current wording allows cross-zone data **"only via async Kafka domain events."**

### Problem
Two things must be settled before any code: (1) the **data-sovereignty rule must be amended** to
sanction a platform fabric (today it would read as a violation), and (2) the **zone-facing contract**
(what a producer publishes, how a consumer declares a foreign copy) must be specified so it is stable
and reviewable.

### Proposed change (design only — NO controller/RisingWave wiring in this issue)
1. File the draft ADR as a numbered `docs/adr/` entry: the decision, the SCS reconciliation table, the
   trade-offs, failure modes (replication-slot WAL bloat, schema drift, RisingWave always-on), and
   security (least-privilege replication credential, TLS, NetworkPolicy exception, read-only copies).
2. **Amend `.claude/rules/scs-zones.md`** to add the sanctioned third mechanism: *platform-managed
   table copies* — producer **publishes** only; fabric reads **only published tables** via a
   **dedicated credential**; a zone still **never** connects to another zone's DB; consumers read
   **only their own local copy**.
3. Specify the **contract schemas**: `spec.data.published` on the producer `NextApp` (name + view +
   primaryKey), and a cross-zone `TableCopy` CRD (`data.kn-next.dev/v1alpha1`: source zone/published,
   target zone/table).

### Acceptance criteria
- A numbered ADR exists in `docs/adr/` with the decision, options table, consequences, and action
  items, matching the draft.
- `.claude/rules/scs-zones.md` is amended with the platform-table-copy clause; the wording preserves
  "a zone never connects to another zone's DB" and "reads only its own local copy."
- The `published` contract + `TableCopy` CRD schemas are written out (field-by-field) and reviewed —
  no implementation required.
- The ADR explicitly sequences the build **after Tier-A** and frames the fabric as an **opt-in
  module**, not core.

### Components & files touched
New `docs/adr/00NN-cross-zone-table-copies.md`; edit `.claude/rules/scs-zones.md`; schema sketches for
`spec.data.published` (NextApp) and the `TableCopy` CRD.

### Architecture notes & risks
- **Scope honesty (flag):** this adds a data-replication capability — PaaS-adjacent. Ship opt-in,
  post-Tier-A; never in the core adapter path. Mirrors the opt-in `BackendService` module (ADR-0004).
- **Rule change is significant:** amending a hard sovereignty rule is exactly why this is an ADR, not
  a silent edit. The amendment narrows the blast radius (published tables only, fabric-only access).

---

## PG1b — Build the table-copy fabric controller (opt-in module: TableCopy CRD → RisingWave)

**Labels:** `tier-C`, `enhancement` · **Milestone:** (post-Tier-A; opt-in module)

### Context
With PG1a's ADR + contract approved, build the controller that turns a `TableCopy` declaration into a
live, maintained copy via RisingWave. This is an **opt-in platform module** (installed only when a
team wants cross-zone copies), kept out of the core deploy path per the "narrow adapter, not a PaaS"
positioning.

### Problem
There is no component that reconciles a `TableCopy` CRD into RisingWave's `CREATE SOURCE`
(postgres-cdc on the producer's published table) + optional materialized view + `CREATE SINK` (into
the consumer's Postgres), nor one that tears those down (including the producer's replication slot) on
delete. RisingWave itself is cluster infra (Helm/operator), not knext code.

### Proposed change
- A **fabric controller** (new opt-in module) that, per `TableCopy`: provisions the RisingWave source
  scoped to the producer's **published** table only, an optional transform MV, and a Postgres sink
  writing a **read-only** table into the consumer's DB; reflects copy freshness/lag in status; and on
  delete removes the RisingWave objects **and** drops the producer replication slot.
- Document deploying **RisingWave** as a cluster dependency (its own operator/Helm) — explicitly
  cluster-infra, always-on (note the scale-to-zero tension).
- Reject a `TableCopy` whose `source.published` is not in the producer's `spec.data.published` set
  (enforces producer-published-only).

### Acceptance criteria
- Applying a `TableCopy` for a published table results in a populated, incrementally-updated read-only
  copy in the consumer's Postgres; an integration test on kind demonstrates an insert/update in the
  producer appearing in the consumer copy.
- A `TableCopy` referencing an **unpublished** table is rejected (admission or status `Degraded`).
- Deleting the `TableCopy` removes the RisingWave source/MV/sink **and** drops the producer's
  replication slot (verified — no orphaned slot left holding WAL).
- The module is **not** installed or referenced by the default deploy path; core `kn-next deploy` is
  unchanged (regression check).

### Components & files touched
New fabric-controller module + `TableCopy` CRD types/reconciler; RisingWave deploy docs; kind
integration test.

### Architecture notes & risks
- **Replication-slot WAL bloat** is the top operational risk: a stuck/lagging copy holds a slot and
  blocks WAL cleanup on the producer, risking disk-fill. Slot teardown on delete + lag monitoring
  (PG1c) are mandatory.
- **RisingWave is always-on** — document the persistent-infra cost; it does not scale to zero.
- Stays on the sanctioned path: reconciliation via a CRD + controller (ADR-0001 / ADR-0004 pattern).

---

## PG1c — Security + operability for the table-copy fabric (credentials, NetworkPolicy, slot/lag monitoring)

**Labels:** `tier-C`, `security` · **Milestone:** (post-Tier-A; opt-in module)

### Context
The fabric is the **only** component permitted to reach across zones, so its credentials, network
paths, and failure monitoring are security- and integrity-critical for an SCS platform.

### Problem
PG1b wires the data path; this issue hardens it. Without it, the fabric could use over-privileged
credentials, breach the default-on zone `NetworkPolicy` implicitly, or silently let a stuck slot fill
a producer's disk.

### Proposed change
- **Least-privilege replication credentials:** a dedicated DB role per producer (REPLICATION + SELECT
  on the **published views only**, never the app role), in a K8s Secret, injected into the fabric;
  CDC connection over TLS (`ssl.mode=verify-full`).
- **NetworkPolicy:** the fabric is an **explicit named exception** to the default-on zone isolation —
  allow fabric→producer-Postgres and fabric→consumer-Postgres only; everything else stays denied.
- **Read-only copies:** grant the consumer app `SELECT`-only on `_copy_*` tables; the app must never
  write them.
- **Monitoring:** export replication-slot lag + copy freshness; alert on a slot exceeding a WAL/age
  threshold (the disk-fill guard).

### Acceptance criteria
- The fabric authenticates to producer Postgres with a role that **cannot** read unpublished tables
  (verified by a denied-SELECT test).
- A NetworkPolicy test shows the fabric can reach producer + consumer Postgres and nothing else can
  reach across zones.
- Slot-lag/freshness metrics are exported; a test asserts an alert fires past the threshold.
- The consumer app role cannot write `_copy_*` tables (denied-write test).

### Components & files touched
Fabric-controller credential + NetworkPolicy reconcile; metrics export; docs in `docs/security/`.

### Architecture notes & risks
- Directly upholds `security.md` (least privilege, secrets in K8s only, no implicit cross-zone trust).
- The NetworkPolicy exception is the one sanctioned cross-zone path — keep it narrow and named.

---

## Sequencing summary

1. **PK1** (track-P, bug) — build the full `@knext/core` library surface to `dist` (all `exports` are raw `.ts` today). *Unblocks a usable publish + app imports.*
2. **PK2** (track-P, tier-A) — clean-machine smoke test of the CLI **and** an app import. *Gates the publish.*
3. **PK5** (track-P, docs) — declare the public application API surface + semver policy. *Intentional contract; land with PK1.*
4. **PK3** (track-P, tier-B, security) — bootstrap + verify the operator bundle. *The other install half.*
5. **PK4** (track-P, docs) — outside-user quickstart. *Adoption.*
6. **PG2** (tier-B, docs) — per-SCS Postgres provisioning + scaling recipe. *Build on E1/E2; flag scope.*
7. **PG1a** (tier-C, docs) — ADR + contract for cross-zone table copies; amend `scs-zones.md`. *Design; do first of the PG1 set.*
8. **PG1b** (tier-C, enhancement) — build the fabric controller (`TableCopy` CRD → RisingWave). *Opt-in module; post-Tier-A; gated on PG1a.*
9. **PG1c** (tier-C, security) — credentials, NetworkPolicy exception, slot/lag monitoring. *Hardens PG1b.*

**Decision recorded (founder):** cross-zone copying **is** an SCS-blessed pattern; the platform
provides a managed **table-copy fabric** — producer **publishes** tables (a view contract), the fabric
**CDC-replicates** them into **read-only copies in each consumer's own Postgres**. Full design in
`adr-draft-cross-zone-table-copies.md`. This **amends** `scs-zones.md` (PG1a) and ships as an
**opt-in module, post-Tier-A**, never in the core adapter path.

**Not re-proposed:** npm scope-resolution + the publish itself (**#53**), and DB-drain/sizing + the
CNPG reference CR (prior drafts **E1/E2**). **Founder action, not an issue:** set `NPM_TOKEN` to flip
`release.yml` from Version-PR-only to publishing.
