import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse as parseYaml } from 'yaml';
import {
  decideScaleSuiteAction,
  reconcileScaleSuiteIssue,
  SCALE_SUITE_ISSUE_TITLE,
} from '../scripts/lib/scale-suite-tolerance.mjs';

/**
 * GUARD TESTS for the scale-to-zero e2e suite's tolerated failure being VISIBLE (#2648).
 *
 * THE DEFECT: `operator-e2e-nightly.yml` runs `make test-e2e-scale` in a step with
 * `continue-on-error: true` (ADR-0037 tolerates genuine Knative scale-timing flake).
 * Nothing read the step's `.outcome`, and `continue-on-error` masks `.conclusion`
 * (reports `success` even on failure), so the auto-filed alerts printed
 * `e2e_scale=success` next to a failed suite. The product's core claim
 * (scale-to-zero) could fail every night with a green workflow, no owner, no expiry.
 *
 * WHAT THIS DOES NOT TOUCH: the tolerance itself and the merge-gating decision. The
 * step keeps `continue-on-error`, the job and workflow stay green on a flaky suite.
 * Asserted below too, so nobody "fixes" this by quietly removing the tolerance.
 *
 * BOTH HALVES: (1) the outcome is recorded and surfaced (summary + tracking issue,
 * recovery on success); (2) nothing opts that surfacing out, and the tolerance
 * carries an owner and an expiry that goes RED once passed.
 */

const WORKFLOW_PATH = resolve(import.meta.dirname, '../.github/workflows/operator-e2e-nightly.yml');
const SCRIPT_PATH = resolve(import.meta.dirname, '../scripts/scale-suite-tolerance.mjs');
const SCALE_JOB = 'scale-to-zero-cache';
const TOLERANCE_JOB = 'scale-suite-tolerance';

const workflowText = readFileSync(WORKFLOW_PATH, 'utf8');
// biome-ignore lint/suspicious/noExplicitAny: workflow YAML has no schema type here.
const workflow = parseYaml(workflowText) as any;
// biome-ignore lint/suspicious/noExplicitAny: see above.
const jobs: Record<string, any> = workflow.jobs ?? {};

/** True for `true` and for any `${{ }}` expression — both can tolerate a failure. */
function tolerates(v: unknown): boolean {
  return v === true || (typeof v === 'string' && v.trim() !== 'false');
}

// biome-ignore lint/suspicious/noExplicitAny: see above.
function tolerantSteps(): Array<{ job: string; step: any }> {
  // biome-ignore lint/suspicious/noExplicitAny: see above.
  const out: Array<{ job: string; step: any }> = [];
  for (const [job, def] of Object.entries(jobs)) {
    for (const step of def.steps ?? []) {
      if (tolerates(step['continue-on-error'])) out.push({ job, step });
    }
  }
  return out;
}

describe('the tolerance is RETAINED (ADR-0037 decision unchanged)', () => {
  it('the scale suite step still carries continue-on-error, the job does not', () => {
    const suite = tolerantSteps().filter((t) => t.job === SCALE_JOB);
    expect(suite).toHaveLength(1);
    expect(String(suite[0].step.run)).toContain('make test-e2e-scale');
    expect(tolerates(jobs[SCALE_JOB]['continue-on-error'])).toBe(false);
  });

  it('nothing else is tolerated (no widening), at step or job level', () => {
    expect(tolerantSteps().map((t) => t.job)).toEqual([SCALE_JOB]);
    for (const [name, def] of Object.entries(jobs)) {
      expect(tolerates(def['continue-on-error']), `job ${name}`).toBe(false);
    }
  });

  it('the tolerance job itself cannot swallow its own failure', () => {
    expect(jobs[TOLERANCE_JOB]).toBeTruthy();
    // biome-ignore lint/suspicious/noExplicitAny: see above.
    for (const step of (jobs[TOLERANCE_JOB].steps ?? []) as any[]) {
      expect(tolerates(step['continue-on-error'])).toBe(false);
    }
  });
});

