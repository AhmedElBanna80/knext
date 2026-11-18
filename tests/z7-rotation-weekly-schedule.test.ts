/**
 * GitHub fires `schedule:` only from the default branch's copy of a workflow. The
 * weekly real-time Z7 key rotation therefore has to live in a workflow file that
 * exists on main and check integration/v2 out explicitly, the way
 * govulncheck-nightly.yml does. A `schedule:` inside a file that exists only on
 * integration/v2 never fires.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const text = readFileSync(resolve(REPO_ROOT, '.github/workflows/z7-rotation-weekly.yml'), 'utf8');
const wf = parse(text);

type Step = {
  name?: string;
  if?: string;
  uses?: string;
  run?: string;
  env?: Record<string, string>;
  with?: Record<string, string>;
};
const job = Object.values(wf.jobs)[0] as { steps: Step[]; 'timeout-minutes': number };

describe('z7-rotation-weekly.yml', () => {
  it('is scheduled weekly and can be dispatched', () => {
    expect(wf.on.schedule[0].cron).toMatch(/^\d+ \d+ \* \* 0$/);
    expect(wf.on).toHaveProperty('workflow_dispatch');
  });

  it('checks integration/v2 out explicitly, without persisting credentials', () => {
    const checkout = job.steps.find((s) => s.uses?.startsWith('actions/checkout@'));
    expect(checkout?.with?.ref).toBe('integration/v2');
    expect(String(checkout?.with?.['persist-credentials'])).toBe('false');
  });

  it('runs the rotation phase through the same run.sh the v2 lane uses', () => {
    const step = job.steps.find((s) => s.run?.includes('z7-identity-kind/run.sh'));
    expect(step?.env?.PHASES).toContain('rotation');
    expect(step?.if).toBeUndefined();
    expect(job['timeout-minutes']).toBeGreaterThanOrEqual(120);
  });

  it('is least-privilege, secret-free and never cancels a mid-overlap run', () => {
    expect(wf.permissions).toEqual({ contents: 'read' });
    expect(text).not.toMatch(/secrets\./);
    expect(wf.concurrency.group).toContain('z7-rotation-weekly');
    expect(wf.concurrency['cancel-in-progress']).toBe(false);
  });

  it('every remote action is pinned by full SHA with a version comment', () => {
    const uses = [...text.matchAll(/^\s*-?\s*uses:\s*(\S+)(.*)$/gm)].filter(
      ([, r]) => !r.startsWith('./'),
    );
    expect(uses.length).toBeGreaterThan(0);
    for (const [, ref, rest] of uses) {
      expect(ref, ref).toMatch(/^[\w.-]+\/[\w./-]+@[0-9a-f]{40}$/);
      expect(rest, ref).toMatch(/#\s*v\d+\.\d+\.\d+/);
    }
  });
});
