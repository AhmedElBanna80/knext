import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MAX_ALLOW_DAYS, ALLOW_KEYS as OSV_ALLOW_KEYS } from '../scripts/lib/osv-gate.mjs';
import { ALLOWLIST_ENTRY_KEYS } from '../scripts/lib/precompile-closure.mjs';
import { NPM_ALLOWLIST_KEYS } from '../scripts/lib/shipped-scan.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const noteOf = (rel: string): string =>
  JSON.parse(readFileSync(resolve(ROOT, rel), 'utf8'))['$schema-note'];

const cases: [string, string[]][] = [
  ['security/precompile-closure-allowlist.json', [...ALLOWLIST_ENTRY_KEYS]],
  ['security/npm-audit-allowlist.json', [...NPM_ALLOWLIST_KEYS]],
  ['security/osv-allowlist.json', [...OSV_ALLOW_KEYS]],
];

describe('allowlist $schema-note matches its validator', () => {
  for (const [file, keys] of cases) {
    it(`${file} names every accepted key`, () => {
      const note = noteOf(file);
      for (const k of keys) expect(note).toContain(`\`${k}\``);
    });
    it(`${file} says expires is REQUIRED and not optional`, () => {
      const note = noteOf(file);
      expect(note).toMatch(/`expires`[^.]*REQUIRED/);
      expect(note).not.toMatch(/expires`[^.]*\) is optional/);
    });
  }
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