describe('every tolerated step has its OUTCOME read, never its masked conclusion', () => {
  it('each continue-on-error step has an id, referenced as steps.<id>.outcome', () => {
    for (const { job, step } of tolerantSteps()) {
      expect(step.id, `tolerated step "${step.name}" in ${job} needs an id`).toBeTruthy();
      expect(workflowText).toContain(`steps.${step.id}.outcome`);
    }
  });

  it('no tolerated step id is ever read through .conclusion (masked to success)', () => {
    for (const { step } of tolerantSteps()) {
      expect(workflowText).not.toMatch(new RegExp(`steps\\.${step.id}\\.conclusion`));
    }
  });

  it('the outcome is written to the job summary AND exposed as a job output, even on failure', () => {
    const job = jobs[SCALE_JOB];
    const suiteId = tolerantSteps().find((t) => t.job === SCALE_JOB)?.step.id;
    // biome-ignore lint/suspicious/noExplicitAny: see above.
    const rec = (job.steps as any[]).find((s) =>
      JSON.stringify(s.env ?? {}).includes(`steps.${suiteId}.outcome`),
    );
    expect(rec, 'a step that carries the suite outcome in its env').toBeTruthy();
    expect(String(rec.if)).toContain('always()');
    expect(String(rec.run)).toContain('GITHUB_STEP_SUMMARY');
    expect(String(rec.run)).toContain('GITHUB_OUTPUT');
    // The output KEY must map to this step's `suite_outcome` output, and that step must
    // write the key from the suite outcome it was handed (not merely share a prefix).
    expect(job.outputs?.suite_outcome).toBe(`\${{ steps.${rec.id}.outputs.suite_outcome }}`);
    expect(String(rec.run)).toMatch(
      /suite_outcome=\$\{?SUITE_OUTCOME\}?"?\s*>>\s*"?\$GITHUB_OUTPUT/,
    );
    expect(rec.env.SUITE_OUTCOME).toBe(`\${{ steps.${suiteId}.outcome }}`);
  });
});

