/**
 * #2505 — every `.claude/` path a doc under `docs/` cites must be in the repo.
 *
 * `.claude/rules/*.md` are tracked and cited on purpose. Most of `.claude/` is
 * not: research notes, plans and verdicts are a maintainer's local working
 * files. A doc citing one sends the reader to a path that does not exist for
 * them. ADR-0066 cited two such plans as the source of a decision, which left
 * the decision unreadable outside one checkout.
 *
 * The fix for an offender is to state what the cited note held in the doc
 * itself, or to drop the path. Adding the path here is never the fix.
 */

import { describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function lsFiles(...paths: string[]): string[] {
  return execFileSync('git', ['ls-files', '--', ...paths], { cwd: repoRoot, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean);
}

/**
 * Repo-relative `.claude/...` paths cited in `text`, with sentence punctuation
 * trimmed. `~/.claude/...` and `/abs/.claude/...` are not repo paths and are skipped.
 */
export function citedClaudePaths(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/(?<![~/\w])\.claude\/[A-Za-z0-9_./-]+/g)) {
    // The class stops at , ; : ) and spaces, so only a sentence's trailing dot can remain.
    out.push(m[0].replace(/\.+$/, ''));
  }
  return out;
}

/** True when `path` is a tracked file, or a tracked directory (cited with or without a slash). */
export function isTracked(
  path: string,
  tracked: ReadonlySet<string>,
  trackedList: readonly string[],
): boolean {
  if (tracked.has(path)) return true;
  const dir = path.endsWith('/') ? path : `${path}/`;
  return trackedList.some((f) => f.startsWith(dir));
}

describe('docs cite only tracked .claude/ paths (#2505)', () => {
  it('the scanner trims punctuation and recognises a tracked directory', () => {
    expect(
      citedClaudePaths('see `.claude/rules/workflow.md`. And .claude/rules, then (.claude/x.md)'),
    ).toEqual(['.claude/rules/workflow.md', '.claude/rules', '.claude/x.md']);
    expect(citedClaudePaths('a ~/.claude/skills/x/SKILL.md and /Users/u/.claude/y.md')).toEqual([]);
    const list = ['.claude/rules/workflow.md'];
    const set = new Set(list);
    expect(isTracked('.claude/rules/workflow.md', set, list)).toBe(true);
    expect(isTracked('.claude/rules', set, list)).toBe(true);
    expect(isTracked('.claude/rules/', set, list)).toBe(true);
    expect(isTracked('.claude/plans/v2-plan-rev4.md', set, list)).toBe(false);
  });

  it('scans a non-trivial set of docs and finds tracked citations (the guard is not vacuous)', () => {
    const docs = lsFiles('docs');
    expect(docs.length).toBeGreaterThan(50);
    const cited = docs.flatMap((f) => citedClaudePaths(readFileSync(resolve(repoRoot, f), 'utf8')));
    expect(cited.length).toBeGreaterThan(20);
  });

  it('no doc under docs/ cites a .claude/ path that is not in the repo', () => {
    const trackedList = lsFiles('.claude');
    const tracked = new Set(trackedList);
    const broken: string[] = [];
    for (const f of lsFiles('docs')) {
      const text = readFileSync(resolve(repoRoot, f), 'utf8');
      for (const p of citedClaudePaths(text)) {
        if (!isTracked(p, tracked, trackedList)) broken.push(`${f}: ${p}`);
      }
    }
    expect(broken).toEqual([]);
  });
});
