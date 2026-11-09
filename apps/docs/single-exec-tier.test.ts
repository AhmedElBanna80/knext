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
 * The vinext shape is never Stable: it stays Beta in every release and is not on
 * the path to Stable (ADR-0070, docs/compat/bar-vinext-axis.md, stability.mdx).
 *
 * The self-contained shape is Stable only when all of these hold:
 *   - it has at least one cell, and every cell is `wired`;
 *   - the committed audit record (`.github/single-exec-credential.json`, the
 *     `auditCredentialMatrix` result for those cells, committed when the
 *     credential is banked) reports every one of those cells `met: true`, for
 *     the same `rcTag` the credential runs against today
 *     (`.github/compat-credential-ref.json`), so a record from an older rc is stale.
 * Anything else is "not met", fail closed: the guard cannot fetch ledgers, so
 * a missing record means not met, never "unknown, allow".
 *
 * Then every docs page is scanned: a page's `## Stable` section, and any
 * paragraph that promotes a shape to Stable, may not name a shape whose tier
 * is not Stable.
 */

import { describe, expect, it } from 'bun:test';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
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
  /** Why the shape can never be Stable, when that is policy rather than evidence. */
  neverStable?: string;
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
    neverStable: 'vinext stays Beta in every release (ADR-0070)',
    names: /\bvinext\b/i,
    cells: (cells) => cells.filter((c) => c.builder === 'vinext'),
  },
];

type AuditRecord = { rcTag?: unknown; cells?: Record<string, { met?: unknown }> } | undefined;

function currentRcTag(root: string): string | undefined {
  try {
    const ref = JSON.parse(
      readFileSync(resolve(root, '.github/compat-credential-ref.json'), 'utf8'),
    ) as {
      rcTag?: unknown;
    };
    return typeof ref.rcTag === 'string' ? ref.rcTag : undefined;
  } catch {
    return undefined;
  }
}

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
  rcTag: string | undefined = currentRcTag(REPO_ROOT),
): { stable: boolean; why: string } {
  if (shape.neverStable) return { stable: false, why: shape.neverStable };
  const own = shape.cells(cells);
  if (own.length === 0) return { stable: false, why: `${shape.id} has no credential cell` };
  const unwired = own.filter((c) => c.wired !== true).map((c) => c.lane);
  if (unwired.length > 0) {
    return { stable: false, why: `${shape.id} cells not wired: ${unwired.join(', ')}` };
  }
  if (!record?.cells) return { stable: false, why: `no committed audit record (${AUDIT_RECORD})` };
  if (!rcTag || record.rcTag !== rcTag) {
    return {
      stable: false,
      why: `the audit record is not for the current rcTag (${String(rcTag)})`,
    };
  }
  const unmet = own.filter((c) => record.cells?.[c.lane]?.met !== true).map((c) => c.lane);
  if (unmet.length > 0)
    return { stable: false, why: `${shape.id} cells not met: ${unmet.join(', ')}` };
  return { stable: true, why: '' };
}

