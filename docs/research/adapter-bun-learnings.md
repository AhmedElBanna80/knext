# Learnings from `nextjs/adapter-bun` (official reference Bun adapter)

> Source: https://github.com/nextjs/adapter-bun @ `main` (Next 16.2.0). Fetched 2026-06-15.
> Purpose: inform knext's node + bun deployment adapters. **Verify against upstream before copying.**

## Headline: the reference does NOT use bytecode caching
Searched the entire source — **no `--compile`, no `--bytecode`, no single-executable, no
`NODE_COMPILE_CACHE`**. `package.json` build is just `tsc`. The "binary.ts" file is a **base64/utf8
byte codec**, not a compiled binary. Startup speed comes from **Bun's native fast boot**, not from
bytecode artifacts. This *validates* knext's existing decisions: `bun --compile` was rejected
(NFT/dynamic-require pain), and Node fast-start is done with `NODE_COMPILE_CACHE` at runtime — both
**orthogonal** to the adapter. So: there is no bytecode pattern to copy here; bytecode is layered
separately at runtime, not at adapter build time.

## How the reference adapter is structured (the parts worth copying)
- **Factory → NextAdapter.** `createBunAdapter(options): NextAdapter`, wired via
  `next.config.ts` → `adapterPath: require.resolve('adapter-bun')`. Hooks used: **`modifyConfig`**
  + **`onBuildComplete`** (the official API — exactly knext's north star).
- **Build/run flow.** `bun --bun next build` → writes `bun-dist/` → run with `bun bun-dist/server.js`.
- **`onBuildComplete` writes a runtime package** (`bun-dist/`): `server.js` (launcher), `runtime/*.js`
  (cache modules), staged `static/`, **`deployment-manifest.json`** (the build→runtime contract:
  port, hostname, buildId, distDir, cache config), and a SQLite `cache.db`.
- **NOT a self-contained bundle.** The runtime server still boots Next.js from the project's `.next`
  + `node_modules`; `NEXT_PROJECT_DIR` overrides the root. (Contrast: knext uses `output:'standalone'`
  which *does* bundle — a deliberate divergence in knext's favour for containers.)
- **Runtime server** (`src/runtime/server.ts`) is a plain `node:http` server (keep-alive 75s) that
  also serves an **internal cache endpoint** and resolves config from the manifest.

## Two patterns knext should steal directly
1. **Authenticated internal cache endpoint.** Cache transport has two modes: `http` (default —
   internal endpoint `/_adapter/cache` guarded by a **shared `cacheAuthToken`** /
   `BUN_ADAPTER_CACHE_HTTP_TOKEN`) and `sqlite` (local `cache.db`). The token-guarded endpoint is the
   correct pattern for knext's open `POST /api/cache/invalidate` vuln — **no unauthenticated mutating
   cache endpoint**. knext maps `http` mode → its Redis cache-handler.
2. **Image optimization via `sharp` + an image cache store** (`SqliteImageCacheStore`, `sharp`
   dependency). This is knext's single biggest functional gap — the reference shows the wiring
   (optimizer + a pluggable cache store), which knext can back with Redis/GCS instead of SQLite.
- Bonus: **`deploymentHost`** option feeds Server-Actions **CSRF allow-listing** — a security detail
  to carry into knext's adapter options.

## Recommended shape for knext's node + bun adapters
- **One adapter factory, two targets — don't rewrite the runtime twice.** A shared
  `createKnextAdapter({ target: 'node' | 'bun', ... })` returning a `NextAdapter`. `modifyConfig`
  forces `output:'standalone'`; `onBuildComplete` stages assets + writes a deployment manifest +
  registers the cache handler. The emitted `server.js` is the same logical server for both runtimes.
- **Bytecode is a runtime concern, set per target — not in the adapter:**
  - **node:** run `server.js` with `NODE_COMPILE_CACHE=<persistent dir>` (already in the operator,
    `nextapp_controller.go:201`). V8 compile cache survives cold starts.
  - **bun:** rely on Bun's native fast start; `bun build --compile --bytecode` produces a single
    executable but breaks the "boot Next from `.next`" model and was already rejected for knext. Keep
    it off the standalone path.
- **Cache:** adopt the http-mode token-authed endpoint contract, backed by **Redis** (knext's plane),
  not SQLite. Reuse the manifest as the build→operator contract.
- **Gate on the official compatibility suite** (the reference ships e2e/fixtures — mirror that).

## Open questions
- Does knext want the reference's "boot from project dir" model, or keep `output:'standalone'`
  (bundled)? knext should keep standalone for containers — note the divergence in docs.
- Image optimizer cache backend: Redis vs GCS vs both (tie to the existing data plane).
