import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { assertAllowlistExpires } from '../scripts/lib/allowlist-expires.mjs';

const ROOT = resolve(import.meta.dirname, '..');

describe('npm-audit allowlist: expires is mandatory', () => {
  it('rejects a missing, empty or malformed `expires`; accepts an ISO date', () => {
    expect(() => assertAllowlistExpires({ id: 'GHSA-1' })).toThrow(/expires/);
    expect(() => assertAllowlistExpires({ id: 'GHSA-1', expires: '' })).toThrow(/expires/);
    expect(() => assertAllowlistExpires({ id: 'GHSA-1', expires: 'soon' })).toThrow(/expires/);
    expect(() => assertAllowlistExpires({ id: 'GHSA-1', expires: '2099-01-01' })).not.toThrow();
  });

  it('audit-published validates every entry through that rule (no second, laxer copy)', () => {
    const src = readFileSync(resolve(ROOT, 'scripts/audit-published.mjs'), 'utf8');
    expect(src).toMatch(/assertAllowlistExpires\(entry\)/);
  });

  it('every committed npm-audit entry carries a valid `expires`', () => {
    const doc = JSON.parse(
      readFileSync(resolve(ROOT, 'security/npm-audit-allowlist.json'), 'utf8'),
    );
    for (const e of doc.allow) expect(() => assertAllowlistExpires(e)).not.toThrow();
  });
});
