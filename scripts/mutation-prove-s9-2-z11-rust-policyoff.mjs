#!/usr/bin/env node
/**
 * Mutation proof for the Z11 Rust policy-off leg and the concurrent drain (S9-2; ADR-0052 D13).
 *
 * Each row removes or weakens ONE thing `tests/z11-activator-drill.test.ts` protects about
 * `policyoff_rust` or `await_zero_all` in packages/grpc/e2e/z11-activator-drill/run.sh, and
 * REQUIRES the spec to go red. The shared driver (`scripts/lib/guard-prover.mjs`) owns the
 * discipline: verdicts by exit code, baseline green first, a canary that must go red, anchors
 * occurring exactly once (else abort), byte-exact restore.
 *
 * Usage: node scripts/mutation-prove-s9-2-z11-rust-policyoff.mjs
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGuardProver } from './lib/guard-prover.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = 'tests/z11-activator-drill.test.ts';

const RUST_COLD =
  '[ "${FC_STATUS}" = 401 ] && [ "${FC_CODE}" = unauthenticated ] && [ "${FC_MESSAGE}" = "missing bearer token" ] \\\n    || fail "policy off, Rust, cold';
const RUST_DIRECT =
  '[ "${FC_STATUS}" = 401 ] && [ "${FC_CODE}" = unauthenticated ] && [ "${FC_MESSAGE}" = "missing bearer token" ] \\\n    || fail "policy off, Rust, direct to the pod, no token';
const RUST_GARBAGE =
  '[ "${FC_STATUS}" = 401 ] && [ "${FC_CODE}" = unauthenticated ] && [ "${FC_MESSAGE}" = "token rejected" ] \\\n    || fail "policy off, Rust, direct to the pod, garbage token';
const weaken = (a) => a.replace('[ "${FC_STATUS}" = 401 ]', '[ "${FC_STATUS}" != 401 ]');

const MUTATIONS = [
  {
    id: 'R1',
    subject: 'run',
    claim: 'the Rust function never has its NetworkPolicy switched off',
    anchor: '  set_rust_policy false\n',
    replacement: '',
  },
  {
    id: 'R2',
    subject: 'run',
    claim: 'the Rust leg stops proving the Rust policy object is gone',
    anchor:
      '|| fail "the Rust function\'s NetworkPolicy still exists: the Rust leg would not be a policy-off leg"',
    replacement: '|| true',
  },
  {
    id: 'R3',
    subject: 'run',
    claim: 'the Rust leg is never run from the policyoff phase',
    anchor: '  policyoff_rust\n}\n',
    replacement: '}\n',
  },
  {
    id: 'R4',
    subject: 'run',
    claim: 'the Rust function may already have a pod, so the leg is not cold',
    anchor:
      '[ "$(all_pods "${RUST_FN}")" = 0 ] || fail "${RUST_FN} has a pod before the cold call, so the Rust leg would not be cold"',
    replacement: 'true',
  },
  {
    id: 'R5',
    subject: 'run',
    claim: 'the cold Rust call weakens its 401 assertion',
    anchor: RUST_COLD,
    replacement: weaken(RUST_COLD),
  },
  {
    id: 'R6',
    subject: 'run',
    claim: 'the refused Rust call is no longer required to have woken the function',
    anchor:
      '[ "$(all_pods "${RUST_FN}")" -ge 1 ] || fail "the refused call never woke ${RUST_FN}: it did not reach the function"',
    replacement: 'true',
  },
  {
    id: 'R7',
    subject: 'run',
    claim: 'the cold Rust call goes to the Go function instead',
    anchor: '  foreign_post "${RUST_URL}${GET_ITEM}" ""\n  [ "${FC_STATUS}" = 401 ]',
    replacement: '  foreign_get ""\n  [ "${FC_STATUS}" = 401 ]',
  },
  {
    id: 'R8',
    subject: 'run',
    claim: 'the Rust direct leg stops requiring the dial to connect',
    anchor: '[ "$(dial_rc "${ip}" 8080)" = 0 ]; then RUST_IP=',
    replacement: '[ "$(dial_rc "${ip}" 8080)" != 99 ]; then RUST_IP=',
  },
  {
    id: 'R9',
    subject: 'run',
    claim: 'the Rust direct leg proceeds when no pod could be dialled',
    anchor: '  fail "policy off: the foreign pod could not reach the warm Rust function pod',
    replacement: '  true "policy off: the foreign pod could not reach the warm Rust function pod',
  },
  {
    id: 'R10',
    subject: 'run',
    claim: 'the direct Rust no-token leg weakens its 401 assertion',
    anchor: RUST_DIRECT,
    replacement: weaken(RUST_DIRECT),
  },
  {
    id: 'R11',
    subject: 'run',
    claim: 'the direct Rust garbage-token call is dropped',
    anchor: '  foreign_post "http://${RUST_IP}:8080${GET_ITEM}" "Bearer not-a-token"\n  [ "${FC_STATUS}" = 401 ] && [ "${FC_CODE}" = unauthenticated ] && [ "${FC_MESSAGE}" = "token rejected" ] \\\n    || fail "policy off, Rust',
    replacement: '  [ "${FC_STATUS}" = 401 ] && [ "${FC_CODE}" = unauthenticated ] && [ "${FC_MESSAGE}" = "token rejected" ] \\\n    || fail "policy off, Rust',
  },
  {
    id: 'R12',
    subject: 'run',
    claim: 'the direct Rust garbage-token leg weakens its 401 assertion',
    anchor: RUST_GARBAGE,
    replacement: weaken(RUST_GARBAGE),
  },
  {
    id: 'R13',
    subject: 'run',
    claim: 'the Rust leg never restores the Rust policy',
    anchor: '  set_rust_policy true\n  ok "policy off: a foreign pod reached the Rust',
    replacement: '  ok "policy off: a foreign pod reached the Rust',
  },
  {
    id: 'R14',
    subject: 'run',
    claim: 'an aborted run leaves the Rust function with its policy off',
    anchor: '  if [ "${RESTORE_RUST_POLICY}" = 1 ]; then\n',
    replacement: '  if [ "${RESTORE_RUST_POLICY}" = 99 ]; then\n',
  },
  {
    id: 'R15',
    subject: 'run',
    claim: 'the drill stops deploying the Rust function',
    anchor: 'Z10_WITH_RUST=1 INTERNAL_PORT',
    replacement: 'Z10_WITH_RUST=0 INTERNAL_PORT',
  },
  {
    id: 'D1',
    subject: 'run',
    claim: 'the concurrent drain stops waiting for the Rust function',
    anchor: '  await_zero_all "${GO_FN}" "${RUST_FN}"\n',
    replacement: '  await_zero_all "${GO_FN}"\n',
  },
  {
    id: 'D2',
    subject: 'run',
    claim: 'the drain falls back to a serial wait on the Go function alone',
    anchor: '  await_zero_all "${GO_FN}" "${RUST_FN}"\n',
    replacement: '  await_zero "${GO_FN}"\n',
  },
  {
    id: 'D3',
    subject: 'run',
    claim: 'await_zero_all waits for the first service only',
    anchor: '  for svc in "$@"; do\n',
    replacement: '  for svc in "$1"; do\n',
  },
  {
    id: 'D4',
    subject: 'run',
    claim: 'await_zero_all stops failing when a service never drains',
    anchor: '      [ "${SECONDS}" -lt "${end}" ] || fail "timed out after 300s waiting for: ${svc} scaled to zero"',
    replacement: '      [ "${SECONDS}" -lt "${end}" ] || true',
  },
  {
    id: 'D5',
    subject: 'run',
    claim: 'await_zero_all accepts a service that still has a pod',
    anchor: '    until [ "$(all_pods "${svc}")" = 0 ]; do\n',
    replacement: '    until [ "$(all_pods "${svc}")" != 99 ]; do\n',
  },
];

const prover = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: SPEC,
  subjects: {
    run: 'packages/grpc/e2e/z11-activator-drill/run.sh',
  },
});

console.log('=== mutation proof: Z11 Rust policy-off leg and concurrent drain (S9-2) ===');
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
