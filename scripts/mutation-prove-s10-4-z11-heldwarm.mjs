#!/usr/bin/env node
/**
 * Mutation proof for the Z11 combined case, the `heldwarm` phase, and the namespace-scoped hold
 * (S10-4; ADR-0004).
 *
 * Each row removes or weakens ONE thing `tests/z11-activator-drill.test.ts` protects about
 * `phase_heldwarm`, the warm half of `hold_call`, its cleanup, or the wiring that runs the phase
 * by default, and REQUIRES the spec to go red. Both halves are covered: what must be there
 * (the rotation, the one cached-key call, each assertion's status, code and message, the control,
 * the restore of every mutated thing) and what must not be (an extra call to the pod between the
 * cached-key call and the held one, a pod that is not the warm one answering). The shared driver
 * (`scripts/lib/guard-prover.mjs`) owns the discipline: verdicts by exit code, baseline green
 * first, a canary that must go red, anchors occurring exactly once (else abort), byte-exact
 * restore.
 *
 * Usage: node scripts/mutation-prove-s10-4-z11-heldwarm.mjs
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGuardProver } from './lib/guard-prover.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = 'tests/z11-activator-drill.test.ts';

const PRE =
  '[ "${PR_STATUS}" = 404 ] && [ "${PR_CODE}" = not_found ] \\\n    || fail "the warm pod answered';
const HELD =
  '[ "${HELD_STATUS}" = 401 ] && [ "${HELD_CODE}" = unauthenticated ] && [ "${HELD_MESSAGE}" = "token rejected" ] \\\n    || fail "warm pod: a call held';
const CTL =
  '[ "${HELD_STATUS}" = 404 ] && [ "${HELD_CODE}" = not_found ] \\\n    || fail "warm pod control: a call held';
const SAME_HELD =
  '[ "${uid}" = "${wuid}" ] && [ "${HELD_POD_UID}" = "${wuid}" ] \\\n    || fail "the held call was not answered';
const SAME_CTL =
  '[ "${uid}" = "${wuid}" ] && [ "${HELD_POD_UID}" = "${wuid}" ] \\\n    || fail "warm pod control: the call was not answered';
const GARBAGE =
  '  foreign_get "Bearer not-a-token"\n  [ "${FC_STATUS}" = 401 ] && [ "${FC_CODE}" = unauthenticated ] && [ "${FC_MESSAGE}" = "token rejected" ] \\\n    || fail "warm pod: after the holds';
const DEFAULTS =
  'PHASES="${PHASES:-up deploy token direct policyoff noauth rotcold held heldwarm}"';

const MUTATIONS = [
  // ---- the warm pod, kept warm and loaded
  {
    id: 'W1',
    subject: 'run',
    claim: 'the function is no longer kept on minScale 1, so it scales to zero during the rotation',
    anchor:
      '  k -n "${NS}" patch backendservice "${GO_FN}" --type merge -p \'{"spec":{"scaling":{"minScale":1}}}\' >/dev/null\n',
    replacement: '',
  },
  {
    id: 'W2',
    subject: 'run',
    claim: 'minScale 1 is no longer recorded for the exit handler',
    anchor: '  RESTORE_MINSCALE=1\n',
    replacement: '',
  },
  {
    id: 'W3',
    subject: 'run',
    claim: 'the wait no longer requires a NEW revision, so the old pod can be the "warm" one',
    anchor:
      '[ "$(k -n "${NS}" get ksvc "${GO_FN}" -o jsonpath="{.status.latestReadyRevisionName}")" != "${rev_before}" ] && ',
    replacement: '',
  },
  {
    id: 'W4',
    subject: 'run',
    claim: 'the wait no longer requires exactly one pod',
    anchor:
      '[ "$(all_pods "${GO_FN}")" = 1 ] && [ -n "$(fn_pod_ip)" ]\'\n  fn_probe "${WORK}/key-pre" pre',
    replacement:
      '[ "$(all_pods "${GO_FN}")" != 99 ] && [ -n "$(fn_pod_ip)" ]\'\n  fn_probe "${WORK}/key-pre" pre',
  },
  {
    id: 'W5',
    subject: 'run',
    claim: 'the key-set-loading call is deleted, so the pod caches nothing',
    anchor: '  fn_probe "${WORK}/key-pre" pre\n',
    replacement: '',
  },
  {
    id: 'W6',
    subject: 'run',
    claim: 'the key-set-loading call may be refused (status)',
    anchor: PRE,
    replacement: PRE.replace('[ "${PR_STATUS}" = 404 ]', '[ "${PR_STATUS}" != 404 ]'),
  },
  {
    id: 'W7',
    subject: 'run',
    claim: 'the key-set-loading call may be refused (code)',
    anchor: PRE,
    replacement: PRE.replace('[ "${PR_CODE}" = not_found ]', '[ "${PR_CODE}" != not_found ]'),
  },
  {
    id: 'W8',
    subject: 'run',
    claim: 'the key to load the set with is no longer exported',
    anchor: '  export_key "${WORK}/key-pre" current\n',
    replacement: '',
  },
  {
    id: 'W9',
    subject: 'run',
    claim: 'the warm pod uid and start are no longer recorded',
    anchor: '  read -r wuid wstart <<<"$(fn_pod_started)"\n',
    replacement: '  wuid=x\n  wstart=0\n',
  },
  // ---- the rotation under the warm pod
  {
    id: 'W10',
    subject: 'run',
    claim: 'the rotation is never requested',
    anchor:
      '  k -n "${NS}" annotate nextapp "${ZONE}" "apps.kn-next.dev/rotate-signing-key=${wnonce}" --overwrite\n  wait_until 60 1 "the operator to take the rotation request under the warm pod"',
    replacement: '  wait_until 60 1 "the operator to take the rotation request under the warm pod"',
  },
  {
    id: 'W11',
    subject: 'run',
    claim: 'the rotation no longer waits for signing to switch',
    anchor:
      '"signing to switch under the warm pod" \'[ "$(secret_get current.kid)" = "${new_kid}" ]\'\n  k -n "${NS}" annotate secret',
    replacement: '"signing to switch under the warm pod" true\n  k -n "${NS}" annotate secret',
  },
  {
    id: 'W12',
    subject: 'run',
    claim: 'the retirement stamp is no longer backdated',
    anchor:
      '\'[ "$(secret_get current.kid)" = "${new_kid}" ]\'\n  k -n "${NS}" annotate secret "${KEY_SECRET}" \\\n    "apps.kn-next.dev/signing-key-switched-at=$(node -p \'new Date(Date.now() - 7200 * 1000).toISOString()\')" --overwrite\n',
    replacement: '\'[ "$(secret_get current.kid)" = "${new_kid}" ]\'\n',
  },
  {
    id: 'W13',
    subject: 'run',
    claim: 'the retirement no longer waits for the previous key to leave the Secret',
    anchor:
      '"the previous key to leave the Secret under the warm pod" \'[ -z "$(secret_get previous.kid)" ]\'\n  wait_until 30 1 "the JWKS to publish only the new key under the warm pod" \'[ "$(jwks_kids)" = "${new_kid}" ]\'\n  retired_at="$(jwks_written_at)"\n  read -r uid',
    replacement:
      '"the previous key to leave the Secret under the warm pod" true\n  wait_until 30 1 "the JWKS to publish only the new key under the warm pod" \'[ "$(jwks_kids)" = "${new_kid}" ]\'\n  retired_at="$(jwks_written_at)"\n  read -r uid',
  },
  {
    id: 'W14',
    subject: 'run',
    claim: 'the JWKS is no longer required to publish only the new key',
    anchor:
      '"the JWKS to publish only the new key under the warm pod" \'[ "$(jwks_kids)" = "${new_kid}" ]\'\n  retired_at="$(jwks_written_at)"\n  read -r uid',
    replacement:
      '"the JWKS to publish only the new key under the warm pod" true\n  retired_at="$(jwks_written_at)"\n  read -r uid',
  },
  {
    id: 'W15',
    subject: 'run',
    claim: 'the pod is no longer required to be the same pod after the rotation',
    anchor:
      '[ "${uid}" = "${wuid}" ] && [ "${wstart}" -lt "${retired_at}" ] \\\n    || fail "the pod is',
    replacement:
      '[ "${uid}" != "" ] && [ "${wstart}" -lt "${retired_at}" ] \\\n    || fail "the pod is',
  },
  {
    id: 'W16',
    subject: 'run',
    claim: 'the pod is no longer shown to have started before the retirement',
    anchor:
      '[ "${uid}" = "${wuid}" ] && [ "${wstart}" -lt "${retired_at}" ] \\\n    || fail "the pod is',
    replacement: '[ "${uid}" = "${wuid}" ] && [ "${wstart}" -ge 0 ] \\\n    || fail "the pod is',
  },
  {
    id: 'W17',
    subject: 'run',
    claim: 'a call reaches the warm pod between the key-set load and the held call',
    anchor: '  log "heldwarm 1/3: rotate and retire the key while that pod is warm and idle"\n',
    replacement:
      '  log "heldwarm 1/3: rotate and retire the key while that pod is warm and idle"\n  fn_probe "${WORK}/key-pre" extra\n',
  },
  // ---- the held call and its answer
  {
    id: 'W18',
    subject: 'run',
    claim: 'the held call is no longer signed with the key that is current after the rotation',
    anchor: '  export_key "${WORK}/key-held" current\n  hold_call "${HELD_SECONDS}" warm\n',
    replacement: '  hold_call "${HELD_SECONDS}" warm\n',
  },
  {
    id: 'W19',
    subject: 'run',
    claim: 'the long held call is not sent',
    anchor: '  hold_call "${HELD_SECONDS}" warm\n',
    replacement: '',
  },
  {
    id: 'W20',
    subject: 'run',
    claim: 'the long hold is cold, not on the warm pod',
    anchor: '  hold_call "${HELD_SECONDS}" warm\n',
    replacement: '  hold_call "${HELD_SECONDS}"\n',
  },
  {
    id: 'W21',
    subject: 'run',
    claim: 'the long held call may be answered with anything but 401',
    anchor: HELD,
    replacement: HELD.replace('[ "${HELD_STATUS}" = 401 ]', '[ "${HELD_STATUS}" != 401 ]'),
  },
  {
    id: 'W22',
    subject: 'run',
    claim: 'the long held call may be answered with any code',
    anchor: HELD,
    replacement: HELD.replace(
      '[ "${HELD_CODE}" = unauthenticated ]',
      '[ "${HELD_CODE}" != unauthenticated ]',
    ),
  },
  {
    id: 'W23',
    subject: 'run',
    claim: 'the long held call accepts any message, so a stripped header would pass',
    anchor: HELD,
    replacement: HELD.replace(
      '[ "${HELD_MESSAGE}" = "token rejected" ]',
      '[ "${HELD_MESSAGE}" != "missing bearer token" ]',
    ),
  },
  {
    id: 'W24',
    subject: 'run',
    claim: 'the long held call may be answered by a pod that is not the warm one (live pod)',
    anchor: SAME_HELD,
    replacement: SAME_HELD.replace('[ "${uid}" = "${wuid}" ]', '[ "${uid}" != "" ]'),
  },
  {
    id: 'W25',
    subject: 'run',
    claim: 'the long held call may be answered by a pod that is not the warm one (hold record)',
    anchor: SAME_HELD,
    replacement: SAME_HELD.replace(
      '[ "${HELD_POD_UID}" = "${wuid}" ]',
      '[ "${HELD_POD_UID}" != "" ]',
    ),
  },
  // ---- the control
  {
    id: 'W26',
    subject: 'run',
    claim: 'the control hold is not sent',
    anchor: '  hold_call "${CONTROL_HELD_SECONDS}" warm\n  echo "HELDWARM-CONTROL',
    replacement: '  echo "HELDWARM-CONTROL',
  },
  {
    id: 'W27',
    subject: 'run',
    claim: 'the control may be refused (status)',
    anchor: CTL,
    replacement: CTL.replace('[ "${HELD_STATUS}" = 404 ]', '[ "${HELD_STATUS}" != 404 ]'),
  },
  {
    id: 'W28',
    subject: 'run',
    claim: 'the control may be answered with any code',
    anchor: CTL,
    replacement: CTL.replace('[ "${HELD_CODE}" = not_found ]', '[ "${HELD_CODE}" != not_found ]'),
  },
  {
    id: 'W29',
    subject: 'run',
    claim: 'the control may be answered by a pod that is not the warm one (live pod)',
    anchor: SAME_CTL,
    replacement: SAME_CTL.replace('[ "${uid}" = "${wuid}" ]', '[ "${uid}" != "" ]'),
  },
  {
    id: 'W30',
    subject: 'run',
    claim: 'the control may be answered by a pod that is not the warm one (hold record)',
    anchor: SAME_CTL,
    replacement: SAME_CTL.replace(
      '[ "${HELD_POD_UID}" = "${wuid}" ]',
      '[ "${HELD_POD_UID}" != "" ]',
    ),
  },
  {
    id: 'W31',
    subject: 'run',
    claim: 'the garbage token after the holds is no longer sent',
    anchor: GARBAGE,
    replacement: GARBAGE.replace('  foreign_get "Bearer not-a-token"\n', ''),
  },
  {
    id: 'W32',
    subject: 'run',
    claim: 'the garbage token after the holds may be accepted',
    anchor: GARBAGE,
    replacement: GARBAGE.replace('[ "${FC_STATUS}" = 401 ]', '[ "${FC_STATUS}" != 401 ]'),
  },
  {
    id: 'W33',
    subject: 'run',
    claim: 'minScale is no longer put back to 0 at the end of the phase',
    anchor:
      '  k -n "${NS}" patch backendservice "${GO_FN}" --type merge -p \'{"spec":{"scaling":{"minScale":0}}}\' >/dev/null\n  RESTORE_MINSCALE=0\n',
    replacement: '  RESTORE_MINSCALE=0\n',
  },
  // ---- the warm hold mechanism and its restore
  {
    id: 'K1',
    subject: 'run',
    claim: 'the warm hold no longer detaches the pod, so the activator has an endpoint',
    anchor:
      '    k -n "${NS}" label pod "${pod}" "serving.knative.dev/revisionUID=detached" --overwrite >/dev/null\n',
    replacement: '',
  },
  {
    id: 'K2',
    subject: 'run',
    claim: 'the warm hold never re-attaches the pod',
    anchor:
      '    k -n "${NS}" label pod "${pod}" "serving.knative.dev/revisionUID=${plabel}" --overwrite >/dev/null\n    RESTORE_DETACH=""\n',
    replacement: '    RESTORE_DETACH=""\n',
  },
  {
    id: 'K3',
    subject: 'run',
    claim: 'the detached pod is not recorded for the exit handler',
    anchor: '    RESTORE_DETACH="${pod}=${plabel}"\n',
    replacement: '',
  },
  {
    id: 'K4',
    subject: 'run',
    claim: 'the exit handler no longer re-attaches a detached pod after an abort',
    anchor: '  if [ -n "${RESTORE_DETACH}" ]; then\n',
    replacement: '  if [ -z "${RESTORE_DETACH}" ]; then\n',
  },
  {
    id: 'K5',
    subject: 'run',
    claim: 'the exit handler no longer puts minScale back after an abort',
    anchor: '  if [ "${RESTORE_MINSCALE}" = 1 ]; then\n',
    replacement: '  if [ "${RESTORE_MINSCALE}" = 99 ]; then\n',
  },
  {
    id: 'K6',
    subject: 'run',
    claim: 'the warm hold no longer shows that exactly the warm pod exists',
    anchor: '[ "$(all_pods "${GO_FN}")" = 1 ] || fail "the warm hold has',
    replacement: '[ "$(all_pods "${GO_FN}")" != 99 ] || fail "the warm hold has',
  },
  {
    id: 'K7',
    subject: 'run',
    claim: 'the cold hold no longer shows that no pod exists',
    anchor: '[ "$(all_pods "${GO_FN}")" = 0 ] || fail "a ${GO_FN} pod exists',
    replacement: '[ "$(all_pods "${GO_FN}")" != 99 ] || fail "a ${GO_FN} pod exists',
  },
  {
    id: 'K8',
    subject: 'run',
    claim: 'the pod that holds the call is no longer recorded for the answer check',
    anchor: '    HELD_POD_UID="${puid}"\n',
    replacement: '',
  },
  {
    id: 'K9',
    subject: 'run',
    claim: 'the ReplicaSet is no longer nudged after the quota is released',
    anchor:
      '  k -n "${NS}" annotate replicaset -l "serving.knative.dev/service=${GO_FN}" "apps.kn-next.dev/z11-release=${SECONDS}" --overwrite >/dev/null\n',
    replacement: '',
  },
  {
    id: 'K10',
    subject: 'run',
    claim: 'the quota no longer admits zero pods, so a pod can be created during the hold',
    anchor: '--hard=pods=0 >/dev/null',
    replacement: '--hard=pods=99 >/dev/null',
  },
  {
    id: 'K11',
    subject: 'run',
    claim:
      'the exit handler deletes the quota without --ignore-not-found, so a missing one aborts the restore',
    anchor: 'delete resourcequota "${HOLD_QUOTA}" --ignore-not-found',
    replacement: 'delete resourcequota "${HOLD_QUOTA}"',
  },
  // ---- dispatch and defaults
  {
    id: 'D1',
    subject: 'run',
    claim: 'the heldwarm phase is no longer dispatched',
    anchor: 'if has_phase heldwarm; then phase_heldwarm; fi\n',
    replacement: '',
  },
  {
    id: 'D2',
    subject: 'run',
    claim: 'heldwarm leaves the default phase list',
    anchor: DEFAULTS,
    replacement: DEFAULTS.replace(' heldwarm}', '}'),
  },
  {
    id: 'D3',
    subject: 'run',
    claim: 'heldwarm is no longer an accepted phase name',
    anchor: '| rotcold | held | heldwarm) ;;',
    replacement: '| rotcold | held) ;;',
  },
  // ---- workflow
  {
    id: 'F1',
    subject: 'workflow',
    claim: 'the workflow runs only the earlier phases',
    anchor: 'including policyoff, rotcold, held and heldwarm)\n        run:',
    replacement:
      'including policyoff, rotcold, held and heldwarm)\n        env:\n          PHASES: up deploy token direct policyoff noauth rotcold held\n        run:',
  },
  {
    id: 'F2',
    subject: 'workflow',
    claim: 'the drill step is renamed so it no longer claims the heldwarm phase',
    anchor: '(all phases, including policyoff, rotcold, held and heldwarm)',
    replacement: '(all phases, including policyoff, rotcold and held)',
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

console.log('=== mutation proof: Z11 combined case, warm pod and held call (S10-4) ===');
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
