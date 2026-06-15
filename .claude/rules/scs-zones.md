# SCS / Zones contract (knext)

> The short, always-on contract. Full explanations live in the skills: **`scs-zones`** (SCS +
> Multi-Zones architecture) and **`pwa-zones`** (the opt-in PWA stitching layer). Complements
> `architecture.md` + `security.md`.

## What knext is
A **scale-to-zero Next.js deployment framework for Knative** (TS + Go). Data plane: Postgres +
Redis + GCS. **Zone databases = PostgreSQL via CloudNativePG.** Each zone = one **Self-Contained
System** (owns UI + logic + data), deployed as its own Knative Service.

## Data sovereignty (hard rule)
- A zone **owns its data store**; **no shared database**.
- A zone **must not read another zone's database** — never connect to another zone's CNPG `-rw`
  (primary) or `-ro` (replica) service. (Enforced: `protect-zone-data-sovereignty.sh`.)
- Cross-zone data flows **only** via **async Kafka domain events** (each zone keeps its own copy)
  and via the **browser** (links / UI composition). Transient UI state via BroadcastChannel.
- A zone reaches **its own** DB via `DATABASE_URL` from a K8s Secret — never a hardcoded host.

## Scope boundary (load-bearing)
knext is the **deployment layer**, not the micro-frontend runtime.
- **knext owns:** Knative/scale-to-zero, the official Next.js adapter, per-zone deploy,
  `assetPrefix` wiring, serving the App Shell, generating the precache manifest.
- **knext does NOT own:** Service Worker / SWI / BroadcastChannel / Module-Federation runtime —
  these are **app-level**, shipped as the optional `pwa-zones` recipe. They must not land in core
  packages (`packages/kn-next`, `packages/cli`, the operator). (Advisory:
  `protect-core-vs-app-boundary.sh`.)

## Caching (security)
SW/caching config: **never cache auth endpoints or any mutation route** (network-only). Caching
them is a correctness + security bug. (Advisory: `guard-sw-cache-policy.sh`.) See `security.md`.

## Sequencing
SCS/zones/PWA stay **design + optional template**, not core, during the fame-first phase. Gated
**after** the official-adapter migration + Tier-A correctness; per-zone DB + PWA are Tier B/C /
optional-module material (`ROADMAP.md`). North star = verified-adapter status.
