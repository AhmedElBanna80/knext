# logger

## Overview
A shared pino JSON logger, published as the `@getknext/lib/logger` subpath (`package.json`
`exports["./logger"]`) and re-exported from the package root. Every line logged inside a
request context is stamped with correlation fields from `../context`.

## Interface
- `index.ts:logger`: the module singleton, built by `buildLogger()` when the module loads.
- `index.ts:buildLogger()`: builds a fresh pino logger from the current environment. It is
  exported so tests can build a logger without re-evaluating the module.

## Invariants
- The level is `process.env.LOG_LEVEL || 'info'`, and levels are output as string labels
  (`formatters.level`).
- `base` holds `app` (from `KN_APP_NAME`, with a hard-coded fallback) and `env` (`NODE_ENV`).
- `mixin()` returns `correlationLogFields()` from `../context`. Outside a request it returns
  `{}`, so no correlation fields are added (`index.ts:buildLogger`).
- `redact` covers `req.headers.authorization`, `req.headers.cookie`, `password` and `token`.
- The `pino-pretty` transport is added only when `NODE_ENV !== 'production'` and
  `createRequire(runtimeAnchor()).resolve('pino-pretty')` succeeds. Its options are
  `colorize: true`, `singleLine: true` and `translateTime: 'SYS:standard'`. Otherwise output is plain
  JSON. A missing prettifier never stops the logger from being built
  (`index.ts:prettyTransport`).

## Side Effects
- Writes log lines to stdout through pino. In development, when `pino-pretty` resolves, pino
  starts a transport worker for it.
- Reads `NODE_ENV` once, when the module loads (`isProduction`). Reads `LOG_LEVEL` and
  `KN_APP_NAME` each time a logger is built.

## Verification
- Run: `node scripts/bun-test.mjs packages/lib` (from repo root)
