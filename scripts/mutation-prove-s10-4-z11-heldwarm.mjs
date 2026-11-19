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
 * cached-key call and the held one, a pod that is not the warm one answering: the rows for that are in the S11-1 prover, which runs
 * the observation itself). The shared driver
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

const LOAD = (x) =>
  `[ "\${PR_STATUS}" = 404 ] && [ "\${PR_CODE}" = not_found ] \\\n    || fail "the warm pod ${x} answered`;
const HELD =
  '[ "${HELD_STATUS}" = 401 ] && [ "${HELD_CODE}" = unauthenticated ] && [ "${HELD_MESSAGE}" = "token rejected" ] \\\n    || fail "warm pod: a call held';
const CTL =
  '[ "${HELD_STATUS}" = 404 ] && [ "${HELD_CODE}" = not_found ] \\\n    || fail "warm pod control: a call held';
const GARBAGE =
  '  foreign_get "Bearer not-a-token"\n  [ "${FC_STATUS}" = 401 ] && [ "${FC_CODE}" = unauthenticated ] && [ "${FC_MESSAGE}" = "token rejected" ] \\\n    || fail "warm pod: after the holds';
const DEFAULTS =
  'PHASES="${PHASES:-up deploy token direct policyoff noauth rotcold held heldwarm}"';
const CLEAN_LOOP =
  '  for entry in ${RESTORE_DETACH}; do\n    k -n "${NS}" label pod "${entry%%=*}" "serving.knative.dev/revisionUID=${entry#*=}" --overwrite >/dev/null 2>&1 \\\n';
const UIDS_CHK =
  '[ "$(fn_pod_uids)" = "${wuids}" ] && [ "$(fn_pods_started_max)" -lt "${wretired_at}" ] \\\n    || fail "the pods are';

const row = (id, claim, anchor, replacement, subject = 'run') => ({
  id,
  subject,
  claim,
  anchor,
  replacement,
});