/** The `## Stable` section of a page, up to the next level-2 heading. */
export function stableSection(page: string): string {
  // The tier heading itself, not a heading that merely starts with the word.
  const start = page.search(/^##\s+Stable\s*$/m);
  if (start < 0) return '';
  const rest = page.slice(start + 1);
  const next = rest.search(/^##\s/m);
  return next < 0 ? page.slice(start) : page.slice(start, start + 1 + next);
}

/** Promotion wording, matched within one clause of a re-joined paragraph. */
const PROMOTES =
  /\b(is|are|now|graduat\w*|promoted to|moves? to|moved to|marked|listed as|ships as|becomes?)\s+(\*\*)?Stable\b/i;
const NEGATED = /\b(not|never|no longer|stays? Beta|remains? Beta|until)\b/i;

/** Clauses (split on sentence ends and semicolons) that promote something to Stable. */
export function promotionsIn(text: string): string[] {
  const out: string[] = [];
  for (const para of text.split(/\n\s*\n/)) {
    for (const clause of para.replace(/\s+/g, ' ').split(/(?<=[.;!?])\s+|\s*\|\s*/)) {
      if (PROMOTES.test(clause) && !NEGATED.test(clause)) out.push(clause.trim());
    }
  }
  return out;
}

/** Every place a page lists a shape as Stable while its tier is not Stable. */
export function violations(
  pages: Record<string, string>,
  cells: readonly Cell[],
  record: AuditRecord,
  rcTag?: string,
): string[] {
  const out: string[] = [];
  for (const shape of SHAPES) {
    const tier =
      rcTag === undefined ? tierOf(shape, cells, record) : tierOf(shape, cells, record, rcTag);
    if (tier.stable) continue;
    for (const [file, text] of Object.entries(pages)) {
      if (shape.names.test(stableSection(text))) {
        out.push(`${file} lists ${shape.id} under Stable, but ${tier.why}`);
      }
      for (const clause of promotionsIn(text)) {
        if (shape.names.test(clause))
          out.push(`${file} promotes ${shape.id} to Stable (${tier.why}): ${clause}`);
      }
    }
  }
  return out;
}

function mdxFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((e) => {
    const full = join(dir, e);
    return statSync(full).isDirectory() ? mdxFiles(full) : full.endsWith('.mdx') ? [full] : [];
  });
}

const PAGES: Record<string, string> = Object.fromEntries(
  mdxFiles(DOCS).map((f) => [relative(DOCS, f), readFileSync(f, 'utf8')]),
);
const CELLS = CREDENTIAL_CELLS as readonly Cell[];
const RECORD = readRecord(REPO_ROOT);

describe('single-executable shapes are Stable only once their credential cells are met', () => {
  it('reads the stability page and a non-empty Stable section', () => {
    expect(stableSection(PAGES['stability.mdx'] ?? '')).toContain('## Stable');
  });

  it('derives the vinext cells from the credential audit', () => {
    expect(SHAPES[1]?.cells(CELLS).length).toBeGreaterThan(0);
  });

  it('no page lists a shape as Stable while its cells are not met', () => {
    const found = violations(PAGES, CELLS, RECORD);
    expect(found, found.join('\n')).toEqual([]);
  });

  it('reds when the self-contained mode is added to the Stable list today', () => {
    const stability = (PAGES['stability.mdx'] ?? '').replace(
      /^##\s+Stable\s*$/m,
      (h) => `${h}\n\n- Self-contained mode (\`selfContained\`).`,
    );
    const found = violations({ ...PAGES, 'stability.mdx': stability }, CELLS, RECORD);
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

  it('self-contained is Stable only with wired cells met for the current rcTag', () => {
    const shape = SHAPES[0] as Shape;
    const wired = [{ lane: 's1', selfContained: true, wired: true }];
    const rc = 'v2.0.0-rc.1';
    const met = { rcTag: rc, cells: { s1: { met: true } } };
    expect(tierOf(shape, wired, undefined, rc).stable).toBe(false);
    expect(tierOf(shape, wired, { rcTag: rc, cells: { s1: { met: false } } }, rc).stable).toBe(
      false,
    );
    expect(tierOf(shape, wired, { rcTag: rc, cells: { s1: { met: 'true' } } }, rc).stable).toBe(
      false,
    );
    expect(tierOf(shape, wired, { ...met, rcTag: 'v1.0.0-rc.6' }, rc).why).toContain(
      'not for the current rcTag',
    );
    expect(tierOf(shape, wired, met, rc).stable).toBe(true);
    expect(tierOf(shape, [{ lane: 's1', selfContained: true, wired: false }], met, rc).stable).toBe(
      false,
    );
    expect(tierOf(shape, CELLS, { cells: {} }, rc).why).toContain('no credential cell');
  });

  it('vinext is never Stable, whatever the record says', () => {
    const cells = [{ lane: 'v1', builder: 'vinext', wired: true }];
    const t = tierOf(SHAPES[1] as Shape, cells, { rcTag: 'x', cells: { v1: { met: true } } }, 'x');
    expect(t.stable).toBe(false);
    expect(t.why).toContain('Beta in every release');
  });
});
