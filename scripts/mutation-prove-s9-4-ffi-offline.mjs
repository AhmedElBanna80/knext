#!/usr/bin/env node
/**
 * Mutation proof for the S9-4 egress proof: the CI knext-crate path is offline
 * with github.com closed, and the closure is real.
 *
 * One spec, `tests/ffi-ci-local-crates.test.ts`, holds the guards. Each mutation
 * puts back ONE defect and requires the spec to go red:
 *
 *   - the rewrite is off (no local source): the positive git fetch fails;
 *   - the github.com denial is not applied: the control is not refused;
 *   - the verdict ignores a control that succeeded;
 *   - the verdict ignores a fetch that did not read the local clone;
 *   - the cargo probe writes no denial into the control's git config;
 *   - the CI step is masked (continue-on-error), replaced by `echo`, or renamed
 *     away, so the step is not what the spec finds;
 *   - the egress script no longer exits 1 on a problem.
 *
 * The verdicts are by EXIT CODE only (the shared driver, `scripts/lib/guard-prover.mjs`,
 * never parses output). Every anchor must occur exactly once (preflight first),
 * the unmutated spec must be green, a canary must go red before any green is
 * trusted, and every restore is content-verified.
 *
 * Usage:  node scripts/mutation-prove-s9-4-ffi-offline.mjs
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGuardProver } from './lib/guard-prover.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = 'tests/ffi-ci-local-crates.test.ts';

const MUTATIONS = [
  {
    id: 'S01',
    subject: 'local',
    claim: 'the rewrite is off: the positive fetch no longer comes from the local clone',
    anchor: "    GIT_CONFIG_COUNT: '1',",
    replacement: "    GIT_CONFIG_COUNT: '0',",
  },
  {
    id: 'S02',
    subject: 'local',
    claim: 'the github.com denial key is misspelled, so github.com is reachable again',
    anchor: '\\tproxy = ${DENIED_PROXY}',
    replacement: '\\tproxyX = ${DENIED_PROXY}',
  },
  {
    id: 'S03',
    subject: 'local',
    claim: 'the verdict stops failing when the control fetch succeeds',
    anchor: '  if (control.status === 0) {',
    replacement: '  if (control.status === 1000) {',
  },
  {
    id: 'S04',
    subject: 'local',
    claim: 'the verdict stops failing when the fetch did not read the local clone',
    anchor: '  } else if (!positive.stderr.includes(',
    replacement: '  } else if (false && !positive.stderr.includes(',
  },
  {
    id: 'S05',
    subject: 'local',
    claim: 'the cargo probe writes no github.com denial into the git config it hands cargo',
    anchor: '    writeFileSync(gitConfig, githubDenialGitConfig());',
    replacement: "    writeFileSync(gitConfig, '');",
  },
  {
    id: 'S06',
    subject: 'workflow',
    claim: 'the egress step is masked with continue-on-error',
    anchor: '        run: bun harness/ffi-egress-offline.ts',
    replacement: '        continue-on-error: true\n        run: bun harness/ffi-egress-offline.ts',
  },
  {
    id: 'S07',
    subject: 'workflow',
    claim: 'the egress step runs an echo instead of the proof',
    anchor: '        run: bun harness/ffi-egress-offline.ts',
    replacement: '        run: echo skipped',
  },
  {
    id: 'S08',
    subject: 'workflow',
    claim: 'the egress step is renamed away, so the crates job has no egress step',
    anchor: '      - name: Generator — egress denied,',
    replacement: '      - name: Generator — egress skipped,',
  },
  {
    id: 'S09',
    subject: 'egress',
    claim: 'the egress script no longer exits 1 on a problem',
    anchor: 'if (problems.length > 0) {',
    replacement: 'if (problems.length > 99) {',
  },
];

// The subjects are inline literals, not a shared constant: the lane's
// subject-existence audit reads them from the createGuardProver call.
const prover = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: SPEC,
  subjects: {
    local: 'crates/harness/local-crates-source.ts',
    egress: 'crates/harness/ffi-egress-offline.ts',
    workflow: '.github/workflows/rust-crates.yml',
  },
});

console.log('=== mutation proof: S9-4 CI egress proof (tests/ffi-ci-local-crates.test.ts) ===');
prover.preflight(MUTATIONS);
declareMutations(MUTATIONS.length);

prover.baseline();
// The canary: a mutation that must be caught before any green verdict is trusted.
prover.proveCanSeeRed({
  subject: 'local',
  anchor: '  } else if (!positive.stderr.includes(',
  replacement: '  } else if (true || !positive.stderr.includes(',
});
for (const m of MUTATIONS) {
  prover.run({ ...m, expect: 'red' });
  recordMutation();
}
prover.finish(MUTATIONS.length);
