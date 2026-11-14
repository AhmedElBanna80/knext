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
      'PHASES="${PHASES:-images deploy cold trailers zerozone rollout sovereignty crosszone wake}"',
    replacement: 'PHASES="${PHASES:-images deploy cold trailers rollout sovereignty wake}"',
  },
  {
    id: 'P02',
    subject: 'lane',
    claim: 'the crosszone phase is never dispatched',
    anchor: 'has_phase crosszone && phase_crosszone\n',
    replacement: '',
  },
];

// The subjects are inline literals, not a shared constant: the lane's
// subject-existence audit reads them from the createGuardProver call.
const lane = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: 'tests/z10-zone-functions-kind-lane.test.ts',
  subjects: { lane: 'packages/grpc/e2e/z10-zone-functions-kind/run.sh' },
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
