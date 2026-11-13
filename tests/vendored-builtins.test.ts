import { afterAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  advisoryView,
  findVendorHosts,
  relabelViewFindings,
  releaseLine,
  vendoredBuiltins,
  vendoredVersion,
} from '../scripts/lib/vendored-builtins.mjs';

/**
 * #61 — the closure SBOM recorded Next's vendored React Server Components as
 * UNKNOWN, and dropped @vitejs/plugin-rsc's vendored copy when projecting onto
 * the app closure, so a scan read clean while the code serving RSC requests was
 * an affected build. These fixtures mirror the real layouts measured on
 * next@16.3.5 and @vitejs/plugin-rsc@0.5.34.
 */

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'vendored-builtins-'));
  roots.push(root);
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(join(root, path, '..'), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  return root;
}

const CANARY = '19.3.0-canary-cbb046ab-20260731';
const EXPERIMENTAL = '19.3.0-experimental-cbb046ab-20260731';
const builtinPkg = (name: string) => JSON.stringify({ name: `${name}-builtin`, main: 'index.js' });
const cjs = (version: string) => `"use strict";\nexports.version = "${version}";\n`;

function nextPackage() {
  return tree({
    'package.json': JSON.stringify({ name: 'next', version: '16.3.5' }),
    'dist/compiled/react-server-dom-webpack/package.json': builtinPkg('react-server-dom-webpack'),
    'dist/compiled/react-server-dom-webpack/cjs/client.development.js': cjs(CANARY),
    'dist/compiled/react-server-dom-webpack/cjs/server.production.js': cjs(CANARY),
    'dist/compiled/react-server-dom-webpack-experimental/package.json': builtinPkg('x'),
    'dist/compiled/react-server-dom-webpack-experimental/cjs/a.js': cjs(EXPERIMENTAL),
    'dist/compiled/react/package.json': builtinPkg('react'),
    'dist/compiled/react/cjs/react.production.js': cjs(CANARY),
  });
}

describe('vendoredVersion', () => {
  it('reads the version literal out of the cjs builds when package.json has none', () => {
    const next = nextPackage();
    expect(vendoredVersion(join(next, 'dist/compiled/react-server-dom-webpack'))).toBe(CANARY);
  });

  it('prefers a declared package.json version', () => {
    const dir = tree({
      'package.json': JSON.stringify({ name: 'react-server-dom-webpack', version: '19.2.8' }),
      'cjs/a.js': cjs(CANARY),
    });
    expect(vendoredVersion(dir)).toBe('19.2.8');
  });

  it('returns null for a directory mixing two builds instead of guessing', () => {
    const dir = tree({
      'package.json': builtinPkg('r'),
      'cjs/a.js': cjs(CANARY),
      'cjs/b.js': cjs('19.2.9'),
    });
    expect(vendoredVersion(dir)).toBeNull();
  });

  it('returns null when no version literal is present', () => {
    const dir = tree({ 'package.json': builtinPkg('r'), 'cjs/a.js': 'module.exports = {};' });
    expect(vendoredVersion(dir)).toBeNull();
  });
});

describe('vendoredBuiltins', () => {
  it("reports next's vendored copies under their UPSTREAM names with the embedded version", () => {
    const { components, unresolved } = vendoredBuiltins([nextPackage()]);
    expect(unresolved).toEqual([]);
    const ids = components.map((c) => c.purl).sort();
    expect(ids).toEqual(
      [
        `pkg:npm/react-server-dom-webpack@${CANARY}`,
        `pkg:npm/react-server-dom-webpack@${EXPERIMENTAL}`,
        `pkg:npm/react@${CANARY}`,
      ].sort(),
    );
    const rsc = components.find(
      (c) => c.version === CANARY && c.name === 'react-server-dom-webpack',
    );
    expect(rsc?.properties).toEqual([
      { name: 'knext:vendored-in', value: 'next@16.3.5 dist/compiled/react-server-dom-webpack' },
    ]);
  });

  it("reports @vitejs/plugin-rsc's vendored react-server-dom-webpack", () => {
    const plugin = tree({
      'package.json': JSON.stringify({ name: '@vitejs/plugin-rsc', version: '0.5.34' }),
      'dist/vendor/react-server-dom/package.json': JSON.stringify({
        name: 'react-server-dom-webpack',
        version: '19.2.8',
      }),
    });
    const { components } = vendoredBuiltins([plugin]);
    expect(components.map((c) => c.purl)).toEqual(['pkg:npm/react-server-dom-webpack@19.2.8']);
  });

  it('reports an unreadable vendored copy as unresolved, never skips it', () => {
    const next = tree({
      'package.json': JSON.stringify({ name: 'next', version: '16.9.0' }),
      'dist/compiled/react-server-dom-turbopack/package.json': builtinPkg('t'),
      'dist/compiled/react-server-dom-turbopack/cjs/a.js': 'module.exports = {};',
    });
    const { components, unresolved } = vendoredBuiltins([next]);
    expect(components).toEqual([]);
    expect(unresolved).toEqual(['next@16.9.0 dist/compiled/react-server-dom-turbopack']);
  });

  it('ignores packages that are not known vendoring hosts', () => {
    const other = tree({
      'package.json': JSON.stringify({ name: 'react', version: '19.2.9' }),
      'dist/compiled/react/cjs/a.js': cjs(CANARY),
    });
    expect(vendoredBuiltins([other])).toEqual({ components: [], unresolved: [] });
  });

  it('lists the same host copy once even when the store holds it twice', () => {
    const next = nextPackage();
    expect(vendoredBuiltins([next, next]).components).toHaveLength(3);
  });
});

