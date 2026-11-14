import { afterAll, beforeAll, describe, expect, it, setDefaultTimeout } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { decideRetry } from '../scripts/lib/e2e-eresolve-retry.mjs';

/**
 * #2296 — at vercel/next.js v16.4.0 three deploy-suite files that used to set
 * `skipDeployment` now deploy (gssp-redirect, gssp-redirect-base-path,
 * router-hash-navigation), and each pins `react@19.3.0-canary-…` in its own
 * fixture. next@16.4.0 peers on `react ^19.0.0`, which excludes prereleases,
 * so e2e-deploy.sh's `npm install <knext tarballs>` into that tree failed with
 * ERESOLVE before knext was ever built (v2 run 38384745675, shards 3/7/8).
 * Vercel installs the same fixtures with pnpm, which only warns on a peer
 * mismatch. The conflict is the fixture's own pin against next's peer range,
 * not anything knext ships.
 *
 * The fix retries the tarball install ONCE with --legacy-peer-deps, and only
 * when the first attempt failed with an ERESOLVE whose report names no
 * @getknext/* package (#2319, scripts/lib/e2e-eresolve-retry.mjs), so every fixture that installs
 * today keeps exactly today's install. This test runs the REAL deploy script
 * through its REAL npm path, offline, on a tree that reproduces the ERESOLVE,
 * and checks the other half too: a non-ERESOLVE install failure still fails
 * the deploy (no blanket retry).
 */

// bun IGNORES `describe(name, { timeout }, fn)` and runs every case and hook under its
// 5000 ms default, but this file runs a REAL scripts/e2e-deploy.sh (spawn budget
// 120 s) and scripts/e2e-cleanup.sh (20 s). `setDefaultTimeout` is the form bun
// honours. File-scoped and equal to spawn + cleanup, so a real hang still fails at
// the spawn timeout rather than being masked by a longer test budget.
setDefaultTimeout(140_000);

const REPO_ROOT = resolve(import.meta.dirname, '..');
const DEPLOY_SH = resolve(REPO_ROOT, 'scripts/e2e-deploy.sh');
const CLEANUP_SH = resolve(REPO_ROOT, 'scripts/e2e-cleanup.sh');

const FAKE_SERVER_JS = `
const http = require('node:http');
const port = Number(process.env.PORT || 3000);
const host = process.env.HOSTNAME || '0.0.0.0';
http.createServer((req, res) => { res.writeHead(200); res.end('ok'); })
  .listen(port, host, () => console.log('fixture server on ' + host + ':' + port));
`;

function fakeNextScript(targetAppDir: string): string {
  return `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
if (process.argv[2] !== 'build') { process.exit(0); }
const app = ${JSON.stringify(targetAppDir)};
const nextDir = path.join(app, '.next');
const standalone = path.join(nextDir, 'standalone');
fs.mkdirSync(path.join(nextDir, 'static'), { recursive: true });
fs.mkdirSync(standalone, { recursive: true });
fs.writeFileSync(path.join(nextDir, 'BUILD_ID'), 'fixture-build-' + Date.now());
fs.writeFileSync(path.join(standalone, 'server.js'), ${JSON.stringify(FAKE_SERVER_JS)});
const tracedNext = path.join(standalone, 'node_modules', 'next');
fs.mkdirSync(path.join(tracedNext, 'dist', 'server', 'lib'), { recursive: true });
fs.writeFileSync(path.join(tracedNext, 'package.json'), '{"name":"next","main":"index.js"}');
fs.writeFileSync(path.join(tracedNext, 'index.js'), 'module.exports = {};');
fs.writeFileSync(path.join(tracedNext, 'dist', 'server', 'lib', 'start-server.js'), 'module.exports = {};');
console.log('[fake-next] build complete (fixture)');
`;
}

function packStub(
  stageDir: string,
  tarballsDir: string,
  pkg: Record<string, unknown>,
  files: Record<string, string>,
): void {
  const dir = join(stageDir, String(pkg.name).replace('/', '__'));
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'package.json'), JSON.stringify(pkg, null, 2));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(join(abs, '..'), { recursive: true });
    writeFileSync(abs, content);
  }
  execFileSync('npm', ['pack', '--pack-destination', tarballsDir], {
    cwd: dir,
    encoding: 'utf8',
    stdio: 'pipe',
  });
}

