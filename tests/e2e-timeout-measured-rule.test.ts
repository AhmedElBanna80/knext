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
 * The units a workflow's citations are checked within: one per job under `jobs:` (a citation is checked
 * against ITS job's timeout, never a later job's), or the whole text when there is no `jobs:` key. Text
 * before `jobs:` is a unit with no job name, so a citation there is a violation rather than a silent skip.
 */
export function jobUnits(yml: string): { job: string | undefined; text: string }[] {
  const lines = yml.split('\n');
  const start = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  if (start < 0) return [{ job: undefined, text: yml }];
  const units = [{ job: undefined, text: lines.slice(0, start).join('\n') }];
  let cur = null;
  for (const l of lines.slice(start + 1)) {
    const header = /^ {2}([A-Za-z0-9_-]+):\s*$/.exec(l);
    if (header) {
      cur = { job: header[1], text: '' };
      units.push(cur);
    } else if (cur) {
      cur.text += `${l}\n`;
    }
  }
  return units;
}

/**
 * Violations of the 1.5x rule in one workflow. Every citation in every job is checked: the first
 * `timeout-minutes` after the citation, within the same job, must be a number (or a ternary of numbers),
 * and every numeric literal in it must reach the minimum. A job that cites a time but has no
 * `timeout-minutes` after the citation is a violation. An uncited workflow has no rule, so it yields none.
 */
export function timeoutViolations(yml: string): string[] {
  const out: string[] = [];
  for (const { job, text } of jobUnits(yml)) {
    const where = job === undefined ? 'outside any job' : `job '${job}'`;
    for (const c of text.matchAll(new RegExp(CITATION.source, 'g'))) {
      const slowest = Number(c[1]);
      const after = text.slice((c.index ?? 0) + c[0].length);
      const t = TIMEOUT.exec(after);
      if (!t) {
        out.push(`${where} cites ${slowest} s but no timeout-minutes follows the citation`);
        continue;
      }
      const literals = [...(t[1] ?? '').matchAll(/\b\d+\b/g)].map((x) => Number(x[0]));
      if (literals.length === 0) {
        out.push(`${where}: timeout-minutes '${t[1]}' is not a number`);
        continue;
      }
      const min = minimumMinutes(slowest);
      for (const v of literals.filter((n) => n < min)) {
        out.push(
          `${where}: timeout-minutes ${v} is below 1.5x the measured ${slowest} s (${min.toFixed(1)} min)`,
        );
      }
    }
  }
  return out;
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
    expect(timeoutViolations('# The slowest is 2313 s (38.6 min).\ntimeout-minutes: 60\n')).toEqual(
      [],
    );
    expect(
      timeoutViolations('# The slowest is 2313 s (38.6 min).\ntimeout-minutes: 50\n').length,
    ).toBe(1);
  });

  it('a ternary is checked on EVERY branch, not only the default', () => {
    expect(
      timeoutViolations('# The slowest is 2557 s.\ntimeout-minutes: ${{ x && 120 || 50 }}\n')
        .length,
    ).toBe(1);
    expect(
      timeoutViolations('# The slowest is 2557 s.\ntimeout-minutes: ${{ x && 120 || 65 }}\n'),
    ).toEqual([]);
  });

  it('a citation with no timeout after it is a violation, not a silent pass', () => {
    expect(timeoutViolations('# The slowest is 100 s.\n').length).toBe(1);
  });

  // Item 7: every job that carries a citation is checked, and a job's citation is checked against
  // that job's own timeout, never against a later job's.
  it('a SECOND citation in the same job is checked too (not only the first)', () => {
    const yml = `jobs:\n  a:\n    # The slowest is 2313 s (38.6 min).\n    timeout-minutes: 60\n    # The slowest is 2557 s (42.6 min).\n    timeout-minutes: 20\n`;
    expect(timeoutViolations(yml).length).toBe(1);
  });

  it('a job that cites a time but has no timeout-minutes is a violation, even if a later job has one', () => {
    const yml = `jobs:\n  a:\n    # The slowest is 2313 s (38.6 min).\n    runs-on: x\n  b:\n    timeout-minutes: 60\n`;
    expect(timeoutViolations(yml).length).toBe(1);
  });

  it('a second job with its own citation is checked against its own timeout', () => {
    const ok = `jobs:\n  a:\n    # The slowest is 2313 s.\n    timeout-minutes: 60\n  b:\n    # The slowest is 2557 s.\n    timeout-minutes: 65\n`;
    expect(timeoutViolations(ok)).toEqual([]);
    const bad = ok.replace('timeout-minutes: 65', 'timeout-minutes: 50');
    expect(timeoutViolations(bad).length).toBe(1);
  });

  it('a citation outside any job (before jobs:) is a violation, not silently skipped', () => {
    expect(
      timeoutViolations(`# The slowest is 100 s.\njobs:\n  a:\n    timeout-minutes: 60\n`).length,
    ).toBe(1);
  });
});
