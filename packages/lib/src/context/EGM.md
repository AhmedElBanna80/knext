# context

## Overview
The request-correlation layer, published as the `@getknext/lib/context` subpath. A per-request
correlation id (and an optional trace id) travels in an `AsyncLocalStorage`. It is added to log
lines through the logger `mixin`, echoed on responses and forwarded on outbound calls. OTel
values are read through injected providers, so the module depends on Node core only
(`node:async_hooks`, `node:crypto`).

## Interface
- `index.ts:CORRELATION_HEADER`: the value `'x-request-id'`.
- `index.ts:RequestContext`: `{ correlationId: string; traceId?: string }`.
- `index.ts:HeaderSource`: accepts Web `Headers`, a plain header record, any object with
  `get()`, `undefined` or `null`.
- `index.ts:isWellFormedCorrelationId(value)`, `index.ts:resolveCorrelationId(raw)`.
- `index.ts:readHeader(source, name)`: uses `source.get(name)` when `get` is a function,
  otherwise matches record keys case-insensitively and takes the first element of an array
  value. Returns `undefined` for a missing source or header.
- `index.ts:setTraceIdProvider(fn)`, `index.ts:resetTraceIdProvider()`.
- `index.ts:setCorrelationIdProvider(fn)`, `index.ts:resetCorrelationIdProvider()`.
- `index.ts:createRequestContext({ correlationId?, headers?, traceId? })`: an explicit
  `correlationId` wins, otherwise the id is resolved from the `x-request-id` header. `traceId`
  defaults to the trace-id provider's value and is left off the context when empty.
- `index.ts:beginRequest(headers?, opts?)`: `createRequestContext({ headers, traceId })`.
- `index.ts:runWithRequestContext(ctx, fn)`, `index.ts:getRequestContext()`,
  `index.ts:getCorrelationId()`, `index.ts:getTraceId()`.
- `index.ts:correlationLogFields()`: returns `{ correlation_id?, trace_id? }`.
- `index.ts:correlationHeaders(ctx?)`: returns `{ 'x-request-id': id }`, or `{}` when there is
  no id. `ctx` defaults to the ALS context.
- `index.ts:applyCorrelationHeader(target, ctx?)`: calls `target.set` (Web `Headers`) or
  `target.setHeader` (Node `ServerResponse`). `ctx` defaults to the ALS context.

## Invariants
- An inbound id is adopted only if it matches `^[A-Za-z0-9._-]{1,128}$` (`ID_PATTERN`,
  `MAX_ID_LENGTH`). Otherwise a `randomUUID()` is generated (`index.ts:resolveCorrelationId`).
  For an array header, only the first element is considered.
- The ALS store and both providers live in one `globalThis` slot keyed by
  `Symbol.for('knext.lib.context.state')` (`index.ts:contextState`). Bundler-duplicated copies
  of the module therefore share them.
- An explicit ALS context takes precedence in `correlationLogFields()`. Without one, the
  function falls back to `correlationIdProvider` and returns `{}` when that provider yields
  nothing.
- A provider that throws is caught and treated as `undefined` (`index.ts:currentTraceId`,
  `index.ts:providedCorrelationId`).
- With no explicit `ctx` and no ALS context, `applyCorrelationHeader` sets nothing and
  `correlationHeaders` returns `{}`. Neither consults the correlation-id provider.

## Side Effects
- `setTraceIdProvider`, `setCorrelationIdProvider` and the `reset*` functions mutate shared
  `globalThis` state. On first access, `contextState()` installs that state on `globalThis`.
- `applyCorrelationHeader` mutates the headers of the target response.

## Verification
- Run: `node scripts/bun-test.mjs packages/lib` (from repo root)
