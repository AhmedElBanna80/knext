import { describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Dated allowlists must not carry past-expiry entries. The precompile-closure
 * loader skips an expired entry silently, so an entry whose fix already
 * landed otherwise sits there reading as a live risk acceptance (and hides
 * the day a real suppression stops applying). This test is what reds instead.
 *
 * Allowlists are DISCOVERED, not enumerated: every git-tracked `*.json` under
 * `security/` (plus any other tracked JSON named `*allowlist*` / `*exceptions*`)
 * is walked for `expires` / `expiry` string fields, so a new allowlist is
 * covered the day it is added.
 *
 * The clock is injectable: `ALLOWLIST_EXPIRY_NOW` (ISO) overrides "now" for the
 * real-file scan; the checker itself takes `now` as a parameter.
 */
const ROOT = resolve(import.meta.dir, '..');
const EXPIRY_KEYS = new Set(['expires', 'expiry']);
const DATE = /^\d{4}-\d{2}-\d{2}$/;

interface DatedEntry {
  file: string;
  path: string;
  expires: string;
}

function collectDatedEntries(file: string, doc: unknown): DatedEntry[] {
  const out: DatedEntry[] = [];
  const walk = (node: unknown, path: string): void => {
    if (Array.isArray(node))
      node.forEach((v, i) => {
        walk(v, `${path}[${i}]`);
      });
    else if (node && typeof node === 'object') {
      for (const [k, v] of Object.entries(node)) {
        if (EXPIRY_KEYS.has(k) && typeof v === 'string') {
          out.push({ file, path: `${path}.${k}`, expires: v });
        } else walk(v, `${path}.${k}`);
      }
    }
  };
  walk(doc, '');
  return out;
}

/** Same boundary as readAllowlist: an entry is dead on its `expires` date, 00:00Z. */
function findExpired(entries: DatedEntry[], now: Date): DatedEntry[] {
  return entries.filter((e) => {
    if (!DATE.test(e.expires)) return true; // malformed counts as a failure, never a pass
    return new Date(`${e.expires}T00:00:00Z`) <= now;
  });
}

function discoverAllowlistFiles(): string[] {
  const tracked = execFileSync('git', ['ls-files', '*.json'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
  return tracked.filter(
    (f) =>
      !f.includes('node_modules/') &&
      !f.startsWith('tests/fixtures/') &&
      (f.startsWith('security/') || /(allowlist|exceptions)[^/]*\.json$/.test(f)),
  );
}

const NOW = new Date(process.env.ALLOWLIST_EXPIRY_NOW ?? Date.now());

describe('dated allowlists carry no expired entries', () => {
  const files = discoverAllowlistFiles();

  it('discovers the known allowlists (the scan is not vacuous)', () => {
    expect(files).toContain('security/precompile-closure-allowlist.json');
    expect(files).toContain('security/osv-allowlist.json');
    const dated = files.flatMap((f) =>
      collectDatedEntries(f, JSON.parse(readFileSync(resolve(ROOT, f), 'utf8'))),
    );
    expect(dated.length).toBeGreaterThan(10);
  });

  for (const f of files) {
    it(`${f} has no past-expiry entry`, () => {
      const entries = collectDatedEntries(f, JSON.parse(readFileSync(resolve(ROOT, f), 'utf8')));
      const expired = findExpired(entries, NOW).map((e) => `${e.file}${e.path}=${e.expires}`);
      // Delete the entry if its fix landed, or re-justify it with a new date.
      expect(expired).toEqual([]);
    });
  }

  describe('checker (injected clock, both halves)', () => {
    const doc = {
      allow: [{ id: 'X', expires: '2026-11-03' }],
      entries: [{ expiry: '2030-01-01' }],
    };
    const entries = collectDatedEntries('f.json', doc);

    it('reds on a past date', () => {
      const bad = findExpired(entries, new Date('2026-11-06T00:00:00Z'));
      expect(bad.map((e) => e.path)).toEqual(['.allow[0].expires']);
    });
    it('passes on a future date', () => {
      expect(findExpired(entries, new Date('2026-11-02T00:00:00Z'))).toEqual([]);
    });
    it('the expiry day itself is expired (matches readAllowlist)', () => {
      expect(findExpired(entries, new Date('2026-11-03T00:00:00Z'))).toHaveLength(1);
    });
    it('a malformed date reds', () => {
      const m = collectDatedEntries('f.json', { allow: [{ expires: 'soon' }] });
      expect(findExpired(m, new Date('2020-01-01T00:00:00Z'))).toHaveLength(1);
    });
  });
});
