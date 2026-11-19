#!/usr/bin/env node
/**
 * Mutation proof for the S9-4 egress proof: the CI knext-crate path is offline
 * with github.com closed, and the closure is real.
 *
 * One spec, `tests/ffi-ci-local-crates.test.ts`, holds the guards. The proof has
 * two halves, and each has its own rows:
 *
 *   REWRITE half (the local clone supplies the recorded rev):
 *     S01-S05: the rewrite is off, misspelled, points at the wrong URL; the
 *     verdict stops requiring the positive db to hold the rev; the probe stops
 *     checking the db.
 *   DENIAL half (github.com is closed, so a control with no rewrite is refused):
 *     S06-S10: the denial key is misspelled, the denial config is empty, the
 *     verdict stops failing on a successful control, stops failing on a control
 *     that died for another reason, and the probe writes no denial.
 *   CI WIRING: S11-S13 (the step masked, echoed, renamed away) and S14 (the
 *     script no longer exits 1 on a problem).
 *
 * Each mutation puts back ONE defect and requires the spec to go red. The
 * verdicts are by EXIT CODE only (the shared driver, `scripts/lib/guard-prover.mjs`,
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
  // ── REWRITE half ─────────────────────────────────────────────────────────
  {
    id: 'S01',
    subject: 'local',
    half: 'rewrite',
    claim: 'the rewrite is off: no local source is configured',
    anchor: "    GIT_CONFIG_COUNT: '1',",
    replacement: "    GIT_CONFIG_COUNT: '0',",
  },
  {
    id: 'S02',
    subject: 'local',
    half: 'rewrite',
    claim: 'the rewrite key is misspelled, so cargo never sees the local clone',
    anchor: '    GIT_CONFIG_KEY_0: `url.file://${repoDir}.insteadOf`,',
    replacement: '    GIT_CONFIG_KEY_0: `url.file://${repoDir}.insteadOfX`,',
  },
  {
    id: 'S03',
    subject: 'local',
    half: 'rewrite',
    claim: 'the rewrite maps a sibling URL, so CRATE_GIT itself is not served locally',
    anchor: '    GIT_CONFIG_VALUE_0: gitUrl,',
    replacement: "    GIT_CONFIG_VALUE_0: gitUrl + '-x',",
  },
  {
    id: 'S04',
    subject: 'local',
    half: 'rewrite',
    claim: 'the verdict stops failing when the positive db does not hold the recorded rev',
    anchor: '  } else if (!positiveHoldsRev) {',
    replacement: '  } else if (false && !positiveHoldsRev) {',
  },
  {
    id: 'S05',
    subject: 'local',
    half: 'rewrite',
    claim: 'the probe reports the db as holding the rev without checking it',
    anchor: "    const holds = cargoDbHoldsRev(join(root, 'cargo-home-positive'), opts.rev);",
    replacement:
      "    const holds = true || cargoDbHoldsRev(join(root, 'cargo-home-positive'), opts.rev);",
  },
  // ── DENIAL half ──────────────────────────────────────────────────────────
  {
    id: 'S06',
    subject: 'local',
    half: 'denial',
    claim: 'the github.com denial key is misspelled, so github.com is reachable again',
    anchor: '\\tproxy = ${DENIED_PROXY}',
    replacement: '\\tproxyX = ${DENIED_PROXY}',
  },
  {
    id: 'S07',
    subject: 'local',
    half: 'denial',
    claim: 'the denial config is empty, so the test helper and the probe carry no route closure',
    anchor: '  return `[http "https://github.com/"]\\n\\tproxy = ${DENIED_PROXY}\\n`;',
    replacement: "  return '';",
  },
  {
    id: 'S08',
    subject: 'local',
    half: 'denial',
    claim: 'the verdict stops failing when the control fetch succeeds',
    anchor: '  if (control.status === 0) {',
    replacement: '  if (control.status === 1000) {',
  },
  {
    id: 'S09',
    subject: 'local',
    half: 'denial',
    claim:
      'the verdict stops failing when the control dies for a reason other than the denied route',
    anchor: '  } else if (!/127\\.0\\.0\\.1 port 9|Failed to connect/.test(control.stderr)) {',
    replacement:
      '  } else if (false && !/127\\.0\\.0\\.1 port 9|Failed to connect/.test(control.stderr)) {',
  },
  {
    id: 'S10',
    subject: 'local',
    half: 'denial',
    claim: 'the probe writes no github.com denial into the git config it hands cargo',
    anchor: '    writeFileSync(gitConfig, githubDenialGitConfig());',
    replacement: "    writeFileSync(gitConfig, '');",
  },
  // ── CI wiring and the script's exit ──────────────────────────────────────
  {
    id: 'S11',
    subject: 'workflow',
    half: 'wiring',
    claim: 'the egress step is masked with continue-on-error',
    anchor: '        run: bun harness/ffi-egress-offline.ts',
    replacement: '        continue-on-error: true\n        run: bun harness/ffi-egress-offline.ts',
  },
  {
    id: 'S12',
    subject: 'workflow',
    half: 'wiring',
    claim: 'the egress step runs an echo instead of the proof',
    anchor: '        run: bun harness/ffi-egress-offline.ts',
    replacement: '        run: echo skipped',
  },
  {
    id: 'S13',
    subject: 'workflow',
    half: 'wiring',
    claim: 'the egress step is renamed away, so the crates job has no egress step',
    anchor: '      - name: Generator — egress denied,',
    replacement: '      - name: Generator — egress skipped,',
  },
  {
    id: 'S14',
    subject: 'egress',
    half: 'wiring',
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

const halves = new Set(MUTATIONS.map((m) => m.half));
if (!halves.has('rewrite') || !halves.has('denial')) {
  throw new Error('the proof must cover BOTH halves (rewrite and denial)');
}

prover.baseline();
// The canary: a mutation that must be caught before any green verdict is trusted.
prover.proveCanSeeRed({
  subject: 'local',
  anchor: '  } else if (!positiveHoldsRev) {',
  replacement: '  } else if (true || !positiveHoldsRev) {',
});
for (const m of MUTATIONS) {
  prover.run({ ...m, expect: 'red' });
  recordMutation();
}
prover.finish(MUTATIONS.length);
