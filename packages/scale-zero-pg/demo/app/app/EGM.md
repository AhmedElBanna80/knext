# demo/app/app

## Overview

App Router pages of the `pg-demo` Next.js app. Every page visit runs real SQL, so each request exercises the scale-to-zero wake path.

## Interface

- `page.js`:
  - default export `Page`, an async server component;
  - `dynamic = "force-dynamic"` and `revalidate = 0`;
  - private `loadVisit()`, which runs `CREATE TABLE IF NOT EXISTS visits`, one `INSERT INTO visits DEFAULT VALUES RETURNING id, seen_at` and one `SELECT count(*), now(), version()`.
- `layout.js`: `metadata` (title `scale-to-zero pg demo`) and default `RootLayout`.
- Child contract: [./api/EGM.md](./api/EGM.md) - API routes (health).

## Invariants

- The page is never statically rendered or cached (`page.js`: `dynamic`, `revalidate`).
- The schema step is idempotent (`CREATE TABLE IF NOT EXISTS`) (`page.js:loadVisit`).
- A database error does not throw out of the page: `Page` catches it and renders `DB error: <message>` (`page.js:Page`).

## Side Effects

- Each visit inserts one row into `visits` through `getDbPool()` (`../lib/db.js`).

## Verification

- No automated test covers this directory. The live demo drill `demo/_verify.sh` exercises it.