describe('advisory view of vendored prereleases', () => {
  it('maps a canary or experimental build to its release line', () => {
    expect(releaseLine(CANARY)).toBe('19.3.0');
    expect(releaseLine(EXPERIMENTAL)).toBe('19.3.0');
    expect(releaseLine('19.2.8')).toBeNull();
  });

  it('re-states only the prereleases, recording the build that actually ships', () => {
    const { components } = vendoredBuiltins([nextPackage()]);
    const plain = {
      name: 'react-server-dom-webpack',
      version: '19.2.8',
      purl: 'pkg:npm/react-server-dom-webpack@19.2.8',
    };
    const view = advisoryView([...components, plain]);
    expect(view.map((c) => c.purl).sort()).toEqual(
      [
        'pkg:npm/react-server-dom-webpack@19.3.0',
        'pkg:npm/react-server-dom-webpack@19.3.0',
        'pkg:npm/react@19.3.0',
      ].sort(),
    );
    const rsc = view.find((c) => c.name === 'react-server-dom-webpack');
    expect(rsc?.properties).toContainEqual({
      name: 'knext:ships-build',
      value: expect.stringMatching(/^19\.3\.0-/),
    });
  });
});

describe('review findings: no silent quiet, nested hosts, relabel, wiring', () => {
  it('a next whose RSC copies moved is UNRESOLVED, never an empty clean result', () => {
    const next = tree({
      'package.json': JSON.stringify({ name: 'next', version: '16.9.0' }),
      'dist/compiled/react-server/cjs/a.js': cjs(CANARY),
    });
    expect(vendoredBuiltins([next])).toEqual({
      components: [],
      unresolved: ['next@16.9.0 no vendored react-server-dom copy at the expected paths'],
    });
  });

  it('a plugin-rsc without its vendor directory is UNRESOLVED', () => {
    const plugin = tree({
      'package.json': JSON.stringify({ name: '@vitejs/plugin-rsc', version: '0.9.0' }),
    });
    expect(vendoredBuiltins([plugin]).unresolved).toHaveLength(1);
  });

  it('findVendorHosts finds top-level, scoped and NESTED (unhoisted) hosts', () => {
    const root = tree({
      'node_modules/next/package.json': JSON.stringify({ name: 'next', version: '16.4.3' }),
      'node_modules/@vitejs/plugin-rsc/package.json': JSON.stringify({
        name: '@vitejs/plugin-rsc',
        version: '0.5.39',
      }),
      'node_modules/vinext/package.json': JSON.stringify({ name: 'vinext', version: '1.0.0' }),
      'node_modules/vinext/node_modules/next/package.json': JSON.stringify({
        name: 'next',
        version: '16.3.5',
      }),
    });
    const hosts = findVendorHosts(join(root, 'node_modules')).map((d) => d.slice(root.length));
    expect(hosts.sort()).toEqual(
      [
        '/node_modules/@vitejs/plugin-rsc',
        '/node_modules/next',
        '/node_modules/vinext/node_modules/next',
      ].sort(),
    );
  });

  it('relabelViewFindings names EVERY shipped build behind a release line', () => {
    const { components } = vendoredBuiltins([nextPackage()]);
    const view = advisoryView(components);
    const [f] = relabelViewFindings(view, [
      {
        id: 'GHSA-x',
        severity: 'critical',
        package: 'react-server-dom-webpack',
        version: '19.3.0',
      },
    ]);
    expect(f.version).toBe(`19.3.0 (vendored build ${CANARY}, ${EXPERIMENTAL})`);
  });

  it('the audit script wires every step: host discovery, fail on unresolved, SBOM append, second pass', () => {
    const src = readFileSync(
      join(import.meta.dir, '../scripts/precompile-closure-audit.mjs'),
      'utf8',
    );
    expect(src).toMatch(/appPackageDirs \?\? findVendorHosts\(nodeModules\)/);
    expect(src).toMatch(/if \(vendored\.unresolved\.length > 0\) \{[\s\S]{0,200}fail\(/);
    expect(src).toMatch(
      /components: \[\.\.\.\(sbom\.components \?\? \[\]\), \.\.\.vendored\.components\]/,
    );
    expect(src).toMatch(/const view = advisoryView\(vendored\.components\)/);
    expect(src).toMatch(/run\('grype', \[`sbom:\$\{viewPath\}`/);
    expect(src).toMatch(/blocking\.push\(\.\.\.relabel\(viewFindings\.blocking\)\)/);
  });
});
