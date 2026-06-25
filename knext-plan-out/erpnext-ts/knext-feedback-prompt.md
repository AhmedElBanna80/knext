Paste everything below the line into a Claude Code session inside the **erpnext-ts** repo. It is
authoritative feedback from the **knext** side (getknext-dev/knext, `main`) on erpnext-ts's
"knext integration readiness" doc: three corrections that will otherwise break your zones, the two
gap decisions, and the corrected per-zone wiring with the **real** field shapes. Treat knext's
surface as fixed-as-described and reconcile erpnext-ts against it.

---

You are working in **erpnext-ts** (a TypeScript port of ERPNext built as 22 Self-Contained-System
Next.js apps — 21 module zones + an `apps/main` proxy) that will deploy onto **knext** (the
scale-to-zero Next.js-on-Knative adapter). Your team wrote a knext-integration-readiness doc. knext
has reviewed it and sent back the feedback below. Apply it: fix the inaccuracies, settle the two
gap decisions, and produce the reference-zone spike. Do not invent knext behavior — everything here
is verified against the knext repo's `main`.

## 1. Three corrections to the readiness doc (these will bite you)

1. **The `kn-next` CLI is plain Node, not Bun.** The Bun-only blocker was fixed upstream — the CLI
   ships `#!/usr/bin/env node` with no Bun imports. Remove any Bun toolchain assumption; `npx kn-next`
   works on Node. (Simplifies your per-zone step 1.)

2. **knext is *publishable*, not yet *published* to npm.** The build-to-`dist` + clean-install smoke
   gate merged, but the actual `npm publish` of `@knext/*` has **not** run yet (it's blocked on the
   maintainer setting `NPM_TOKEN`). **Until then you cannot `npm i @knext/core` from the registry** —
   consume `@knext/core` / `@knext/lib` from a local tarball or a workspace link, and pin to that.
   Plan for the publish to land, but don't block the spike on it.

3. **`secrets.envMap` shape is `{ secretName, secretKey }` — NOT `{ name, key }`.** This is the exact
   field the operator reads; `{ name, key }` will fail to reconcile. Correct form on the `NextApp` CR
   (and via the typed config):
   ```yaml
   spec:
     secrets:
       envMap:
         DATABASE_URL:   { secretName: accounting-db,      secretKey: uri }
         PAYLOAD_SECRET: { secretName: accounting-payload, secretKey: secret }
       envFrom: [accounting-extra]   # optional: inject all keys of a Secret
   ```

Everything else in your "what knext provides" section is accurate (CLI commands, `@knext/core` /
`@knext/lib` surfaces, the `NextApp` CRD blocks, `runtime: node` default = good for Payload,
`minScale: 0` scale-to-zero, dev `infrastructure.postgres` being single-instance/dev-only).

## 2. Gap #2 — production Postgres + pooler (the make-or-break). DECISION:

- **Default pooler = CloudNativePG's built-in `Pooler` CRD (PgBouncer, transaction mode).** It is
  native to the CNPG that the SCS model already uses for zone databases, self-hosted, no lock-in.
  Point each zone's `DATABASE_URL` at the **pooler Service**, not the Postgres `-rw` primary.
- **Do NOT self-host Neon.** Neon's code is Apache-2.0, but production self-hosting is **unsupported
  / experimental** (pageserver + safekeepers + control plane + S3). Neon Cloud / Aurora Serverless v2
  remain options via a `DATABASE_URL` swap if you accept managed lock-in — not the default.
- **Payload-critical caveat:** PgBouncer **transaction mode breaks SQL-level `PREPARE`/`DEALLOCATE`**
  (and `SET`/`LISTEN`/session advisory locks). Payload v3 / Drizzle / Prisma rely on prepared
  statements — so set `max_prepared_statements` (PgBouncer ≥ 1.21) **or** disable the ORM's
  statement cache, per zone, or it breaks in production.
