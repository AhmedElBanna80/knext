import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import {
  EXCEPTION_REASON,
  evaluateException,
  verifyProtectedRefs,
} from '../scripts/lib/protected-refs.mjs';
import {
  evaluateZ7Runs,
  fetchZ7Runs,
  Z7_FIRST_EXPECTED_MS,
  Z7_GRACE_MARGIN_MS,
} from '../scripts/lib/z7-watchdog.mjs';
import { PROTECTED_REFS } from '../scripts/verify-action-pins.mjs';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const NOW = Date.parse('2026-11-19T12:00:00Z');
const AFTER_GRACE = Z7_FIRST_EXPECTED_MS + Z7_GRACE_MARGIN_MS + 1;
const day = (n: number) => new Date(NOW - n * 86_400_000).toISOString();
const run = (conclusion: string | null, ageDays: number, status = 'completed') => ({
  status,
  conclusion,
  event: 'schedule',
  head_branch: 'main',
  created_at: day(ageDays),
  updated_at: day(ageDays),
});
const dispatch = (conclusion: string | null, ageDays: number) => ({
  ...run(conclusion, ageDays),
  event: 'workflow_dispatch',
});
const otherBranch = (conclusion: string | null, ageDays: number) => ({
  ...run(conclusion, ageDays),
  head_branch: 'feature/x',
});

describe('evaluateZ7Runs (D3 watchdog)', () => {
  it('passes: latest success within the window', () => {
    expect(evaluateZ7Runs([run('success', 2)], NOW, 9).ok).toBe(true);
  });
  it('fails closed: a workflow that never started, once the grace has passed', () => {
    const r = evaluateZ7Runs([], AFTER_GRACE, 9);
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/never started/);
  });
  it('the grace constant is the first cron fire (2026-11-22T03:23Z) plus a margin', () => {
    expect(Z7_FIRST_EXPECTED_MS).toBe(Date.parse('2026-11-22T03:23:00Z'));
    expect(Z7_GRACE_MARGIN_MS).toBeGreaterThanOrEqual(3_600_000);
  });
  it('zero runs BEFORE the first due run is not an alert (both sides of the boundary)', () => {
    expect(evaluateZ7Runs([], NOW, 9).ok).toBe(true);
    expect(evaluateZ7Runs([], Z7_FIRST_EXPECTED_MS, 9).ok).toBe(true);
    expect(evaluateZ7Runs([], Z7_FIRST_EXPECTED_MS + Z7_GRACE_MARGIN_MS - 1, 9).ok).toBe(true);
    expect(evaluateZ7Runs([], Z7_FIRST_EXPECTED_MS + Z7_GRACE_MARGIN_MS, 9).ok).toBe(false);
  });
  it('the grace never excuses a failed run that DID start', () => {
    expect(evaluateZ7Runs([run('failure', 0)], NOW, 9).ok).toBe(false);
  });
  it('a later successful dispatch on top of a scheduled startup_failure is RED', () => {
    const runs = [dispatch('success', 0), run('startup_failure', 1)];
    expect(evaluateZ7Runs(runs, NOW, 9).ok).toBe(false);
  });
  it('a dispatch or other-branch success cannot satisfy the staleness window', () => {
    expect(evaluateZ7Runs([dispatch('success', 1), run('success', 12)], NOW, 9).ok).toBe(false);
    expect(evaluateZ7Runs([otherBranch('success', 1), run('success', 12)], NOW, 9).ok).toBe(false);
  });
  it('a dispatch or other-branch failure cannot cause a red', () => {
    expect(evaluateZ7Runs([dispatch('failure', 0), run('success', 2)], NOW, 9).ok).toBe(true);
    expect(evaluateZ7Runs([otherBranch('cancelled', 0), run('success', 2)], NOW, 9).ok).toBe(true);
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
    const bad = { ...run('success', 1), created_at: 'nope', updated_at: 'nope' };
    expect(evaluateZ7Runs([bad], NOW, 9).ok).toBe(false);
  });
});

