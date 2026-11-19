#!/usr/bin/env node
/**
 * Mutation proof for the Z11 policy-off leg (S8-1; ADR-0004, ADR-0052 D13).
 *
 * Each row removes one thing `tests/z11-activator-drill.test.ts` protects about the
 * `policyoff` phase of packages/grpc/e2e/z11-activator-drill/run.sh, or about the
 * workflow that runs it by default, and REQUIRES the spec to go red. The shared
 * driver (`scripts/lib/guard-prover.mjs`) owns the discipline: verdicts by exit code,
 * baseline green first, a canary that must go red, anchors occurring exactly once
 * (else abort), byte-exact restore.
 *
 * Usage: node scripts/mutation-prove-s8-1-z11-policyoff.mjs
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGuardProver } from './lib/guard-prover.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = 'tests/z11-activator-drill.test.ts';

const MUTATIONS = [
  {
    id: 'P1',
    subject: 'run',
    claim: 'the policy-off phase no longer switches the policy off',
    anchor: '  set_policy false\n  # set_policy returned only once',
    replacement: '  # set_policy returned only once',
  },
  {
    id: 'P2',
    subject: 'run',
    claim: 'the policy-off phase stops proving the policy object is gone',
    anchor:
      '|| fail "the function\'s NetworkPolicy still exists: the leg would not be a policy-off leg"',
    replacement: '|| true',
  },
  {
    id: 'P3',
    subject: 'run',
    claim: 'the policy-off phase never restores the policy',
    anchor: '  set_policy true\n  ok "policy off: a foreign pod reached',
    replacement: '  ok "policy off: a foreign pod reached',
  },
  {
    id: 'P4',
    subject: 'run',
    claim: 'the direct leg stops requiring the dial to connect',
    anchor: '[ "$(dial_rc "${ip}" 8080)" = 0 ]; then DIRECT_IP=',
    replacement: '[ "$(dial_rc "${ip}" 8080)" != 99 ]; then DIRECT_IP=',
  },
  {
    id: 'P5',
    subject: 'run',
    claim: 'the direct no-token call is no longer sent to the pod',
    anchor: '  foreign_post "http://${ip}:8080${GET_ITEM}" ""\n',
    replacement: '  foreign_get ""\n',
  },
  {
    id: 'P6',
    subject: 'run',
    claim: 'the direct garbage-token call is dropped',
    anchor: '  foreign_post "http://${ip}:8080${GET_ITEM}" "Bearer not-a-token"\n',
    replacement: '',
  },
  {
    id: 'P7',
    subject: 'run',
    claim: 'the policyoff phase is no longer dispatched',
    anchor: 'if has_phase policyoff; then phase_policyoff; fi\n',
    replacement: '',
  },
  {
    id: 'P8',
    subject: 'run',
    claim: 'policyoff leaves the default phase list',
    anchor: 'PHASES="${PHASES:-up deploy token direct policyoff noauth}"',
    replacement: 'PHASES="${PHASES:-up deploy token direct noauth}"',
  },
  {
    id: 'L1',
    subject: 'run',
    claim: 'the cold policy-off leg weakens its 401 assertion',
    anchor:
      '[ "${FC_STATUS}" = 401 ] && [ "${FC_CODE}" = unauthenticated ] && [ "${FC_MESSAGE}" = "missing bearer token" ] \\\n    || fail "policy off, cold',
    replacement:
      '[ "${FC_STATUS}" != 401 ] && [ "${FC_CODE}" = unauthenticated ] && [ "${FC_MESSAGE}" = "missing bearer token" ] \\\n    || fail "policy off, cold',
  },
  {
    id: 'L2',
    subject: 'run',
    claim: 'the direct no-token leg weakens its 401 assertion',
    anchor:
      '[ "${FC_STATUS}" = 401 ] && [ "${FC_CODE}" = unauthenticated ] && [ "${FC_MESSAGE}" = "missing bearer token" ] \\\n    || fail "policy off, direct to the pod, no token',
    replacement:
      '[ "${FC_STATUS}" != 401 ] && [ "${FC_CODE}" = unauthenticated ] && [ "${FC_MESSAGE}" = "missing bearer token" ] \\\n    || fail "policy off, direct to the pod, no token',
  },
  {
    id: 'L3',
    subject: 'run',
    claim: 'the direct garbage-token leg weakens its 401 assertion',
    anchor:
      '[ "${FC_STATUS}" = 401 ] && [ "${FC_CODE}" = unauthenticated ] && [ "${FC_MESSAGE}" = "token rejected" ] \\\n    || fail "policy off, direct to the pod, garbage token',
    replacement:
      '[ "${FC_STATUS}" != 401 ] && [ "${FC_CODE}" = unauthenticated ] && [ "${FC_MESSAGE}" = "token rejected" ] \\\n    || fail "policy off, direct to the pod, garbage token',
  },
  {
    id: 'L4',
    subject: 'run',
    claim: 'the cold policy-off call is deleted, leaving the stale status to be judged',
    anchor:
      '  foreign_get ""\n  [ "${FC_STATUS}" = 401 ] && [ "${FC_CODE}" = unauthenticated ] && [ "${FC_MESSAGE}" = "missing bearer token" ] \\\n    || fail "policy off, cold',
    replacement:
      '  [ "${FC_STATUS}" = 401 ] && [ "${FC_CODE}" = unauthenticated ] && [ "${FC_MESSAGE}" = "missing bearer token" ] \\\n    || fail "policy off, cold',
  },
  {
    id: 'WK1',
    subject: 'run',
    claim: 'phase_direct stops waking the function before it looks for a pod',
    anchor: '  wake_ready\n  ip="${WARM_IP}"\n',
    replacement: '  ip="$(fn_pod_ip)"\n',
  },
  {
    id: 'WK2',
    subject: 'run',
    claim: 'the policy-off direct wait stops waking the function first',
    anchor: '  wake_ready\n  await_direct_ip\n  ip="${DIRECT_IP}"\n',
    replacement: '  await_direct_ip\n  ip="${DIRECT_IP}"\n',
  },
  {
    id: 'WK3',
    subject: 'run',
    claim: 'wake_ready stops failing closed when no pod becomes Ready',
    anchor: '  fail "no Ready ${GO_FN} pod to dial after waking',
    replacement: '  true "no Ready ${GO_FN} pod to dial after waking',
  },
  {
    id: 'K1',
    subject: 'run',
    claim: 'the policy-off direct wait stops keeping the pod warm',
    anchor:
      '    zone_call "/example/get?sub=alice&id=missing"\n    ip="$(fn_pod_ip)"\n    if [ -n "${ip}" ] && [ "$(dial_rc "${ip}" 8080)" = 0 ]; then DIRECT_IP=',
    replacement:
      '    ip="$(fn_pod_ip)"\n    if [ -n "${ip}" ] && [ "$(dial_rc "${ip}" 8080)" = 0 ]; then DIRECT_IP=',
  },
  {
    id: 'N1',
    subject: 'run',
    claim: 'noauth no longer turns the policy off for its direct dial',
    anchor: '  set_policy false\n  wake_ready\n  await_direct_ip\n  local dip=',
    replacement: '  wake_ready\n  await_direct_ip\n  local dip=',
  },
  {
    id: 'N2',
    subject: 'run',
    claim: 'noauth no longer dials the no-interceptor pod directly',
    anchor: '  foreign_post "http://${dip}:8080${GET_ITEM}" ""\n',
    replacement: '  foreign_get ""\n',
  },
  {
    id: 'N3',
    subject: 'run',
    claim: 'noauth weakens the policy-off outcome (404 not_found)',
    anchor: '[ "${pstatus}" = 404 ] && [ "${pcode}" = not_found ]',
    replacement: '[ "${pstatus}" != 404 ] && [ "${pcode}" = not_found ]',
  },
  {
    id: 'N4',
    subject: 'run',
    claim: 'noauth leaves the policy off while the image is restored',
    anchor: '  set_policy true\n  echo "NOAUTH-WITH-POLICY-OFF',
    replacement: '  echo "NOAUTH-WITH-POLICY-OFF',
  },
  {
    id: 'W4',
    subject: 'workflow',
    claim: 'the drill run step gains a step-level if that can skip it',
    anchor: '        run: packages/grpc/e2e/z11-activator-drill/run.sh',
    replacement:
      "        if: github.event_name != 'push'\n        run: packages/grpc/e2e/z11-activator-drill/run.sh",
  },
  {
    id: 'W5',
    subject: 'workflow',
    claim: 'the path filter widens back to the whole operator tree',
    anchor:
      "      - '.github/workflows/z11-activator-drill-e2e.yml'\n      - 'tests/z11-activator-drill.test.ts'\n  push:",
    replacement:
      "      - '.github/workflows/z11-activator-drill-e2e.yml'\n      - 'tests/z11-activator-drill.test.ts'\n      - 'packages/kn-next-operator/**'\n  push:",
  },
  {
    id: 'W6',
    subject: 'workflow',
    claim: 'the push path filter drifts from the pull_request one (drops an entry)',
    anchor: "      - 'tests/z11-activator-drill.test.ts'\n  workflow_dispatch: {}",
    replacement: '  workflow_dispatch: {}',
  },
  {
    id: 'W1',
    subject: 'workflow',
    claim: 'the workflow runs only a subset of phases',
    anchor:
      '      - name: Run the Z11 activator-path drill (all phases, including policyoff)\n        run:',
    replacement:
      '      - name: Run the Z11 activator-path drill (all phases, including policyoff)\n        env:\n          PHASES: up deploy token\n        run:',
  },
  {
    id: 'W2',
    subject: 'workflow',
    claim: 'the workflow masks a red step',
    anchor: '    timeout-minutes: 60\n',
    replacement: '    timeout-minutes: 60\n    continue-on-error: true\n',
  },
  {
    id: 'W3',
    subject: 'workflow',
    claim: 'the workflow stops running on integration pushes',
    anchor: "    branches: [main, 'integration/**']",
    replacement: '    branches: [main]',
  },
];

const prover = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: SPEC,
  subjects: {
    run: 'packages/grpc/e2e/z11-activator-drill/run.sh',
    workflow: '.github/workflows/z11-activator-drill-e2e.yml',
  },
});

console.log('=== mutation proof: Z11 policy-off leg (S8-1) ===');
prover.preflight(MUTATIONS);
declareMutations(MUTATIONS.length);
prover.baseline();
prover.proveCanSeeRed({
  subject: 'run',
  anchor: 'FOREIGN="${NS}-foreign"',
  replacement: 'FOREIGN="${NS}-foreignz"',
});
for (const m of MUTATIONS) {
  prover.run({ ...m, expect: 'red' });
  recordMutation();
}
prover.finish(MUTATIONS.length);
