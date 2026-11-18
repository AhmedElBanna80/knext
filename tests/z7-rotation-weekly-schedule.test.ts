/**
 * GitHub fires `schedule:` only from the default branch's copy of a workflow. The Z7
 * kind lane lives on integration/v2, so the weekly real-time key rotation is fired by a
 * THIN CALLER on main that `uses:` the lane (through its `workflow_call`) and alerts
 * when it goes red. The caller must stay a caller: a second copy of the rotation job
 * would drift from the lane (the earlier mirror did, and claimed to be byte-identical).
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { isOwnRepoReusableWorkflow } from '../scripts/verify-action-pins.mjs';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const text = readFileSync(resolve(REPO_ROOT, '.github/workflows/z7-rotation-weekly.yml'), 'utf8');
const wf = parse(text);

type Job = {
  uses?: string;
  with?: Record<string, unknown>;
  steps?: { uses?: string; run?: string; env?: Record<string, string> }[];
  needs?: string | string[];
  if?: string;
  permissions?: Record<string, string>;
  [k: string]: unknown;
};
const jobs = wf.jobs as Record<string, Job>;
const callers = Object.entries(jobs).filter(([, j]) => j.uses !== undefined);
const others = Object.entries(jobs).filter(([, j]) => j.uses === undefined);

describe('z7-rotation-weekly.yml', () => {
  it('is scheduled weekly (Sunday) and can be dispatched', () => {
    expect(wf.on.schedule).toHaveLength(1);
    expect(wf.on.schedule[0].cron).toBe('23 3 * * 0');
    expect(wf.on).toHaveProperty('workflow_dispatch');
  });

  it('is a caller of exactly the Z7 lane on integration/v2 with rotation_realtime: true', () => {
    expect(callers).toHaveLength(1);
    const [, call] = callers[0] as [string, Job];
    expect(call.uses).toBe(
      'AhmedElBanna80/knext/.github/workflows/z7-identity-kind-e2e.yml@integration/v2',
    );
    expect(call.with).toEqual({ rotation_realtime: true, checkout_ref: 'integration/v2' });
    expect(call.needs).toEqual(['preflight']);
    // The called workflow needs only contents: read; the caller grants no more.
    expect(call.permissions).toEqual({ contents: 'read' });
    expect(wf.permissions).toEqual({ contents: 'read' });
  });

  it('owns NO job steps of its own besides the alert (no mirrored rotation job)', () => {
    // The caller job has no steps/runs-on/env of its own.
    const [, call] = callers[0] as [string, Job];
    for (const k of ['steps', 'runs-on', 'env', 'timeout-minutes'])
      expect(call, k).not.toHaveProperty(k);
    // The only other jobs are preflight, wiring-check and the alert; run.sh is never invoked here.
    expect(others.map(([n]) => n).sort()).toEqual([
      'preflight',
      'rotation-red-alert',
      'wiring-check',
    ]);
    expect(text).not.toContain('z7-identity-kind/run.sh');
    expect(text).not.toMatch(/\bkind\b.*\binstall_only\b|helm\/kind-action|setup-go|setup-bun/);
  });

  it('has a red alert that fires on failure or cancel of the call and files an issue without pinning', () => {
    const alert = jobs['rotation-red-alert'] as Job;
    expect(alert.needs).toEqual(['preflight', 'rotation']);
    expect(String(alert.if).replace(/\s+/g, ' ').trim()).toBe(
      "always() && github.event_name == 'schedule' && (needs.preflight.result == 'failure' || needs.preflight.result == 'cancelled' || needs.rotation.result == 'failure' || needs.rotation.result == 'cancelled')",
    );
    expect(alert.permissions).toEqual({ issues: 'write', actions: 'read' });
    const run = (alert.steps ?? []).map((s) => s.run ?? '').join('\n');
    expect(run).toContain('node scripts/nightly-alert-issue.mjs');
    expect(run).not.toContain('gh issue pin');
  });

  it('preflight expects exactly the repository the uses: line names', () => {
    const [, call] = callers[0] as [string, Job];
    const usesRepo = String(call.uses).split('/').slice(0, 2).join('/');
    const pre = jobs.preflight as Job;
    const step = (pre.steps ?? []).find((s) => s.env?.EXPECTED_REPOSITORY !== undefined);
    expect(step, 'preflight step with EXPECTED_REPOSITORY').toBeDefined();
    expect(step?.env?.EXPECTED_REPOSITORY).toBe(usesRepo);
    expect(step?.env?.ACTUAL_REPOSITORY).toBe('${{ github.repository }}');
    expect(step?.run).toContain('exit 1');
    expect(step?.run).toContain('getknext-dev');
  });

  it('wiring-check does not depend on the call and checks workflow_call on integration/v2', () => {
    const w = jobs['wiring-check'] as Job;
    expect(w.needs).toEqual(['preflight']);
    const step = (w.steps ?? []).find((s) => s.run?.includes('workflow_call'));
    expect(step?.env?.LANE_REF).toBe('integration/v2');
    expect(step?.env?.LANE_PATH).toBe('.github/workflows/z7-identity-kind-e2e.yml');
  });

  it('is secret-free, never cancels a mid-overlap run, and does not claim to be a copy', () => {
    expect(text).not.toMatch(/\$\{\{\s*secrets\./);
    expect(wf.concurrency.group).toContain('z7-rotation-weekly');
    expect(wf.concurrency['cancel-in-progress']).toBe(false);
    expect(text).not.toMatch(/byte-identical/i);
    expect(text).toMatch(/THIN CALLER/);
  });

  it('every remote action step is pinned by full SHA with a version comment', () => {
    const uses = [...text.matchAll(/^\s*-?\s*uses:\s*(\S+)(.*)$/gm)].filter(
      // The caller's own-repo reusable workflow is a branch ref by design (asserted above).
      ([, r]) => {
        if (r.startsWith('./')) return false;
        const at = r.lastIndexOf('@');
        return !isOwnRepoReusableWorkflow(r.slice(0, at), r.slice(at + 1));
      },
    );
    expect(uses.length).toBeGreaterThan(0);
    for (const [, ref, rest] of uses) {
      expect(ref, ref).toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/);
      expect(rest, ref).toMatch(/#\s*v\d+\.\d+\.\d+/);
    }
  });
});
