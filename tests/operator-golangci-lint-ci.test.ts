import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';

/**
 * GUARD for the operator lint lane in root CI.
 *
 * The only golangci-lint invocation the repo ever pinned lived in
 * `packages/kn-next-operator/.github/workflows/lint.yml`, a file GitHub never
 * loads (only the repo-root `.github/workflows/` is read). It was deleted, which
 * left `make lint` as a local-only entry point and the operator with no lint
 * lane. This asserts the lane exists in ci.yml and cannot silently go soft:
 *
 *   - it runs the Makefile's `lint` target, which is the one place that builds
 *     the custom golangci-lint (the `.custom-gcl.yml` logcheck plugin) at the one
 *     pinned version, rather than a second copy of the version in the workflow;
 *   - it runs on every PR (ci.yml has no `paths` filter), so a PR touching the
 *     operator is always linted and the check can be made required without
 *     hanging on PRs that do not touch it;
 *   - it is blocking: no `continue-on-error`, no `|| true`, no `if:` that can
 *     skip it;
 *   - `contents: read`, and every action it uses is a 40-hex SHA with a version
 *     comment.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..');
const OPERATOR = 'packages/kn-next-operator';
const CI = readFileSync(resolve(REPO_ROOT, '.github/workflows/ci.yml'), 'utf8');
type Step = {
  uses?: string;
  run?: string;
  if?: string;
  with?: Record<string, string>;
  [k: string]: unknown;
};
type Job = { steps?: Step[]; permissions?: unknown; if?: string; [k: string]: unknown };
const wf = parse(CI) as { on: Record<string, Record<string, unknown>>; jobs?: Record<string, Job> };
const JOB_ID = 'operator-lint';
const job = wf.jobs?.[JOB_ID];

describe('operator golangci-lint lane in root CI', () => {
  it('ci.yml defines the operator-lint job', () => {
    expect(job, `ci.yml has no \`${JOB_ID}\` job`).toBeDefined();
  });

  it('runs `make lint` in the operator module', () => {
    const steps: Step[] = job?.steps ?? [];
    const lint = steps.filter((s) => typeof s.run === 'string' && /\bmake\s+lint\b/.test(s.run));
    expect(lint).toHaveLength(1);
    expect(lint[0]['working-directory']).toBe(OPERATOR);
  });

  it('sets Go up from the operator go.mod', () => {
    const goStep = (job?.steps ?? []).find((s) => /^actions\/setup-go@/.test(s.uses ?? ''));
    expect(goStep, 'no setup-go step').toBeDefined();
    expect(goStep?.with?.['go-version-file']).toBe(`${OPERATOR}/go.mod`);
  });

  it('is blocking: no continue-on-error, no swallowed exit, no skip condition', () => {
    expect(job?.['continue-on-error']).toBeUndefined();
    expect(job?.if).toBeUndefined();
    for (const s of job?.steps ?? []) {
      expect(s['continue-on-error'], JSON.stringify(s)).toBeUndefined();
      expect(s.if, JSON.stringify(s)).toBeUndefined();
      if (typeof s.run === 'string') expect(s.run).not.toMatch(/\|\|\s*(true|:)\b/);
    }
  });

  it('runs on every pull_request (ci.yml has no paths filter)', () => {
    expect(wf.on.pull_request).toBeDefined();
    expect(wf.on.pull_request.paths).toBeUndefined();
    expect(wf.on.pull_request['paths-ignore']).toBeUndefined();
  });

  it('has contents: read and a timeout', () => {
    expect(job?.permissions).toEqual({ contents: 'read' });
    expect(typeof job?.['timeout-minutes']).toBe('number');
  });

  it('pins every action by 40-hex SHA with a version comment', () => {
    const lines = CI.split('\n');
    const start = lines.findIndex((l) => l === `  ${JOB_ID}:`);
    expect(start).toBeGreaterThan(-1);
    let end = lines.findIndex((l, i) => i > start && /^ {2}[a-z0-9-]+:\s*$/.test(l));
    if (end === -1) end = lines.length;
    const uses = lines.slice(start, end).filter((l) => /^\s*-?\s*uses:/.test(l));
    expect(uses.length).toBeGreaterThan(0);
    for (const l of uses) {
      expect(l).toMatch(/uses:\s*\S+@[0-9a-f]{40}\s+#\s*v\d+\.\d+\.\d+/);
    }
  });

  it('the pinned lint version is single-sourced and agrees with .custom-gcl.yml', () => {
    const mk = readFileSync(resolve(REPO_ROOT, OPERATOR, 'Makefile'), 'utf8');
    const mkVersion = mk.match(/^GOLANGCI_LINT_VERSION\s*\?=\s*(v\S+)/m)?.[1];
    const gcl = parse(readFileSync(resolve(REPO_ROOT, OPERATOR, '.custom-gcl.yml'), 'utf8'));
    expect(mkVersion).toMatch(/^v\d+\.\d+\.\d+$/);
    expect(gcl.version).toBe(mkVersion);
    // The workflow must not carry its own copy of the version.
    expect(JSON.stringify(job ?? {})).not.toMatch(/golangci-lint[^"]*v\d+\.\d+\.\d+/);
  });
});
