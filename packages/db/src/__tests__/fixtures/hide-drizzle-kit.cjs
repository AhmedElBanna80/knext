/**
 * hide-drizzle-kit.cjs — v3-P3c contract-test fixture (CJS `--require` preload).
 *
 * Makes `drizzle-kit` (and only it) unresolvable, simulating a consumer who never
 * installed the optional peer. @getknext/db ships ESM and probes the peer with
 * `createRequire(import.meta.url).resolve('drizzle-kit')`, which goes through
 * `Module._resolveFilename` like any CJS resolution, so we patch it to throw
 * MODULE_NOT_FOUND for that specifier. Everything else resolves normally.
 *
 * This lets the peer-shape contract test prove, in a real subprocess, that:
 *   - `require('@getknext/db')` / `@getknext/db/migrate` still load (no drizzle-kit), and
 *   - only `defineDrizzleConfig()` fails — with an actionable named error, never a
 *     bare MODULE_NOT_FOUND.
 */
const Module = require('node:module');

const original = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'drizzle-kit' || request.startsWith('drizzle-kit/')) {
    const err = new Error(`Cannot find module '${request}'`);
    err.code = 'MODULE_NOT_FOUND';
    throw err;
  }
  return original.call(this, request, ...rest);
};
