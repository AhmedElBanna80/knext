/**
 * A single-executable shape may be called Stable only once its credential
 * cells are met (ADR-0070 "What Stable permits", #2446).
 *
 * Two shapes: the self-contained Bun executable (`selfContained`) and the
 * compiled vinext executable (`build: 'vinext'`). Each shape's cells come from
 * the credential audit's own cell list, `CREDENTIAL_CELLS` in
 * scripts/compat-window-audit.mjs: vinext cells are the ones with
 * `builder: 'vinext'`, self-contained cells the ones with `selfContained: true`.
 *
 * A shape's tier is Stable only when all of these hold:
 *   - it has at least one cell, and every cell is `wired`;
 *   - the committed audit record (`.github/single-exec-credential.json`, the
 *     `auditCredentialMatrix` result for those cells, committed when the
 *     credential is banked) reports every one of those cells `met: true`.
 * Anything else is "not met", fail closed: the guard cannot fetch ledgers, so
 * a missing record means not met, never "unknown, allow".
 *
 * Then the pages are scanned, not enumerated: the Stable section of the
 * stability page, and any line of the compatibility matrix that promotes a
 * shape to Stable, may not name a shape whose tier is not Stable.
 */

import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { CREDENTIAL_CELLS } from '../../scripts/compat-window-audit.mjs';

const DOCS = resolve(import.meta.dirname, 'content/docs');
const REPO_ROOT = resolve(import.meta.dirname, '..', '..');
export const AUDIT_RECORD = '.github/single-exec-credential.json';

interface Cell {
  lane: string;
  builder?: string;
  wired?: boolean;
  selfContained?: boolean;
}

export interface Shape {
  id: 'self-contained' | 'vinext';
  /** Words that name the shape on a page. */
  names: RegExp;
  cells: (cells: readonly Cell[]) => Cell[];
}

export const SHAPES: Shape[] = [
  {
    id: 'self-contained',
    names: /\bself-contained\b|\bselfContained\b/i,
    cells: (cells) => cells.filter((c) => c.selfContained === true),
  },
  {
    id: 'vinext',
    names: /\bvinext\b/i,
    cells: (cells) => cells.filter((c) => c.builder === 'vinext'),
  },
];

type AuditRecord = { cells?: Record<string, { met?: unknown }> } | undefined;

function readRecord(root: string): AuditRecord {
  const file = resolve(root, AUDIT_RECORD);
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as AuditRecord;
  } catch {
    return undefined;
  }
}

/** The shape's tier and, when not Stable, why. */
export function tierOf(
  shape: Shape,
  cells: readonly Cell[],
  record: AuditRecord,
): { stable: boolean; why: string } {
  const own = shape.cells(cells);
  if (own.length === 0) return { stable: false, why: `${shape.id} has no credential cell` };
  const unwired = own.filter((c) => c.wired !== true).map((c) => c.lane);
  if (unwired.length > 0) {
    return { stable: false, why: `${shape.id} cells not wired: ${unwired.join(', ')}` };
  }
  if (!record?.cells) return { stable: false, why: `no committed audit record (${AUDIT_RECORD})` };
  const unmet = own.filter((c) => record.cells?.[c.lane]?.met !== true).map((c) => c.lane);
  if (unmet.length > 0)
    return { stable: false, why: `${shape.id} cells not met: ${unmet.join(', ')}` };
  return { stable: true, why: '' };
}