function packKnextStubs(
  stageDir: string,
  tarballsDir: string,
  corePeers: Record<string, string> = {},
): void {
  packStub(
    stageDir,
    tarballsDir,
    { name: '@getknext/lib', version: '0.0.0-test', main: 'index.js' },
    { 'index.js': 'module.exports = {};\n' },
  );
  packStub(
    stageDir,
    tarballsDir,
    { name: '@getknext/db', version: '0.0.0-test', main: 'index.js' },
    { 'index.js': 'module.exports = {};\n' },
  );
  packStub(
    stageDir,
    tarballsDir,
    {
      name: '@getknext/core',
      version: '0.0.0-test',
      exports: {
        './adapter': './dist/adapters/next-adapter.js',
        './internal/cache-control-normalize': './dist/adapters/cache-control-normalize.cjs',
        './internal/bun-keepalive-guard': './dist/adapters/bun-keepalive-guard.cjs',
      },
      dependencies: { '@getknext/lib': '0.0.0-test' },
      ...(Object.keys(corePeers).length > 0 ? { peerDependencies: corePeers } : {}),
    },
    {
      'dist/adapters/next-adapter.js': 'module.exports = {};\n',
      'dist/adapters/cache-control-normalize.cjs': 'module.exports = {};\n',
      'dist/adapters/bun-keepalive-guard.cjs': 'module.exports = {};\n',
    },
  );
}

/**
 * A harness test dir shaped like the v16.4.0 gssp-redirect fixture after the
 * harness's own install: the root pins a prerelease react, and an installed
 * package (standing in for next@16.4.0) peers on `react ^19.0.0`.
 */
function makeCanaryPinnedApp(): string {
  const appDir = mkdtempSync(join(tmpdir(), 'knext-e2e-eresolve-'));
  writeFileSync(
    join(appDir, 'package.json'),
    JSON.stringify(
      {
        name: 'fixture-app',
        version: '0.0.0',
        private: true,
        dependencies: { 'peer-host': '1.0.0', react: '19.3.0-canary-fef12a01-20260413' },
      },
      null,
      2,
    ),
  );
  const nm = join(appDir, 'node_modules');
  mkdirSync(join(nm, 'peer-host'), { recursive: true });
  writeFileSync(
    join(nm, 'peer-host', 'package.json'),
    JSON.stringify({ name: 'peer-host', version: '1.0.0', peerDependencies: { react: '^19.0.0' } }),
  );
  mkdirSync(join(nm, 'react'), { recursive: true });
  writeFileSync(
    join(nm, 'react', 'package.json'),
    JSON.stringify({ name: 'react', version: '19.3.0-canary-fef12a01-20260413', main: 'index.js' }),
  );
  writeFileSync(join(nm, 'react', 'index.js'), "module.exports = 'canary-react';\n");
  mkdirSync(join(nm, '.bin'), { recursive: true });
  const nextBin = join(nm, '.bin', 'next');
  writeFileSync(nextBin, fakeNextScript(appDir));
  chmodSync(nextBin, 0o755);
  return appDir;
}

function runDeploy(appDir: string, tarballsDir: string, deploySh: string = DEPLOY_SH) {
  return spawnSync('bash', [deploySh], {
    cwd: appDir,
    env: {
      ...process.env,
      KNEXT_E2E_TARBALLS_DIR: tarballsDir,
      KNEXT_RUNTIME: 'node',
      // Hermetic: every package involved is local; never reach a registry.
      npm_config_offline: 'true',
    },
    encoding: 'utf8',
    timeout: 120000,
  });
}

function cleanup(appDir: string): void {
  if (existsSync(CLEANUP_SH) && appDir) {
    spawnSync('bash', [CLEANUP_SH], { cwd: appDir, env: { ...process.env }, timeout: 20000 });
  }
  if (appDir && existsSync(appDir)) rmSync(appDir, { recursive: true, force: true });
}

