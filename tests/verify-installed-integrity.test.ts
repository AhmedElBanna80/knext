import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { lockedPackage, verifyInstalledIntegrity } from '../scripts/verify-installed-integrity.mjs';

const ROOT = resolve(import.meta.dir, '..');
const SCRIPT = resolve(ROOT, 'scripts/verify-installed-integrity.mjs');
const LOCK = `{
  "packages": {
    "typescript": ["typescript@5.9.3", "", { "bin": { "tsc": "bin/tsc", "tsserver": "bin/tsserver" } }, "sha512-TSINT"],
    "typescript-tsc7": ["typescript@7.0.2", "", { "bin": { "tsc": "bin/tsc" } }, "sha512-OTHER"],
    "yaml": ["yaml@2.9.0", "", { "bin": { "yaml": "bin.mjs" } }, "sha512-YAMLINT"],
  }
}`;
const installed = (over: Record<string, { version: string; integrity: string }> = {}) =>
  JSON.stringify({
    packages: {
      'node_modules/typescript': { version: '5.9.3', integrity: 'sha512-TSINT' },
      'node_modules/yaml': { version: '2.9.0', integrity: 'sha512-YAMLINT' },
      ...over,
    },
  });
const check = (installedLockText: string, packages = ['typescript', 'yaml'], lockText = LOCK) =>
  verifyInstalledIntegrity({ lockText, installedLockText, packages });

describe('lockedPackage', () => {
  it('reads the exact top-level entry, not a name-prefixed sibling', () => {
    expect(lockedPackage(LOCK, 'typescript')).toEqual({
      version: '5.9.3',
      integrity: 'sha512-TSINT',
    });
    expect(lockedPackage(LOCK, 'yaml')).toEqual({ version: '2.9.0', integrity: 'sha512-YAMLINT' });
  });
  it('throws for a package with no entry', () => {
    expect(() => lockedPackage(LOCK, 'left-pad')).toThrow(/no top-level left-pad entry/);
  });
});

describe('verifyInstalledIntegrity (fail closed)', () => {
  it('accepts matching version and integrity for every package', () => {
    expect(() => check(installed())).not.toThrow();
  });
  it('rejects a tampered integrity', () => {
    expect(() =>
      check(installed({ 'node_modules/yaml': { version: '2.9.0', integrity: 'sha512-EVIL' } })),
    ).toThrow(/yaml@2\.9\.0 integrity mismatch/);
  });
  it('rejects a version that is not the lockfile pin', () => {
    expect(() =>
      check(installed({ 'node_modules/yaml': { version: '2.8.0', integrity: 'sha512-YAMLINT' } })),
    ).toThrow(/installed yaml is 2\.8\.0, lockfile pins 2\.9\.0/);
  });
  it('rejects a package missing from the installed lockfile', () => {
    const t = JSON.parse(installed());
    delete t.packages['node_modules/typescript'];
    expect(() => check(JSON.stringify(t))).toThrow(/typescript is not in the installed lockfile/);
    expect(() => check(JSON.stringify({}))).toThrow(/not in the installed lockfile/);
  });
  it('rejects a package the lockfile does not pin, an empty package list and bad JSON', () => {
    expect(() => check(installed(), ['left-pad'])).toThrow(/no top-level left-pad entry/);
    expect(() => check(installed(), [])).toThrow(/no packages to verify/);
    expect(() => check('not json')).toThrow();
  });
  it('checks every package, not only the first', () => {
    expect(() =>
      check(installed({ 'node_modules/yaml': { version: '2.9.0', integrity: 'sha512-EVIL' } }), [
        'typescript',
        'yaml',
      ]),
    ).toThrow(/yaml/);
  });
});

describe('the CLI exits nonzero on every failure and 0 only on a match', () => {
  const run = (setup: (prefix: string) => void, ...pkgs: string[]) => {
    const dir = mkdtempSync(resolve(tmpdir(), 'verify-integrity-'));
    try {
      writeFileSync(resolve(dir, 'bun.lock'), LOCK);
      setup(dir);
      return spawnSync(
        process.execPath,
        [SCRIPT, '--prefix', dir, '--lock', resolve(dir, 'bun.lock'), ...pkgs],
        { encoding: 'utf8' },
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  const writeInstalled = (text: string) => (dir: string) => {
    mkdirSync(resolve(dir, 'node_modules'), { recursive: true });
    writeFileSync(resolve(dir, 'node_modules/.package-lock.json'), text);
  };
  it('0 on a match', () => {
    const r = run(writeInstalled(installed()), 'typescript', 'yaml');
    expect(r.status).toBe(0);
  });
  it('1 on a tampered integrity', () => {
    const r = run(
      writeInstalled(
        installed({ 'node_modules/yaml': { version: '2.9.0', integrity: 'sha512-EVIL' } }),
      ),
      'typescript',
      'yaml',
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('integrity mismatch');
  });
  it('1 on a missing entry', () => {
    const t = JSON.parse(installed());
    delete t.packages['node_modules/yaml'];
    const r = run(writeInstalled(JSON.stringify(t)), 'typescript', 'yaml');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('not in the installed lockfile');
  });
  it('1 on a missing hidden lockfile (nothing was installed)', () => {
    const r = run(() => {}, 'typescript', 'yaml');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('FAILED');
  });
  it('1 with no packages or no prefix (usage)', () => {
    expect(run(writeInstalled(installed())).status).toBe(1);
    expect(spawnSync(process.execPath, [SCRIPT, 'yaml'], { encoding: 'utf8' }).status).toBe(1);
  });
});

describe('the ratchet job runs it after the install and before the node_modules link', () => {
  const ci = readFileSync(resolve(ROOT, '.github/workflows/ci.yml'), 'utf8');
  const start = ci.indexOf('\n  prover-unattributed-ratchet:');
  const job = start === -1 ? '' : ci.slice(start + 1, ci.indexOf('\n  compat-smoke:', start));
  it('orders install, verify, link', () => {
    const install = job.indexOf('npm install --prefix');
    const verify = job.indexOf('node scripts/verify-installed-integrity.mjs');
    const link = job.indexOf('ln -s');
    expect(install).toBeGreaterThan(-1);
    expect(verify).toBeGreaterThan(install);
    expect(link).toBeGreaterThan(verify);
  });
  it('verifies every package the job installs, from the same prefix', () => {
    const verifyLine = job.match(/node scripts\/verify-installed-integrity\.mjs[^\n]*/)?.[0] ?? '';
    expect(verifyLine).toContain('--prefix "$RUNNER_TEMP/ratchet-deps"');
    for (const pkg of ['typescript', 'yaml'])
      expect(verifyLine).toMatch(new RegExp(`\\b${pkg}\\b`));
  });
});