describe('fetchZ7Runs', () => {
  it('returns runs from the API payload, querying scheduled runs on main only', () => {
    const calls: string[] = [];
    const gh = (a: string[]) => {
      calls.push(a[1]);
      return JSON.stringify({ workflow_runs: [run('success', 1)], total_count: 1 });
    };
    expect(fetchZ7Runs({ gh, repo: 'o/r' })).toHaveLength(1);
    expect(calls[0]).toContain('branch=main');
    expect(calls[0]).toContain('event=schedule');
  });
  it('follows pagination to the last page', () => {
    const pages: Record<string, unknown[]> = {
      '1': [run('success', 3), run('success', 4)],
      '2': [run('failure', 1)],
    };
    const gh = (a: string[]) => {
      const page = /[?&]page=(\d+)/.exec(a[1])?.[1] as string;
      return JSON.stringify({ workflow_runs: pages[page] ?? [], total_count: 3 });
    };
    const runs = fetchZ7Runs({ gh, repo: 'o/r', perPage: 2 });
    expect(runs).toHaveLength(3);
    expect(evaluateZ7Runs(runs, NOW, 9).ok).toBe(false);
  });
  it('throws (fail closed) when there are more pages than the cap', () => {
    const gh = () => JSON.stringify({ workflow_runs: [run('success', 1)], total_count: 999 });
    expect(() => fetchZ7Runs({ gh, repo: 'o/r', perPage: 1, maxPages: 3 })).toThrow(/pages/);
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
  it('"command not found" is NOT a 404: the tag check is UNVERIFIABLE', () => {
    const api = allGood();
    api[tagPath('main')] = new Error('gh: command not found');
    const r = verifyProtectedRefs({ gh: apiGh(api), repo: 'o/r', refs: PROTECTED_REFS });
    expect(r.ok).toBe(false);
    expect(r.findings.join('\n')).toMatch(/tag.*main.*UNVERIFIABLE/);
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
  it('runs both checks, each with its OWN alert job and issue title', () => {
    expect(text).toContain('scripts/verify-z7-watchdog.mjs');
    expect(text).toContain('scripts/verify-protected-refs.mjs');
    const pairs: [string, string][] = [
      ['z7-watchdog-red-alert', 'z7-watchdog'],
      ['protected-refs-red-alert', 'protected-refs'],
    ];
    for (const [alertId, need] of pairs) {
      const alert = wf.jobs[alertId];
      expect(alert.needs).toEqual([need]);
      expect(alert.if).toMatch(/always\(\)/);
      expect(alert.if).toContain("github.event_name == 'schedule'");
      expect(alert.if).toContain(`needs.${need}.result == 'failure'`);
      expect(alert.if).toContain(`needs.${need}.result == 'cancelled'`);
      expect(alert.permissions).toEqual({ issues: 'write' });
    }
    const titles = [...text.matchAll(/title='([^']+)'/g)].map((m) => m[1]);
    expect(titles).toEqual(['Z7 weekly caller watchdog RED', 'Protected-ref check RED']);
  });
  it('the protected-ref issue is suppressed only by the dated-exception step, which fails closed', () => {
    const steps = wf.jobs['protected-refs-red-alert'].steps;
    const probe = steps.find((st: { id?: string }) => st.id === 'exception');
    expect(probe.run).toContain('scripts/protected-refs-exception-status.mjs');
    const file = steps.find((st: { run?: string }) => st.run?.includes('nightly-alert-issue.mjs'));
    expect(file.if).toBe("steps.exception.outputs.active != 'true'");
    // The z7 alert has no exception path.
    expect(JSON.stringify(wf.jobs['z7-watchdog-red-alert'].steps)).not.toContain('exception');
  });
  it('never pins the alert issue', () => {
    expect(text).not.toMatch(/gh issue pin/);
  });
  it('grants only the read scopes the checks need', () => {
    expect(wf.jobs['z7-watchdog'].permissions).toEqual({ contents: 'read', actions: 'read' });
  });
});

describe('dated known exception for protected refs', () => {
  const T = Date.parse('2026-11-20T00:00:00Z');
  const ok = { granted: '2026-11-19', expires: '2026-12-15', reason: EXCEPTION_REASON };
  it('is active before expiry', () => {
    expect(evaluateException(ok, T).active).toBe(true);
  });
  it('lapses at expiry (the issue is filed again)', () => {
    expect(evaluateException(ok, Date.parse('2026-12-14T23:59:59Z')).active).toBe(true);
    expect(evaluateException(ok, Date.parse('2026-12-15T00:00:00Z')).active).toBe(false);
    expect(evaluateException(ok, Date.parse('2027-03-01T00:00:00Z')).active).toBe(false);
  });
  it('fails closed on a missing, malformed, over-long or wrong-reason exception', () => {
    expect(evaluateException(undefined, T).active).toBe(false);
    expect(evaluateException({ ...ok, expires: 'soon' }, T).active).toBe(false);
    expect(evaluateException({ ...ok, granted: undefined } as never, T).active).toBe(false);
    expect(evaluateException({ ...ok, expires: '2026-12-20' }, T).active).toBe(false);
    expect(evaluateException({ ...ok, reason: 'because' }, T).active).toBe(false);
  });
  it('the committed exception file is currently valid and within 30 days', () => {
    const file = JSON.parse(
      readFileSync(resolve(REPO_ROOT, 'security/protected-refs-exception.json'), 'utf8'),
    );
    expect(evaluateException(file, Date.parse(file.granted)).active).toBe(true);
  });
});
