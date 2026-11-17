#!/usr/bin/env node
/**
 * Mutation proof for the three Z8 BackendService scenarios committed as Z10
 * kind phases (#2421):
 *
 *   - zerozone   the zone and its function both at zero; one call wakes both,
 *                and the function is rendered for h2c;
 *   - rollout    each served-version bump rolls exactly one zone revision;
 *   - crosszone  a function naming another zone binds on neither side.
 *
 * The guard is tests/z10-zone-functions-kind-lane.test.ts, which reads
 * run.sh as text (the lane itself needs a cluster). Each mutation weakens one
 * claim in run.sh, and the guard must go red.
 *
 * Verdicts are by EXIT CODE only (scripts/lib/guard-prover.mjs never parses
 * output), every anchor must occur exactly once (preflight first), the
 * baseline must be green, a canary must go red before any green is trusted,
 * and every restore is content-verified.
 *
 * What this does not prove: that the phases pass on a cluster. That is the
 * kind run (the Z7 job in CI).
 *
 * Usage:  node scripts/mutation-prove-2421-z8-scenarios.mjs
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGuardProver } from './lib/guard-prover.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const MUTATIONS = [
  {
    id: 'Z01',
    subject: 'lane',
    claim: 'the zone is never dropped to minScale 0, so only the function is cold',
    anchor: '  set_zone_min 0\n  await_zero "${ZONE}"\n',
    replacement: '  await_zero "${ZONE}"\n',
  },
  {
    id: 'Z02',
    subject: 'lane',
    claim: 'the call is made without waiting for the zone to reach zero',
    anchor: '  set_zone_min 0\n  await_zero "${ZONE}"\n',
    replacement: '  set_zone_min 0\n',
  },
  {
    id: 'Z03',
    subject: 'lane',
    claim: 'a call answered without waking the zone is accepted',
    anchor:
      '  [ -n "$(pod_uids "${ZONE}")" ] || fail "the call succeeded but the zone has no pod: it did not wake from zero"\n',
    replacement: '',
  },
  {
    id: 'Z04',
    subject: 'lane',
    claim: 'the h2c port check is dropped',
    anchor:
      '  [ "${port}" = h2c ] || fail "${GO_FN}: its Knative Service port is \'${port}\', want h2c"\n',
    replacement: '',
  },
  {
    id: 'Z05',
    subject: 'lane',
    claim: 'the zone is left at minScale 0 for the phases after it',
    anchor: '  set_zone_min 1\n',
    replacement: '',
  },
  {
    id: 'Z06',
    subject: 'lane',
    claim: 'an explicit HTTP/1.1 override on the binding is accepted',
    anchor: '  case "${hv}" in unset | 2) ;; *) fail',
    replacement: '  case "${hv}" in *) ;; 2) fail',
  },
  {
    id: 'Z07',
    subject: 'lane',
    claim: "the zone's h2c transport notice is never read",
    anchor:
      '  grep -qF \'knext: example function: transport h2c (HTTP/2 cleartext)\' <<<"${zlog}" \\\n',
    replacement: '  true \\\n',
  },
  {
    id: 'Z10',
    subject: 'lane',
    claim: 'a missing h2c notice no longer fails the lane',
    anchor: '    || fail "the woken zone did not log an h2c transport for the example function"\n',
    replacement: '    || true\n',
  },
  {
    id: 'Z11',
    subject: 'lane',
    claim: 'an HTTP/1.1 notice no longer fails the lane',
    anchor: '    || fail "the woken zone logged an HTTP/1.1 transport for the example function"\n',
    replacement: '    || true\n',
  },
  {
    id: 'Z12',
    subject: 'lane',
    claim: "the notice is read from the function's log, not the zone's",
    anchor:
      '  zlog="$(k -n "${NS}" logs -l "serving.knative.dev/service=${ZONE}" -c user-container --tail=-1)"\n',
    replacement:
      '  zlog="$(k -n "${NS}" logs -l "serving.knative.dev/service=${GO_FN}" -c user-container --tail=-1)"\n',
  },
  {
    id: 'Z08',
    subject: 'lane',
    claim: 'the function is not re-checked at zero right before the call',
    anchor:
      '  [ "$(all_pods "${GO_FN}")" = 0 ] || fail "${GO_FN} has a pod again before the call"\n',
    replacement: '',
  },
  {
    id: 'Z09',
    subject: 'lane',
    claim:
      'the call goes through the retrying zone_call, so a timed-out first request is retried warm',
    anchor:
      '  out="$(curl -s -m 120 -H "Host: ${ZONE_HOST}" -w \'\\n%{http_code}\' \\\n    "http://127.0.0.1:${INTERNAL_PORT}/example/put?sub=alice&id=zero-1&value=v1" 2>/dev/null)" || out=$\'\\n000\'\n',
    replacement:
      '  zone_call "/example/put?sub=alice&id=zero-1&value=v1"; out="${ZC_BODY}\n${ZC_STATUS}"\n',
  },
  {
    id: 'R03',
    subject: 'lane',
    claim: 'the count is truncated to one, so two revisions read as one',
    anchor: '<(printf \'%s\\n\' "${after}") | grep -c . || true)"',
    replacement: '<(printf \'%s\\n\' "${after}") | head -1 | grep -c . || true)"',
  },
  {
    id: 'X05',
    subject: 'lane',
    claim: "the function's Ready reason is not checked",
    anchor: '  [ "$(cond_of backendservice "${XZ_FN}" Ready)" = False/ZoneNotListed ] \\\n',
    replacement: '  [ "$(cond_of backendservice "${XZ_FN}" Ready | cut -d/ -f1)" = False ] \\\n',
  },
  {
    id: 'X06',
    subject: 'lane',
    claim: 'the env-absence check can pass with no user-container at all',
    anchor:
      '  [ "$(k -n "${NS}" get ksvc "${XZ_LISTING}" -o json | jq \'[.spec.template.spec.containers[] | select(.name == "user-container")] | length\')" = 1 ] \\\n',
    replacement: '  [ 1 = 1 ] \\\n',
  },
  {
    id: 'R01',
    subject: 'lane',
    claim: 'the revision count is taken before the hold, so a late second revision is missed',
    anchor: '  sleep 20\n  after="$(zone_revisions)"\n',
    replacement: '  after="$(zone_revisions)"\n',
  },
  {
    id: 'R02',
    subject: 'lane',
    claim: 'any number of zone revisions is accepted',
    anchor: '  [ "${rolled}" = "${want}" ] \\\n',
    replacement: '  [ "${rolled}" -ge 0 ] \\\n',
  },
  {
    id: 'X01',
    subject: 'lane',
    claim: 'the refusal is read before a hold, so one that flaps to rendering passes',
    anchor:
      '  # Hold for a while: a refusal that flaps to rendering is not one.\n  sleep 20\n  [ "$(cond_of nextapp',
    replacement: '  [ "$(cond_of nextapp',
  },
  {
    id: 'X02',
    subject: 'lane',
    claim: "the function's Knative Service is never checked for absence",
    anchor: '  [ -z "$(k -n "${NS}" get ksvc "${XZ_FN}" --ignore-not-found -o name)" ] \\\n',
    replacement: '  [ -z "" ] \\\n',
  },
  {
    id: 'X03',
    subject: 'lane',
    claim: 'the listing zone may render the cross-zone URL',
    anchor: 'select(.name | startswith("XZ_SERVICE_"))',
    replacement: 'select(.name | startswith("XZ_NEVER_"))',
  },
  {
    id: 'X04',
    subject: 'lane',
    claim: 'the function names the listing zone, so the scenario is not cross-zone',
    anchor: '  zone: ${XZ_OWNER}\n',
    replacement: '  zone: ${XZ_LISTING}\n',
  },
  {
    id: 'P01',
    subject: 'lane',
    claim: 'the new phases are not in the default run',
    anchor:
      'PHASES="${PHASES:-images deploy cold trailers grpctrailers zerozone rollout sovereignty crosszone wake}"',
    replacement:
      'PHASES="${PHASES:-images deploy cold trailers grpctrailers rollout sovereignty wake}"',
  },
  {
    id: 'G01',
    subject: 'lane',
    claim: 'the grpctrailers phase is not in the lane default phase list',
    anchor:
      'PHASES="${PHASES:-images deploy cold trailers grpctrailers zerozone rollout sovereignty crosszone wake}"',
    replacement:
      'PHASES="${PHASES:-images deploy cold trailers zerozone rollout sovereignty crosszone wake}"',
  },
  {
    id: 'G02',
    subject: 'lane',
    claim: 'the grpctrailers phase is never dispatched (CI runs the default dispatch)',
    anchor: 'has_phase grpctrailers && phase_grpctrailers\n',
    replacement: '',
  },
  {
    id: 'G03',
    subject: 'lane',
    claim: 'the grpc-status is never checked against the status the case expects',
    anchor: '  [ "${GP_STATUS}" = "${want_status}" ] || fail',
    replacement: '  true || fail',
  },
  {
    id: 'G04',
    subject: 'lane',
    claim: 'a success may take its grpc-status from the headers, not the trailer',
    anchor: '    trailer) [ "${GP_SOURCE}" = trailer ] || fail',
    replacement: '    trailer) [ -n "${GP_SOURCE}" ] || fail',
  },
  {
    id: 'P02',
    subject: 'lane',
    claim: 'the crosszone phase is never dispatched',
    anchor: 'has_phase crosszone && phase_crosszone\n',
    replacement: '',
  },
  {
    id: 'H01',
    subject: 'probe',
    claim: 'the probe stops using the gRPC transport',
    anchor: '  const transport = createGrpcTransport({',
    replacement: '  const transport = createConnectTransport({',
  },
  {
    id: 'H02',
    subject: 'probe',
    claim: 'the probe stops using its own HTTP/2 session manager',
    anchor: '    sessionManager: sessions,\n',
    replacement: '',
  },
  {
    id: 'H03',
    subject: 'probe',
    claim: 'the probe no longer types its HTTP/2 stream from node:http2',
    anchor: "from 'node:http2';",
    replacement: "from 'node:http';",
  },
];

// The subjects are inline literals, not a shared constant: the lane's
// subject-existence audit reads them from the createGuardProver call.
const lane = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: 'tests/z10-zone-functions-kind-lane.test.ts',
  subjects: {
    lane: 'packages/grpc/e2e/z10-zone-functions-kind/run.sh',
    probe: 'packages/grpc/e2e/z7-identity-kind/zone-caller/grpc-probe.ts',
  },
});

console.log('=== mutation proof: Z8 BackendService scenarios in the Z10 lane (#2421) ===');
lane.preflight(MUTATIONS);
declareMutations(MUTATIONS.length);

lane.baseline();
lane.proveCanSeeRed({
  subject: 'lane',
  anchor: 'has_phase zerozone && phase_zerozone\n',
  replacement: '',
});
for (const m of MUTATIONS) {
  lane.run({ ...m, expect: 'red' });
  recordMutation();
}
lane.finish(MUTATIONS.length);
