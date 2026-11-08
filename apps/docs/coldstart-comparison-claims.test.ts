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
 *
 * It is a keyword heuristic, and its limits are deliberate:
 *   - a sentence must name the executable (or open with a pronoun for the
 *     previous sentence that did) and say "cold start", "scale from zero" or
 *     "from zero", so a wake-measured BOOT comparison between runtimes (the
 *     hedged Bun-vs-Node figures on tuning-cold-start.mdx and bun-runtime.mdx)
 *     is out of scope, as is a sentence about bytecode caching on both
 *     runtimes that names the executable in passing (oke.mdx);
 *   - only the presence of `win test: passed` in the named ledger entry is
 *     checked, not the A/B's fields (n, IQR): the ledger entry is reviewed.
 * A reviewer remains the backstop for phrasings outside these patterns.
 */

import { describe, expect, it } from 'bun:test';
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
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
  /\b(single[- ]exec(utable)?s?|self-contained (build|image|executable|binary)|compiled[- ](bun |vinext )?(binary|executable)|vinext (build|executable|binary)|bun (single[- ])?executable|the executable|the binary)\b/i;
// Cold start, not process boot: boot numbers are boot-claim-hygiene.test.ts's.
const COLD_START = /\bcold[- ]?start(s|ed|ing)?\b|\bscale[- ]from[- ]zero\b|\bfrom zero\b/i;
const COMPARATIVE =
  /\b(faster|quicker|shorter|wins?|beats?|outperforms?|ahead of|advantage|cuts?|reduces?|halves)\b|\b\d+(\.\d+)?\s*(%|ms|s|×|x)\s+(faster|quicker|less|lower|shorter)\b/i;
/** A clause that makes the claim even inside otherwise honest wording. */
const BUT_CLAIM = /\bbut\b[^.;]*\b(faster|quicker|shorter|wins?|beats?)\b/i;
/** A sentence that refers back to the previous sentence's subject. */
const PRONOUN_START = /^(it|this|that|they|these)\b/i;
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
  if (file !== root && !file.startsWith(`${root}/`)) return `${path} is outside the repository`;
  if (!existsSync(file) || !statSync(file).isFile()) return `${path} is not a file`;
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
  if (!/^\s*[-*]?\s*win test:\s*passed\s*$/im.test(section)) {
    return `${path}#${anchor} does not record "win test: passed"`;
  }
  return undefined;
}

/** Every comparative cold-start claim about the single executable without a passing A/B pointer. */
export function findUnbackedClaims(file: string, text: string, root = REPO_ROOT): Finding[] {
  const out: Finding[] = [];
  for (const para of paragraphs(text)) {
    if (!SUBJECT.test(para)) continue;
    const marker = para.match(MARKER);
    let prev = '';
    for (const s of sentences(para)) {
      const before = prev;
      prev = s;
      if (!COLD_START.test(s) || !COMPARATIVE.test(s)) continue;
      if (HONEST.test(s) && !BUT_CLAIM.test(s)) continue;
      // The claim must name the executable itself, or open with a pronoun for
      // the previous sentence that did, not merely sit near it in the paragraph.
      if (!SUBJECT.test(s) && !(PRONOUN_START.test(s.trim()) && SUBJECT.test(before))) continue;
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

  it('reds the phrasings a reader would still take as a claim', () => {
    const cases = [
      'The compiled Bun executable has a shorter cold start than Node.',
      'The single executable is quicker. It starts faster from zero.',
      'The self-contained build cuts cold start by 40%.',
      'The vinext executable has comparable throughput but a faster cold start.',
      'The compiled-executable image cold-started faster than disk mode.',
    ];
    for (const c of cases) expect(findUnbackedClaims('x.mdx', c).length, c).toBe(1);
  });

  it('passes a claim whose pointer names a section that passed the win test, and reds one that did not', () => {
    const root = mkdtempSync(join(tmpdir(), 'knext-ab-'));
    writeFileSync(
      join(root, 'ledger.md'),
      '# Ledger\n\n## A/B one\n\n- win test: passed\n\n## A/B two\n\n- win test: failed\n\n## A/B three\n\n- win test: passed?\n',
    );
    try {
      const claim = (ref: string) =>
        `The single executable cold-starts faster. {/* cold-start-ab: ${ref} */}`;
      const why = (ref: string) => findUnbackedClaims('x.mdx', claim(ref), root)[0]?.why;
      expect(findUnbackedClaims('x.mdx', claim('ledger.md#ab-one'), root)).toEqual([]);
      expect(why('ledger.md#ab-two')).toContain('does not record');
      expect(why('ledger.md#ab-three')).toContain('does not record');
      expect(why('ledger.md#missing')).toContain('has no section');
      expect(why('../outside.md#ab-one')).toContain('outside the repository');
      expect(why('.#ab-one')).toContain('not a file');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
