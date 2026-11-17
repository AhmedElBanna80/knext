import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

/**
 * GUARD TEST for the "upstream-gated" doc drift.
 *
 * Docs used to say edge Middleware/Proxy and PPR/Cache Components are "upstream-gated" /
 * "not yet adapter-standardizable" as one blanket claim. That is not what the code or the
 * compatibility matrix says:
 *   - Node-runtime `middleware.ts` IS supported (red-on-fail smoke check, ✅ in the matrix).
 *   - Edge-runtime middleware is NOT supported (Node runtime only; ⛔).
 *   - PPR / Cache Components are opt-in (`knext create --cache-components`), outside the
 *     compatibility credential, with no parity claim (⛔).
 *   - The `'use cache'` Redis handler is implemented but NOT covered by the compatibility suite.
 *
 * This guard SCANS every user doc page, docs/*.md and ROADMAP.md (no enumerated file list), so a
 * new or reworded page cannot reintroduce the stale claim. CLAUDE.md is deliberately out of
 * scope (founder-owned; not editable by agents).
 */

const REPO_ROOT = resolve(import.meta.dirname, '..');

function walk(dir: string, ext: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return walk(p, ext);
    return e.name.endsWith(ext) ? [p] : [];
  });
}

const DOCS_DIR = resolve(REPO_ROOT, 'docs');
const FILES: string[] = [
  ...walk(resolve(REPO_ROOT, 'apps/docs/content/docs'), '.mdx'),
  ...readdirSync(DOCS_DIR)
    .filter((f) => f.endsWith('.md'))
    .map((f) => join(DOCS_DIR, f)),
  resolve(REPO_ROOT, 'ROADMAP.md'),
];
const read = (p: string): string => readFileSync(p, 'utf-8');
const rel = (p: string): string => relative(REPO_ROOT, p);

/** The stale blanket phrases for these capabilities. */
const STALE_BLANKET =
  /upstream-gated|not\s+yet\s+(?:adapter-standardi[sz]able|standardi[sz]ed\s+for\s+adapters)|not\s+yet\s+stabili[sz]ed\s+for\s+adapters/i;

/** A positive support claim about `'use cache'`. */
const USE_CACHE_CLAIM = /'use cache'/;
const SUPPORT_WORD = /\b(?:supported|backed\s+by|support\s+for)\b/i;
const NEGATED = /\bnot\s+(?:yet\s+)?(?:supported|backed)|\bunsupported\b/i;
const CAVEAT = /not\s+yet\s+covered\s+by\s+the\s+compatibility/i;

/**
 * Units that claim `'use cache'` support without the caveat. A unit is a table row, or a sentence
 * of prose (a paragraph's wrapped lines rejoined). The caveat may sit anywhere in the same
 * paragraph/row, so a caveat sentence next to the claim clears it.
 */
function uncaveatedUseCacheClaims(text: string): string[] {
  const out: string[] = [];
  for (const para of text.split(/\n\s*\n/)) {
    const isTable = para.includes('\n|') || para.trimStart().startsWith('|');
    const groups = isTable ? para.split('\n') : [para.replace(/\s*\n\s*(?:>\s*)?/g, ' ')];
    for (const group of groups) {
      if (CAVEAT.test(group)) continue;
      for (const sentence of group.split(/(?<=[.!?])\s+/)) {
        if (
          USE_CACHE_CLAIM.test(sentence) &&
          SUPPORT_WORD.test(sentence) &&
          !NEGATED.test(sentence)
        ) {
          out.push(sentence);
        }
      }
    }
  }
  return out;
}

describe('scan coverage', () => {
  it('scans many pages, including the previously-missed ones', () => {
    const names = FILES.map(rel);
    expect(FILES.length).toBeGreaterThan(30);
    for (const must of [
      'apps/docs/content/docs/compat-suite.mdx',
      'apps/docs/content/docs/migrate-from-vercel.mdx',
      'apps/docs/content/docs/compat-matrix.mdx',
      'apps/docs/content/docs/build-pipeline.mdx',
      'docs/compat-matrix.md',
      'docs/V1_ROADMAP.md',
      'ROADMAP.md',
    ]) {
      expect(names).toContain(must);
    }
  });
});

describe('no page carries the stale blanket claim', () => {
  for (const f of FILES) {
    it(rel(f), () => {
      expect(read(f)).not.toMatch(STALE_BLANKET);
    });
  }
});

describe("no page claims 'use cache' is supported without the coverage caveat", () => {
  for (const f of FILES) {
    it(rel(f), () => {
      expect(uncaveatedUseCacheClaims(read(f))).toEqual([]);
    });
  }
});

/** Status marker for the first matrix row whose Feature cell starts with `prefix`. */
function matrixStatus(matrix: string, prefix: string): string {
  const row = matrix.split('\n').find((line) => {
    const cells = line.split('|').map((c) => c.trim());
    return cells.length > 2 && cells[1].startsWith(prefix);
  });
  if (row === undefined) throw new Error(`no compat-matrix row starts with "${prefix}"`);
  return row.split('|')[2].trim();
}

describe('matrix status the docs are written against', () => {
  const MATRIX = read(resolve(REPO_ROOT, 'docs/compat-matrix.md'));

  it('Node-runtime middleware is ✅', () => {
    expect(matrixStatus(MATRIX, 'Middleware (Node runtime')).toBe('✅');
  });

  it('edge-runtime middleware is ⛔ (Node only)', () => {
    expect(matrixStatus(MATRIX, 'Edge Middleware (edge runtime)')).toBe('⛔');
  });

  it('PPR / Cache Components is ⛔, outside the suite, and the handler is flagged uncovered', () => {
    expect(matrixStatus(MATRIX, 'PPR / Cache Components')).toBe('⛔');
    expect(MATRIX).toMatch(
      /PPR \/ Cache Components[^\n]*\*\*not\*\* covered by the compatibility suite/,
    );
    expect(MATRIX).toMatch(/PPR \/ Cache Components[^\n]*not yet covered by the compatibility/);
  });
});

describe('ROADMAP.md Tier C and build-pipeline state the accurate status', () => {
  const ROADMAP = read(resolve(REPO_ROOT, 'ROADMAP.md'));
  const start = ROADMAP.indexOf('## Tier C');
  const rest = ROADMAP.slice(start + 1);
  const next = rest.indexOf('\n## ');
  const tierC =
    start < 0 ? '' : next < 0 ? ROADMAP.slice(start) : ROADMAP.slice(start, start + 1 + next);

  it('Tier C: Node middleware supported, edge not, PPR opt-in with no parity claim', () => {
    expect(start).toBeGreaterThanOrEqual(0);
    expect(tierC).toMatch(/Node-runtime `middleware\.ts` is supported\b/i);
    expect(tierC).toMatch(/edge-runtime middleware[^\n]*(?:Node only|not supported)/i);
    expect(tierC).toMatch(/opt-in/i);
    expect(tierC).toMatch(/no parity claim/i);
  });

  it('build-pipeline names edge middleware unsupported and PPR opt-in with the handler caveat', () => {
    const bp = read(resolve(REPO_ROOT, 'apps/docs/content/docs/build-pipeline.mdx'));
    const gapStart = bp.indexOf('Edge-runtime middleware is not supported');
    expect(gapStart).toBeGreaterThanOrEqual(0);
    const gaps = bp.slice(gapStart, gapStart + 1200);
    expect(gaps).toMatch(/Partial Prerendering and Cache Components are opt-in/);
    expect(gaps).toMatch(/no parity claim/);
    expect(gaps).toMatch(/not yet covered by the compatibility suite/);
  });
});
