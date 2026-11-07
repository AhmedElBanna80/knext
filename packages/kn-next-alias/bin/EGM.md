# bin (legacy bare-name alias shim)

## Overview

A single CommonJS Node script, `kn-next.js`, that is the `bin` entry of the
legacy bare-name alias package (`packages/kn-next-alias/package.json` `bin`).
It owns no CLI logic: it resolves the `@getknext/core` CLI entry point and
re-executes it in a child process with the same arguments
(`kn-next.js` header comment). Use the canonical `knext` command; this shim
exists only for backward compatibility.

## Interface

- `kn-next.js` (top-level script, no exports): run as
  `node bin/kn-next.js <args...>`; forwards `process.argv.slice(2)` unchanged
  to the core CLI (`kn-next.js:spawn(process.execPath, [binPath, ...])`).
- Core bin resolution (`kn-next.js:binPath`): `createRequire(__filename)`
  resolves the `@getknext/core` root export, then walks up directories until a
  `package.json` is found; the bin path is `corePkg.bin` when it is a string,
  otherwise `corePkg.bin.knext`.
- Exit status (`kn-next.js:child.on('exit')`): the child's exit code, or `1`
  when the code is `null`; on a signal-terminated child, the shim re-raises the
  same signal on itself.

## Invariants

- Spawn, never import: the core bin is executed as a separate process with
  `stdio: 'inherit'` so it keeps its own exit codes, signal handling and stdio
  (`kn-next.js` header comment, `spawn(..., { stdio: 'inherit' })`).
- `package.json` is located by walking up from the resolved root export, not
  by resolving `@getknext/core/package.json`, because core's exports map does
  not expose it (`kn-next.js` comment on `ERR_PACKAGE_PATH_NOT_EXPORTED`).
- Any resolution failure prints an install hint to stderr and exits `1` before
  any child is spawned (`kn-next.js` `catch` block, `process.exit(1)`).
- `SIGINT`, `SIGTERM` and `SIGHUP` received by the shim are forwarded to the
  child (`kn-next.js` `for (const sig of [...]) process.on(sig, () => child.kill(sig))`),
  so a supervisor timeout cannot orphan a cluster-mutating CLI run.
- On a signalled child exit, `process.removeAllListeners(signal)` runs before
  `process.kill(process.pid, signal)`, so the re-raise uses the default
  disposition and the shim does not exit `0` (`kn-next.js:child.on('exit')`).
- `node:` built-ins only (`child_process`, `fs`, `module`, `path`); the only
  package dependency is `@getknext/core` (`packages/kn-next-alias/package.json`
  `dependencies`).

## Side Effects

- Spawns one child process running `process.execPath` on the resolved core bin
  (`kn-next.js:spawn`).
- Reads the filesystem to probe for `package.json` (`kn-next.js:existsSync`,
  `require(path.join(dir, 'package.json'))`).
- Writes an error message to stderr on resolution failure, advising
  `npm install @getknext/core` or `npx @getknext/core`
  (`kn-next.js:process.stderr.write`).
- Installs process signal listeners and sends signals to the child and, on a
  signalled child exit, to its own process (`kn-next.js:child.kill`,
  `process.kill`).

## Verification

- Run: `node scripts/bun-test.mjs` (from repo root; the shim is covered by
  `tests/kn-next-alias.test.ts`)
- Syntax check: `node --check bin/kn-next.js` (`packages/kn-next-alias/package.json`
  `scripts.typecheck`)
