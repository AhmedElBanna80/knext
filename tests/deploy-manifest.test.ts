import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Contract test for test/deploy-tests-manifest.knext.json (#89, ADR-0007 A3-2).
 *
 * The manifest is the HONEST, in-repo ledger of which Next.js deploy-mode e2e
 * tests knext currently excludes. The project honesty rule (CLAUDE.md §10,
 * .claude/rules/architecture.md) forbids a silent skip: every exclusion MUST
 * carry a non-empty rationale tied to a known-unsupported category. An EMPTY
 * exclude list would be a false "we pass everything" claim; an ALL-excluding
 * list would be a fake green. This test guards both ends.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..');
const MANIFEST_PATH = resolve(REPO_ROOT, 'test/deploy-tests-manifest.knext.json');

interface ExcludeEntry {
  test: string;
  rationale: string;
  category: string;
}
interface Manifest {
  version: number;
  suites: string[];
  rules: {
    include: string[];
    exclude: ExcludeEntry[];
  };
}

/**
 * Categories an exclusion may legitimately reference. These mirror the
 * compat-matrix rows that are architecturally or upstream-gated (CLAUDE.md §8
 * "buckets"): things knext does NOT support today, by design or because the
 * feature is not adapter-standardizable yet.
 */
const KNOWN_UNSUPPORTED_CATEGORIES = new Set([
  'edge-runtime',
  'edge-middleware',
  'ppr',
  'cache-components',
  'image-optimization',
]);

describe('test/deploy-tests-manifest.knext.json — honest exclusion ledger (#89)', () => {
  it('the manifest file exists', () => {
    expect(existsSync(MANIFEST_PATH)).toBe(true);
  });

  const manifest: Manifest = existsSync(MANIFEST_PATH)
    ? JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'))
    : ({} as Manifest);

  it('parses as JSON with {version, suites, rules:{include,exclude}}', () => {
    expect(typeof manifest.version).toBe('number');
    expect(Array.isArray(manifest.suites)).toBe(true);
    expect(manifest.suites.length).toBeGreaterThan(0);
    expect(manifest.rules).toBeTruthy();
    expect(Array.isArray(manifest.rules.include)).toBe(true);
    expect(Array.isArray(manifest.rules.exclude)).toBe(true);
  });

  it('is neither an empty nor an all-excluding ledger (no false green)', () => {
    // Not empty: an empty exclude list would falsely imply "we pass all deploy tests".
    expect(manifest.rules.exclude.length).toBeGreaterThan(0);
    // Not absurdly large: a giant exclude list = faking green by skipping everything.
    expect(manifest.rules.exclude.length).toBeLessThan(50);
  });

  it('EVERY exclude entry has a non-empty rationale (no silent skips)', () => {
    for (const entry of manifest.rules.exclude) {
      expect(typeof entry.test, `exclude entry missing "test": ${JSON.stringify(entry)}`).toBe(
        'string',
      );
      expect(entry.test.trim().length, `empty test name: ${JSON.stringify(entry)}`).toBeGreaterThan(
        0,
      );
      expect(
        typeof entry.rationale === 'string' && entry.rationale.trim().length > 0,
        `exclude entry "${entry.test}" has no rationale`,
      ).toBe(true);
    }
  });

  it('every exclusion references a known-unsupported category', () => {
    for (const entry of manifest.rules.exclude) {
      expect(
        KNOWN_UNSUPPORTED_CATEGORIES.has(entry.category),
        `exclude "${entry.test}" cites unknown category "${entry.category}" — ` +
          `only ${[...KNOWN_UNSUPPORTED_CATEGORIES].join(', ')} are honest exclusions`,
      ).toBe(true);
    }
  });
});
