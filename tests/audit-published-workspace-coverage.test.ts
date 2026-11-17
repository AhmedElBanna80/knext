import { describe, expect, it } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { auditScope } from '../scripts/audit-published.mjs';

/**
 * #2438: `scripts/audit-published.mjs` must cover every PUBLISHED package. The
 * published set here is DERIVED from the workspace manifests (`private !== true`),
 * never enumerated, so a package that becomes publishable and is neither audited
 * nor explicitly exempt turns this red.
 *
 * The one exemption is the `kn-next` forwarding alias: ADR-0020 amendment
 * 2026-11-09 records that its target's SBOM describes it. tests/publish-lane-
 * supply-chain.test.ts holds the reasoned entry and the conditions under which
 * it stops being valid; this file only refuses to let it be silent.
 */
const ROOT = resolve(import.meta.dirname, '..');
const EXEMPT = new Set(['kn-next']);

function workspaceManifests(): Array<{ dir: string; name: string; private?: boolean }> {
  const out: Array<{ dir: string; name: string; private?: boolean }> = [];
  for (const group of ['packages', 'apps']) {
    const base = join(ROOT, group);
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      const file = join(base, entry.name, 'package.json');
      if (!entry.isDirectory() || !existsSync(file)) continue;
      const m = JSON.parse(readFileSync(file, 'utf8'));
      out.push({ dir: join(base, entry.name), name: m.name, private: m.private });
    }
  }
  return out;
}

describe('audit-published covers every publishable workspace package', () => {
  const publishable = workspaceManifests().filter((m) => m.private !== true);
  const scope: string[] = auditScope().map((p: { name: string }) => p.name);

  it('is not vacuous: the derived published set contains the fixed group', () => {
    const names = publishable.map((m) => m.name);
    for (const n of ['@getknext/lib', '@getknext/db', '@getknext/core']) {
      expect(names).toContain(n);
    }
  });
  it('every publishable workspace package is audited or explicitly exempt', () => {
    const missing = publishable
      .map((m) => m.name)
      .filter((n) => !scope.includes(n) && !EXEMPT.has(n));
    expect(missing).toEqual([]);
  });
  it('every audited package is a publishable workspace package (no stale scope entry)', () => {
    const names = new Set(publishable.map((m) => m.name));
    expect(scope.filter((n) => !names.has(n))).toEqual([]);
  });
  it('an exemption never names a package that is audited, or one that is not publishable', () => {
    const names = new Set(publishable.map((m) => m.name));
    for (const e of EXEMPT) {
      expect(names.has(e)).toBe(true);
      expect(scope).not.toContain(e);
    }
  });
});
