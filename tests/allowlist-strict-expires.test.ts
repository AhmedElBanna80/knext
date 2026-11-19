import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { assertAllowlistExpires } from '../scripts/lib/allowlist-expires.mjs';
import { readAllowlist } from '../scripts/lib/precompile-closure.mjs';
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
    it(`precompile-closure: ${name}`, () => {
      const e: Record<string, unknown> = { id: 'GHSA-x', justification: 'y', added: '2026-08-19' };
      if (v !== undefined) e.expires = v;
      expect(() => readAllowlist({ allow: [e] }, NOW)).toThrow(/expires/);
    });
    it(`npm-audit (audit-published rule): ${name}`, () => {
      expect(() => assertAllowlistExpires({ id: 'GHSA-x', expires: v })).toThrow(/expires/);
    });
  }

  it('an expired precompile entry stops suppressing and a future one still does', () => {
    const e = (id: string, expires: string) => ({
      id,
      justification: 'y',
      added: '2026-01-01',
      expires,
    });
    const active = readAllowlist(
      { allow: [e('GHSA-old', '2026-11-18'), e('GHSA-new', '2026-12-31')] },
      NOW,
    );
    expect([...active]).toEqual(['GHSA-new']);
  });

  it('audit-published validates every entry through the rule and compares parsed dates, never strings', () => {
    const src = readFileSync(resolve(ROOT, 'scripts/audit-published.mjs'), 'utf8');
    expect(src).toMatch(/assertAllowlistExpires\(entry\)/);
    expect(src).toMatch(/expiresBefore\(entry\.expires, today\)/);
    expect(src).not.toMatch(/entry\.expires\s*[<>]/);
  });

  it('every committed allowlist entry has a real `expires`', () => {
    for (const f of ['npm-audit', 'precompile-closure']) {
      const doc = JSON.parse(readFileSync(resolve(ROOT, `security/${f}-allowlist.json`), 'utf8'));
      for (const e of doc.allow) expect(parseStrictIsoDate(e.expires)).not.toBeNull();
    }
  });
});
