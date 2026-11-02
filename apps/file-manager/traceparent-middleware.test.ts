// #2627 — knext-owned traceparent-through-middleware test.
//
// Replaces the coverage lost when upstream `otel-middleware-trace` (Next 16.4.1+)
// was quarantined as Vercel-topology coupled (ADR-0007 §h): that file snapshots
// span TREES shaped by Vercel's separate middleware/render functions. What it is
// ABOUT — trace context surviving middleware to the handler — is asserted here on
// knext's own topology: ONE `next start` process serving middleware + handler,
// with `@vercel/otel` registered exactly as `apps/file-manager` registers it.
//
// Hermetic: real `next build` + `next start` of a tiny fixture on a free local
// port. No cluster, no network beyond loopback.
//
// Both halves are asserted: a good trace id survives to the handler, AND a
// missing / malformed one is detected (fresh valid id, never the garbage).

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { freePort } from './e2e-support/child-ports';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, '__fixtures__', 'traceparent-app');
const NEXT_BIN = join(HERE, 'node_modules', 'next', 'dist', 'bin', 'next');

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

async function echo(path: string, traceparent?: string): Promise<Echo> {
  const res = await fetch(`${base}${path}`, {
    headers: traceparent ? { traceparent } : {},
  });
  expect(res.status).toBe(200);
  return (await res.json()) as Echo;
}

/** Poll until the server answers; fail fast (with stderr) if it exits first. */
async function waitReady(proc: ChildProcess): Promise<void> {
  let exited: string | undefined;
  proc.once('exit', (code, sig) => {
    exited = `code ${code} signal ${sig}`;
  });
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (exited) throw new Error(`fixture next start exited early: ${exited}`);
    try {
      const r = await fetch(`${base}/api/echo`);
      if (r.status === 200) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('fixture next start never became ready within 60s');
}

beforeAll(async () => {
  const build = spawnSync('node', [NEXT_BIN, 'build', '--webpack'], {
    cwd: FIXTURE,
    encoding: 'utf8',
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' },
  });
  if (build.status !== 0) {
    throw new Error(`fixture next build failed:\n${build.stdout}\n${build.stderr}`);
  }
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  server = spawn('node', [NEXT_BIN, 'start', '-p', String(port), '-H', '127.0.0.1'], {
    cwd: FIXTURE,
    stdio: 'ignore',
    env: { ...process.env, NEXT_TELEMETRY_DISABLED: '1' },
  });
  await waitReady(server);
}, 180_000);

afterAll(() => {
  server?.kill('SIGTERM');
});

describe('traceparent through middleware on knext topology (#2627)', () => {
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
