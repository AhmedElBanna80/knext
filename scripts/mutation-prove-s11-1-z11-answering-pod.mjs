#!/usr/bin/env node
/**
 * Mutation proof for WHICH POD ANSWERED in the Z11 heldwarm phase (S11-1; ADR-0004), and for the
 * positive control on pod B.
 *
 * The drill used to assign the answering pod's uid from the hold's target, so "the same pod
 * answered" was a tautology and the prover rows for it (S10-4's W30 and W37) only checked that
 * source text existed. The spec here, `tests/z11-answering-pod.test.ts`, RUNS the shell: the
 * counter reading and the attribution (`answering-pod.sh`) on fabricated counters, and the
 * assertions cut out of `run.sh` and executed with `fail` stubbed. So each row below changes what
 * the code DOES and requires the run to go red, and the verdict is the spec's exit code.
 * Both halves are covered: what must be there (a counter that rose, by exactly one, on the
 * expected pod) and what must not be (a different pod, two pods, nobody, an unreadable pod, a uid
 * taken from the target). The shared driver (`scripts/lib/guard-prover.mjs`) owns the discipline:
 * baseline green first, a canary that must go red, anchors occurring exactly once (else abort),
 * byte-exact restore.
 *
 * Usage: node scripts/mutation-prove-s11-1-z11-answering-pod.mjs
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGuardProver } from './lib/guard-prover.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = 'tests/z11-answering-pod.test.ts';

const row = (id, subject, claim, anchor, replacement) => ({
  id,
  subject,
  claim,
  anchor,
  replacement,
});

const ASSERT_A =
  'assert_answered_by "${wuid_a}" "${HELD_REQ_BEFORE}" "${HELD_REQ_AFTER}" \\\n    || fail "warm pod control';
const ASSERT_B =
  'assert_answered_by "${wuid_b}" "${HELD_REQ_BEFORE}" "${HELD_REQ_AFTER}" \\\n    || fail "the held call';
const ASSERT_FRESH =
  'assert_answered_by "${wuid_b}" "${bctl_before}" "${bctl_after}" \\\n    || fail "warm pod B: the fresh-token';
const FRESH_STATUS =
  '[ "${PR_STATUS}" = 404 ] && [ "${PR_CODE}" = not_found ] \\\n    || fail "warm pod B: a FRESH token';
const OBSERVE =
  'HELD_POD_UID="$(answering_pod_uid "${HELD_REQ_BEFORE}" "${HELD_REQ_AFTER}")" || fail ';

const MUTATIONS = [
  // ---- the counter reading
  row(
    'L1',
    'lib',
    'a pod is counted by its LAST series only, so a pod that served several codes is undercounted',
    '/^revision_request_count[{ ]/ { sum += $NF }',
    '/^revision_request_count[{ ]/ { sum = $NF }',
  ),
  row(
    'L2',
    'lib',
    'the counter reads 0 for every pod, so no call is ever seen',
    '/^revision_request_count[{ ]/ { sum += $NF }',
    '/^revision_request_count[{ ]/ { sum += 0 }',
  ),
  row(
    'L3',
    'lib',
    'an unreadable pod counts as 0, so a short snapshot passes silently',
    'total="$(pod_request_total "${pod}")" || {',
    'total="$(pod_request_total "${pod}")" || total=0 || {',
  ),
  // ---- the attribution
  row(
    'L4',
    'lib',
    'the snapshots may be of different pods',
    '[ "$(awk \'{print $1}\' <<<"${before}" | sort)" = "$(awk \'{print $1}\' <<<"${after}" | sort)" ]',
    'true',
  ),
  row(
    'L5',
    'lib',
    'a counter that went down (a restarted pod) is tolerated',
    'if [ "${total}" -lt "${prev}" ]; then',
    'if false; then',
  ),
  row(
    'L6',
    'lib',
    'a pod that counted several calls is accepted as the answering pod',
    '[ $((total - prev)) = 1 ] ||',
    'true ||',
  ),
  row(
    'L7',
    'lib',
    'two pods counting the call is accepted (the first wins)',
    '[ "${n}" = 1 ] ||',
    '[ "${n}" -ge 1 ] ||',
  ),
  row('L8', 'lib', 'a call nobody counted is accepted', '[ "${n}" = 1 ] ||', '[ "${n}" != 99 ] ||'),
  row(
    'L9',
    'lib',
    'the comparison no longer names the expected pod: any attributable pod passes',
    '[ "${got}" = "$1" ] ||',
    '[ -n "${got}" ] ||',
  ),
  // ---- how run.sh uses it
  row(
    'W30',
    'run',
    'the control is judged against pod B, so a call answered by the wrong pod passes it',
    ASSERT_A,
    ASSERT_A.replace('"${wuid_a}"', '"${wuid_b}"'),
  ),
  row(
    'W30b',
    'run',
    'the control no longer asserts which pod answered',
    `  ${ASSERT_A}`,
    '  true \\\n    || fail "warm pod control',
  ),
  row(
    'W37',
    'run',
    'the long held call is judged against pod A, so a call answered by the wrong pod passes it',
    ASSERT_B,
    ASSERT_B.replace('"${wuid_b}"', '"${wuid_a}"'),
  ),
  row(
    'W37b',
    'run',
    'the long held call no longer asserts which pod answered',
    `  ${ASSERT_B}`,
    '  true \\\n    || fail "the held call',
  ),
  row(
    'O1',
    'run',
    'the answering uid is taken from the hold target again, not from the counters',
    OBSERVE,
    'HELD_POD_UID="$3" || fail ',
  ),
  row(
    'O2',
    'run',
    'the counters are read before the call but never after it',
    '    HELD_REQ_AFTER="$(request_snapshot)" || fail "cannot read the pods\' request counters after the hold"\n',
    '    HELD_REQ_AFTER="${HELD_REQ_BEFORE}"\n',
  ),
  // ---- the positive control on pod B
  row(
    'P1',
    'run',
    'the fresh token is never sent to pod B',
    '  fn_probe "${WORK}/key-held" fresh-b\n',
    '',
  ),
  row(
    'P2',
    'run',
    'the fresh token is sent with pod A still attached, so pod B is not the only candidate',
    '  isolate_pods "${wuid_b}"\n  bctl_before=',
    '  bctl_before=',
  ),
  row(
    'P3',
    'run',
    'pod B may refuse the fresh token (status)',
    FRESH_STATUS,
    FRESH_STATUS.replace('[ "${PR_STATUS}" = 404 ]', '[ "${PR_STATUS}" != 404 ]'),
  ),
  row(
    'P4',
    'run',
    'pod B may refuse the fresh token (code)',
    FRESH_STATUS,
    FRESH_STATUS.replace('[ "${PR_CODE}" = not_found ]', '[ "${PR_CODE}" != not_found ]'),
  ),
  row(
    'P5',
    'run',
    'the fresh call is not attributed to pod B',
    `  ${ASSERT_FRESH}`,
    '  true \\\n    || fail "warm pod B: the fresh-token',
  ),
  row(
    'P6',
    'run',
    'the fresh call is attributed with the counters of the hold, not of the fresh call',
    ASSERT_FRESH,
    ASSERT_FRESH.replace(
      '"${bctl_before}" "${bctl_after}"',
      '"${HELD_REQ_BEFORE}" "${HELD_REQ_AFTER}"',
    ),
  ),
];

const prover = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: SPEC,
  subjects: {
    run: 'packages/grpc/e2e/z11-activator-drill/run.sh',
    lib: 'packages/grpc/e2e/z11-activator-drill/answering-pod.sh',
  },
});

console.log('=== mutation proof: which pod answered, and the pod B positive control (S11-1) ===');
prover.preflight(MUTATIONS);
declareMutations(MUTATIONS.length);
prover.baseline();
prover.proveCanSeeRed({
  subject: 'lib',
  anchor: 'echo "${risen}"',
  replacement: 'echo "${risen}z"',
});
for (const m of MUTATIONS) {
  prover.run({ ...m, expect: 'red' });
  recordMutation();
}
prover.finish(MUTATIONS.length);