- **App-side, do this yourself NOW (knext is shipping it as `PGS-1` but it isn't merged):** today
  `@knext/lib`'s `getDbPool()` is an **unbounded pool with no `pool.end()` on SIGTERM** — a
  scaled-down pod can sever an in-flight ledger transaction. In each zone, set a **small pool `max`
  (e.g. 5)** and **drain the pool on `SIGTERM`** (`await getDbPool().end()`), within the pod's
  termination grace window, so submit/GL transactions commit-or-rollback before exit.

## 3. Gaps #1, #3, #5 — confirmed

- **#1 Kafka (BYO):** knext's Kafka is **ISR-revalidation only**; it will **not** wire your cross-zone
  domain-event consumers. Bring your own broker (e.g. Strimzi/Kafka) + your `KafkaEventBus` client;
  knext injects the broker credentials via `secrets.envMap`, nothing more. This matches the SCS rule
  (cross-zone integration = your async domain events, each zone keeps its own copy).
- **#3 Composition (`apps/main`):** the app-level `rewrites()` proxy works today — deploy `apps/main`
  as its own `NextApp` whose Next `rewrites()` target each zone's in-cluster `status.url`. No new
  knext primitive is required; CR-native routing is a deferred design question, not a blocker. Verify
  cross-service rewrites + session/auth at the single origin on Knative during the spike.
- **#5 Cold start:** set **`minScale: 1` for the `accounting` (ledger) zone** so it never pays
  cold-start + pool re-establish on the write path; keep read-heavy zones at `minScale: 0`. For write
  zones prefer **lower `maxScale`, higher `containerConcurrency`** to bound DB fan-out.

## 4. Corrected per-zone wiring (steps 2–5), with real shapes

Per zone (use knext's `knext-app`, `knext-lib`, `knext-deploy` skills if available in the session):

- **`kn-next.config.ts`**: `name`, `registry`, `runtime: 'node'`, `scaling` (per #5),
  `cache: { provider: 'redis', url, keyPrefix }`, `storage: { provider: 'gcs' | 'minio', ... }` for
  Payload media (note: **`azure` is NOT accepted** by the validator — use MinIO/S3-API),
  `secrets.envMap` with the `{ secretName, secretKey }` shape above.
- **`next.config.ts`**: `output: 'standalone'`, `experimental.adapterPath: '@knext/core/adapter'`,
  `cacheHandler: path.resolve(import.meta.dirname, 'cache-handler.js')`,
  `assetPrefix: process.env.ASSET_PREFIX || ''`.
- **`cache-handler.js`** (app root): `export { default } from '@knext/core/adapters/cache-handler';`
- **`app/api/health/route.ts`**: use `checkDeepHealth()` from `@knext/lib/health` (returns
  `{ status, timestamp, checks: { postgres, redis } }`); return 503 when `status === 'down'`.
- **`instrumentation.ts`**: `resolveOtelOptions()` from `@knext/core/adapters/otel-config` (tracing
  stays off until an OTLP endpoint is configured).
- **Do NOT import any `@knext/core/internal/*` path** — those are framework wiring with no stability
  guarantee.

## 5. The next step — the `accounting` reference-zone spike

Produce ONE thin spike PR on the `accounting` zone proving the path end-to-end, then replicate:

Acceptance:
- `accounting` has `@knext/core`/`@knext/lib` wired: `kn-next.config.ts`, `output: 'standalone'`,
  the adapter, the `cache-handler.js` re-export, `/api/health`, `instrumentation.ts`.
- A small bounded DB pool + a `SIGTERM` `getDbPool().end()` drain are in place (per #2).
- `kn-next validate` passes; `kn-next build` produces a digest-pinned image; `kn-next deploy` against
  a local **kind** cluster reconciles a `NextApp` to `Ready` with `status.url` set, and `/api/health`
  returns 200.
- A CNPG `Pooler` (transaction mode) fronts the zone's Postgres, `DATABASE_URL` points at the pooler,
  and `max_prepared_statements` (or ORM statement-cache-off) is set so Payload works.
- `minScale: 1` for `accounting`; document the cold-start observation.

Report: the spike result, any field/behavior where knext differed from this feedback, and the two
fleet-rollout decisions still owned by erpnext-ts — (a) the Kafka broker choice for domain events,
and (b) managed-vs-CNPG Postgres per environment.