describe('the tolerance job surfaces the outcome, with an owner and an expiry', () => {
  const job = jobs[TOLERANCE_JOB] ?? {};
  const env = JSON.stringify(
    // biome-ignore lint/suspicious/noExplicitAny: see above.
    (job.steps ?? []).map((s: any) => s.env ?? {}),
  );

  it('consumes the scale job outcome through needs, and runs even when the scale job failed', () => {
    expect([job.needs].flat()).toContain(SCALE_JOB);
    expect(String(job.if)).toContain('always()');
    expect(env).toContain(`needs.${SCALE_JOB}.outputs.`);
  });

  it('is told whether the scale job even ran (its result), so "did not execute" is distinguishable', () => {
    expect(env).toMatch(new RegExp(`JOB_RESULT[^,]*needs\\.${SCALE_JOB}\\.result`));
  });

  it('has least privilege: issues:write only, plus contents:read; workflow default unchanged', () => {
    expect(job.permissions).toEqual({ contents: 'read', issues: 'write' });
    expect(workflow.permissions).toEqual({ contents: 'read' });
  });

  it('declares a named owner and a valid ISO expiry date in the job env', () => {
    const owner = /OWNER:\s*['"]?([A-Za-z0-9-]+)['"]?/.exec(env.replace(/"/g, ''))?.[1];
    const expires = /TOLERANCE_EXPIRES:\s*['"]?(\d{4}-\d{2}-\d{2})['"]?/.exec(
      env.replace(/"/g, ''),
    )?.[1];
    expect(owner).toBeTruthy();
    expect(expires).toBeTruthy();
    expect(Number.isNaN(Date.parse(`${expires}T00:00:00Z`))).toBe(false);
  });

  it('cites the open tracking issue in the workflow comment', () => {
    expect(workflowText).toMatch(/tolerance[^\n]*#2648|#2648[^\n]*tolerance/i);
  });

  it('the expiry check is unconditional; issue open/close is scoped by event in the script', () => {
    expect(String(job.if)).not.toMatch(/event_name\s*==\s*'schedule'/);
    expect(env).toContain('github.event_name');
  });

  it('a red tolerance job (expired) reaches the nightly alert', () => {
    const alert = jobs['nightly-red-alert'];
    expect([alert.needs].flat()).toContain(TOLERANCE_JOB);
    expect(String(alert.if)).toContain(`needs.${TOLERANCE_JOB}.result == 'failure'`);
    expect(String(alert.if)).toContain(`needs.${TOLERANCE_JOB}.result == 'cancelled'`);
  });

  it('the alert names the suite outcome rather than only the masked job result', () => {
    // biome-ignore lint/suspicious/noExplicitAny: see above.
    const alertEnv = JSON.stringify(jobs['nightly-red-alert'].steps.map((s: any) => s.env ?? {}));
    expect(alertEnv).toContain(`needs.${SCALE_JOB}.outputs.`);
  });

  it('runs the committed script, whose run block is expression-free (values via env)', () => {
    // biome-ignore lint/suspicious/noExplicitAny: see above.
    const run = (job.steps as any[]).find((s) =>
      String(s.run ?? '').includes('scale-suite-tolerance'),
    );
    expect(run).toBeTruthy();
    expect(String(run.run)).not.toContain('${{');
  });

  it('every action in the workflow is pinned by full SHA with a version comment', () => {
    for (const line of workflowText.split('\n')) {
      const m = /^\s*-?\s*uses:\s*(\S+)(.*)$/.exec(line);
      if (!m || m[1].startsWith('./')) continue;
      expect(m[1]).toMatch(/@[0-9a-f]{40}$/);
      expect(m[2]).toMatch(/#\s*v\d/);
    }
  });
});

describe('decideScaleSuiteAction (behaviour)', () => {
  const base = {
    expires: '2026-12-15',
    today: '2026-11-02',
    event: 'schedule',
    jobResult: 'success',
  };

  it('failure on a scheduled run opens/updates the issue', () => {
    expect(decideScaleSuiteAction({ ...base, outcome: 'failure' })).toEqual({
      expired: false,
      issue: 'alert',
      notRun: false,
    });
  });
  it('cancelled and an unrecognised outcome fail closed to an alert', () => {
    expect(decideScaleSuiteAction({ ...base, outcome: 'cancelled' }).issue).toBe('alert');
    expect(decideScaleSuiteAction({ ...base, outcome: 'wat' }).issue).toBe('alert');
  });
  it('empty outcome because the scale job did not execute: NOT a suite failure, no issue action, flagged notRun', () => {
    for (const jobResult of ['failure', 'cancelled', 'skipped']) {
      const d = decideScaleSuiteAction({ ...base, outcome: '', jobResult });
      expect(d.issue, jobResult).toBe('none');
      expect(d.notRun, jobResult).toBe(true);
    }
  });
  it('empty outcome although the scale job SUCCEEDED (or its result is unknown) fails loud', () => {
    expect(() => decideScaleSuiteAction({ ...base, outcome: '', jobResult: 'success' })).toThrow();
    expect(() => decideScaleSuiteAction({ ...base, outcome: '', jobResult: '' })).toThrow();
    expect(() =>
      decideScaleSuiteAction({
        ...base,
        outcome: '',
        jobResult: 'success',
        event: 'workflow_dispatch',
      }),
    ).toThrow();
  });
  it('a recorded outcome is used even when the job later failed (the suite did run)', () => {
    const d = decideScaleSuiteAction({ ...base, outcome: 'failure', jobResult: 'failure' });
    expect(d.issue).toBe('alert');
    expect(d.notRun).toBe(false);
  });
  it('success on a scheduled run marks recovery', () => {
    expect(decideScaleSuiteAction({ ...base, outcome: 'success' }).issue).toBe('recover');
  });
  it('skipped (an earlier step already reded the job) neither alerts nor recovers', () => {
    expect(decideScaleSuiteAction({ ...base, outcome: 'skipped' }).issue).toBe('none');
  });
  it('a dispatched run never touches the issue', () => {
    expect(
      decideScaleSuiteAction({ ...base, event: 'workflow_dispatch', outcome: 'failure' }).issue,
    ).toBe('none');
  });
  it('expires on the day AFTER the expiry date, not on it', () => {
    const on = decideScaleSuiteAction({ ...base, today: '2026-12-15', outcome: 'success' });
    const after = decideScaleSuiteAction({ ...base, today: '2026-12-16', outcome: 'success' });
    expect(on.expired).toBe(false);
    expect(after.expired).toBe(true);
  });
  it('a malformed or missing expiry throws (cannot be silently never-expiring)', () => {
    expect(() =>
      decideScaleSuiteAction({ ...base, expires: 'soon', outcome: 'success' }),
    ).toThrow();
    expect(() => decideScaleSuiteAction({ ...base, expires: '', outcome: 'success' })).toThrow();
  });
});

describe('reconcileScaleSuiteIssue (fake gh)', () => {
  function fake(list: unknown[]) {
    const calls: string[][] = [];
    const gh = (a: string[]) => {
      calls.push(a);
      if (a[1] === 'list') return JSON.stringify(list);
      if (a[1] === 'create') return 'https://github.com/getknext-dev/knext/issues/900';
      return '';
    };
    return { gh, calls };
  }
  const args = { repo: 'o/r', runUrl: 'https://run', owner: 'someone', expires: '2026-12-15' };

  it('alert creates ONE issue when none is open, and comments on it when one is', () => {
    const a = fake([]);
    reconcileScaleSuiteIssue({ ...args, gh: a.gh, issue: 'alert', outcome: 'failure' });
    expect(a.calls.filter((c) => c[1] === 'create')).toHaveLength(1);
    const body = a.calls.find((c) => c[1] === 'create')?.join('\n') ?? '';
    expect(body).toContain('someone');
    expect(body).toContain('2026-12-15');
    expect(body).toContain('https://run');

    const b = fake([{ number: 5, title: SCALE_SUITE_ISSUE_TITLE }]);
    reconcileScaleSuiteIssue({ ...args, gh: b.gh, issue: 'alert', outcome: 'failure' });
    expect(b.calls.some((c) => c[1] === 'create')).toBe(false);
    expect(b.calls.some((c) => c[1] === 'comment' && c.includes('5'))).toBe(true);
  });

  it('recover comments and CLOSES the open issue; does nothing when none is open', () => {
    const a = fake([{ number: 5, title: SCALE_SUITE_ISSUE_TITLE }]);
    reconcileScaleSuiteIssue({ ...args, gh: a.gh, issue: 'recover', outcome: 'success' });
    expect(a.calls.some((c) => c[1] === 'comment' && c.includes('5'))).toBe(true);
    expect(a.calls.some((c) => c[1] === 'close' && c.includes('5'))).toBe(true);

    const b = fake([{ number: 6, title: 'unrelated' }]);
    reconcileScaleSuiteIssue({ ...args, gh: b.gh, issue: 'recover', outcome: 'success' });
    expect(b.calls.some((c) => c[1] === 'close' || c[1] === 'comment')).toBe(false);
  });

  it('recover closes EVERY matching open issue, not only the first', () => {
    const a = fake([
      { number: 5, title: SCALE_SUITE_ISSUE_TITLE },
      { number: 6, title: 'unrelated' },
      { number: 7, title: SCALE_SUITE_ISSUE_TITLE },
    ]);
    reconcileScaleSuiteIssue({ ...args, gh: a.gh, issue: 'recover', outcome: 'success' });
    for (const n of ['5', '7']) {
      expect(
        a.calls.some((c) => c[1] === 'close' && c.includes(n)),
        n,
      ).toBe(true);
    }
    expect(a.calls.some((c) => c[1] === 'close' && c.includes('6'))).toBe(false);
  });

  it('issue "none" makes no gh call at all', () => {
    const a = fake([]);
    reconcileScaleSuiteIssue({ ...args, gh: a.gh, issue: 'none', outcome: 'skipped' });
    expect(a.calls).toHaveLength(0);
  });
});

describe('the CLI goes RED once the expiry has passed (executed, exit code)', () => {
  function run(env: Record<string, string>) {
    return spawnSync('node', [SCRIPT_PATH], {
      env: {
        PATH: process.env.PATH ?? '',
        EVENT_NAME: 'workflow_dispatch',
        OUTCOME: 'success',
        OWNER: 'someone',
        ...env,
      },
      encoding: 'utf8',
    });
  }
  it('scale job did not execute (empty outcome, job failed): exit 0, visible warning, no gh/issue use', () => {
    const r = run({
      EVENT_NAME: 'schedule',
      OUTCOME: '',
      JOB_RESULT: 'failure',
      TOLERANCE_EXPIRES: '2999-01-01',
    });
    expect(r.status).toBe(0);
    expect(`${r.stdout}${r.stderr}`).toMatch(/::warning::.*did not (run|execute)/i);
  });
  it('empty outcome with a SUCCEEDED scale job -> exit 1 (fail loud)', () => {
    const r = run({
      EVENT_NAME: 'schedule',
      OUTCOME: '',
      JOB_RESULT: 'success',
      TOLERANCE_EXPIRES: '2999-01-01',
    });
    expect(r.status).toBe(1);
  });
  it('expired -> exit 1 and says so', () => {
    const r = run({ TOLERANCE_EXPIRES: '2000-01-01' });
    expect(r.status).toBe(1);
    expect(`${r.stdout}${r.stderr}`).toMatch(/expired/i);
  });
  it('not yet expired -> exit 0', () => {
    expect(run({ TOLERANCE_EXPIRES: '2999-01-01' }).status).toBe(0);
  });
  it('malformed expiry -> exit 1', () => {
    expect(run({ TOLERANCE_EXPIRES: 'later' }).status).toBe(1);
  });
});
