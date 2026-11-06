import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The nightly prover lane installs envtest with `make setup-envtest`, which downloads
 * `envtest-v<k8s>-linux-amd64.tar.gz` from the controller-tools GitHub release. That asset
 * exists; in run 42049823853 two of six legs still died at this step on a GitHub
 * "504 Gateway Timeout", which took every prover in those legs down with it.
 *
 * What must hold: the install retries a transient download failure, and still fails the
 * leg (exit 1, no continue-on-error) once the attempts run out, because a lane without
 * envtest cannot grade its envtest provers.
 */
const ROOT = resolve(import.meta.dir, '..');
const WORKFLOW = readFileSync(
  resolve(ROOT, '.github/workflows/mutation-prover-nightly.yml'),
  'utf8',
);

function envtestStep(): string {
  const start = WORKFLOW.indexOf("- name: Install the operator's envtest binaries");
  expect(start, 'envtest install step not found').toBeGreaterThan(-1);
  const end = WORKFLOW.indexOf('\n      - name:', start + 1);
  return WORKFLOW.slice(start, end === -1 ? undefined : end);
}

describe('nightly envtest install', () => {
  it('retries make setup-envtest at least three times', () => {
    const step = envtestStep();
    const loop = step.match(/for attempt in ((?:\d+ ?)+); do\n([\s\S]*?)\n\s*done/);
    expect(loop, 'no retry loop around make setup-envtest').not.toBeNull();
    expect(loop?.[1].trim().split(/\s+/).length).toBeGreaterThanOrEqual(3);
    // A command that RUNS it, not a log line that names it.
    expect(loop?.[2]).toMatch(/^\s*if make setup-envtest; then exit 0; fi$/m);
  });

  it('does not sleep after the final attempt', () => {
    const step = envtestStep();
    const loop = step.match(/for attempt in ((?:\d+ ?)+); do\n([\s\S]*?)\n\s*done/);
    const attempts = loop?.[1].trim().split(/\s+/) ?? [];
    const last = attempts[attempts.length - 1];
    const sleeps = (loop?.[2] ?? '').split('\n').filter((l) => /\bsleep\b/.test(l));
    expect(sleeps.length, 'expected exactly one backoff sleep in the loop').toBe(1);
    expect(sleeps[0]).toMatch(new RegExp(`if \\[ "\\$attempt" -lt ${last} \\]; then sleep `));
  });

  it('fails the leg once the attempts run out', () => {
    const step = envtestStep();
    expect(step).not.toContain('continue-on-error');
    const afterLoop = step.slice(step.lastIndexOf('done'));
    expect(afterLoop).toMatch(/\n\s*exit 1\b/);
  });
});
