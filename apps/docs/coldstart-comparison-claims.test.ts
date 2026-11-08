/**
 * Comparative cold-start claims need a separated A/B (ADR-0070 C5).
 *
 * No user-facing page may say the single executable (the self-contained Bun
 * build or the compiled vinext executable) cold-starts faster, or wins on cold
 * start, unless the same paragraph points at a cold-start ledger section that
 * records a paired OKE A/B whose result passed the ADR-0060 Decision 7 win
 * test. The pointer is an MDX comment in that paragraph:
 *
 *   {/* cold-start-ab: docs/benchmarks/cold-start-ledger.md#<anchor> *\/}
 *
 * and the section it names must contain the line `win test: passed`. No such
 * section exists today, so in practice the guard keeps comparative cold-start
 * claims off the site. Statements of a tie, or of "not (yet) a proven win",
 * pass: they are not comparative claims.
 *
 * Process-boot claims ("boots in ~61 ms", "boots 14x faster") are a different
 * number, guarded by boot-claim-hygiene.test.ts; this file is about cold start.
 */

import { describe, expect, it } from 'bun:test';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const APPS_DOCS_DIR = resolve(import.meta.dirname);
const REPO_ROOT = resolve(APPS_DOCS_DIR, '..', '..');

function textFiles(dir: string, exts: string[]): string[] {
  return readdirSync(dir).flatMap((entry) => {
    const full = join(dir, entry);
    if (entry === 'node_modules' || entry === '.next') return [];
    if (statSync(full).isDirectory()) return textFiles(full, exts);
    return exts.some((ext) => full.endsWith(ext)) ? [full] : [];
  });
}

const FILES = [
  ...textFiles(join(APPS_DOCS_DIR, 'app'), ['.tsx']),
  ...textFiles(join(APPS_DOCS_DIR, 'content/docs'), ['.mdx']),
];

/** The thing a claim is about: the single executable, in any of its names. */
const SUBJECT =
  /\b(single[- ]exec(utable)?s?|self-contained (build|image|executable|binary)|compiled (binary|executable)|vinext (build|executable|binary)|the executable|the binary)\b/i;
const COLD_START = /\bcold[- ]?starts?\b/i;
const COMPARATIVE =
  /\b(faster|quicker|wins?|beats?|outperforms?|ahead of)\b|\b\d+(\.\d+)?\s*(ms|s|×|x)\s+(faster|quicker|less|lower)\b/i;
/** Wording that states a tie or the absence of a proven win. */
const HONEST =
  /\b(tie|tied|not (yet |\(yet\) )?a proven|no proven|not proven|not (a|yet a) (\w+ )?win|comparable|small or absent|no (measurable|separated)|does not (win|beat)|isn't faster|is not faster)\b/i;
const MARKER = /cold-start-ab:\s*([^\s*}]+)/;

export interface Finding {
  file: string;
  sentence: string;
  why: string;
}

