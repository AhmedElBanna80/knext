import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * The empty-dir mutation prover must finish inside the nightly lane's per-prover bound.
 *
 * Nightly runs 41851702194 and 42049823853 killed it at the 7800 s bound while it was on
 * mutation 76 of 77: every mutation ran the spec TWICE (once mutated, once more after the
 * restore), about 52 s per run on a hosted runner, so 77 mutations cost ~8000 s. A prover the
 * bound kills reports no counts at all (`FAIL —/—`), so one too many mutations turns the whole
 * night red without saying which guard is the problem.
 *
 * What must hold:
 *  - one spec run per mutation (the restore is already proved byte-identical by sha256 in
 *    `mutation-harness.mjs`, so a per-mutation re-run re-proves the baseline);
 *  - a green re-check every RECHECK_EVERY (at most 20) mutations AND after the last one, so
 *    residue that leaks out of a red run and poisons later mutations fails the prover instead
 *    of counting as kills, even when a later run happens to clean that residue up;
 *  - the declared mutation count, at the measured per-run cost, fits the bound the workflow
 *    sets with room for the 40% runner-to-runner variance the workflow comment records.
 */
const ROOT = resolve(import.meta.dir, '..');
const PROVER = readFileSync(resolve(ROOT, 'scripts/mutation-prove-empty-dir-guard.mjs'), 'utf8');
const WORKFLOW = readFileSync(
  resolve(ROOT, '.github/workflows/mutation-prover-nightly.yml'),
  'utf8',
);

// MEASURED: run 42049823853, 76 mutations x 2 spec runs in 7800 s => ~51 s per spec run.
const SECONDS_PER_SPEC_RUN = 52;
// The workflow comment records 40%+ variance for the same prover between hosted runners.
const RUNNER_VARIANCE = 1.4;

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

function reportBody(): string {
  const start = PROVER.indexOf('function report(');
  const end = PROVER.indexOf('\nfunction prove(', start);
  expect(start, 'function report( not found').toBeGreaterThan(-1);
  expect(end, 'function prove( not found after report').toBeGreaterThan(start);
  return PROVER.slice(start, end);
}

function declared(): number {
  const m = PROVER.match(/declareMutations\((\d+)\)/);
  expect(m, 'declareMutations(n) not found').not.toBeNull();
  return Number(m?.[1]);
}

function recheckEvery(): number {
  const m = PROVER.match(/const RECHECK_EVERY = (\d+);/);
  expect(m, 'const RECHECK_EVERY = n; not found').not.toBeNull();
  return Number(m?.[1]);
}

function boundSeconds(): number {
  const m = WORKFLOW.match(/KNEXT_PROVER_TIMEOUT_MS:\s*(\d+)/);
  expect(m, 'KNEXT_PROVER_TIMEOUT_MS not found in the nightly workflow').not.toBeNull();
  return Number(m?.[1]) / 1000;
}

describe('empty-dir mutation prover fits the nightly bound', () => {
  it('runs the spec exactly once per mutation', () => {
    expect(count(reportBody(), 'specPasses()')).toBe(1);
  });

  it('the re-check helper fails the prover when the spec is red', () => {
    const start = PROVER.indexOf('function recheckGreen(');
    expect(start, 'function recheckGreen( not found').toBeGreaterThan(-1);
    const body = PROVER.slice(start, PROVER.indexOf('\n}', start));
    expect(body).toContain('if (!specPasses())');
    expect(body).toContain('process.exit(1)');
  });

  it('re-checks green every RECHECK_EVERY mutations, at most every 20', () => {
    expect(recheckEvery()).toBeGreaterThan(0);
    expect(recheckEvery()).toBeLessThanOrEqual(20);
    expect(reportBody()).toMatch(
      /mutationsRun \+= 1;\s*if \(mutationsRun % RECHECK_EVERY === 0\) \{\s*recheckGreen\(/,
    );
  });

  it('re-checks green after the last mutation', () => {
    const tail = PROVER.slice(PROVER.lastIndexOf('\nprove'));
    expect(tail).toMatch(/\nrecheckGreen\(/);
  });

  it('declared mutations x spec runs fit the bound with runner-variance headroom', () => {
    const runsPerMutation = count(reportBody(), 'specPasses()');
    // baseline + per-mutation runs + periodic re-checks + the final re-check
    const runs = 1 + declared() * runsPerMutation + Math.floor(declared() / recheckEvery()) + 1;
    const worstCase = runs * SECONDS_PER_SPEC_RUN * RUNNER_VARIANCE;
    expect(worstCase).toBeLessThanOrEqual(boundSeconds());
  });
});
