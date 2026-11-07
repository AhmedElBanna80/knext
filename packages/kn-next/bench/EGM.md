# bench

## Overview

Standalone Node benchmark scripts (`.mjs`, run manually and not part of the test
suite) for knext's cold-start and serving performance:

- `coldstart-supervisor-overhead.mjs` - how much the supervisor wrapper adds to
  cold start: DIRECT vs SUPERVISOR, timed in alternating pairs.
- `boot-phase-trace.mjs` - where the supervisor's boot time goes, measured from
  inside the process with `KNEXT_BOOT_TRACE=1` phase marks.
- `http-loadtest.mjs` - closed-loop HTTP throughput and latency against any
  running endpoint.

Absolute numbers are machine-specific. The scripts report shape and deltas;
re-run them on the target cluster before claiming a deployed result.

## Interface

### `coldstart-supervisor-overhead.mjs`

Run: `node packages/kn-next/bench/coldstart-supervisor-overhead.mjs`

- Env: `N` (pairs, default 12) and `KNEXT_BENCH_STANDALONE` (a real
  `server.js`; otherwise a fast fixture that answers `/api/health`).
- DIRECT runs `node <fixture>`. SUPERVISOR runs
  `node -e "import('@getknext/core/internal/node-server')"` with
  `STANDALONE_SERVER_PATH=<fixture>`, `METRICS_PORT=port+10000`, and
  `CACHE_INVALIDATE_TOKEN=bench`.
- Readiness means `GET /api/health` returns 200 (20 s deadline).
- Prints DIRECT and SUPERVISOR medians and ranges, the DELTA, and whether the two
  distributions separate. Ports are 41000-41001 for warm-up and `42000 + 4i` for
  measured pairs.

### `boot-phase-trace.mjs`

Run: `node packages/kn-next/bench/boot-phase-trace.mjs`

- Env: `N` (default 12) and `KNEXT_BENCH_STANDALONE`.
- Runs the deployed `dist/adapters/node-server.js` by absolute file URL, with
  `KNEXT_BOOT_TRACE=1`, `KNEXT_CHILD_READY_PROBE_MS=10`, and
  `NODE_ENV=production`.
- Parses the stderr JSON lines that contain `knextBootTrace`.
- Phase chain: `entry-eval`, `spawn-issued`, `child-listening`,
  `supervisor-ready`. `metrics-listening` is reported off-chain.
- Reference arms: FLOOR wall (`node -e ""`), FLOOR in-process
  (`process.uptime()`), FLOOR esm-import (dynamic import of an empty module), and
  DIRECT.
- Derived values: wrapper overhead and the size of knext's own entry graph.
- Ports are 43900-43901 for warm-up and `44000 + 4i` for measured reps.

### `http-loadtest.mjs`

Run: `KNEXT_BENCH_URL=... node packages/kn-next/bench/http-loadtest.mjs`

- Env: `KNEXT_BENCH_URL` (default `http://127.0.0.1:8080`); `PATH_` or
  `BENCH_PATH` (default `/api/health`); `C` (concurrency, default 50);
  `DURATION_MS` (default 8000); `WARMUP` (sequential warm-up requests,
  default 2000).
- Uses keep-alive `http`/`https` agents.
- Prints ok/err counts, req/s, and p50/p95/p99/max latency in ms.

## Invariants

- The two supervisor benches need a built `@getknext/core`. They run
  `pnpm --filter @getknext/core --prod deploy --legacy <tmp>` from the repo root
  and exit with code 2 if `dist/adapters/node-server.js` is missing.
- Scratch trees (`knext-core-deploy-*`, `knext-cs-runner-*`, `knext-bpt-runner-*`)
  are removed on process `exit`. The early-failure path removes the deploy tree
  before exiting.
- Child processes are spawned `detached` and killed as a process group
  (`process.kill(-pid, "SIGKILL")`, falling back to `child.kill`).
- `boot-phase-trace.mjs` derives intervals from each rep's absolute
  `sinceStartMs`, not from `sinceLastMs`, so async marks that arrive out of order
  do not skew the table. When a phase repeats, the first occurrence wins.
- `http-loadtest.mjs` reads its path from `PATH_`/`BENCH_PATH`, never from
  `PATH`, which would clobber the shell `PATH`. It does not start a server.
- Only HTTP 200 responses count as `ok` and contribute latency samples.

## Side Effects

- Spawn `pnpm` and many `node` child processes. They bind local TCP ports in the
  ranges listed above, plus metrics ports at `+10000`.
- Create and delete temp directories under `os.tmpdir()`, and write fixture files
  `fast-server.mjs` and `empty-module.mjs` there.
- Create a symlink `node_modules/@getknext/core` pointing to the deploy tree.
- `http-loadtest.mjs` sends live HTTP/HTTPS load to the target URL.
- All three write progress to stderr and results to stdout.

## Verification

- Run (from `packages/kn-next`): `node ../../scripts/bun-test.mjs packages/kn-next`
  (these scripts are not exercised by the suite. Run them directly as shown
  above.)
