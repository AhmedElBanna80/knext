#!/usr/bin/env node
/**
 * Mutation proof for the Z11 cold-pod rotation and held-call phases (S9-1; ADR-0004).
 *
 * Each row removes or weakens ONE assertion of the `rotcold` or `held` phase of
 * packages/grpc/e2e/z11-activator-drill/run.sh (or of the workflow that runs them by
 * default) and REQUIRES `tests/z11-activator-drill.test.ts` to go red. The shared driver
 * (`scripts/lib/guard-prover.mjs`) owns the discipline: verdicts by exit code, baseline
 * green first, a canary that must go red, anchors occurring exactly once (else abort),
 * byte-exact restore.
 *
 * Usage: node scripts/mutation-prove-s9-1-z11-rotation-held.mjs
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGuardProver } from './lib/guard-prover.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = 'tests/z11-activator-drill.test.ts';

const run = (id, claim, anchor, replacement) => ({
  id,
  subject: 'run',
  claim,
  anchor,
  replacement,
});

const MUTATIONS = [
  // ---- rotcold
  run(
    'C1',
    'the rotation is never requested',
    '  k -n "${NS}" annotate nextapp "${ZONE}" "apps.kn-next.dev/rotate-signing-key=${nonce}" --overwrite\n',
    '',
  ),
  run(
    'C2',
    'the control (a cold pod accepts the old key before the rotation) weakens',
    '[ "${PR_STATUS}" = 404 ] && [ "${PR_CODE}" = not_found ] \\\n    || fail "before the rotation',
    '[ "${PR_STATUS}" != 404 ] && [ "${PR_CODE}" = not_found ] \\\n    || fail "before the rotation',
  ),
  run(
    'C3',
    'the function is no longer scaled to zero before the rotation is requested',
    '  log "rotcold 1/4: scale to zero, then request the rotation"\n  await_zero "${GO_FN}"\n',
    '  log "rotcold 1/4: scale to zero, then request the rotation"\n',
  ),
  run(
    'C4',
    'the rotation no longer waits for signing to switch',
    '"signing to switch to the new key" \'[ "$(secret_get current.kid)" = "${new_kid}" ]\'',
    '"signing to switch to the new key" true',
  ),
  run(
    'C5',
    'the retirement stamp is no longer backdated',
    '    "apps.kn-next.dev/signing-key-switched-at=$(node -p \'new Date(Date.now() - 2 * 3600 * 1000).toISOString()\')" --overwrite\n',
    '    "apps.kn-next.dev/unrelated=1" --overwrite\n',
  ),
  run(
    'C6',
    'the operator is no longer restarted to re-read the stamp',
    '  k -n "${OPERATOR_NS}" rollout restart deployment/kn-next-operator-controller-manager\n',
    '',
  ),
  run(
    'C7',
    'the retirement no longer waits for the previous key to leave the Secret',
    '[ -z "$(secret_get previous.kid)" ]\'\n  wait_until 30 1 "the JWKS to publish only the new key"',
    'true\'\n  wait_until 30 1 "the JWKS to publish only the new key"',
  ),
  run(
    'C8',
    'the JWKS is no longer required to publish only the new key',
    '"the JWKS to publish only the new key" \'[ "$(jwks_kids)" = "${new_kid}" ]\'',
    '"the JWKS to publish only the new key" true',
  ),
  run(
    'C9',
    'the proof that the pod was at zero through the rotation is dropped',
    '[ "$(all_pods "${GO_FN}")" = 0 ] || fail "${GO_FN} woke during the rotation',
    'true || fail "${GO_FN} woke during the rotation',
  ),
  run('C10', 'the cold old-key call is deleted', '  fn_probe "${WORK}/key-old" old\n', ''),
  run(
    'C11',
    'the cold old-key refusal weakens (status)',
    '[ "${PR_STATUS}" = 401 ] && [ "${PR_CODE}" = unauthenticated ] \\\n    || fail "cold pod, retired key',
    '[ "${PR_STATUS}" != 401 ] && [ "${PR_CODE}" = unauthenticated ] \\\n    || fail "cold pod, retired key',
  ),
  run(
    'C12',
    'the cold old-key refusal weakens (code)',
    '[ "${PR_STATUS}" = 401 ] && [ "${PR_CODE}" = unauthenticated ] \\\n    || fail "cold pod, retired key',
    '[ "${PR_STATUS}" = 401 ] && [ "${PR_CODE}" != unauthenticated ] \\\n    || fail "cold pod, retired key',
  ),
  run(
    'C13',
    'the old-key call no longer has to have woken the function',
    '  [ "$(all_pods "${GO_FN}")" -ge 1 ] || fail "the refused call never woke ${GO_FN}: it did not reach the function"\n  ok "cold pod, retired key',
    '  ok "cold pod, retired key',
  ),
  run(
    'C14',
    'the second scale to zero before the new-key call is dropped',
    '  await_zero "${GO_FN}"\n  fn_probe "${WORK}/key-new" new\n',
    '  fn_probe "${WORK}/key-new" new\n',
  ),
  run('C15', 'the new-key call is deleted', '  fn_probe "${WORK}/key-new" new\n', ''),
  run(
    'C16',
    'the new-key acceptance weakens',
    '[ "${PR_STATUS}" = 404 ] && [ "${PR_CODE}" = not_found ] \\\n    || fail "cold pod, new key',
    '[ "${PR_STATUS}" != 404 ] && [ "${PR_CODE}" = not_found ] \\\n    || fail "cold pod, new key',
  ),
  run(
    'C17',
    'the zone control after the rotation is dropped',
    '  expect_zone "control: after the rotation the zone\'s own call reaches the function (NotFound, not 401)" \\\n    "/example/get?sub=alice&id=missing" 404 \'.ok == false and .code == "NotFound"\'\n',
    '',
  ),
  run(
    'C18',
    'fn_probe retries a call the function ANSWERED',
    '    [ "${rc}" = 2 ] || break\n',
    '    [ "${rc}" = 3 ] || break\n',
  ),
  run(
    'C19',
    'fn_probe stops signing with the key it was handed',
    '--auth signer --key-dir "$1"',
    '--auth garbage --key-dir "$1"',
  ),
  run(
    'C20',
    'export_key stops decoding the Secret field',
    '\'.data[$s] // empty | @base64d\' <<<"${json}" >"${dir}/current.key"',
    '\'.data[$s] // empty\' <<<"${json}" >"${dir}/current.key"',
  ),
  // ---- held
  run(
    'H1',
    'the nodes are no longer cordoned, so nothing holds the call',
    '  k cordon $(k get nodes -o name) >/dev/null\n',
    '',
  ),
  run(
    'H2',
    'the function is no longer scaled to zero before the hold',
    '  local out="${WORK}/held.out" start\n  await_zero "${GO_FN}"\n',
    '  local out="${WORK}/held.out" start\n',
  ),
  run(
    'H3',
    'the call is released before the token has expired',
    'while [ $((SECONDS - start)) -lt "$1" ]; do',
    'while [ $((SECONDS - start)) -lt 0 ]; do',
  ),
  run(
    'H4',
    'the check that the call is still outstanding is dropped',
    '    kill -0 "$(cat "${HELD_PIDFILE}")" 2>/dev/null || fail "the held call ended',
    '    true || fail "the held call ended',
  ),
  run(
    'H5',
    'the held call may be answered with anything but 401',
    '[ "${HELD_STATUS}" = 401 ] && [ "${HELD_CODE}" = unauthenticated ]',
    '[ "${HELD_STATUS}" != 401 ] && [ "${HELD_CODE}" = unauthenticated ]',
  ),
  run(
    'H6',
    'the held call may be answered with any code',
    '[ "${HELD_STATUS}" = 401 ] && [ "${HELD_CODE}" = unauthenticated ]',
    '[ "${HELD_STATUS}" = 401 ] && [ "${HELD_CODE}" != unauthenticated ]',
  ),
  run(
    'H7',
    'the measured hold time is no longer compared with the minimum',
    '  [ "${HELD_FOR}" -ge "$1" ] || fail "the held call was outstanding only',
    '  true || fail "the held call was outstanding only',
  ),
  run(
    'H8',
    'the nodes are never uncordoned after the hold',
    '  k uncordon $(k get nodes -o name) >/dev/null\n  RESTORE_CORDON=0\n',
    '  RESTORE_CORDON=0\n',
  ),
  run(
    'H9',
    'the fresh token after the hold is no longer sent',
    '  fn_probe "${WORK}/key-held" fresh\n',
    '',
  ),
  run(
    'H10',
    'the fresh token after the hold may be refused',
    '[ "${PR_STATUS}" = 404 ] && [ "${PR_CODE}" = not_found ] \\\n    || fail "after the hold a fresh token',
    '[ "${PR_STATUS}" != 404 ] && [ "${PR_CODE}" = not_found ] \\\n    || fail "after the hold a fresh token',
  ),
  run(
    'H11',
    'the garbage token after the hold is no longer sent',
    '  foreign_get "Bearer not-a-token"\n  [ "${FC_STATUS}" = 401 ] && [ "${FC_CODE}" = unauthenticated ] && [ "${FC_MESSAGE}" = "token rejected" ] \\\n    || fail "after the hold',
    '  [ "${FC_STATUS}" = 401 ] && [ "${FC_CODE}" = unauthenticated ] && [ "${FC_MESSAGE}" = "token rejected" ] \\\n    || fail "after the hold',
  ),
  run(
    'H12',
    'the default hold shrinks below the token life plus skew',
    'HELD_SECONDS="${Z11_HELD_SECONDS:-80}"',
    'HELD_SECONDS="${Z11_HELD_SECONDS:-10}"',
  ),
  run(
    'H13',
    'the exit handler no longer uncordons after an abort',
    '  if [ "${RESTORE_CORDON}" = 1 ]; then\n',
    '  if [ "${RESTORE_CORDON}" = 99 ]; then\n',
  ),
  run('H14', 'the cordon is no longer recorded for the exit handler', '  RESTORE_CORDON=1\n', ''),
  // ---- round 2: the code halves, the message, the control, the pod-start proof
  run(
    'C2b',
    'the control no longer requires the not_found code',
    '[ "${PR_STATUS}" = 404 ] && [ "${PR_CODE}" = not_found ] \\\n    || fail "before the rotation',
    '[ "${PR_STATUS}" = 404 ] && [ "${PR_CODE}" != not_found ] \\\n    || fail "before the rotation',
  ),
  run(
    'C16b',
    'the new-key acceptance no longer requires the not_found code',
    '[ "${PR_STATUS}" = 404 ] && [ "${PR_CODE}" = not_found ] \\\n    || fail "cold pod, new key',
    '[ "${PR_STATUS}" = 404 ] && [ "${PR_CODE}" != not_found ] \\\n    || fail "cold pod, new key',
  ),
  run(
    'H10b',
    'the fresh token after the hold no longer requires the not_found code',
    '[ "${PR_STATUS}" = 404 ] && [ "${PR_CODE}" = not_found ] \\\n    || fail "after the hold a fresh token',
    '[ "${PR_STATUS}" = 404 ] && [ "${PR_CODE}" != not_found ] \\\n    || fail "after the hold a fresh token',
  ),
  run(
    'H15',
    'the garbage-token message check after the hold weakens',
    '[ "${FC_MESSAGE}" = "token rejected" ] \\\n    || fail "after the hold a garbage',
    '[ "${FC_MESSAGE}" != "token rejected" ] \\\n    || fail "after the hold a garbage',
  ),
  run(
    'T1',
    'the held call gets a short client timeout',
    '--with-message --timeout-seconds 240',
    '--with-message --timeout-seconds 20',
  ),
  run(
    'T2',
    'fn_probe gets a short client timeout',
    '--timeout-seconds 60 >"${WORK}/fn-probe.out"',
    '--timeout-seconds 5 >"${WORK}/fn-probe.out"',
  ),
  run(
    'P1',
    'the precondition no longer checks for a staged key',
    '[ -z "$(secret_get next.kid)" ] && [ -z "$(secret_get previous.kid)" ] \\\n    || fail "a rotation is already',
    '[ -z "$(secret_get previous.kid)" ] \\\n    || fail "a rotation is already',
  ),
  run(
    'P2',
    'the precondition no longer checks for a previous key',
    '[ -z "$(secret_get next.kid)" ] && [ -z "$(secret_get previous.kid)" ] \\\n    || fail "a rotation is already',
    '[ -z "$(secret_get next.kid)" ] \\\n    || fail "a rotation is already',
  ),
  run(
    'K1',
    'the short-hold control call is deleted',
    '  hold_call "${CONTROL_HELD_SECONDS}"\n',
    '',
  ),
  run(
    'K2',
    'the control no longer requires status 404',
    '[ "${HELD_STATUS}" = 404 ] && [ "${HELD_CODE}" = not_found ] \\\n    || fail "control: a call held',
    '[ "${HELD_STATUS}" != 404 ] && [ "${HELD_CODE}" = not_found ] \\\n    || fail "control: a call held',
  ),
  run(
    'K3',
    'the control no longer requires the not_found code',
    '[ "${HELD_STATUS}" = 404 ] && [ "${HELD_CODE}" = not_found ] \\\n    || fail "control: a call held',
    '[ "${HELD_STATUS}" = 404 ] && [ "${HELD_CODE}" != not_found ] \\\n    || fail "control: a call held',
  ),
  run(
    'K4',
    'the control hold grows past the token life',
    'CONTROL_HELD_SECONDS="${Z11_CONTROL_HELD_SECONDS:-30}"',
    'CONTROL_HELD_SECONDS="${Z11_CONTROL_HELD_SECONDS:-75}"',
  ),
  run(
    'M1',
    'the long hold accepts any message, so a stripped header would pass',
    '[ "${HELD_MESSAGE}" = "token rejected" ] \\\n    || fail "a call held',
    '[ "${HELD_MESSAGE}" != "missing bearer token" ] \\\n    || fail "a call held',
  ),
  run(
    'M2',
    'the message is no longer read from the held call output',
    '  HELD_MESSAGE="$(jq -r \'.message // ""\' "${out}")"\n',
    '  HELD_MESSAGE="token rejected"\n',
  ),
  run(
    'S1',
    'the pod that refused the retired key is no longer shown to start after the retirement',
    '[ "${old_start}" -ge "${retired_at}" ]',
    '[ "${old_start}" -ge 0 ]',
  ),
  run(
    'S2',
    'the pod that accepted the new key is no longer shown to start after the retirement',
    '[ "${new_start}" -ge "${retired_at}" ]',
    '[ "${new_start}" -ge 0 ]',
  ),
  run(
    'S3',
    'the second pod is no longer required to be a different pod',
    '[ "${new_uid}" != "${old_uid}" ]',
    '[ "${new_uid}" != "" ]',
  ),
  run(
    'S4',
    'the retirement time is no longer read from the cluster',
    '  retired_at="$(jwks_written_at)"\n',
    '  retired_at=0\n',
  ),
  run(
    'X1',
    'the exit handler no longer kills the held call',
    '  if [ -s "${HELD_PIDFILE}" ]; then kill',
    '  if [ -z "${HELD_PIDFILE}" ]; then kill',
  ),
  run(
    'X2',
    'the held call pid is never recorded for the exit handler',
    '  echo "$!" >"${HELD_PIDFILE}"\n',
    '',
  ),
  // ---- dispatch and defaults
  run(
    'D1',
    'the rotcold phase is no longer dispatched',
    'if has_phase rotcold; then phase_rotcold; fi\n',
    '',
  ),
  run(
    'D2',
    'the held phase is no longer dispatched',
    'if has_phase held; then phase_held; fi\n',
    '',
  ),
  run(
    'D3',
    'rotcold leaves the default phase list',
    'PHASES="${PHASES:-up deploy token direct policyoff noauth rotcold held}"',
    'PHASES="${PHASES:-up deploy token direct policyoff noauth held}"',
  ),
  run(
    'D4',
    'held leaves the default phase list',
    'PHASES="${PHASES:-up deploy token direct policyoff noauth rotcold held}"',
    'PHASES="${PHASES:-up deploy token direct policyoff noauth rotcold}"',
  ),
  {
    id: 'Q1',
    subject: 'probe',
    claim: 'the probe loses its --with-message option',
    anchor: "    'with-message': { type: 'boolean', default: false },\n",
    replacement: '',
  },
  {
    id: 'Q2',
    subject: 'probe',
    claim: 'the probe no longer passes the option to summarize',
    anchor: "summarize(outcome, auth.kid, values['with-message'])",
    replacement: 'summarize(outcome, auth.kid)',
  },
  // ---- workflow
  {
    id: 'W1',
    subject: 'workflow',
    claim: 'the workflow runs only the earlier phases',
    anchor: 'including policyoff, rotcold and held)\n        run:',
    replacement:
      'including policyoff, rotcold and held)\n        env:\n          PHASES: up deploy token direct policyoff noauth\n        run:',
  },
  {
    id: 'W2',
    subject: 'workflow',
    claim: 'the job budget shrinks back so the new phases cannot finish',
    anchor: 'timeout-minutes: 90',
    replacement: 'timeout-minutes: 60',
  },
  {
    id: 'W3',
    subject: 'workflow',
    claim: 'the drill step is renamed so it no longer claims the new phases',
    anchor: '(all phases, including policyoff, rotcold and held)',
    replacement: '(all phases, including policyoff)',
  },
];

const prover = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: SPEC,
  subjects: {
    run: 'packages/grpc/e2e/z11-activator-drill/run.sh',
    workflow: '.github/workflows/z11-activator-drill-e2e.yml',
    probe: 'packages/grpc/e2e/z7-identity-kind/probe.ts',
  },
});

console.log('=== mutation proof: Z11 cold-pod rotation and held call (S9-1) ===');
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