const MUTATIONS = [
  // ---- two warm pods, each loaded with the OLD key set
  row(
    'W1',
    'the function is no longer kept on two pods, so one pod would have to serve both legs',
    '  k -n "${NS}" patch backendservice "${GO_FN}" --type merge -p \'{"spec":{"scaling":{"minScale":2,"maxScale":2}}}\' >/dev/null\n',
    '',
  ),
  row(
    'W2',
    'the raised scale is no longer recorded for the exit handler',
    '  RESTORE_MINSCALE=1\n',
    '',
  ),
  row(
    'W3',
    'the wait no longer requires a NEW revision, so an old pod can be a "warm" one',
    '[ "$(k -n "${NS}" get ksvc "${GO_FN}" -o jsonpath="{.status.latestReadyRevisionName}")" != "${rev_before}" ] && ',
    '',
  ),
  row(
    'W4',
    'the wait no longer requires exactly two pods',
    '[ "$(all_pods "${GO_FN}")" = 2 ] &&',
    '[ "$(all_pods "${GO_FN}")" != 99 ] &&',
  ),
  row(
    'W5',
    'the two warm pods are no longer required to be different pods',
    '[ -n "${wuid_a}" ] && [ -n "${wuid_b}" ] && [ "${wuid_a}" != "${wuid_b}" ] || fail',
    '[ -n "${wuid_a}" ] && [ -n "${wuid_b}" ] && [ "${wuid_a}" != "" ] || fail',
  ),
  row('W6', 'pod A is not isolated before its load call', '  isolate_pods "${wuid_a}"\n', ''),
  row(
    'W7',
    'the load call to pod A is deleted, so it caches nothing',
    '  fn_probe "${WORK}/key-pre" load-a\n',
    '',
  ),
  row(
    'W8',
    'pod B is not isolated before its load call',
    '  isolate_pods "${wuid_b}"\n  fn_probe "${WORK}/key-pre" load-b\n',
    '  fn_probe "${WORK}/key-pre" load-b\n',
  ),
  row(
    'W9',
    'the load call to pod B is deleted, so it caches nothing',
    '  fn_probe "${WORK}/key-pre" load-b\n',
    '',
  ),
  row(
    'W10',
    "pod A's load call may be refused (status)",
    LOAD('A'),
    LOAD('A').replace('[ "${PR_STATUS}" = 404 ]', '[ "${PR_STATUS}" != 404 ]'),
  ),
  row(
    'W11',
    "pod A's load call may be refused (code)",
    LOAD('A'),
    LOAD('A').replace('[ "${PR_CODE}" = not_found ]', '[ "${PR_CODE}" != not_found ]'),
  ),
  row(
    'W12',
    "pod B's load call may be refused (status)",
    LOAD('B'),
    LOAD('B').replace('[ "${PR_STATUS}" = 404 ]', '[ "${PR_STATUS}" != 404 ]'),
  ),
  row(
    'W13',
    "pod B's load call may be refused (code)",
    LOAD('B'),
    LOAD('B').replace('[ "${PR_CODE}" = not_found ]', '[ "${PR_CODE}" != not_found ]'),
  ),
  row(
    'W14',
    'pod A stays detached after its load call, so B is isolated with A still out',
    '  release_pods\n  isolate_pods "${wuid_b}"\n',
    '  isolate_pods "${wuid_b}"\n',
  ),
  row(
    'W15',
    'the pods are not re-attached after the last load call',
    '  release_pods\n  ok "both warm pods',
    '  ok "both warm pods',
  ),
  row(
    'W16',
    'the key to load the set with is no longer exported',
    '  export_key "${WORK}/key-pre" current\n',
    '',
  ),
  // ---- the rotation under the warm pods
  row(
    'W17',
    'the rotation is never requested',
    '  k -n "${NS}" annotate nextapp "${ZONE}" "apps.kn-next.dev/rotate-signing-key=${wnonce}" --overwrite\n',
    '',
  ),
  row(
    'W18',
    'the rotation no longer waits for signing to switch',
    '"signing to switch under the warm pod" \'[ "$(secret_get current.kid)" = "${new_kid}" ]\'',
    '"signing to switch under the warm pod" true',
  ),
  row(
    'W19',
    'the retirement stamp is no longer backdated',
    '\'[ "$(secret_get current.kid)" = "${new_kid}" ]\'\n  k -n "${NS}" annotate secret "${KEY_SECRET}" \\\n    "apps.kn-next.dev/signing-key-switched-at=$(node -p \'new Date(Date.now() - 7200 * 1000).toISOString()\')" --overwrite\n',
    '\'[ "$(secret_get current.kid)" = "${new_kid}" ]\'\n',
  ),
  row(
    'W20',
    'the retirement no longer waits for the previous key to leave the Secret',
    '"the previous key to leave the Secret under the warm pod" \'[ -z "$(secret_get previous.kid)" ]\'',
    '"the previous key to leave the Secret under the warm pod" true',
  ),
  row(
    'W21',
    'the JWKS is no longer required to publish only the new key',
    '"the JWKS to publish only the new key under the warm pod" \'[ "$(jwks_kids)" = "${new_kid}" ]\'',
    '"the JWKS to publish only the new key under the warm pod" true',
  ),
  row(
    'W22',
    'the pods are no longer required to be the same pods after the rotation',
    UIDS_CHK,
    UIDS_CHK.replace('[ "$(fn_pod_uids)" = "${wuids}" ]', '[ "$(fn_pod_uids)" != "" ]'),
  ),
  row(
    'W23',
    'the pods are no longer shown to have started before the retirement',
    UIDS_CHK,
    UIDS_CHK.replace('-lt "${wretired_at}" ]', '-ge 0 ]'),
  ),
  row(
    'W24',
    'a call reaches a warm pod between the key-set load and the held calls',
    '  log "heldwarm 1/3: rotate and retire the key while those pods are warm and idle"\n',
    '  log "heldwarm 1/3: rotate and retire the key while those pods are warm and idle"\n  fn_probe "${WORK}/key-pre" extra\n',
  ),
  // ---- the control (pod A, held short) and the test (pod B, held long)
  row(
    'W25',
    'the held calls are no longer signed with the key that is current after the rotation',
    '  export_key "${WORK}/key-held" current\n  hold_call "${CONTROL_HELD_SECONDS}" warm "${wuid_a}"\n',
    '  hold_call "${CONTROL_HELD_SECONDS}" warm "${wuid_a}"\n',
  ),
  row(
    'W26',
    'the control hold is not sent',
    '  hold_call "${CONTROL_HELD_SECONDS}" warm "${wuid_a}"\n',
    '',
  ),
  row(
    'W27',
    'the control hold targets the other pod',
    'hold_call "${CONTROL_HELD_SECONDS}" warm "${wuid_a}"',
    'hold_call "${CONTROL_HELD_SECONDS}" warm "${wuid_b}"',
  ),
  row(
    'W28',
    'the control may be refused (status)',
    CTL,
    CTL.replace('[ "${HELD_STATUS}" = 404 ]', '[ "${HELD_STATUS}" != 404 ]'),
  ),
  row(
    'W29',
    'the control may be answered with any code',
    CTL,
    CTL.replace('[ "${HELD_CODE}" = not_found ]', '[ "${HELD_CODE}" != not_found ]'),
  ),
  row(
    'W31',
    'the long held call is not sent',
    '  hold_call "${HELD_SECONDS}" warm "${wuid_b}"\n',
    '',
  ),
  row(
    'W32',
    'the long hold targets the pod the control already refreshed',
    'hold_call "${HELD_SECONDS}" warm "${wuid_b}"',
    'hold_call "${HELD_SECONDS}" warm "${wuid_a}"',
  ),
  row(
    'W33',
    'the long hold is cold, not on a warm pod',
    'hold_call "${HELD_SECONDS}" warm "${wuid_b}"',
    'hold_call "${HELD_SECONDS}"',
  ),
  row(
    'W34',
    'the long held call may be answered with anything but 401',
    HELD,
    HELD.replace('[ "${HELD_STATUS}" = 401 ]', '[ "${HELD_STATUS}" != 401 ]'),
  ),
  row(
    'W35',
    'the long held call may be answered with any code',
    HELD,
    HELD.replace('[ "${HELD_CODE}" = unauthenticated ]', '[ "${HELD_CODE}" != unauthenticated ]'),
  ),
  row(
    'W36',
    'the long held call accepts any message, so a stripped header would pass',
    HELD,
    HELD.replace(
      '[ "${HELD_MESSAGE}" = "token rejected" ]',
      '[ "${HELD_MESSAGE}" != "missing bearer token" ]',
    ),
  ),
  row(
    'W38',
    'the garbage token after the holds is no longer sent',
    GARBAGE,
    GARBAGE.replace('  foreign_get "Bearer not-a-token"\n', ''),
  ),
  row(
    'W39',
    'the garbage token after the holds may be accepted',
    GARBAGE,
    GARBAGE.replace('[ "${FC_STATUS}" = 401 ]', '[ "${FC_STATUS}" != 401 ]'),
  ),
  row(
    'W40',
    'the scale is no longer put back at the end of the phase',
    '  k -n "${NS}" patch backendservice "${GO_FN}" --type merge -p \'{"spec":{"scaling":{"minScale":0,"maxScale":1}}}\' >/dev/null\n  RESTORE_MINSCALE=0\n',
    '  RESTORE_MINSCALE=0\n',
  ),
  // ---- the warm hold mechanism, the label-before-quota order, the exactly-these-pods check
  row(
    'K1',
    'the warm hold no longer detaches the pods, so the activator has endpoints',
    '      k -n "${NS}" label pod "${pod}" "serving.knative.dev/revisionUID=detached" --overwrite >/dev/null\n    done <<<"${pods}"',
    '      true\n    done <<<"${pods}"',
  ),
  row(
    'K2',
    'the target pod is never re-attached before the answer',
    '    k -n "${NS}" label pod "${tpod}" "serving.knative.dev/revisionUID=${tlabel}" --overwrite >/dev/null\n',
    '',
  ),
  row(
    'K3',
    'the quota is deleted BEFORE the target pod is re-attached',
    '    # The label goes back BEFORE the quota is deleted, and only on the target pod.\n    k -n "${NS}" label pod "${tpod}" "serving.knative.dev/revisionUID=${tlabel}" --overwrite >/dev/null\n',
    '    k -n "${NS}" delete resourcequota "${HOLD_QUOTA}" >/dev/null\n    k -n "${NS}" label pod "${tpod}" "serving.knative.dev/revisionUID=${tlabel}" --overwrite >/dev/null\n',
  ),
  row(
    'K4',
    'the pod set is no longer checked unchanged during the hold',
    '[ "$(fn_pod_uids)" = "${uids_before}" ] || fail "the warm pods changed during the hold',
    '[ "$(fn_pod_uids)" != "x" ] || fail "the warm pods changed during the hold',
  ),
  row(
    'K5',
    'the pod set is no longer required to be exactly the original after the answer',
    '[ "$(fn_pod_uids)" = "${uids_before}" ] || fail "after the answer the pods are',
    '[ "$(fn_pod_uids)" != "x" ] || fail "after the answer the pods are',
  ),
  row(
    'K6',
    'the other pods are never re-attached after the answer',
    '    release_pods\n    # Exactly',
    '    # Exactly',
  ),
  row(
    'K8',
    'the original pod set is no longer recorded',
    '    uids_before="$(fn_pod_uids)"\n',
    '    uids_before=x\n',
  ),
  row(
    'K9',
    'the exit handler deletes the quota BEFORE it re-attaches detached pods',
    CLEAN_LOOP,
    `  k -n "\${NS}" delete resourcequota "\${HOLD_QUOTA}" --ignore-not-found >/dev/null 2>&1\n${CLEAN_LOOP}`,
  ),
  row(
    'K10',
    'the exit handler no longer re-attaches detached pods after an abort',
    CLEAN_LOOP,
    CLEAN_LOOP.replace('for entry in ${RESTORE_DETACH}', 'for entry in'),
  ),
  row(
    'K11',
    'release_pods deletes the quota BEFORE it re-attaches the pods',
    '  local entry\n  for entry in ${RESTORE_DETACH}; do\n',
    '  local entry\n  k -n "${NS}" delete resourcequota "${HOLD_QUOTA}" >/dev/null\n  for entry in ${RESTORE_DETACH}; do\n',
  ),
  row(
    'K12',
    'isolate_pods keeps no pod, detaching them all',
    '    [ "${uid}" = "$1" ] && continue\n',
    '',
  ),
  row(
    'K13',
    'isolate_pods no longer waits for the endpoints to hold only the kept pod',
    '.subsets[]?.addresses[]?] | length\')" = 1 ]; do',
    '.subsets[]?.addresses[]?] | length\')" != 99 ]; do',
  ),
  row(
    'K14',
    'the warm hold no longer has the quota, so the ReplicaSet can replace detached pods',
    '  RESTORE_QUOTA=1\n  k -n "${NS}" create resourcequota "${HOLD_QUOTA}" --hard=pods=0 >/dev/null\n  if [ "${mode}"',
    '  RESTORE_QUOTA=1\n  k -n "${NS}" create resourcequota "${HOLD_QUOTA}" --hard=pods=99 >/dev/null\n  if [ "${mode}"',
  ),
  row(
    'K15',
    'isolate_pods no longer has the quota, so the ReplicaSet can replace detached pods',
    '  RESTORE_QUOTA=1\n  k -n "${NS}" create resourcequota "${HOLD_QUOTA}" --hard=pods=0 >/dev/null\n  while read',
    '  RESTORE_QUOTA=1\n  k -n "${NS}" create resourcequota "${HOLD_QUOTA}" --hard=pods=99 >/dev/null\n  while read',
  ),
  row(
    'K16',
    'the cold hold no longer shows that no pod exists',
    '[ "$(all_pods "${GO_FN}")" = 0 ] || fail "a ${GO_FN} pod exists',
    '[ "$(all_pods "${GO_FN}")" != 99 ] || fail "a ${GO_FN} pod exists',
  ),
  row(
    'K17',
    'the ReplicaSet is no longer nudged after a cold release',
    '    k -n "${NS}" annotate replicaset -l "serving.knative.dev/service=${GO_FN}" "apps.kn-next.dev/z11-release=${SECONDS}" --overwrite >/dev/null\n',
    '',
  ),
  row(
    'K18',
    'the exit handler no longer puts the scale back after an abort',
    '  if [ "${RESTORE_MINSCALE}" = 1 ]; then\n',
    '  if [ "${RESTORE_MINSCALE}" = 99 ]; then\n',
  ),
  row(
    'K19',
    'the exit handler restores minScale but not maxScale',
    '{"spec":{"scaling":{"minScale":0,"maxScale":1}}}\' >/dev/null 2>&1',
    '{"spec":{"scaling":{"minScale":0}}}\' >/dev/null 2>&1',
  ),
  // ---- dispatch and defaults
  row(
    'D1',
    'the heldwarm phase is no longer dispatched',
    'if has_phase heldwarm; then phase_heldwarm; fi\n',
    '',
  ),
  row(
    'D2',
    'heldwarm leaves the default phase list',
    DEFAULTS,
    DEFAULTS.replace(' heldwarm}', '}'),
  ),
  row(
    'D3',
    'heldwarm is no longer an accepted phase name',
    '| rotcold | held | heldwarm) ;;',
    '| rotcold | held) ;;',
  ),
  // ---- workflow
  row(
    'F1',
    'the workflow runs only the earlier phases',
    'including policyoff, rotcold, held and heldwarm)\n        run:',
    'including policyoff, rotcold, held and heldwarm)\n        env:\n          PHASES: up deploy token direct policyoff noauth rotcold held\n        run:',
    'workflow',
  ),
  row(
    'F2',
    'the drill step is renamed so it no longer claims the heldwarm phase',
    '(all phases, including policyoff, rotcold, held and heldwarm)',
    '(all phases, including policyoff, rotcold and held)',
    'workflow',
  ),
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
