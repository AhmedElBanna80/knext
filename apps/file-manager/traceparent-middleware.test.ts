// #2627 — knext-owned traceparent-through-middleware test.
//
// Replaces the coverage lost when upstream `otel-middleware-trace` (Next 16.4.1+)
// was quarantined as Vercel-topology coupled (ADR-0007 §h): that file snapshots
// span TREES shaped by Vercel's separate middleware/render functions. What it is
// ABOUT — trace context surviving middleware to the handler — is asserted here
// against a topology knext shares and Vercel does not: ONE process serving
// middleware + handler.
//
// WHAT THIS BOOTS, exactly: a tiny fixture built with `output: 'standalone'`,
// then the emitted standalone `server.js` run by plain `node` — the same artifact
// shape knext ships — with `@vercel/otel` registered exactly as `apps/file-manager`
// registers it. WHAT IT IS NOT: no knext Next adapter (`adapterPath`), no operator,
// no Knative/queue-proxy, no cluster, no container image. It is a hermetic
// standalone-server e2e on loopback, not a kind/OKE test.
//
// Both halves are asserted: a good trace id survives to the handler, AND a
// missing / malformed one is detected (fresh valid id, never the garbage).
// Not covered here (tracked separately): span TREES and OTLP export.

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { reserveHeldPorts } from './e2e-support/child-ports';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, '__fixtures__', 'traceparent-app');
const NEXT_BIN = join(HERE, 'node_modules', 'next', 'dist', 'bin', 'next');
const BUILD_TIMEOUT_MS = 150_000;
const READY_TIMEOUT_MS = 60_000;

const TRACE_ID = '0af7651916cd43dd8448eb211c80319c';
const INCOMING = `00-${TRACE_ID}-b7ad6b7169203331-01`;
const MW_TRACEPARENT = '00-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-bbbbbbbbbbbbbbbb-01';
const VALID_ID = /^(?!0{32}$)[0-9a-f]{32}$/;

interface Echo {
  traceparentHeader: string | null;
  mwOverride: string | null;
  activeTraceId: string | null;
}

let server: ChildProcess | undefined;
let base = '';
let output = '';

async function echo(path: string, traceparent?: string): Promise<Echo> {
  const res = await fetch(`${base}${path}`, {
    headers: traceparent ? { traceparent } : {},
  });
  expect(res.status).toBe(200);
  return (await res.json()) as Echo;
}

/**
 * Locate the standalone `server.js`. Next nests it under the monorepo-relative
 * path of the fixture (tracing root = workspace root), so search for it rather
 * than hardcoding that layout. Exactly one must exist.
 */
function findStandaloneServer(): string {
  const root = join(FIXTURE, '.next', 'standalone');
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules') continue;
      const p = join(dir, name);
      if (statSync(p).isDirectory()) walk(p);
      else if (name === 'server.js') found.push(p);
    }
  };
  walk(root);
  if (found.length !== 1) {
    throw new Error(`expected exactly one standalone server.js under ${root}, found: ${found}`);
  }
  return found[0];
}

