import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { loadAllowlist } from '../scripts/lib/osv-gate.mjs';
import { readAllowlist } from '../scripts/lib/precompile-closure.mjs';
import { assertAllowlistExpires, loadNpmAllowlist } from '../scripts/lib/shipped-scan.mjs';
import {
  expiresBefore,
  parseStrictIsoDate,
  requireStrictIsoDate,
} from '../scripts/lib/strict-date.mjs';

const ROOT = resolve(import.meta.dirname, '..');

/** Values that must NEVER be accepted as an `expires` (each one suppresses forever if let through). */
const BAD: [string, unknown][] = [
  ['impossible month/day', '2026-13-45'],
  ['calendar rollover (Feb 30)', '2026-02-30'],
  ['9999-99-99 (sorts after every real date)', '9999-99-99'],
  ['empty string', ''],
  ['missing', undefined],
  ['a number', 20261119],
  ['a date-time string', '2026-11-19T00:00:00Z'],
];

const osvEntry = (over: Record<string, unknown>) => ({
  id: 'GHSA-x',
  package: 'p',
  version: '1.0.0',
  lockfile: 'bun.lock',
  justification: 'a justification that is long enough',
  added: '2026-10-01',
  ...over,
});

describe('strict-date', () => {
  it('accepts a real date and returns UTC midnight', () => {
    expect(parseStrictIsoDate('2026-02-28')).toBe(Date.parse('2026-02-28T00:00:00Z'));
    expect(parseStrictIsoDate('2028-02-29')).not.toBeNull(); // a leap day is real
    expect(parseStrictIsoDate('2027-02-29')).toBeNull();
  });
  for (const [name, v] of BAD) {
    it(`rejects ${name}`, () => {
      expect(parseStrictIsoDate(v)).toBeNull();
      expect(() => requireStrictIsoDate(v, 'expires')).toThrow(/real YYYY-MM-DD/);
      expect(() => expiresBefore(v as string, '2026-11-19')).toThrow();
    });
  }
  it('compares parsed dates, not strings', () => {
    expect(expiresBefore('2026-11-18', '2026-11-19')).toBe(true);
    expect(expiresBefore('2026-11-19', '2026-11-19')).toBe(false);
  });
});

describe('every allowlist validator rejects an unparseable `expires`', () => {
  const NOW = new Date('2026-11-19T00:00:00Z');
  for (const [name, v] of BAD) {
    const withExpires = (e: Record<string, unknown>) =>
      v === undefined ? e : { ...e, expires: v };
    it(`precompile-closure: ${name}`, () => {
      const e = withExpires({ id: 'GHSA-x', justification: 'y', added: '2026-08-19' });
      expect(() => readAllowlist({ allow: [e] }, NOW)).toThrow(/expires/);
    });
    it(`npm-audit (loadNpmAllowlist): ${name}`, () => {
      const e = withExpires({ id: 'GHSA-x', justification: 'y', added: '2026-08-19' });
      expect(() => loadNpmAllowlist({ allow: [e] }, '2026-11-19')).toThrow(/expires/);
    });
    it(`npm-audit (audit-published rule): ${name}`, () => {
      expect(() => assertAllowlistExpires({ id: 'GHSA-x', expires: v })).toThrow(/expires/);
    });
    it(`osv: ${name}`, () => {
      expect(() => loadAllowlist({ allow: [withExpires(osvEntry({}))] }, '2026-11-19')).toThrow(
        /expires/,
      );
    });
  }

  it('an impossible `added` is rejected (it anchors the osv 180-day window)', () => {
    expect(() =>
      loadAllowlist(
        { allow: [osvEntry({ added: '2026-02-30', expires: '2026-04-01' })] },
        '2026-11-19',
      ),
    ).toThrow(/added/);
  });

  it('osv keeps its 180-day window', () => {
    expect(() =>
      loadAllowlist(
        { allow: [osvEntry({ added: '2026-01-01', expires: '2026-12-31' })] },
        '2026-11-19',
      ),
    ).toThrow(/180/);
  });

  it('audit-published compares parsed dates, never strings (a lexical compare passes 9999-99-99)', () => {
    const src = readFileSync(resolve(ROOT, 'scripts/audit-published.mjs'), 'utf8');
    expect(src).toMatch(/assertAllowlistExpires\(entry\)/);
    expect(src).toMatch(/expiresBefore\(entry\.expires, today\)/);
    expect(src).not.toMatch(/entry\.expires\s*[<>]/);
  });
});