/** Split into paragraphs (blank-line separated), then sentences. */
function paragraphs(text: string): string[] {
  return text.split(/\n\s*\n/);
}
function sentences(paragraph: string): string[] {
  return paragraph.replace(/\s+/g, ' ').split(/(?<=[.!?])\s+(?=[A-Z*`[(])/);
}

/** Does `ref` (path#anchor, repo-relative) name a ledger section that passed the win test? */
export function abReferencePasses(ref: string, root = REPO_ROOT): string | undefined {
  const [path, anchor] = ref.split('#');
  if (!path || !anchor) return `"${ref}" is not path#anchor`;
  const file = resolve(root, path);
  if (!existsSync(file)) return `${path} does not exist`;
  const text = readFileSync(file, 'utf8');
  const lines = text.split('\n');
  const slug = (h: string) =>
    h
      .replace(/^#+\s*/, '')
      .trim()
      .toLowerCase()
      .replace(/[^\w\s-]/g, '')
      .replace(/\s+/g, '-');
  const start = lines.findIndex((l) => /^#{1,6}\s/.test(l) && slug(l) === anchor);
  if (start < 0) return `${path} has no section #${anchor}`;
  const level = (lines[start].match(/^#+/) as RegExpMatchArray)[0].length;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    const m = lines[i].match(/^(#+)\s/);
    if (m && m[1].length <= level) {
      end = i;
      break;
    }
  }
  const section = lines.slice(start, end).join('\n');
  if (!/^\s*[-*]?\s*win test:\s*passed\b/im.test(section)) {
    return `${path}#${anchor} does not record "win test: passed"`;
  }
  return undefined;
}

/** Every comparative cold-start claim about the single executable without a passing A/B pointer. */
export function findUnbackedClaims(file: string, text: string, root = REPO_ROOT): Finding[] {
  const out: Finding[] = [];
  for (const para of paragraphs(text)) {
    if (!SUBJECT.test(para) || !COLD_START.test(para)) continue;
    const marker = para.match(MARKER);
    for (const s of sentences(para)) {
      if (!COLD_START.test(s) || !COMPARATIVE.test(s) || HONEST.test(s)) continue;
      // The claim must name the executable itself, not a neighbour in the paragraph.
      if (!SUBJECT.test(s)) continue;
      if (marker) {
        const problem = abReferencePasses(marker[1], root);
        if (!problem) continue;
        out.push({ file, sentence: s.trim(), why: problem });
      } else {
        out.push({ file, sentence: s.trim(), why: 'no cold-start-ab: pointer in the paragraph' });
      }
    }
  }
  return out;
}

describe('comparative cold-start claims about the single executable (ADR-0070 C5)', () => {
  it('has files to check', () => {
    expect(FILES.length).toBeGreaterThan(5);
  });

  it('no page makes one without a passing paired A/B in the cold-start ledger', () => {
    const findings = FILES.flatMap((f) =>
      findUnbackedClaims(relative(REPO_ROOT, f), readFileSync(f, 'utf8')),
    );
    expect(findings, JSON.stringify(findings, null, 2)).toEqual([]);
  });

  it('reds on an unbacked claim', () => {
    expect(
      findUnbackedClaims('x.mdx', 'The self-contained build cold-starts faster than disk mode.')
        .length +
        findUnbackedClaims(
          'x.mdx',
          'With bytecode baked in, the single executable wins on cold start.',
        ).length +
        findUnbackedClaims('x.mdx', 'The compiled binary has a 300 ms faster cold start.').length,
    ).toBe(3);
  });

  it('passes a tie or a not-proven statement', () => {
    expect(
      findUnbackedClaims(
        'x.mdx',
        'The single executable is not (yet) a proven speed win on cold start. On OKE the cold start is a tie.',
      ),
    ).toEqual([]);
  });

  it('passes a claim whose pointer names a section that passed the win test, and reds one that did not', () => {
    const dir = resolve(import.meta.dirname, '.tmp-ab');
    const ledger = join(dir, 'ledger.md');
    require('node:fs').mkdirSync(dir, { recursive: true });
    require('node:fs').writeFileSync(
      ledger,
      '# Ledger\n\n## A/B one\n\n- win test: passed\n\n## A/B two\n\n- win test: failed\n',
    );
    try {
      const claim = (anchor: string) =>
        `The single executable cold-starts faster. {/* cold-start-ab: ${relative(REPO_ROOT, ledger)}#${anchor} */}`;
      expect(findUnbackedClaims('x.mdx', claim('ab-one'))).toEqual([]);
      expect(findUnbackedClaims('x.mdx', claim('ab-two'))[0]?.why).toContain('does not record');
      expect(findUnbackedClaims('x.mdx', claim('missing'))[0]?.why).toContain('has no section');
    } finally {
      require('node:fs').rmSync(dir, { recursive: true, force: true });
    }
  });
});
