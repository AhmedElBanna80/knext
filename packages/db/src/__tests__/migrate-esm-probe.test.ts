import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * The package ships ESM, where a bare `require` is undefined. Under `bun test`
 * `require` exists in every module, so only a real Node ESM load proves the
 * drizzle-kit probe works: with drizzle-kit installed, defineDrizzleConfig must
 * not report it missing.
 */
const MIGRATE = pathToFileURL(resolve(import.meta.dirname, '../migrate.ts')).href;

describe('@getknext/db/migrate under Node ESM', () => {
  it('finds an installed drizzle-kit (no bare require in ESM)', () => {
    const script = `
      const m = await import(${JSON.stringify(MIGRATE)});
      m.defineDrizzleConfig({ schema: './s.ts' });
      console.log('resolved');
    `;
    const r = spawnSync(process.env.NODE_BINARY ?? 'node', ['--input-type=module', '-e', script], {
      cwd: resolve(import.meta.dirname, '../..'),
      encoding: 'utf8',
    });
    expect(`${r.stdout}${r.stderr}`).not.toContain('drizzle-kit is required');
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('resolved');
  });
});