describe('scripts/e2e-deploy.sh — a fixture pinning a prerelease react still installs the knext tarballs (#2296)', () => {
  let stageDir = '';
  let tarballsDir = '';
  let appDir = '';
  let result: ReturnType<typeof runDeploy>;

  beforeAll(() => {
    stageDir = mkdtempSync(join(tmpdir(), 'knext-e2e-eresolve-stubs-'));
    tarballsDir = join(stageDir, 'tarballs');
    mkdirSync(tarballsDir, { recursive: true });
    packKnextStubs(stageDir, tarballsDir);
    appDir = makeCanaryPinnedApp();
    result = runDeploy(appDir, tarballsDir);
  }, 150000);

  afterAll(() => {
    cleanup(appDir);
    if (stageDir && existsSync(stageDir)) rmSync(stageDir, { recursive: true, force: true });
  });

  it('self-check: a plain npm install of a tarball into this tree really fails with ERESOLVE', () => {
    const probeApp = makeCanaryPinnedApp();
    try {
      const r = spawnSync(
        'npm',
        [
          'install',
          '--no-save',
          '--no-audit',
          '--no-fund',
          join(tarballsDir, 'getknext-lib-0.0.0-test.tgz'),
        ],
        { cwd: probeApp, env: { ...process.env, npm_config_offline: 'true' }, encoding: 'utf8' },
      );
      expect(r.status).not.toBe(0);
      expect(`${r.stdout}${r.stderr}`).toContain('ERESOLVE');
      // the exact line scripts/lib/e2e-eresolve-retry.mjs gates the retry on
      expect(`${r.stdout}${r.stderr}`).toMatch(/^npm (?:error|ERR!) code ERESOLVE\s*$/m);
    } finally {
      rmSync(probeApp, { recursive: true, force: true });
    }
  });

  it('the deploy succeeds and prints exactly one URL line', () => {
    expect(result.status, result.stderr).toBe(0);
    const lines = result.stdout.split('\n').filter((l) => l.trim().length > 0);
    expect(lines.length).toBe(1);
    expect(() => new URL(lines[0])).not.toThrow();
  });

  it('the knext adapter tarball really installed into the fixture', () => {
    const r = spawnSync(
      'node',
      ['-e', 'process.stdout.write(require.resolve("@getknext/core/adapter"))'],
      { cwd: appDir, encoding: 'utf8' },
    );
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain(join('@getknext', 'core'));
  });

  it("the fixture's own prerelease react pin is left in place", () => {
    const r = spawnSync('node', ['-e', 'process.stdout.write(require("react"))'], {
      cwd: appDir,
      encoding: 'utf8',
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe('canary-react');
  });

  it('the retry is logged, naming ERESOLVE and --legacy-peer-deps', () => {
    expect(result.stderr).toMatch(/ERESOLVE.*--legacy-peer-deps|--legacy-peer-deps.*ERESOLVE/);
  });
});

describe('scripts/e2e-deploy.sh — a NON-ERESOLVE install failure still fails the deploy (#2296)', () => {
  let stageDir = '';
  let appDir = '';
  let result: ReturnType<typeof runDeploy>;

  beforeAll(() => {
    stageDir = mkdtempSync(join(tmpdir(), 'knext-e2e-badtgz-stubs-'));
    const tarballsDir = join(stageDir, 'tarballs');
    mkdirSync(tarballsDir, { recursive: true });
    packKnextStubs(stageDir, tarballsDir);
    // Corrupt the core tarball: npm fails with a tar/gzip error, not ERESOLVE.
    writeFileSync(join(tarballsDir, 'getknext-core-0.0.0-test.tgz'), 'not a gzip stream\n');
    appDir = makeCanaryPinnedApp();
    result = runDeploy(appDir, tarballsDir);
  }, 150000);

  afterAll(() => {
    cleanup(appDir);
    if (stageDir && existsSync(stageDir)) rmSync(stageDir, { recursive: true, force: true });
  });

  it('exits non-zero and does not print a URL', () => {
    expect(result.status).not.toBe(0);
    expect(result.stdout.trim()).toBe('');
  });

  it('does not retry with --legacy-peer-deps', () => {
    expect(result.stderr).not.toContain('--legacy-peer-deps');
  });

  it('the helper refused it as not an ERESOLVE, not for some other reason', () => {
    expect(result.stderr).toContain('e2e-eresolve-retry: no retry: not an ERESOLVE refusal');
  });
});

describe('scripts/e2e-deploy.sh — a helper that never decides (crash, missing) fails the deploy, never retried (#2319)', () => {
  // A retryable fixture ERESOLVE (the canary react pin), so the ONLY thing that
  // stops the retry is the helper's missing verdict. The deploy script and its
  // lib/ are copied so the helper can be replaced without touching the repo; the
  // failing install exits before anything resolves outside scripts/.
  let stageDir = '';
  let tarballsDir = '';
  beforeAll(() => {
    stageDir = mkdtempSync(join(tmpdir(), 'knext-e2e-helper-crash-'));
    tarballsDir = join(stageDir, 'tarballs');
    mkdirSync(tarballsDir, { recursive: true });
    packKnextStubs(stageDir, tarballsDir);
  }, 150000);
  afterAll(() => {
    if (stageDir && existsSync(stageDir)) rmSync(stageDir, { recursive: true, force: true });
  });

  // The stub keeps a copy of the install log it was handed, so the test can ask
  // the real helper what it would have decided.
  const KEEP_LOG =
    "import { copyFileSync } from 'node:fs';\ncopyFileSync(process.argv[2], `${process.argv[2]}.seen`);\n";
  const withHelper = (name: string, helper: string | null) => {
    const scripts = join(stageDir, name, 'scripts');
    cpSync(join(REPO_ROOT, 'scripts/lib'), join(scripts, 'lib'), { recursive: true });
    writeFileSync(join(scripts, 'e2e-deploy.sh'), readFileSync(DEPLOY_SH, 'utf8'));
    const helperPath = join(scripts, 'lib', 'e2e-eresolve-retry.mjs');
    if (helper === null) rmSync(helperPath);
    else writeFileSync(helperPath, helper);
    return join(scripts, 'e2e-deploy.sh');
  };

  for (const [name, helper] of [
    ['throws', `${KEEP_LOG}throw new Error('helper crashed before deciding');\n`],
    ['exits 0 silently', `${KEEP_LOG}process.exit(0);\n`],
    ['is missing', null],
  ] as const) {
    it(`the helper ${name}: the deploy exits non-zero without retrying`, () => {
      const appDir = makeCanaryPinnedApp();
      try {
        const r = runDeploy(appDir, tarballsDir, withHelper(name.replace(/ /g, '-'), helper));
        expect(r.status).not.toBe(0);
        expect(r.stdout.trim()).toBe('');
        if (helper === null) {
          expect(r.stderr).toMatch(/Cannot find module|ERR_MODULE_NOT_FOUND/);
        } else {
          // The stub kept the log it was handed: the REAL helper would have
          // retried it, so only the stub's missing verdict stopped the retry.
          const seen = readFileSync(join(appDir, '.knext-npm-install.log.seen'), 'utf8');
          expect(decideRetry(seen).retry, seen.slice(-2000)).toBe(true);
        }
        expect(r.stderr).not.toContain('retrying once with --legacy-peer-deps');
        expect(r.stderr).toContain('was not retried');
        expect(existsSync(join(appDir, '.knext-npm-install.log'))).toBe(false);
      } finally {
        cleanup(appDir);
      }
    });
  }
});

describe("scripts/e2e-deploy.sh — an ERESOLVE in knext's OWN peer range fails the deploy, never retried (#2319)", () => {
  let stageDir = '';
  let appDir = '';
  let result: ReturnType<typeof runDeploy>;

  beforeAll(() => {
    stageDir = mkdtempSync(join(tmpdir(), 'knext-e2e-knext-peer-stubs-'));
    const tarballsDir = join(stageDir, 'tarballs');
    mkdirSync(tarballsDir, { recursive: true });
    // @getknext/core with a NON-optional peer the fixture cannot satisfy: a real
    // conflict in knext's own packages, which --legacy-peer-deps would hide.
    packKnextStubs(stageDir, tarballsDir, { react: '^99.0.0' });
    appDir = makeCanaryPinnedApp();
    result = runDeploy(appDir, tarballsDir);
  }, 150000);

  afterAll(() => {
    cleanup(appDir);
    if (stageDir && existsSync(stageDir)) rmSync(stageDir, { recursive: true, force: true });
  });

  it('exits non-zero and does not print a URL', () => {
    expect(result.status).not.toBe(0);
    expect(result.stdout.trim()).toBe('');
  });

  it("does not retry with --legacy-peer-deps, and says the conflict is knext's", () => {
    expect(result.stderr).not.toContain('retrying once with --legacy-peer-deps');
    expect(result.stderr).toContain("names knext's own package(s): @getknext/core");
  });
});

describe('scripts/lib/e2e-eresolve-retry.mjs — which ERESOLVE may be retried (#2319)', () => {
  const fixtureConflict = [
    'npm error code ERESOLVE',
    'npm error ERESOLVE unable to resolve dependency tree',
    'npm error While resolving: fixture-app@0.0.0',
    'npm error Found: react@19.3.0-canary-fef12a01-20260413',
    'npm error Could not resolve dependency:',
    'npm error peer react@"^19.0.0" from next@16.4.3',
  ].join('\n');

  it("retries a conflict that is the fixture's own pin", () => {
    expect(decideRetry(fixtureConflict).retry).toBe(true);
  });
  it('refuses when knext declares the conflicting peer', () => {
    const log = fixtureConflict.replace('from next@16.4.3', 'from @getknext/core@2.0.0');
    expect(decideRetry(log)).toEqual({
      retry: false,
      reason: "the conflict names knext's own package(s): @getknext/core",
    });
  });
  it('refuses when knext is the package being resolved', () => {
    const log = fixtureConflict.replace(
      'While resolving: fixture-app@0.0.0',
      'While resolving: @getknext/db@2.0.0',
    );
    expect(decideRetry(log).retry).toBe(false);
  });
  it('refuses when knext is only the package found, or only on a path line', () => {
    expect(decideRetry(`${fixtureConflict}\nnpm error Found: @getknext/core@2.0.0`).retry).toBe(
      false,
    );
    expect(decideRetry(`${fixtureConflict}\nnpm error   node_modules/@getknext/lib`).retry).toBe(
      false,
    );
  });
  it('refuses a different failure whose log only carries an ERESOLVE warning line', () => {
    const log = [
      'npm warn ERESOLVE overriding peer dependency',
      'npm warn While resolving: fixture-app@0.0.0',
      'npm error code EINTEGRITY',
      'npm error sha512-... integrity checksum failed',
    ].join('\n');
    expect(decideRetry(log).retry).toBe(false);
  });
  it('refuses on any mention of @getknext/, whatever its case or suffix', () => {
    expect(decideRetry(`${fixtureConflict}\nnpm error see @getknext/`).retry).toBe(false);
    expect(
      decideRetry(`${fixtureConflict}\nnpm error peer x@"1" from @GetKnext/Core@2.0.0`).retry,
    ).toBe(false);
  });
  it('refuses a failure that is not ERESOLVE', () => {
    expect(decideRetry('npm error code EINTEGRITY\n').retry).toBe(false);
  });
});

describe('scripts/lib/e2e-eresolve-retry.mjs as a CLI — its verdict is a printed "retry", never just exit 0 (#2319)', () => {
  const HELPER = resolve(REPO_ROOT, 'scripts/lib/e2e-eresolve-retry.mjs');
  const LOG = [
    'npm error code ERESOLVE',
    'npm error While resolving: fixture-app@0.0.0',
    'npm error peer react@"^19.0.0" from next@16.4.3',
  ].join('\n');

  it('prints retry for a fixture conflict, even when the helper lives under a path with a space', () => {
    const dir = mkdtempSync(join(tmpdir(), 'knext eresolve '));
    try {
      const copy = join(dir, 'e2e-eresolve-retry.mjs');
      writeFileSync(copy, readFileSync(HELPER, 'utf8'));
      const log = join(dir, 'install log.txt');
      writeFileSync(log, LOG);
      const r = spawnSync('node', [copy, log], { encoding: 'utf8' });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toBe('retry\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prints nothing and exits 2 for an unreadable log', () => {
    const r = spawnSync('node', [HELPER, join(tmpdir(), 'knext-no-such-install-log')], {
      encoding: 'utf8',
    });
    expect(r.status).toBe(2);
    expect(r.stdout).toBe('');
  });

  it('the deploy script retries only on that exact output', () => {
    const sh = readFileSync(DEPLOY_SH, 'utf8');
    expect(sh).toContain(
      'if [ "$(node "${SCRIPT_DIR}/lib/e2e-eresolve-retry.mjs" "${NPM_INSTALL_LOG}" || true)" = "retry" ]; then',
    );
    expect(sh).not.toMatch(/grep -q .ERESOLVE./);
  });
});
