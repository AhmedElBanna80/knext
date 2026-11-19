import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { verifyProtectedRefs } from '../scripts/lib/protected-refs.mjs';
import { evaluateZ7Runs, fetchZ7Runs } from '../scripts/lib/z7-watchdog.mjs';
import { PROTECTED_REFS } from '../scripts/verify-action-pins.mjs';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const NOW = Date.parse('2026-11-19T12:00:00Z');
const day = (n: number) => new Date(NOW - n * 86_400_000).toISOString();
const run = (conclusion: string | null, ageDays: number, status = 'completed') => ({
  status,
  conclusion,
  created_at: day(ageDays),
  updated_at: day(ageDays),
});

describe('evaluateZ7Runs (D3 watchdog)', () => {
  it('passes: latest success within the window', () => {
    expect(evaluateZ7Runs([run('success', 2)], NOW, 9).ok).toBe(true);
  });
  it('fails closed: a workflow that never started', () => {
    const r = evaluateZ7Runs([], NOW, 9);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/never started/);
  });
  it('fails: last success older than N days', () => {
    const r = evaluateZ7Runs([run('success', 10)], NOW, 9);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/no successful run/);
  });
  it('fails: last run failed even if an older success is in the window', () => {
    expect(evaluateZ7Runs([run('failure', 1), run('success', 5)], NOW, 9).ok).toBe(false);
  });
  it('treats cancelled (and timed_out) as failure', () => {
    expect(evaluateZ7Runs([run('cancelled', 1), run('success', 5)], NOW, 9).ok).toBe(false);
    expect(evaluateZ7Runs([run('timed_out', 1), run('success', 5)], NOW, 9).ok).toBe(false);
  });
  it('an in-flight latest run does not mask a stale success', () => {
    expect(evaluateZ7Runs([run(null, 0, 'in_progress'), run('success', 12)], NOW, 9).ok).toBe(
      false,
    );
    expect(evaluateZ7Runs([run(null, 0, 'in_progress'), run('success', 3)], NOW, 9).ok).toBe(true);
  });
  it('sorts by recency, not array order', () => {
    expect(evaluateZ7Runs([run('success', 5), run('failure', 1)], NOW, 9).ok).toBe(false);
  });
  it('fails closed on an unparseable timestamp', () => {
    const bad = {
      status: 'completed',
      conclusion: 'success',
      created_at: 'nope',
      updated_at: 'nope',
    };
    expect(evaluateZ7Runs([bad], NOW, 9).ok).toBe(false);
  });
});

describe('fetchZ7Runs', () => {
  it('returns runs from the API payload', () => {
    const gh = () => JSON.stringify({ workflow_runs: [run('success', 1)] });
    expect(fetchZ7Runs({ gh, repo: 'o/r' })).toHaveLength(1);
  });
  it('throws (fail closed) when the API is unreachable', () => {
    const gh = () => {
      throw new Error('connect ECONNREFUSED');
    };
    expect(() => fetchZ7Runs({ gh, repo: 'o/r' })).toThrow(/ECONNREFUSED/);
  });
  it('throws on a malformed payload', () => {
    expect(() => fetchZ7Runs({ gh: () => '{}', repo: 'o/r' })).toThrow();
    expect(() => fetchZ7Runs({ gh: () => 'not json', repo: 'o/r' })).toThrow();
  });
});

type Api = Record<string, string | Error>;
const apiGh = (api: Api) => (args: string[]) => {
  const path = args.find((a) => a.startsWith('repos/')) as string;
  const hit = api[path];
  if (hit === undefined) throw new Error('gh: Not Found (HTTP 404)');
  if (hit instanceof Error) throw hit;
  return hit;
};
const branchPath = (b: string) => `repos/o/r/branches/${b.replace('/', '%2F')}`;
const tagPath = (b: string) => `repos/o/r/git/ref/tags/${b}`;
const allGood = (): Api =>
  Object.fromEntries(
    [...PROTECTED_REFS].map((b) => [branchPath(b), JSON.stringify({ protected: true })]),
  );

