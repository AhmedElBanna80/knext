import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * GUARD TEST for the "upstream-gated" doc drift (#2086).
 *
 * ROADMAP.md (Tier C) and apps/docs/content/docs/build-pipeline.mdx used to say that
 * edge Middleware/Proxy and PPR/Cache Components are "not yet adapter-standardizable" as one
 * blanket claim. That is not what the code or the compatibility matrix says:
 *   - Node-runtime `middleware.ts` IS supported and backed by a red-on-fail smoke check
 *     (the `Middleware (Node runtime ...)` row is ✅ in docs/compat-matrix.md).
 *   - Edge-runtime middleware is NOT supported (knext middleware runs on Node only; ⛔).
 *   - PPR / Cache Components are opt-in (`knext create --cache-components`), outside the
 *     compatibility credential, and make no parity claim (⛔ in the matrix).
 *
 * Both halves are checked: the docs must match the matrix's live status for each row, so a
 * promotion in the matrix (for example PPR moving to ✅) fails this test until the prose is
 * updated, and the stale blanket sentence can never come back unnoticed.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..');
const MATRIX = readFileSync(resolve(REPO_ROOT, 'docs/compat-matrix.md'), 'utf-8');
const ROADMAP = readFileSync(resolve(REPO_ROOT, 'ROADMAP.md'), 'utf-8');
const BUILD_PIPELINE = readFileSync(
  resolve(REPO_ROOT, 'apps/docs/content/docs/build-pipeline.mdx'),
  'utf-8',
);

/** The blanket sentence this guard exists to keep out of the two docs. */
const STALE_BLANKET = /not yet\s+adapter-standardizable/i;

/** Status marker for the first matrix row whose Feature cell starts with `prefix`. */
function matrixStatus(prefix: string): string {
  const row = MATRIX.split('\n').find((line) => {
    const cells = line.split('|').map((c) => c.trim());
    return cells.length > 2 && cells[1].startsWith(prefix);
  });
  if (row === undefined) throw new Error(`no compat-matrix row starts with "${prefix}"`);
  return row.split('|')[2].trim();
}

/** The ROADMAP Tier C section: from its heading to the next level-2 heading. */
function tierC(): string {
  const start = ROADMAP.indexOf('## Tier C');
  if (start < 0) throw new Error('ROADMAP.md has no Tier C section');
  const rest = ROADMAP.slice(start + 1);
  const next = rest.indexOf('\n## ');
  return next < 0 ? ROADMAP.slice(start) : ROADMAP.slice(start, start + 1 + next);
}

/** The build-pipeline paragraph that lists what is still unverified. */
function remainingGaps(): string {
  const start = BUILD_PIPELINE.indexOf('The remaining gaps');
  if (start < 0) throw new Error('build-pipeline.mdx has no "remaining gaps" paragraph');
  const end = BUILD_PIPELINE.indexOf('</Callout>', start);
  return BUILD_PIPELINE.slice(start, end < 0 ? start + 2000 : end);
}

describe('matrix status the docs are written against', () => {
  it('Node-runtime middleware is ✅ (red-on-fail smoke f)', () => {
    expect(matrixStatus('Middleware (Node runtime')).toBe('✅');
  });

  it('edge-runtime middleware is ⛔ (Node only)', () => {
    expect(matrixStatus('Edge Middleware (edge runtime)')).toBe('⛔');
  });

  it('PPR / Cache Components is ⛔ and outside the compatibility suite', () => {
    expect(matrixStatus('PPR / Cache Components')).toBe('⛔');
    expect(MATRIX).toMatch(
      /PPR \/ Cache Components[^\n]*\*\*not\*\* covered by the compatibility suite/,
    );
  });
});

describe('ROADMAP.md Tier C matches the matrix', () => {
  it('drops the blanket "not yet adapter-standardizable" claim', () => {
    expect(tierC()).not.toMatch(STALE_BLANKET);
  });

  it('states Node-runtime middleware is supported', () => {
    // `\bis supported` rather than /supported/: "unsupported" would otherwise pass.
    expect(tierC()).toMatch(/Node-runtime `?middleware[^.]*\bis supported\b/i);
  });

  it('keeps edge-runtime middleware as an open gap', () => {
    expect(tierC()).toMatch(/edge-runtime middleware/i);
    expect(tierC()).toMatch(/not supported|Node only|Node runtime only/i);
  });

  it('describes PPR / Cache Components as opt-in with no parity claim', () => {
    expect(tierC()).toMatch(/PPR|Partial Prerendering/);
    expect(tierC()).toMatch(/opt-in/i);
    expect(tierC()).toMatch(/no parity claim|not covered by the compatibility/i);
  });
});

describe('build-pipeline.mdx remaining-gaps paragraph matches the matrix', () => {
  it('is free of the blanket "not yet adapter-standardizable" claim', () => {
    expect(BUILD_PIPELINE).not.toMatch(STALE_BLANKET);
  });

  it('names edge-runtime middleware as not supported (Node runtime only)', () => {
    expect(remainingGaps()).toMatch(/edge-runtime middleware/i);
    expect(remainingGaps()).toMatch(/Node runtime only|Node only|not supported/i);
  });

  it('describes Partial Prerendering and Cache Components as opt-in with no parity claim', () => {
    expect(remainingGaps()).toMatch(/Partial Prerendering/);
    expect(remainingGaps()).toMatch(/Cache Components/);
    expect(remainingGaps()).toMatch(/opt-in/i);
    expect(remainingGaps()).toMatch(/no parity claim|not covered by the compatibility/i);
  });
});

describe('mutation control: the blanket-claim matcher is not vacuous', () => {
  it('matches the exact stale sentence this guard exists to catch', () => {
    expect(
      STALE_BLANKET.test(
        'Edge Middleware/Proxy and PPR/Cache Components are not yet\nadapter-standardizable',
      ),
    ).toBe(true);
  });

  it('does not match the corrected wording', () => {
    expect(STALE_BLANKET.test('edge-runtime middleware is not supported')).toBe(false);
  });
});
