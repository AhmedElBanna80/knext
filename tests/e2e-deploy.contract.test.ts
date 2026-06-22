import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Contract test for scripts/e2e-deploy.sh + scripts/e2e-cleanup.sh (#89, ADR-0007 A3-2).
 *
 * The official Next.js deploy-test harness invokes our deploy script per fixture app
 * (cwd = the app's temp dir) and reads exactly ONE stdout line — the deployment URL —
 * to drive its e2e tests. This test verifies that contract WITHOUT cloning
 * vercel/next.js, by shimming `next` on PATH so `next build` fabricates a minimal
 * standalone server. It exercises the REAL deploy-script logic: build invocation,
 * asset staging, server boot on a free port, TCP readiness probe, single-line URL
 * echo, and BUILD_ID/DEPLOYMENT_ID persistence to .adapter-build.log. cleanup then
 * frees the port.
 *
 * Deploy / logs / cleanup are SEPARATE processes that communicate only via the log
 * file — exactly as the harness runs them.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..');
const DEPLOY_SH = resolve(REPO_ROOT, 'scripts/e2e-deploy.sh');
const CLEANUP_SH = resolve(REPO_ROOT, 'scripts/e2e-cleanup.sh');

let appDir = '';
let binDir = '';
let deployStdout = '';
let parsedPort = 0;

/** A standalone server.js that a fake `next build` would emit: serves HTTP on $PORT. */
const FAKE_SERVER_JS = `
const http = require('node:http');
const port = Number(process.env.PORT || 3000);
const host = process.env.HOSTNAME || '0.0.0.0';
http.createServer((req, res) => {
  res.writeHead(200, { 'content-type': 'text/html' });
  res.end('<!doctype html><html><body>knext e2e fixture ok</body></html>');
}).listen(port, host, () => {
  console.log('fixture standalone server listening on ' + host + ':' + port);
});
`;

/** A fake `next` CLI: on `build`, emit BUILD_ID + a standalone server tree. */
function fakeNextScript(targetAppDir: string): string {
  return `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const cmd = process.argv[2];
if (cmd !== 'build') { process.exit(0); }
const app = ${JSON.stringify(targetAppDir)};
const nextDir = path.join(app, '.next');
const standalone = path.join(nextDir, 'standalone');
fs.mkdirSync(path.join(nextDir, 'static'), { recursive: true });
fs.mkdirSync(standalone, { recursive: true });
fs.writeFileSync(path.join(nextDir, 'BUILD_ID'), 'fixture-build-' + Date.now());
fs.writeFileSync(path.join(standalone, 'server.js'), ${JSON.stringify(FAKE_SERVER_JS)});
console.log('[fake-next] build complete (fixture)');
`;
}

function tcpConnects(port: number, host = '127.0.0.1', timeoutMs = 3000): Promise<boolean> {
  return new Promise((res) => {
    const sock = connect({ port, host });
    const done = (ok: boolean) => {
      sock.destroy();
      res(ok);
    };
    sock.setTimeout(timeoutMs);
    sock.once('connect', () => done(true));
    sock.once('timeout', () => done(false));
    sock.once('error', () => done(false));
  });
}

describe('scripts/e2e-deploy.sh — official deploy-script contract (#89)', () => {
  beforeAll(() => {
    appDir = mkdtempSync(join(tmpdir(), 'knext-e2e-app-'));
    binDir = mkdtempSync(join(tmpdir(), 'knext-e2e-bin-'));

    // minimal fixture app
    writeFileSync(
      join(appDir, 'package.json'),
      JSON.stringify({ name: 'fixture-app', version: '0.0.0', private: true }, null, 2),
    );
    writeFileSync(join(appDir, 'next.config.js'), "module.exports = { output: 'standalone' };\n");

    // PATH shim for `next`
    const nextBin = join(binDir, 'next');
    writeFileSync(nextBin, fakeNextScript(appDir));
    chmodSync(nextBin, 0o755);

    // Run the deploy script with cwd = the fixture app, `next` shimmed on PATH.
    // KNEXT_E2E_SKIP_PACK lets the contract test bypass the real `npm pack`/install
    // of the adapter tarball (network + build heavy); the script still does
    // everything else for real.
    const out = execFileSync('bash', [DEPLOY_SH], {
      cwd: appDir,
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH}`,
        KNEXT_E2E_SKIP_PACK: '1',
        KNEXT_RUNTIME: 'node',
      },
      encoding: 'utf8',
      timeout: 60000,
    });
    deployStdout = out;
  });

  afterAll(() => {
    if (existsSync(CLEANUP_SH) && appDir) {
      spawnSync('bash', [CLEANUP_SH], {
        cwd: appDir,
        env: { ...process.env },
        encoding: 'utf8',
        timeout: 20000,
      });
    }
    for (const d of [appDir, binDir]) {
      if (d && existsSync(d)) rmSync(d, { recursive: true, force: true });
    }
  });

  it('emits EXACTLY one stdout line (the deployment URL)', () => {
    const lines = deployStdout.split('\n').filter((l) => l.trim().length > 0);
    expect(lines.length).toBe(1);
  });

  it('the single stdout line is a parseable http://localhost:<port> URL', () => {
    const line = deployStdout.trim();
    const url = new URL(line);
    expect(url.protocol).toBe('http:');
    expect(['localhost', '127.0.0.1']).toContain(url.hostname);
    parsedPort = Number(url.port);
    expect(parsedPort).toBeGreaterThan(0);
  });

  it('the advertised port accepts a TCP connection (server really booted)', async () => {
    expect(parsedPort).toBeGreaterThan(0);
    expect(await tcpConnects(parsedPort)).toBe(true);
  });

  it('.adapter-build.log records BUILD_ID and DEPLOYMENT_ID', () => {
    const logPath = join(appDir, '.adapter-build.log');
    expect(existsSync(logPath)).toBe(true);
    const log = readFileSync(logPath, 'utf8');
    expect(log).toMatch(/BUILD_ID=.+/);
    expect(log).toMatch(/DEPLOYMENT_ID=.+/);
    expect(log).toMatch(/PORT=\d+/);
    expect(log).toMatch(/PID=\d+/);
  });

  it('e2e-cleanup.sh frees the port (server torn down)', async () => {
    expect(parsedPort).toBeGreaterThan(0);
    const r = spawnSync('bash', [CLEANUP_SH], {
      cwd: appDir,
      env: { ...process.env },
      encoding: 'utf8',
      timeout: 20000,
    });
    expect(r.status).toBe(0);
    // give SIGTERM a beat to release the socket
    await new Promise((res) => setTimeout(res, 1500));
    expect(await tcpConnects(parsedPort)).toBe(false);
  });
});
