# demo/app/app/api/health

## Overview

The demo app's liveness and readiness route. The knext operator's default health-check path points at it (`route.js` header).

## Interface

- `GET` (`route.js`) returns `{"status":"ok"}`.
- `dynamic = "force-dynamic"` (`route.js`).

## Invariants

- It must not touch Postgres. A probe that woke the database would defeat scale-to-zero (`route.js` header).

## Side Effects

- None.

## Verification

- No automated test covers this directory. The live demo drill `demo/_verify.sh` exercises it.
