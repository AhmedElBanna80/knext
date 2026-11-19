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
  // The negation must DIRECTLY modify REQUIRED: "not REQUIRED", "no longer REQUIRED", "never
  // REQUIRED", "isn't REQUIRED", with any one adverb ("strictly", "always", "really") allowed between. A window of words is not used:
  // it flagged "(ISO date, not blank, REQUIRED)" and "not optional, REQUIRED", which both say REQUIRED.
  if (
    /`expires`[^.]*\b(?:(?:is|are)\s+)?(?:not|no\s+longer|never|isn['’]t)(?:\s+\w+)?\s+REQUIRED\b/i.test(
      note,
    )
  )
    return '`expires` is said to be negated before REQUIRED';
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
    expect(
      requiredRuleViolation('`expires` (ISO date, REQUIRED, at most 180 days)'),
    ).toBeUndefined();
    expect(requiredRuleViolation('no expiry sentence at all')).toBeDefined();
  });

  it('the REQUIRED check also rejects "no longer REQUIRED", "isn\'t REQUIRED" and "never REQUIRED" (item 6)', () => {
    expect(requiredRuleViolation('`expires` is no longer REQUIRED')).toBeDefined();
    expect(requiredRuleViolation("`expires` isn't REQUIRED")).toBeDefined();
    expect(requiredRuleViolation('`expires` (ISO date) is not really REQUIRED')).toBeDefined();
    expect(requiredRuleViolation('`expires` (ISO date, REQUIRED, not optional)')).toBeUndefined();
  });

  it('ROUND 2 item 4: the two false-positive phrases pass (negation must modify REQUIRED itself)', () => {
    expect(
      requiredRuleViolation('`expires` (ISO date, not blank, REQUIRED, at most 180 days)'),
    ).toBeUndefined();
    expect(requiredRuleViolation('`expires` (ISO date) not optional, REQUIRED')).toBeUndefined();
  });

  it('ROUND 2 item 4: "optional" as the predicate is still rejected, and REQUIRED alone passes', () => {
    expect(requiredRuleViolation('`expires` (ISO date) is optional, REQUIRED')).toBeDefined();
    expect(requiredRuleViolation('`expires` (ISO date) is REQUIRED')).toBeUndefined();
  });

  it('ROUND 3 item 4: any adverb between the negation and REQUIRED is still a negation (must reject)', () => {
    expect(requiredRuleViolation('`expires` (ISO date) is not strictly REQUIRED')).toBeDefined();
    expect(requiredRuleViolation('`expires` (ISO date) is not always REQUIRED')).toBeDefined();
    expect(requiredRuleViolation('`expires` (ISO date) is no longer strictly REQUIRED')).toBeDefined();
  });
  it('ROUND 3 item 4: the must-pass phrases still pass with the wider negation', () => {
    expect(requiredRuleViolation('`expires` (ISO date, not blank, REQUIRED, at most 180 days)')).toBeUndefined();
    expect(requiredRuleViolation('`expires` (ISO date) not optional, REQUIRED')).toBeUndefined();
    expect(requiredRuleViolation('`expires` (ISO date, REQUIRED, not optional)')).toBeUndefined();
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
