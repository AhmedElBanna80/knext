import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * TD-S12-3b. A kind e2e workflow states its timeout as a rule over a measured CI figure: "The slowest
 * is N s ... Timeout = the slowest CI job plus a 50 percent margin ... N x 1.5 = M s". Nothing tied the
 * `timeout-minutes` to that rule, so a new phase could quietly leave 1 minute of headroom (F8). This
 * test parses the cited slowest time and requires every `timeout-minutes` that follows it to be at least
 * 1.5x that time, in minutes.
 */
const WORKFLOWS = resolve(import.meta.dirname, '..', '.github', 'workflows');
const CITATION = /The slowest is (\d+) s\b/;
const TIMEOUT = /^\s*timeout-minutes:\s*(.+?)\s*$/m;

/** The minimum timeout (minutes) the rule allows for a measured slowest time in seconds. */
export const minimumMinutes = (slowestSeconds: number): number => (slowestSeconds * 1.5) / 60;

/**
 * Violations of the 1.5x rule in one workflow: for each citation, the first `timeout-minutes` after it
 * must be a number (or a ternary of numbers) and every numeric literal in it must reach the minimum.
 * An uncited workflow has no rule to check, so it yields no violations.
 */
export function timeoutViolations(yml: string): string[] {
  const m = CITATION.exec(yml);
  if (!m) return [];
  const slowest = Number(m[1]);
  const after = yml.slice(m.index + m[0].length);
  const t = TIMEOUT.exec(after);
  if (!t) return [`cites ${slowest} s but no timeout-minutes follows the citation`];
  const literals = [...(t[1] ?? '').matchAll(/\b\d+\b/g)].map((x) => Number(x[0]));
  if (literals.length === 0) return [`timeout-minutes '${t[1]}' is not a number`];
  const min = minimumMinutes(slowest);
  return literals
    .filter((v) => v < min)
    .map((v) => `timeout-minutes ${v} is below 1.5x the measured ${slowest} s (${min.toFixed(1)} min)`);
}

const e2eWorkflows = readdirSync(WORKFLOWS)
  .filter((f) => /e2e.*\.ya?ml$/.test(f))
  .sort();
const cited = e2eWorkflows.filter((f) =>
  CITATION.test(readFileSync(resolve(WORKFLOWS, f), 'utf8')),
);

describe('a kind e2e timeout is at least 1.5x its measured slowest CI run (TD-S12-3b)', () => {
  it('finds the cited workflows at all, so the rule cannot pass vacuously', () => {
    expect(cited).toEqual(
      expect.arrayContaining(['z11-activator-drill-e2e.yml', 'z7-identity-kind-e2e.yml']),
    );
  });

  for (const f of cited) {
    it(`${f}: every timeout-minutes after its citation reaches 1.5x the slowest run`, () => {
      expect(timeoutViolations(readFileSync(resolve(WORKFLOWS, f), 'utf8'))).toEqual([]);
    });
  }

  it('the rule itself: 2313 s needs 57.8 min, so 60 passes and 50 fails', () => {
    expect(minimumMinutes(2313)).toBeCloseTo(57.8, 1);
    expect(timeoutViolations('# The slowest is 2313 s (38.6 min).\ntimeout-minutes: 60\n')).toEqual([]);
    expect(timeoutViolations('# The slowest is 2313 s (38.6 min).\ntimeout-minutes: 50\n').length).toBe(
      1,
    );
  });

  it('a ternary is checked on EVERY branch, not only the default', () => {
    expect(
      timeoutViolations('# The slowest is 2557 s.\ntimeout-minutes: ${{ x && 120 || 50 }}\n').length,
    ).toBe(1);
    expect(
      timeoutViolations('# The slowest is 2557 s.\ntimeout-minutes: ${{ x && 120 || 65 }}\n'),
    ).toEqual([]);
  });

  it('a citation with no timeout after it is a violation, not a silent pass', () => {
    expect(timeoutViolations('# The slowest is 100 s.\n').length).toBe(1);
  });
});
