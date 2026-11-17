import { describe, expect, it } from 'bun:test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';

/**
 * #2417: every bun workspace member's directory is named by a Dependabot
 * `bun` or `npm` entry (`directory` / `directories`, `*` globs honoured).
 *
 * The workspace set is DERIVED from the root `workspaces` globs, so a new
 * `packages/*` member that no entry reaches turns this red.
 *
 * WHAT THIS DOES NOT PROVE: that Dependabot's bun ecosystem resolves this
 * repo's `workspace:` / `catalog:` specifiers at run time. Nothing here can run
 * Dependabot; that stays unverified until a run log is read.
 */
const ROOT = resolve(import.meta.dirname, '..');

type Entry = { 'package-ecosystem': string; directory?: string; directories?: string[] };

export function workspaceDirs(root: string): string[] {
  const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  const globs: string[] = Array.isArray(pkg.workspaces) ? pkg.workspaces : pkg.workspaces?.packages;
  if (!globs?.length) throw new Error('root package.json declares no workspaces');
  const dirs: string[] = [];
  for (const g of globs) {
    if (!g.endsWith('/*')) throw new Error(`unsupported workspace glob ${g}`);
    const base = g.slice(0, -2);
    for (const e of readdirSync(join(root, base), { withFileTypes: true })) {
      if (e.isDirectory() && existsSync(join(root, base, e.name, 'package.json')))
        dirs.push(`/${base}/${e.name}`);
    }
  }
  return dirs.sort();
}

function covered(entries: Entry[], dir: string): boolean {
  return entries
    .filter((e) => e['package-ecosystem'] === 'bun' || e['package-ecosystem'] === 'npm')
    .flatMap((e) => [...(e.directories ?? []), ...(e.directory ? [e.directory] : [])])
    .some((pat) => {
      if (pat === dir) return true;
      if (!pat.endsWith('/*')) return false;
      const base = pat.slice(0, -2);
      return dir.startsWith(`${base}/`) && !dir.slice(base.length + 1).includes('/');
    });
}

const entriesOf = (text: string): Entry[] => parse(text).updates as Entry[];
const REAL = readFileSync(join(ROOT, '.github/dependabot.yml'), 'utf8');

describe('dependabot covers every workspace package directory', () => {
  const dirs = workspaceDirs(ROOT);

  it('is not vacuous: the derived workspace set includes the published packages', () => {
    expect(dirs).toEqual(
      expect.arrayContaining(['/packages/kn-next', '/packages/lib', '/packages/db', '/apps/docs']),
    );
  });
  it('every workspace directory is covered by a bun or npm entry', () => {
    expect(dirs.filter((d) => !covered(entriesOf(REAL), d))).toEqual([]);
  });
  it('the check goes red when a directory is not covered (fixture)', () => {
    const entries: Entry[] = [{ 'package-ecosystem': 'bun', directories: ['/', '/apps/*'] }];
    expect(covered(entries, '/apps/docs')).toBe(true);
    expect(covered(entries, '/packages/lib')).toBe(false);
  });
  it('a non-bun/npm ecosystem naming the directory does not count (fixture)', () => {
    expect(
      covered([{ 'package-ecosystem': 'docker', directory: '/packages/lib' }], '/packages/lib'),
    ).toBe(false);
  });
  it('a glob does not reach nested directories (fixture)', () => {
    expect(covered([{ 'package-ecosystem': 'bun', directories: ['/apps/*'] }], '/apps/a/b')).toBe(
      false,
    );
  });
});
