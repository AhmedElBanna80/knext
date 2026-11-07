# demo/app

## Overview

`pg-demo`, a minimal Next.js 15.5.28 app (`package.json`; dependencies `next` 15.5.28, `react` and `react-dom` 19.0.0, `pg` 8.13.1) used as a real knext workload in front of a scale-to-zero Postgres. It is packaged by `Dockerfile` as a two-stage, digest-pinned `node:24-alpine` image that runs `node server.js` from the standalone output on port 3000 (`HOSTNAME=0.0.0.0`) as user `1000:1000`. `public/robots.txt` is its only static asset.

## Interface

- `next.config.js`: `output: "standalone"`, which emits `.next/standalone/server.js`, and an empty `experimental` block.
- `package.json` scripts: `dev`, `build`, `start`.
- Child contracts:
  - [./app/EGM.md](./app/EGM.md) - the page that runs SQL on every request, and the API routes.
  - [./lib/EGM.md](./lib/EGM.md) - `getDbPool()` singleton pool.

## Invariants

- Standalone output only. The config sets nothing else of substance (`next.config.js`).

## Side Effects

- None at config level. Runtime database effects are documented in the child contracts.

## Verification

- No automated test covers this directory. The live demo drill `demo/_verify.sh` exercises it.
