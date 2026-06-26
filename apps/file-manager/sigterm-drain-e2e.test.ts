// @vitest-environment node
//
// This e2e makes real cross-origin HTTP calls to localhost child processes; the
// repo's default `apps` project runs happy-dom, whose fetch enforces a
// Same-Origin Policy that blocks those calls. Force the node environment so the
// drain proof exercises real sockets, not a DOM fetch shim.
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

/**
 * Container/process-level SIGTERM-drain e2e for the knext runtime entry.
 *
 * The unit test (packages/kn-next/.../shutdown.test.ts) proves gracefulShutdown's
 * logic with a child-process DOUBLE. It does NOT prove that the runtime entry,
 * run as the actual container process, forwards a real SIGTERM to a real child
 * and waits for in-flight requests to finish. That end-to-end path is the gap
 * that lets a regression (e.g. the Dockerfile bare-exec'ing server.js) silently
 * drop in-flight requests on scale-down — exactly what security.md forbids.
 *
 * This test boots the REAL, BUILT @knext/core node-server runtime entry
 * (dist/adapters/node-server.js — the exact module the container's
 * `@knext/core/internal/node-server` specifier resolves to) as a child process,
 * points it at a fixture standalone server via STANDALONE_SERVER_PATH, issues a
 * slow in-flight request, sends SIGTERM to the runtime entry, and asserts:
 *   1. the in-flight request COMPLETES (200 "drained") — not dropped, and
 *   2. the runtime process exits cleanly (code 0).
 *
 * This is a process-level (not full kind/pod) e2e — per the issue's AC4, the
 * deliverable when full pod infra is too heavy to land cleanly. It still runs
 * the genuine runtime entrypoint code (signal forwarding + drain), which is the
 * gap the unit test cannot cover.
 *
 * Skips (does not fail) when the dist build is absent, so it is non-blocking in
 * a source-only checkout; CI builds @knext/core before running it.
 *
 * Written RED-first: a runtime entry that does not forward SIGTERM + wait for
 * the child to drain would have the in-flight request killed → this fails.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');
// The BUILT runtime entry — exactly what `@knext/core/internal/node-server`
// resolves to inside the standalone bundle the Dockerfile ships.
const NODE_SERVER_DIST = resolve(REPO_ROOT, 'packages/kn-next/dist/adapters/node-server.js');
const SLOW_SERVER = resolve(__dirname, '__fixtures__/slow-standalone-server.mjs');

const PORT = 39187; // unlikely-to-collide test port
const METRICS_PORT = 9091;

let child: ReturnType<typeof spawn> | undefined;

// The runtime entry is plain Node; clear any harness NODE_OPTIONS preload so the
// spawned `node` starts cleanly in any environment.
function childEnv(extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  const env = { ...process.env, ...extra };
  delete env.NODE_OPTIONS;
  return env;
}

afterEach(() => {
  if (child && child.exitCode === null) {
    child.kill('SIGKILL');
  }
  child = undefined;
});

function spawnRuntime(extraEnv: Record<string, string>): ReturnType<typeof spawn> {
  return spawn('node', [NODE_SERVER_DIST], {
    cwd: REPO_ROOT,
    env: childEnv({
      PORT: String(PORT),
      STANDALONE_SERVER_PATH: SLOW_SERVER,
      STORAGE_BUCKET: '', // disable image-cache sync side effects
      ...extraEnv,
    }),
    stdio: ['ignore', 'pipe', 'inherit'],
  });
}

function waitForListening(proc: ReturnType<typeof spawn>): Promise<void> {
  return new Promise((resolvePromise, reject) => {
    const timeout = setTimeout(
      () => reject(new Error('fixture server never reported LISTENING')),
      25_000,
    );
    let buf = '';
    proc.stdout?.on('data', (d: Buffer) => {
      buf += d.toString();
      if (buf.includes(`LISTENING:${PORT}`)) {
        clearTimeout(timeout);
        resolvePromise();
      }
    });
    proc.once('exit', (code) => {
      clearTimeout(timeout);
      reject(new Error(`runtime entry exited early (code ${code}) before listening`));
    });
  });
}

describe('SIGTERM drain e2e: knext runtime entry drains in-flight requests on scale-down', () => {
  it.skipIf(!existsSync(NODE_SERVER_DIST))(
    'completes an in-flight request after SIGTERM and exits cleanly',
    async () => {
      let stdout = '';
      child = spawnRuntime({ SHUTDOWN_GRACE_MS: '10000' });
      child.stdout?.on('data', (d: Buffer) => {
        stdout += d.toString();
      });

      await waitForListening(child);

      // Fire a slow in-flight request; do NOT await it yet.
      const inFlight = fetch(`http://127.0.0.1:${PORT}/slow`).then((r) => r.text());

      // Let the request be accepted, then SIGTERM the runtime entry.
      await new Promise((r) => setTimeout(r, 300));
      child.kill('SIGTERM');

      // The in-flight request MUST still complete (drained), not be dropped.
      const body = await inFlight;
      expect(body).toBe('drained');

      // The runtime entry must exit cleanly after the child drains.
      const exitCode = await new Promise<number | null>((r) => {
        if (child?.exitCode != null) {
          r(child.exitCode);
          return;
        }
        child?.once('exit', (code) => r(code));
      });
      expect(exitCode).toBe(0);

      // The fixture proves the signal was actually forwarded + the drain ran.
      expect(stdout).toContain('SIGTERM-RECEIVED');
      expect(stdout).toContain('DRAINED-EXIT');
    },
    40_000,
  );

  it.skipIf(!existsSync(NODE_SERVER_DIST))(
    'serves the Prometheus metrics sidecar while the runtime entry is up',
    async () => {
      child = spawnRuntime({});
      await waitForListening(child);

      const res = await fetch(`http://127.0.0.1:${METRICS_PORT}/metrics`);
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toMatch(/process_cpu|nodejs_/); // default metrics present

      child.kill('SIGTERM');
    },
    40_000,
  );
});
