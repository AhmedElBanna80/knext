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

const MUTATIONS = [
  // ---- rotcold
  {
    id: 'C1',
    subject: 'run',
    claim: 'the rotation is never requested',
    anchor:
      '  k -n "${NS}" annotate nextapp "${ZONE}" "apps.kn-next.dev/rotate-signing-key=${nonce}" --overwrite\n',
    replacement: '',
  },
  {
    id: 'C2',
    subject: 'run',
    claim: 'the control (a cold pod accepts the old key before the rotation) weakens',
    anchor:
      '[ "${PR_STATUS}" = 404 ] && [ "${PR_CODE}" = not_found ] \\\n    || fail "before the rotation',
    replacement:
      '[ "${PR_STATUS}" != 404 ] && [ "${PR_CODE}" = not_found ] \\\n    || fail "before the rotation',
  },
  {
    id: 'C3',
    subject: 'run',
    claim: 'the function is no longer scaled to zero before the rotation is requested',
    anchor:
      '  log "rotcold 1/4: scale to zero, then request the rotation"\n  await_zero "${GO_FN}"\n',
    replacement: '  log "rotcold 1/4: scale to zero, then request the rotation"\n',
  },
  {
    id: 'C4',
    subject: 'run',
    claim: 'the rotation no longer waits for signing to switch',
    anchor: '"signing to switch to the new key" \'[ "$(secret_get current.kid)" = "${new_kid}" ]\'',
    replacement: '"signing to switch to the new key" true',
  },
  {
    id: 'C5',
    subject: 'run',
    claim: 'the retirement stamp is no longer backdated',
    anchor:
      '    "apps.kn-next.dev/signing-key-switched-at=$(node -p \'new Date(Date.now() - 2 * 3600 * 1000).toISOString()\')" --overwrite\n',
    replacement: '    "apps.kn-next.dev/unrelated=1" --overwrite\n',
  },
  {
    id: 'C6',
    subject: 'run',
    claim: 'the operator is no longer restarted to re-read the stamp',
    anchor:
      '  k -n "${OPERATOR_NS}" rollout restart deployment/kn-next-operator-controller-manager\n',
    replacement: '',
  },
  {
    id: 'C7',
    subject: 'run',
    claim: 'the retirement no longer waits for the previous key to leave the Secret',
    anchor:
      '[ -z "$(secret_get previous.kid)" ]\'\n  wait_until 30 1 "the JWKS to publish only the new key"',
    replacement: 'true\'\n  wait_until 30 1 "the JWKS to publish only the new key"',
  },
  {
    id: 'C8',
    subject: 'run',
    claim: 'the JWKS is no longer required to publish only the new key',
    anchor: '"the JWKS to publish only the new key" \'[ "$(jwks_kids)" = "${new_kid}" ]\'',
    replacement: '"the JWKS to publish only the new key" true',
  },
  {
    id: 'C9',
    subject: 'run',
    claim: 'the proof that the pod was at zero through the rotation is dropped',
    anchor: '[ "$(all_pods "${GO_FN}")" = 0 ] || fail "${GO_FN} woke during the rotation',
    replacement: 'true || fail "${GO_FN} woke during the rotation',
  },
  {
    id: 'C10',
    subject: 'run',
    claim: 'the cold old-key call is deleted',
    anchor: '  fn_probe "${WORK}/key-old" old\n',
    replacement: '',
  },
  {
    id: 'C11',
    subject: 'run',
    claim: 'the cold old-key refusal weakens (status)',
    anchor:
      '[ "${PR_STATUS}" = 401 ] && [ "${PR_CODE}" = unauthenticated ] \\\n    || fail "cold pod, retired key',
    replacement:
      '[ "${PR_STATUS}" != 401 ] && [ "${PR_CODE}" = unauthenticated ] \\\n    || fail "cold pod, retired key',
  },
  {
    id: 'C12',
    subject: 'run',
    claim: 'the cold old-key refusal weakens (code)',
    anchor:
      '[ "${PR_STATUS}" = 401 ] && [ "${PR_CODE}" = unauthenticated ] \\\n    || fail "cold pod, retired key',
    replacement:
      '[ "${PR_STATUS}" = 401 ] && [ "${PR_CODE}" != unauthenticated ] \\\n    || fail "cold pod, retired key',
  },
  {
    id: 'C13',
    subject: 'run',
    claim: 'the old-key call no longer has to have woken the function',
    anchor:
      '  [ "$(all_pods "${GO_FN}")" -ge 1 ] || fail "the refused call never woke ${GO_FN}: it did not reach the function"\n  ok "cold pod, retired key',
    replacement: '  ok "cold pod, retired key',
  },
  {
    id: 'C14',
    subject: 'run',
    claim: 'the second scale to zero before the new-key call is dropped',
    anchor: '  await_zero "${GO_FN}"\n  fn_probe "${WORK}/key-new" new\n',
    replacement: '  fn_probe "${WORK}/key-new" new\n',
  },
  {
    id: 'C15',
    subject: 'run',
    claim: 'the new-key call is deleted',
    anchor: '  fn_probe "${WORK}/key-new" new\n',
    replacement: '',
  },
  {
    id: 'C16',
    subject: 'run',
    claim: 'the new-key acceptance weakens',
    anchor:
      '[ "${PR_STATUS}" = 404 ] && [ "${PR_CODE}" = not_found ] \\\n    || fail "cold pod, new key',
    replacement:
      '[ "${PR_STATUS}" != 404 ] && [ "${PR_CODE}" = not_found ] \\\n    || fail "cold pod, new key',
  },
  {
    id: 'C17',
    subject: 'run',
    claim: 'the zone control after the rotation is dropped',
    anchor:
      '  expect_zone "control: after the rotation the zone\'s own call reaches the function (NotFound, not 401)" \\\n    "/example/get?sub=alice&id=missing" 404 \'.ok == false and .code == "NotFound"\'\n',
    replacement: '',
  },
  {
    id: 'C18',
    subject: 'run',
    claim: 'fn_probe retries a call the function ANSWERED',
    anchor: '    [ "${rc}" = 2 ] || break\n',
    replacement: '    [ "${rc}" = 3 ] || break\n',
  },
  {
    id: 'C19',
    subject: 'run',
    claim: 'fn_probe stops signing with the key it was handed',
    anchor: '--auth signer --key-dir "$1"',
    replacement: '--auth garbage --key-dir "$1"',
  },
  {
    id: 'C20',
    subject: 'run',
    claim: 'export_key stops decoding the Secret field',
    anchor: '\'.data[$s] // empty | @base64d\' <<<"${json}" >"${dir}/current.key"',
    replacement: '\'.data[$s] // empty\' <<<"${json}" >"${dir}/current.key"',
  },
  // ---- held
  {
    id: 'H1',
    subject: 'run',
    claim: 'the pod quota is no longer created, so nothing holds the call',
    anchor:
      '  k -n "${NS}" create resourcequota "${HOLD_QUOTA}" --hard=pods=0 >/dev/null\n  if [ "${mode}" = warm ]; then\n    while read',
    replacement: '  if [ "${mode}" = warm ]; then\n    while read',
  },
  {
    id: 'H2',
    subject: 'run',
    claim: 'the function is no longer scaled to zero before the hold',
    anchor: '    await_zero "${GO_FN}"\n  fi\n  ensure_forward\n',
    replacement: '    true\n  fi\n  ensure_forward\n',
  },
  {
    id: 'H3',
    subject: 'run',
    claim: 'the call is released before the token has expired',
    anchor: 'while [ $((SECONDS - start)) -lt "$1" ]; do',
    replacement: 'while [ $((SECONDS - start)) -lt 0 ]; do',
  },
  {
    id: 'H4',
    subject: 'run',
    claim: 'the check that the call is still outstanding is dropped',
    anchor: '    kill -0 "$(cat "${HELD_PIDFILE}")" 2>/dev/null || fail "the held call ended',
    replacement: '    true || fail "the held call ended',
  },
  {
    id: 'H5',
    subject: 'run',
    claim: 'the held call may be answered with anything but 401',
    anchor:
      '[ "${HELD_STATUS}" = 401 ] && [ "${HELD_CODE}" = unauthenticated ] && [ "${HELD_MESSAGE}" = "token rejected" ] \\\n    || fail "a call held',
    replacement:
      '[ "${HELD_STATUS}" != 401 ] && [ "${HELD_CODE}" = unauthenticated ] && [ "${HELD_MESSAGE}" = "token rejected" ] \\\n    || fail "a call held',
  },
  {
    id: 'H6',
    subject: 'run',
    claim: 'the held call may be answered with any code',
    anchor:
      '[ "${HELD_STATUS}" = 401 ] && [ "${HELD_CODE}" = unauthenticated ] && [ "${HELD_MESSAGE}" = "token rejected" ] \\\n    || fail "a call held',
    replacement:
      '[ "${HELD_STATUS}" = 401 ] && [ "${HELD_CODE}" != unauthenticated ] && [ "${HELD_MESSAGE}" = "token rejected" ] \\\n    || fail "a call held',
  },
  {
    id: 'H7',
    subject: 'run',
    claim: 'the measured hold time is no longer compared with the minimum',
    anchor: '  [ "${HELD_FOR}" -ge "$1" ] || fail "the held call was outstanding only',
    replacement: '  true || fail "the held call was outstanding only',
  },
  {
    id: 'H8',
    subject: 'run',
    claim: 'the pod quota is never deleted after the hold',
    anchor: '  k -n "${NS}" delete resourcequota "${HOLD_QUOTA}" >/dev/null\n  RESTORE_QUOTA=0\n',
    replacement: '  RESTORE_QUOTA=0\n',
  },
  {
    id: 'H9',
    subject: 'run',
    claim: 'the fresh token after the hold is no longer sent',
    anchor: '  fn_probe "${WORK}/key-held" fresh\n',
    replacement: '',
  },
  {
    id: 'H10',
    subject: 'run',
    claim: 'the fresh token after the hold may be refused',
    anchor:
      '[ "${PR_STATUS}" = 404 ] && [ "${PR_CODE}" = not_found ] \\\n    || fail "after the hold a fresh token',
    replacement:
      '[ "${PR_STATUS}" != 404 ] && [ "${PR_CODE}" = not_found ] \\\n    || fail "after the hold a fresh token',
  },
  {
    id: 'H11',
    subject: 'run',
    claim: 'the garbage token after the hold is no longer sent',
    anchor:
      '  foreign_get "Bearer not-a-token"\n  [ "${FC_STATUS}" = 401 ] && [ "${FC_CODE}" = unauthenticated ] && [ "${FC_MESSAGE}" = "token rejected" ] \\\n    || fail "after the hold',
    replacement:
      '  [ "${FC_STATUS}" = 401 ] && [ "${FC_CODE}" = unauthenticated ] && [ "${FC_MESSAGE}" = "token rejected" ] \\\n    || fail "after the hold',
  },
  {
    id: 'H12',
    subject: 'run',
    claim: 'the default hold shrinks below the token life plus skew',
    anchor: 'HELD_SECONDS="${Z11_HELD_SECONDS:-80}"',
    replacement: 'HELD_SECONDS="${Z11_HELD_SECONDS:-10}"',
  },
  {
    id: 'H13',
    subject: 'run',
    claim: 'the exit handler no longer deletes the quota after an abort',
    anchor: '  if [ "${RESTORE_QUOTA}" = 1 ]; then\n',
    replacement: '  if [ "${RESTORE_QUOTA}" = 99 ]; then\n',
  },
  {
    id: 'H14',
    subject: 'run',
    claim: 'the quota is no longer recorded for the exit handler',
    anchor:
      '  RESTORE_QUOTA=1\n  k -n "${NS}" create resourcequota "${HOLD_QUOTA}" --hard=pods=0 >/dev/null\n  if [ "${mode}"',
    replacement:
      '  k -n "${NS}" create resourcequota "${HOLD_QUOTA}" --hard=pods=0 >/dev/null\n  if [ "${mode}"',
  },
  // ---- round 2: the code halves, the message, the control, the pod-start proof
  {
    id: 'C2b',
    subject: 'run',
    claim: 'the control no longer requires the not_found code',
    anchor:
      '[ "${PR_STATUS}" = 404 ] && [ "${PR_CODE}" = not_found ] \\\n    || fail "before the rotation',
    replacement:
      '[ "${PR_STATUS}" = 404 ] && [ "${PR_CODE}" != not_found ] \\\n    || fail "before the rotation',
  },
  {
    id: 'C16b',
    subject: 'run',
    claim: 'the new-key acceptance no longer requires the not_found code',
    anchor:
      '[ "${PR_STATUS}" = 404 ] && [ "${PR_CODE}" = not_found ] \\\n    || fail "cold pod, new key',
    replacement:
      '[ "${PR_STATUS}" = 404 ] && [ "${PR_CODE}" != not_found ] \\\n    || fail "cold pod, new key',
  },
  {
    id: 'H10b',
    subject: 'run',
    claim: 'the fresh token after the hold no longer requires the not_found code',
    anchor:
      '[ "${PR_STATUS}" = 404 ] && [ "${PR_CODE}" = not_found ] \\\n    || fail "after the hold a fresh token',
    replacement:
      '[ "${PR_STATUS}" = 404 ] && [ "${PR_CODE}" != not_found ] \\\n    || fail "after the hold a fresh token',
  },
  {
    id: 'H15',
    subject: 'run',
    claim: 'the garbage-token message check after the hold weakens',
    anchor: '[ "${FC_MESSAGE}" = "token rejected" ] \\\n    || fail "after the hold a garbage',
    replacement:
      '[ "${FC_MESSAGE}" != "token rejected" ] \\\n    || fail "after the hold a garbage',
  },
  {
    id: 'T1',
    subject: 'run',
    claim: 'the held call gets a short client timeout',
    anchor: '--with-message --timeout-seconds 240',
    replacement: '--with-message --timeout-seconds 20',
  },
  {
    id: 'T2',
    subject: 'run',
    claim: 'fn_probe gets a short client timeout',
    anchor: '--timeout-seconds 60 >"${WORK}/fn-probe.out"',
    replacement: '--timeout-seconds 5 >"${WORK}/fn-probe.out"',
  },
  {
    id: 'P1',
    subject: 'run',
    claim: 'the precondition no longer checks for a staged key',
    anchor:
      '[ -z "$(secret_get next.kid)" ] && [ -z "$(secret_get previous.kid)" ] \\\n    || fail "a rotation is already',
    replacement: '[ -z "$(secret_get previous.kid)" ] \\\n    || fail "a rotation is already',
  },
  {
    id: 'P2',
    subject: 'run',
    claim: 'the precondition no longer checks for a previous key',
    anchor:
      '[ -z "$(secret_get next.kid)" ] && [ -z "$(secret_get previous.kid)" ] \\\n    || fail "a rotation is already',
    replacement: '[ -z "$(secret_get next.kid)" ] \\\n    || fail "a rotation is already',
  },
  {
    id: 'K1',
    subject: 'run',
    claim: 'the short-hold control call is deleted',
    anchor: '  hold_call "${CONTROL_HELD_SECONDS}"\n',
    replacement: '',
  },
  {
    id: 'K2',
    subject: 'run',
    claim: 'the control no longer requires status 404',
    anchor:
      '[ "${HELD_STATUS}" = 404 ] && [ "${HELD_CODE}" = not_found ] \\\n    || fail "control: a call held',
    replacement:
      '[ "${HELD_STATUS}" != 404 ] && [ "${HELD_CODE}" = not_found ] \\\n    || fail "control: a call held',
  },
  {
    id: 'K3',
    subject: 'run',
    claim: 'the control no longer requires the not_found code',
    anchor:
      '[ "${HELD_STATUS}" = 404 ] && [ "${HELD_CODE}" = not_found ] \\\n    || fail "control: a call held',
    replacement:
      '[ "${HELD_STATUS}" = 404 ] && [ "${HELD_CODE}" != not_found ] \\\n    || fail "control: a call held',
  },
  {
    id: 'K4',
    subject: 'run',
    claim: 'the control hold grows past the token life',
    anchor: 'CONTROL_HELD_SECONDS="${Z11_CONTROL_HELD_SECONDS:-30}"',
    replacement: 'CONTROL_HELD_SECONDS="${Z11_CONTROL_HELD_SECONDS:-75}"',
  },
  {
    id: 'M1',
    subject: 'run',
    claim: 'the long hold accepts any message, so a stripped header would pass',
    anchor: '[ "${HELD_MESSAGE}" = "token rejected" ] \\\n    || fail "a call held',
    replacement: '[ "${HELD_MESSAGE}" != "missing bearer token" ] \\\n    || fail "a call held',
  },
  {
    id: 'M2',
    subject: 'run',
    claim: 'the message is no longer read from the held call output',
    anchor: '  HELD_MESSAGE="$(jq -r \'.message // ""\' "${out}")"\n',
    replacement: '  HELD_MESSAGE="token rejected"\n',
  },
  {
    id: 'S1',
    subject: 'run',
    claim: 'the pod that refused the retired key is no longer shown to start after the retirement',
    anchor: '[ "${old_start}" -ge "${retired_at}" ]',
    replacement: '[ "${old_start}" -ge 0 ]',
  },
  {
    id: 'S2',
    subject: 'run',
    claim: 'the pod that accepted the new key is no longer shown to start after the retirement',
    anchor: '[ "${new_start}" -ge "${retired_at}" ]',
    replacement: '[ "${new_start}" -ge 0 ]',
  },
  {
    id: 'S3',
    subject: 'run',
    claim: 'the second pod is no longer required to be a different pod',
    anchor: '[ "${new_uid}" != "${old_uid}" ]',
    replacement: '[ "${new_uid}" != "" ]',
  },
  {
    id: 'S4',
    subject: 'run',
    claim: 'the retirement time is no longer read from the cluster',
    anchor: '  retired_at="$(jwks_written_at)"\n',
    replacement: '  retired_at=0\n',
  },
  {
    id: 'X1',
    subject: 'run',
    claim: 'the exit handler no longer kills the held call',
    anchor: '  if [ -s "${HELD_PIDFILE}" ]; then kill',
    replacement: '  if [ -z "${HELD_PIDFILE}" ]; then kill',
  },
  {
    id: 'X2',
    subject: 'run',
    claim: 'the held call pid is never recorded for the exit handler',
    anchor: '  echo "$!" >"${HELD_PIDFILE}"\n',
    replacement: '',
  },
  // ---- dispatch and defaults
  {
    id: 'D1',
    subject: 'run',
    claim: 'the rotcold phase is no longer dispatched',
    anchor: 'if has_phase rotcold; then phase_rotcold; fi\n',
    replacement: '',
  },
  {
    id: 'D2',
    subject: 'run',
    claim: 'the held phase is no longer dispatched',
    anchor: 'if has_phase held; then phase_held; fi\n',
    replacement: '',
  },
  {
    id: 'D3',
    subject: 'run',
    claim: 'rotcold leaves the default phase list',
    anchor: 'PHASES="${PHASES:-up deploy token direct policyoff noauth rotcold held heldwarm}"',
    replacement: 'PHASES="${PHASES:-up deploy token direct policyoff noauth held heldwarm}"',
  },
  {
    id: 'D4',
    subject: 'run',
    claim: 'held leaves the default phase list',
    anchor: 'PHASES="${PHASES:-up deploy token direct policyoff noauth rotcold held heldwarm}"',
    replacement: 'PHASES="${PHASES:-up deploy token direct policyoff noauth rotcold heldwarm}"',
  },
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
    anchor: 'including policyoff, rotcold, held and heldwarm)\n        run:',
    replacement:
      'including policyoff, rotcold, held and heldwarm)\n        env:\n          PHASES: up deploy token direct policyoff noauth\n        run:',
  },
  {
    id: 'W2',
    subject: 'workflow',
    claim: 'the job budget shrinks back so the new phases cannot finish',
    anchor: 'timeout-minutes: 60',
    replacement: 'timeout-minutes: 20',
  },
  {
    id: 'W3',
    subject: 'workflow',
    claim: 'the drill step is renamed so it no longer claims the new phases',
    anchor: '(all phases, including policyoff, rotcold, held and heldwarm)',
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
