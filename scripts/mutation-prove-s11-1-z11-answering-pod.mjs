#!/usr/bin/env node
/**
 * Mutation proof for WHICH POD ANSWERED in the Z11 heldwarm phase and the verdicts on a held call
 * (S11-1; ADR-0004), and for the positive control on pod B.
 *
 * The decisions live in sourced shell functions (`answering-pod.sh`): reading a pod's request
 * counter (failing closed on a missing or malformed metric), attributing a call to the one pod
 * whose counter rose by exactly one, and the status/code/message verdicts. The spec,
 * `tests/z11-answering-pod.test.ts`, RUNS them (a stub `kubectl` on PATH, fabricated snapshots).
 * The L, M and V rows mutate those functions and require the run to go red, so they change what
 * the code DOES. Both halves are covered: what must be there (a counter that rose by exactly one
 * on the expected pod, 404 or 401 as required) and what must not be (a different pod, two pods,
 * nobody, an unreadable pod, an empty, missing or non-numeric metric).
 *
 * The WR rows are WIRING rows and are labelled so: they delete or redirect a call in `run.sh` and
 * are caught by the spec's source-text wiring block ("run.sh calls function X in phase Y"). They
 * prove the call is wired, not what it decides.
 *
 * The shared driver (`scripts/lib/guard-prover.mjs`) owns the discipline: verdicts by exit code,
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

const ACC = 'answer_is_accepted() { [ "$1" = 404 ] && [ "$2" = not_found ]; }';
const REF =
  'answer_is_refused() { [ "$1" = 401 ] && [ "$2" = unauthenticated ] && [ "$3" = "token rejected" ]; }';
const CHK_A =
  '  answer_is_accepted "$4" "$5" || { echo "want 404 not_found, got status $4 code \'$5\'" >&2; return 1; }\n  assert_answered_by "$1" "$2" "$3"';
const CHK_R = '  answer_is_refused "$4" "$5" "$6" || {';
const OBSERVE =
  'HELD_POD_UID="$(answering_pod_uid "${HELD_REQ_BEFORE}" "${HELD_REQ_AFTER}")" || fail ';

const MUTATIONS = [
  // ---- the counter reading: behavioural
  row('L1', 'lib', 'a pod is counted by its LAST series only', 'sum += v }', 'sum = v }'),
  row('L2', 'lib', 'the counter reads 0 for every pod', 'sum += v }', 'sum += 0 }'),
  row(
    'L3',
    'lib',
    'an unreadable pod counts as 0 in the snapshot',
    'total="$(pod_request_total "${pod}")" || {',
    'total="$(pod_request_total "${pod}")" || total=0 || {',
  ),
  row(
    'M1',
    'lib',
    'an empty scrape is no longer reported as empty',
    '[ -n "${text}" ] || { echo "pod $1: the metrics scrape is empty" >&2; return 1; }\n',
    '',
  ),
  row(
    'M2',
    'lib',
    'a missing revision_request_count family is treated as zero',
    '3) echo "pod $1: the scrape has no revision_request_count series" >&2; return 1 ;;',
    '3) echo 0 ;;',
  ),
  row(
    'M3',
    'lib',
    'a non-numeric value is skipped instead of failing',
    '{ bad = 1 } else',
    '{ sum += 0 } else',
  ),
  row(
    'M4',
    'lib',
    'the numeric check no longer rejects words',
    'if (v !~ /^[0-9]+(\\.[0-9]+)?([eE][+-]?[0-9]+)?$/)',
    'if (v == "")',
  ),
  row(
    'M5',
    'lib',
    'the failure is not attributed to a pod: the message no longer names it',
    '3) echo "pod $1: the scrape has no revision_request_count series" >&2; return 1 ;;',
    '3) echo "the scrape has no revision_request_count series" >&2; return 1 ;;',
  ),
  // ---- the attribution: behavioural
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
  // ---- the verdicts: behavioural
  row('V1', 'lib', 'the control accepts any status', ACC, ACC.replace('= 404', '!= 404')),
  row('V2', 'lib', 'the control accepts any code', ACC, ACC.replace('= not_found', '!= not_found')),
  row('V3', 'lib', 'the refusal accepts any status', REF, REF.replace('= 401', '!= 401')),
  row(
    'V4',
    'lib',
    'the refusal accepts any code',
    REF,
    REF.replace('= unauthenticated', '!= unauthenticated'),
  ),
  row(
    'V5',
    'lib',
    'the refusal accepts any message (a stripped header would pass)',
    REF,
    REF.replace('= "token rejected"', '!= "missing bearer token"'),
  ),
  row(
    'V6',
    'lib',
    'the control no longer checks which pod answered',
    CHK_A,
    CHK_A.replace('  assert_answered_by "$1" "$2" "$3"', '  true'),
  ),
  row(
    'V7',
    'lib',
    'the control no longer checks the status and code',
    CHK_A,
    CHK_A.replace('answer_is_accepted "$4" "$5" ||', 'true ||'),
  ),
  row(
    'V8',
    'lib',
    'the refusal no longer checks the status, code and message',
    CHK_R,
    '  true || {',
  ),
  row(
    'V9',
    'lib',
    'the refusal no longer checks which pod answered',
    '  assert_answered_by "$1" "$2" "$3"\n}\n',
    '  true\n}\n',
  ),
  // ---- WIRING rows: run.sh calls the functions, where it should (text-level, labelled as such)
  row(
    'WR1',
    'run',
    'wiring: the control no longer calls check_accepted_by',
    '  check_accepted_by "${wuid_a}"',
    '  true "${wuid_a}"',
  ),
  row(
    'WR2',
    'run',
    'wiring: the long hold no longer calls check_refused_by',
    '  check_refused_by "${wuid_b}"',
    '  true "${wuid_b}"',
  ),
  row(
    'WR3',
    'run',
    'wiring: the pod B fresh-token control no longer calls check_accepted_by',
    '  check_accepted_by "${wuid_b}" "${bctl_before}"',
    '  true "${wuid_b}" "${bctl_before}"',
  ),
  row(
    'WR4',
    'run',
    'wiring: the control expects pod B',
    '  check_accepted_by "${wuid_a}"',
    '  check_accepted_by "${wuid_b}"',
  ),
  row(
    'WR5',
    'run',
    'wiring: the long hold expects pod A',
    '  check_refused_by "${wuid_b}"',
    '  check_refused_by "${wuid_a}"',
  ),
  row(
    'WR6',
    'run',
    'wiring: the answering uid is taken from the hold target again',
    OBSERVE,
    'HELD_POD_UID="$3" || fail ',
  ),
  row(
    'WR7',
    'run',
    'wiring: the counters are read before the call but never after it',
    '    HELD_REQ_AFTER="$(request_snapshot)" || fail "cannot read the pods\' request counters after the hold"\n',
    '    HELD_REQ_AFTER="${HELD_REQ_BEFORE}"\n',
  ),
  row(
    'WR8',
    'run',
    'wiring: the fresh token is never sent to pod B',
    '  fn_probe "${WORK}/key-held" fresh-b\n',
    '',
  ),
  row(
    'WR9',
    'run',
    'wiring: the fresh token is sent with pod A still attached',
    '  isolate_pods "${wuid_b}"\n  bctl_before=',
    '  bctl_before=',
  ),
  row(
    'WR10',
    'run',
    'wiring: the fresh call is judged with the counters of the hold, not of the fresh call',
    '"${wuid_b}" "${bctl_before}" "${bctl_after}"',
    '"${wuid_b}" "${HELD_REQ_BEFORE}" "${HELD_REQ_AFTER}"',
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