/** Poll until the server answers; fail fast (with its output) if it exits first. */
async function waitReady(proc: ChildProcess): Promise<void> {
  let exited: string | undefined;
  proc.once('exit', (code, sig) => {
    exited = `code ${code} signal ${sig}`;
  });
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (exited) {
      throw new Error(`fixture standalone server exited early: ${exited}\n${output}`);
    }
    try {
      const r = await fetch(`${base}/api/echo`);
      if (r.status === 200) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(
    `fixture standalone server never became ready within ${READY_TIMEOUT_MS}ms\n${output}`,
  );
}

beforeAll(async () => {
  const build = spawnSync('node', [NEXT_BIN, 'build', '--webpack'], {
    cwd: FIXTURE,
    encoding: 'utf8',
    timeout: BUILD_TIMEOUT_MS,
    killSignal: 'SIGKILL',
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' },
  });
  if (build.error) {
    throw new Error(
      `fixture next build did not complete (${build.error.message}; timeout ${BUILD_TIMEOUT_MS}ms):\n${build.stdout}\n${build.stderr}`,
    );
  }
  if (build.status !== 0) {
    throw new Error(`fixture next build failed:\n${build.stdout}\n${build.stderr}`);
  }
  const serverJs = findStandaloneServer();

  // Hold the port until the instant before spawn (no self-collision); the
  // remaining release->bind window is the irreducible one child-ports.ts documents.
  const held = await reserveHeldPorts(1);
  const port = held.ports[0];
  base = `http://127.0.0.1:${port}`;
  await held.release();
  // Own process group so teardown can kill the whole tree.
  server = spawn('node', [serverJs], {
    cwd: dirname(serverJs),
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      NEXT_TELEMETRY_DISABLED: '1',
      PORT: String(port),
      HOSTNAME: '127.0.0.1',
    },
  });
  server.stdout?.on('data', (d: Buffer) => {
    output += `[stdout] ${d}`;
  });
  server.stderr?.on('data', (d: Buffer) => {
    output += `[stderr] ${d}`;
  });
  await waitReady(server);
}, 240_000);

afterAll(async () => {
  const proc = server;
  server = undefined;
  if (!proc || proc.pid == null) return;
  const closed = new Promise<void>((done) => {
    if (proc.exitCode !== null || proc.signalCode !== null) done();
    else proc.once('close', () => done());
  });
  try {
    process.kill(-proc.pid, 'SIGKILL'); // negative pid -> whole process group
  } catch {
    try {
      proc.kill('SIGKILL');
    } catch {
      /* already gone */
    }
  }
  await closed;
});

describe('traceparent through middleware, standalone server (#2627)', () => {
  it('an incoming traceparent is the root of the trace the handler runs in, and middleware overrides still apply', async () => {
    const seen = await echo('/api/echo', INCOMING);
    expect(seen.activeTraceId).toBe(TRACE_ID);
    expect(seen.traceparentHeader?.split('-')[1]).toBe(TRACE_ID);
    expect(seen.mwOverride).toBe('applied');
  });

  it('a missing traceparent is detected: the handler gets a fresh valid trace id, distinct per request', async () => {
    const a = await echo('/api/echo');
    const b = await echo('/api/echo');
    expect(a.activeTraceId).toMatch(VALID_ID);
    expect(b.activeTraceId).toMatch(VALID_ID);
    expect(a.activeTraceId).not.toBe(b.activeTraceId);
    expect(a.activeTraceId).not.toBe(TRACE_ID);
    expect(a.mwOverride).toBe('applied');
  });

  // Guards REGISTRATION (the SDK is actually installed in this process) and the
  // UPSTREAM W3C propagator's rejection of malformed input. That rejection is not
  // knext-owned behaviour: a failure here means registration broke or an
  // OTel/@vercel/otel bump changed parsing.
  it('a malformed traceparent is detected: never adopted, a fresh valid trace id is used', async () => {
    const seen = await echo('/api/echo', 'not-a-traceparent');
    expect(seen.activeTraceId).toMatch(VALID_ID);
    expect(seen.activeTraceId).not.toBe(TRACE_ID);
    expect(seen.mwOverride).toBe('applied');
  });

  it('a middleware-set traceparent reaches the handler as a request-header override', async () => {
    const seen = await echo('/api/echo/mw-sets', INCOMING);
    expect(seen.traceparentHeader).toBe(MW_TRACEPARENT);
    expect(seen.mwOverride).toBe('applied');
    // ...and it starts its OWN trace: the handler runs under the middleware's
    // trace id, not the incoming one (measured on Next 16.4.3).
    expect(seen.activeTraceId).toBe(MW_TRACEPARENT.split('-')[1]);
    expect(seen.activeTraceId).not.toBe(TRACE_ID);
  });
});
