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

/**
 * A capability subject: `'use cache'`, Cache Components, PPR / Partial Prerendering. A sentence
 * naming one of these AND asserting a positive state is a claim that needs the coverage caveat.
 */
const SUBJECT = /'use cache|Cache Components|\bPPR\b|Partial Prerendering/i;
const CLAIM_WORD =
  /\b(?:supported|backed\s+by|backs|support\s+for|shared|works|implemented|is\s+a\s+hit)\b/i;
const NEGATED =
  /\bnot\s+(?:yet\s+)?(?:supported|backed|covered|implemented|shared)|\bunsupported\b|\bno\s+parity\s+claim/i;
const CAVEAT = /not\s+yet\s+covered\s+by\s+the\s+(?:official\s+)?(?:Next\.js\s+)?compatibility/i;

/** "does not implement" / "architectural exclusion" asserted for these capabilities. */
const EXCLUSION =
  /(?:does\s+not|doesn't|do\s+not)\s+implement|architectural(?:ly)?\s+exclusions?|architecturally\s+out\s+of\s+reach/i;

/** Sentences of a page; a table row is one sentence-like unit, list bullets split too. */
function sentences(text: string): string[] {
  const out: string[] = [];
  for (const para of text.split(/\n\s*\n/)) {
    const isTable = para.trimStart().startsWith('|') || para.includes('\n|');
    if (isTable) {
      for (const row of para.split('\n'))
        for (const cell of row.split(/(?<!\\)\|/)) out.push(...cell.split(/(?<=[.!?])\s+/));
      continue;
    }
    for (const item of para.split(/\n(?=\s*(?:[-*]|\d+\.)\s)/)) {
      const flat = item.replace(/\s*\n\s*(?:>\s*)?/g, ' ');
      out.push(...flat.split(/(?<=[.!?])\s+/));
    }
  }
  return out;
}

/** Claims about these capabilities with no caveat in the same sentence or the next one. */
function uncaveatedClaims(text: string): string[] {
  const ss = sentences(text);
  const out: string[] = [];
  ss.forEach((s, i) => {
    if (/^\s*#{1,6}\s/.test(s)) return; // a heading names a section; its body carries the caveat
    if (!SUBJECT.test(s) || !CLAIM_WORD.test(s) || NEGATED.test(s)) return;
    if (CAVEAT.test(s) || CAVEAT.test(ss[i + 1] ?? '')) return;
    out.push(s);
  });
  return out;
}

/** Sentences that call these capabilities an exclusion or "not implemented". */
function exclusionClaims(text: string): string[] {
  // Proximity, not co-occurrence: a long table row can mention both far apart without linking them.
  const near = (s: string): boolean => {
    for (const m of s.matchAll(new RegExp(EXCLUSION.source, 'gi'))) {
      const at = m.index ?? 0;
      if (SUBJECT.test(s.slice(Math.max(0, at - 120), at + m[0].length + 120))) return true;
    }
    return false;
  };
  return sentences(text).filter(near);
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
      // the unchanged ⛔ legend line legitimately uses the phrase; everything else may not
      const body = read(f)
        .split('\n')
        .filter((l) => !l.startsWith('| ⛔ | **Upstream-gated**'))
        .join('\n');
      expect(body).not.toMatch(STALE_BLANKET);
    });
  }
});

describe("no page claims 'use cache' / Cache Components / PPR works without the caveat", () => {
  for (const f of FILES) {
    it(rel(f), () => {
      expect(uncaveatedClaims(read(f))).toEqual([]);
    });
  }
});

describe('no page calls PPR / Cache Components "not implemented" or an architectural exclusion', () => {
  for (const f of FILES) {
    it(rel(f), () => {
      expect(exclusionClaims(read(f))).toEqual([]);
    });
  }
});

describe('the marker legend is never redefined', () => {
  // Verbatim from the integration/v2 base: the whole Marker/Meaning table, exact lines.
  const COMMON = [
    '| Marker | Meaning |',
    '|---|---|',
    '| ✅ | **Supported** — backed by a red-on-fail check (the per-PR `compat-smoke` gate) or test-covered source on disk. |',
  ];
  const TAIL = [
    '| ❌ | **Unsupported / unverified** — no working implementation or no evidence; treat as a gap. |',
    '| ⛔ | **Upstream-gated** — architecturally out of reach today (global edge, not yet adapter-standardizable upstream). |',
  ];
  const LEGENDS: Record<string, string[]> = {
    'docs/compat-matrix.md': [
      ...COMMON,
      '| ⚠️ | **Partial** — implemented but **not** guarded by a hard correctness check, or with a known caveat (see Notes). Do not rely on it as "verified." |',
      ...TAIL,
    ],
    'apps/docs/content/docs/compat-matrix.mdx': [
      ...COMMON,
      '| ⚠️ | **Partial** — implemented but **not** guarded by a hard correctness check, or with a known caveat. Do not rely on it as "verified." |',
      ...TAIL,
    ],
  };
  for (const [f, legend] of Object.entries(LEGENDS)) {
    it(f, () => {
      const lines = read(resolve(REPO_ROOT, f)).split('\n');
      const at = lines.indexOf(legend[0]);
      expect(at).toBeGreaterThanOrEqual(0);
      expect(lines.slice(at, at + legend.length)).toEqual(legend);
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