describe('verifyProtectedRefs (D4)', () => {
  it('passes when every PROTECTED_REFS branch is protected and no tag shadows it', () => {
    const r = verifyProtectedRefs({ gh: apiGh(allGood()), repo: 'o/r', refs: PROTECTED_REFS });
    expect(r.ok).toBe(true);
    expect(r.findings).toEqual([]);
  });
  it('covers every ref in PROTECTED_REFS (scan, not a hardcoded pair)', () => {
    const seen: string[] = [];
    const gh = (args: string[]) => {
      seen.push(args.find((a) => a.startsWith('repos/')) as string);
      return apiGh(allGood())(args);
    };
    verifyProtectedRefs({ gh, repo: 'o/r', refs: PROTECTED_REFS });
    for (const b of PROTECTED_REFS) {
      expect(seen).toContain(branchPath(b));
      expect(seen).toContain(tagPath(b));
    }
  });
  it('fails on an unprotected branch', () => {
    const api = allGood();
    api[branchPath('main')] = JSON.stringify({ protected: false });
    const r = verifyProtectedRefs({ gh: apiGh(api), repo: 'o/r', refs: PROTECTED_REFS });
    expect(r.ok).toBe(false);
    expect(r.findings.join('\n')).toMatch(/main.*UNPROTECTED/);
  });
  it('fails on a tag shadowing a protected branch name', () => {
    const api = allGood();
    api[tagPath('integration/v2')] = JSON.stringify({ ref: 'refs/tags/integration/v2' });
    const r = verifyProtectedRefs({ gh: apiGh(api), repo: 'o/r', refs: PROTECTED_REFS });
    expect(r.ok).toBe(false);
    expect(r.findings.join('\n')).toMatch(/tag.*integration\/v2.*EXISTS/);
  });
  it('reports UNVERIFIABLE (and fails) when the API errors, never passes silently', () => {
    const api = allGood();
    api[branchPath('main')] = new Error('HTTP 403 Resource not accessible by integration');
    const r = verifyProtectedRefs({ gh: apiGh(api), repo: 'o/r', refs: PROTECTED_REFS });
    expect(r.ok).toBe(false);
    expect(r.findings.join('\n')).toMatch(/main.*UNVERIFIABLE/);
  });
  it('a non-404 tag lookup error is UNVERIFIABLE, not "absent"', () => {
    const api = allGood();
    api[tagPath('main')] = new Error('HTTP 502 Bad Gateway');
    const r = verifyProtectedRefs({ gh: apiGh(api), repo: 'o/r', refs: PROTECTED_REFS });
    expect(r.ok).toBe(false);
    expect(r.findings.join('\n')).toMatch(/tag.*main.*UNVERIFIABLE/);
  });
  it('a missing `protected` field is UNVERIFIABLE', () => {
    const api = allGood();
    api[branchPath('main')] = JSON.stringify({ name: 'main' });
    expect(verifyProtectedRefs({ gh: apiGh(api), repo: 'o/r', refs: PROTECTED_REFS }).ok).toBe(
      false,
    );
  });
  it('an empty ref set fails (nothing verified is not a pass)', () => {
    expect(verifyProtectedRefs({ gh: apiGh({}), repo: 'o/r', refs: new Set() }).ok).toBe(false);
  });
});

describe('z7-watchdog workflow', () => {
  const text = readFileSync(
    resolve(REPO_ROOT, '.github/workflows/z7-watchdog-nightly.yml'),
    'utf8',
  );
  const wf = parse(text);
  it('is scheduled, with least-privilege top-level permissions', () => {
    expect(wf.on.schedule).toBeDefined();
    expect(wf.permissions).toEqual({ contents: 'read' });
  });
  it('runs both checks and an alert job that fires on failure AND cancelled', () => {
    expect(text).toContain('scripts/verify-z7-watchdog.mjs');
    expect(text).toContain('scripts/verify-protected-refs.mjs');
    const alert = wf.jobs['watchdog-red-alert'];
    expect(alert.if).toMatch(/always\(\)/);
    for (const j of alert.needs) {
      expect(alert.if).toContain(`needs.${j}.result == 'failure'`);
      expect(alert.if).toContain(`needs.${j}.result == 'cancelled'`);
    }
    expect(alert.permissions).toEqual({ issues: 'write' });
  });
  it('never pins the alert issue', () => {
    expect(text).not.toMatch(/gh issue pin/);
  });
  it('grants only the read scopes the checks need', () => {
    expect(wf.jobs['z7-watchdog'].permissions).toEqual({ contents: 'read', actions: 'read' });
  });
});
