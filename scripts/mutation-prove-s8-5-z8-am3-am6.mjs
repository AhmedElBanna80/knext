#!/usr/bin/env node
/**
 * Mutation proof for the two Z10 kind phases that prove ADR-0004 Amendment 3
 * (image-swap refusal, `imagepin`) and Amendment 6 (HTTP/1.1 through the h2c
 * port, `http11`).
 *
 * The guard is tests/z10-zone-functions-kind-lane.test.ts, which reads run.sh as
 * text (the lane itself needs a cluster). Each mutation weakens one claim in
 * run.sh, and the guard must go red.
 *
 * Verdicts are by EXIT CODE only (scripts/lib/guard-prover.mjs never parses
 * output), every anchor must occur exactly once (preflight first), the baseline
 * must be green, a canary must go red before any green is trusted, and every
 * restore is content-verified.
 *
 * What this does not prove: that the phases pass on a cluster. That is the kind
 * run (the Z7 job in CI).
 *
 * Usage:  node scripts/mutation-prove-s8-5-z8-am3-am6.mjs
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGuardProver } from './lib/guard-prover.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const MUTATIONS = [
  {
    id: 'P01',
    subject: 'lane',
    claim: 'the pin is set to something other than the digest the function runs',
    anchor: '\\"path\\":\\"/spec/backends/0/image\\",\\"value\\":\\"${pin}\\"',
    replacement: '\\"path\\":\\"/spec/backends/0/image\\",\\"value\\":\\"${swap_img}\\"',
  },
  {
    id: 'P02',
    subject: 'lane',
    claim: "the swap image is the function's own image, so nothing is swapped",
    anchor: '  swap_img="$(image_ref zone-caller)"\n',
    replacement: '  swap_img="$(image_ref function-go)"\n',
  },
  {
    id: 'P03',
    subject: 'lane',
    claim: "the zone's BackendBindings report of the refusal is not checked",
    anchor:
      '  [ "$(cond_of nextapp "${ZONE}" BackendBindings)" = False/BindingImageMismatch ] \\\n',
    replacement: '  true \\\n',
  },
  {
    id: 'P04',
    subject: 'lane',
    claim: 'the refusal is not held, so a flap back to rendering would pass',
    anchor:
      '  # Hold: a refusal that flaps back to rendering is not one.\n  sleep 20\n  [ "$(cond_of backendservice "${GO_FN}" Bound)" = False/BindingImageMismatch ]',
    replacement: '  [ "$(cond_of backendservice "${GO_FN}" Bound)" = False/BindingImageMismatch ]',
  },
  {
    id: 'P05',
    subject: 'lane',
    claim: 'recovery on the pinned image is never exercised by a call',
    anchor:
      '  expect_zone "the pinned image is back: the zone calls ${GO_FN} again" \\\n    "/example/put?sub=alice&id=pin-2&value=v" 200 \'.ok == true\'\n',
    replacement: '',
  },
  {
    id: 'P06',
    subject: 'lane',
    claim: "the pin is left on the zone's entry for the later phases",
    anchor: '    -p \'[{"op":"remove","path":"/spec/backends/0/image"}]\' >/dev/null\n',
    replacement:
      '    -p \'[{"op":"test","path":"/spec/backends/0/image","value":"x"}]\' >/dev/null || true\n',
  },
  {
    id: 'H01',
    subject: 'lane',
    claim: 'the zone is set to httpVersion 2, not 1.1',
    anchor: '"path":"/spec/backends/0/httpVersion","value":"1.1"',
    replacement: '"path":"/spec/backends/0/httpVersion","value":"2"',
  },
  {
    id: 'H02',
    subject: 'lane',
    claim: 'the function port is not re-checked as h2c after the 1.1 calls',
    anchor:
      '  [ "$(fn_port_names)" = h2c ] || fail "${GO_FN}: its Knative Service port is \'$(fn_port_names)\' under httpVersion 1.1, want h2c"\n',
    replacement: '',
  },
  {
    id: 'H03',
    subject: 'lane',
    claim: 'the transport notice is read from every pod of the service, terminating ones included',
    anchor: 'logs "${zpod}" -c user-container',
    replacement: 'logs -l "serving.knative.dev/service=${ZONE}" -c user-container',
  },
  {
    id: 'H04',
    subject: 'lane',
    claim: 'an h2c notice under httpVersion 1.1 is accepted',
    anchor:
      '  ! grep -qF \'knext: example function: transport h2c\' <<<"${zlog}" \\\n    || fail "the zone logged an h2c transport for the example function under httpVersion 1.1"\n',
    replacement: '',
  },
  {
    id: 'H05',
    subject: 'lane',
    claim: 'the HTTP/1.1 call from zero through the activator is dropped',
    anchor:
      '  cold_call "${GO_FN}" "/example/put?sub=alice&id=h11-2&value=v2" 200 \'.ok == true\' \\\n    "httpVersion 1.1 from zero"\n',
    replacement: '',
  },
  {
    id: 'H06',
    subject: 'lane',
    claim: 'the zone is not waited back onto no httpVersion',
    anchor:
      '  wait_until 300 3 "the zone runs without EXAMPLE_SERVICE_HTTP_VERSION" "zone_http_version unset"\n',
    replacement: '',
  },
  {
    id: 'D01',
    subject: 'lane',
    claim: 'http11 is no longer a default phase',
    anchor: 'crosszone wake imagepin http11}"',
    replacement: 'crosszone wake imagepin}"',
  },
];

// The subjects are inline literals, not a shared constant: the lane's
// subject-existence audit reads them from the createGuardProver call.
const lane = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: 'tests/z10-zone-functions-kind-lane.test.ts',
  subjects: {
    lane: 'packages/grpc/e2e/z10-zone-functions-kind/run.sh',
  },
});

console.log('=== mutation proof: Z10 imagepin and http11 phases (ADR-0004 Am3, Am6) ===');
lane.preflight(MUTATIONS);
declareMutations(MUTATIONS.length);

lane.baseline();
lane.proveCanSeeRed({
  subject: 'lane',
  anchor: 'has_phase imagepin && phase_imagepin\n',
  replacement: '',
});
for (const m of MUTATIONS) {
  lane.run({ ...m, expect: 'red' });
  recordMutation();
}
lane.finish(MUTATIONS.length);
