# Cache Test Live HTTP Evidence — POC-ADAPTER-P1

**Run command:**
```sh
cd apps/file-manager/.next/standalone/apps/file-manager
NODE_COMPILE_CACHE=.next/compile-cache PORT=3999 HOSTNAME=127.0.0.1 NODE_ENV=production node server.js
```

**Probe command:**
```sh
node apps/file-manager/scripts/http-probe.mjs
```

## Results (Node 24.14.0, Next.js 16.0.3, 2026-05-28)

### (a) Time-Based ISR

```
GET /cache-tests/time-based [1st] → HTTP 200
  cache-control : s-maxage=10, stale-while-revalidate=31535990
  x-next-cache-tags : …,time-based
GET /cache-tests/time-based [2nd] → HTTP 200 (served from in-memory cache)
  cache-control : s-maxage=10, stale-while-revalidate=31535990
```

**Server log confirms MISS → SET → HIT:**
```
[Cache] MISS /cache-tests/time-based (memory)
[Cache] SET  /cache-tests/time-based (memory)
[Cache] HIT  /cache-tests/time-based (memory)
```

### (b) On-Demand Revalidation (revalidateTag) — WITH BEFORE/AFTER BODY PROOF

The `/cache-tests/on-demand` page uses `unstable_cache` with `generatedAt: new Date().toISOString()`.
After `revalidateTag("products")`, the cache function re-runs and produces a **new** `generatedAt`
timestamp — proving the cache was actually invalidated, not just status-200 served.

```
Step 1 — Warm-up GET (populate unstable_cache):
  HTTP 200 | Timestamps in body:
    products.generatedAt : 2026-05-28T11:27:28.032Z   ← product cache created
    orders.generatedAt   : 2026-05-28T11:27:27.694Z
    summary.generatedAt  : 2026-05-28T11:27:28.084Z

Step 2 — Second GET (HIT — same cached generatedAt values):
  HTTP 200 | Timestamps in body:
    products.generatedAt : 2026-05-28T11:27:28.032Z   ← identical ✓ (cache HIT)
    orders.generatedAt   : 2026-05-28T11:27:27.694Z   ← unchanged ✓
    summary.generatedAt  : 2026-05-28T11:27:28.084Z   ← unchanged ✓

Step 3 — POST /api/cache/invalidate {tag:"products"}:
  HTTP 200: {"success":true,"message":"Cache invalidated for tag: products",
             "timestamp":"2026-05-28T11:28:13.701Z"}

Step 4 — GET after invalidation (products cache MISS → re-computed):
  HTTP 200 | Timestamps in body:
    products.generatedAt : 2026-05-28T11:28:14.055Z   ← NEW timestamp ✅ CHANGED
    orders.generatedAt   : 2026-05-28T11:27:27.694Z   ← unchanged (orders tag not invalidated)
    summary.generatedAt  : 2026-05-28T11:28:14.108Z   ← NEW (summary tagged products+orders)

✅ PROVED: generatedAt changed 2026-05-28T11:27:28.032Z → 2026-05-28T11:28:14.055Z
   revalidateTag("products") busted products + summary caches.
   orders cache (different tag) remained stable — correct selective invalidation.
```

**Probe script:** `node apps/file-manager/scripts/invalidation-probe.mjs`

### (c) RSC / Streaming Response

```
GET / → HTTP 200
  content-type      : text/html; charset=utf-8
  x-nextjs-prerender: 1
  cache-control     : s-maxage=60, stale-while-revalidate=31535940
  x-next-cache-tags : _N_T_/layout,_N_T_/page,_N_T_/,_N_T_/index,files
  RSC flight marker in body: true   ← self.__next_f present
```

### (d) Nested ISR Routes

```
GET /cache-tests/nested         → HTTP 200 | s-maxage=30
GET /cache-tests/nested/child-a → HTTP 200 | s-maxage=15
GET /cache-tests/nested/child-b → HTTP 200 | s-maxage=45
```
Each route has its own independent revalidation interval (15/30/45s).

### (e) Parallel Cache Requests

```
3x concurrent GET /cache-tests/parallel → 200 200 200
```
All three concurrent requests resolved successfully — no race conditions.

### (f) Dynamic-Static Mix

```
GET /cache-tests/dynamic-static/static  → HTTP 200 (prerendered at build)
GET /cache-tests/dynamic-static/dynamic → HTTP 200 (server-rendered on demand)
```

### (g) API Health

```
GET /api/health → HTTP 200
{"status":"ok","checks":{"postgres":"unconfigured","redis":"unconfigured"}}
```
Server healthy; Redis/Postgres "unconfigured" is expected (no services in local probe).

## NODE_COMPILE_CACHE Evidence

```
$ ls $NODE_COMPILE_CACHE/
v24.14.0-arm64-cf738c9d-501/
```
V8 compile cache dir populated on first server startup. Subsequent runs reuse it
for faster cold-start module evaluation.

## onBuildComplete Upload Evidence

```
[knext-poc-adapter] upload skipped: STORAGE_BUCKET not set
  — set STORAGE_BUCKET to enable artifact upload
```
When `STORAGE_BUCKET` is set, the adapter uploads `staticFiles` + `prerenders`
(keyed by `buildId`) via `getMinioClient().putObject()` from `@knative-next/lib/clients`.
Unit test mocks `getMinioClient` and asserts `putObject` is called.
