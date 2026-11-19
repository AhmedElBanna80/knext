import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MAX_ALLOW_DAYS, ALLOW_KEYS as OSV_ALLOW_KEYS } from '../scripts/lib/osv-gate.mjs';
import { ALLOWLIST_ENTRY_KEYS } from '../scripts/lib/precompile-closure.mjs';
import { NPM_ALLOWLIST_KEYS } from '../scripts/lib/shipped-scan.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const noteOf = (rel: string): string =>
  JSON.parse(readFileSync(resolve(ROOT, rel), 'utf8'))['$schema-note'];

/**
 * The key names a note spells out: every backticked lowercase identifier (`id`, `expires`,
 * `vendoredIn`). Uppercase tokens (`YYYY-MM-DD`, `MAL-…`) and paths are not keys and are excluded.
 */
export const noteKeys = (note: string): Set<string> =>
  new Set([...note.matchAll(/`([a-z][A-Za-z]*)`/g)].map((m) => m[1] as string));

/**
 * Why a note's `expires` sentence is not a REQUIRED sentence, or undefined when it is. A bare
 * `REQUIRED` is not enough: "`expires` is not REQUIRED" contains it, so the negation is checked too.
 */
export function requiredRuleViolation(note: string): string | undefined {
  if (!/`expires`[^.]*\bREQUIRED\b/.test(note)) return 'no `expires` sentence says REQUIRED';
  if (/`expires`[^.]*\bnot\s+REQUIRED\b/i.test(note)) return '`expires` is said to be not REQUIRED';
  if (/`expires`[^.]*\bis optional\b/i.test(note)) return '`expires` is said to be optional';
  return undefined;
}

const cases: [string, string[]][] = [
  ['security/precompile-closure-allowlist.json', [...ALLOWLIST_ENTRY_KEYS]],
  ['security/npm-audit-allowlist.json', [...NPM_ALLOWLIST_KEYS]],
  ['security/osv-allowlist.json', [...OSV_ALLOW_KEYS]],
];

describe('allowlist $schema-note matches its validator', () => {
  for (const [file, keys] of cases) {
    it(`${file} names EXACTLY the accepted keys (a stale extra key fails)`, () => {
      expect(noteKeys(noteOf(file))).toEqual(new Set(keys));
    });
    it(`${file} says expires is REQUIRED, not optional and not "not REQUIRED"`, () => {
      expect(requiredRuleViolation(noteOf(file))).toBeUndefined();
    });
  }

  it('the REQUIRED check rejects "not REQUIRED" and "optional", and accepts the real wording', () => {
    expect(requiredRuleViolation('`expires` is not REQUIRED')).toBeDefined();
    expect(requiredRuleViolation('`expires` (ISO date) is optional')).toBeDefined();
    expect(requiredRuleViolation('`expires` (ISO date, REQUIRED, at most 180 days)')).toBeUndefined();
    expect(requiredRuleViolation('no expiry sentence at all')).toBeDefined();
  });

  it('the key scan rejects a stale extra key and ignores uppercase tokens', () => {
    expect(noteKeys('keys `id` and `note` and `YYYY-MM-DD`')).toEqual(new Set(['id', 'note']));
  });

  it('closure note bracketed key list equals the validator set exactly', () => {
    const m = noteOf(cases[0][0]).match(/outside \[([^\]]+)\]/);
    expect(m).not.toBeNull();
    const listed = (m?.[1] ?? '').split(',').map((s) => s.trim());
    expect(new Set(listed)).toEqual(new Set(ALLOWLIST_ENTRY_KEYS));
  });
  it("osv note states the validator's expiry cap", () => {
    expect(noteOf('security/osv-allowlist.json')).toContain(`at most ${MAX_ALLOW_DAYS} days after`);
  });
  it('the dated-exemptions header does not call expires optional', () => {
    const src = readFileSync(resolve(ROOT, 'scripts/lib/dated-exemptions.mjs'), 'utf8');
    expect(src).not.toContain('makes it optional');
  });
});
