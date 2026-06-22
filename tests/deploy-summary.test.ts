import { describe, expect, it } from 'vitest';
// The summary generator exposes a pure parse function so it is unit-testable
// without invoking the workflow. It turns raw `run-tests.js` stdout into the
// machine-readable summary the compat-matrix publisher (#41) consumes.
import { summarize } from '../scripts/e2e-summary.mjs';

/**
 * Contract test for scripts/e2e-summary.mjs (#89, ADR-0007 A3-2 / unblocks #41).
 *
 * The official harness (`node run-tests.js --type e2e`) prints jest-style tallies.
 * `summarize()` must reduce that noisy output + the run metadata into the exact
 * artifact shape the matrix publisher expects: {passed, failed, excluded, ref, shard}.
 */

// A representative slice of `run-tests.js` stdout (jest reporter summary lines).
const SAMPLE_RUNNER_OUTPUT = `
  ● Test suite failed to run
Tests:       3 failed, 41 passed, 2 skipped, 46 total
Test Suites: 1 failed, 12 passed, 13 total
Time:        612.34 s
Ran all test suites.
`;

describe('scripts/e2e-summary.mjs — summarize() (#89)', () => {
  it('extracts passed/failed counts from jest-style "Tests:" line', () => {
    const s = summarize(SAMPLE_RUNNER_OUTPUT, { ref: 'v16.0.3', shard: '1/4', excluded: 7 });
    expect(s.passed).toBe(41);
    expect(s.failed).toBe(3);
  });

  it('carries through ref, shard, and excluded metadata', () => {
    const s = summarize(SAMPLE_RUNNER_OUTPUT, { ref: 'v16.0.3', shard: '1/4', excluded: 7 });
    expect(s.ref).toBe('v16.0.3');
    expect(s.shard).toBe('1/4');
    expect(s.excluded).toBe(7);
  });

  it('produces a fully-shaped, JSON-serializable summary object', () => {
    const s = summarize(SAMPLE_RUNNER_OUTPUT, { ref: 'v16.0.3', shard: '1/4', excluded: 7 });
    expect(Object.keys(s).sort()).toEqual(['excluded', 'failed', 'passed', 'ref', 'shard'].sort());
    // round-trips through JSON (it's an artifact)
    expect(JSON.parse(JSON.stringify(s))).toEqual(s);
  });

  it('defaults counts to 0 when the runner output has no recognizable tally', () => {
    const s = summarize('no tests ran at all\n', { ref: 'v16.0.3', shard: '2/4', excluded: 0 });
    expect(s.passed).toBe(0);
    expect(s.failed).toBe(0);
    expect(s.excluded).toBe(0);
  });

  it('treats a missing failed-count (all green) as 0 failures', () => {
    const allGreen = 'Tests:       46 passed, 46 total\n';
    const s = summarize(allGreen, { ref: 'v16.0.3', shard: '3/4', excluded: 5 });
    expect(s.passed).toBe(46);
    expect(s.failed).toBe(0);
  });
});