/** The `## Stable` section of a page, up to the next level-2 heading. */
export function stableSection(page: string): string {
  const start = page.search(/^##\s+Stable\b/m);
  if (start < 0) return '';
  const rest = page.slice(start + 1);
  const next = rest.search(/^##\s/m);
  return next < 0 ? page.slice(start) : page.slice(start, start + 1 + next);
}

/** Matrix lines that promote something to Stable (not ones saying it is not, or stays Beta). */
const PROMOTES =
  /\b(is|are|now|graduat\w*|promoted to|marked|listed as|ships as)\s+(\*\*)?Stable\b/i;
const NEGATED = /\b(not|never|no longer|stays? Beta|remains? Beta|until)\b/i;

export function promotionsIn(text: string): string[] {
  return text.split('\n').filter((l) => PROMOTES.test(l) && !NEGATED.test(l));
}

/** Every place a page lists a shape as Stable while its tier is not Stable. */
export function violations(
  pages: { stability: string; matrix: string },
  cells: readonly Cell[],
  record: AuditRecord,
): string[] {
  const out: string[] = [];
  const stable = stableSection(pages.stability);
  const promotions = promotionsIn(pages.matrix);
  for (const shape of SHAPES) {
    const tier = tierOf(shape, cells, record);
    if (tier.stable) continue;
    if (shape.names.test(stable)) {
      out.push(`stability.mdx lists ${shape.id} under Stable, but ${tier.why}`);
    }
    for (const line of promotions) {
      if (shape.names.test(line))
        out.push(`compat-matrix.mdx promotes ${shape.id} to Stable (${tier.why}): ${line.trim()}`);
    }
  }
  return out;
}

const read = (f: string) => readFileSync(resolve(DOCS, f), 'utf8');
const PAGES = { stability: read('stability.mdx'), matrix: read('compat-matrix.mdx') };
const CELLS = CREDENTIAL_CELLS as readonly Cell[];
const RECORD = readRecord(REPO_ROOT);

describe('single-executable shapes are Stable only once their credential cells are met', () => {
  it('reads the stability page and a non-empty Stable section', () => {
    expect(stableSection(PAGES.stability)).toContain('## Stable');
  });

  it('derives the vinext cells from the credential audit', () => {
    expect(SHAPES[1]?.cells(CELLS).length).toBeGreaterThan(0);
  });

  it('no page lists a shape as Stable while its cells are not met', () => {
    const found = violations(PAGES, CELLS, RECORD);
    expect(found, found.join('\n')).toEqual([]);
  });

  it('reds when the self-contained mode is added to the Stable list today', () => {
    const stability = PAGES.stability.replace(
      /^##\s+Stable\b.*$/m,
      (h) => `${h}\n\n- Self-contained mode (\`selfContained\`).`,
    );
    const found = violations({ ...PAGES, stability }, CELLS, RECORD);
    expect(found.some((f) => f.includes('self-contained'))).toBe(true);
  });

  it('reds a matrix line promoting vinext, and passes "stays Beta"', () => {
    expect(promotionsIn('The vinext build is now Stable.')).toHaveLength(1);
    expect(promotionsIn('The vinext build stays Beta; it is not Stable.')).toHaveLength(0);
    const matrix = `${PAGES.matrix}\nThe vinext build is now Stable.\n`;
    expect(violations({ ...PAGES, matrix }, CELLS, RECORD).some((f) => f.includes('vinext'))).toBe(
      true,
    );
  });

  it('a shape is Stable only with wired cells that the committed record reports met', () => {
    const shape = SHAPES[1] as Shape;
    const wired = [{ lane: 'v1', builder: 'vinext', wired: true }];
    expect(tierOf(shape, wired, undefined).stable).toBe(false);
    expect(tierOf(shape, wired, { cells: { v1: { met: false } } }).stable).toBe(false);
    expect(tierOf(shape, wired, { cells: { v1: { met: 'true' } } }).stable).toBe(false);
    expect(tierOf(shape, wired, { cells: { v1: { met: true } } }).stable).toBe(true);
    expect(
      tierOf(shape, [{ lane: 'v1', builder: 'vinext', wired: false }], {
        cells: { v1: { met: true } },
      }).stable,
    ).toBe(false);
    expect(tierOf(SHAPES[0] as Shape, CELLS, { cells: {} }).why).toContain('no credential cell');
  });
});
