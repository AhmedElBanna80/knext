#!/usr/bin/env node
/**
 * Mutation proof for the wake-ahead primer (#2054, ADR-0066 D3).
 *
 * Each row removes one thing `packages/kn-next/src/__tests__/wake-ahead.test.ts`
 * protects and REQUIRES that spec to go red: the call becomes blocking, a
 * SIGTERM handler stops aborting the primers, the call stops listening to the
 * shared signal or its timeout, the URL derivation drifts from the operator's
 * fixture, the opt-out is ignored, or the primer leaves the list. The shared
 * driver (`scripts/lib/guard-prover.mjs`) owns the discipline: verdicts by EXIT
 * CODE only, baseline green first, a canary that must go red, anchors that must
 * occur exactly once (else abort), byte-exact restore.
 *
 * The primer list's own wiring into node-server.ts and standalone-compile.mjs
 * is guarded by `arp-primer-entry-order.test.ts` and
 * `preload-lists-lockstep.test.ts`, which carry their own drift cases.
 *
 * Usage: node scripts/mutation-prove-2054-wake-ahead.mjs
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGuardProver } from './lib/guard-prover.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = 'packages/kn-next/src/__tests__/wake-ahead.test.ts';

const MUTATIONS = [
  {
    id: 'W1',
    subject: 'wake',
    claim: 'the wake calls block the boot for 1.5 s',
    anchor: '    for (const t of targets) {\n',
    replacement:
      '    { const s = Date.now(); while (Date.now() - s < 1500) {} }\n    for (const t of targets) {\n',
  },
  {
    id: 'W2',
    subject: 'wake',
    claim: 'a wake call ignores the shared primer signal (SIGTERM cannot cancel it)',
    anchor: "      shared.addEventListener('abort', onAbort, { once: true });\n",
    replacement: '',
  },
  {
    id: 'W3',
    subject: 'wake',
    claim: 'a wake call loses its hard timeout',
    anchor: '      const timer = setTimeout(onAbort, timeoutMs);\n',
    replacement: '      const timer = setTimeout(() => {}, timeoutMs);\n',
  },
  {
    id: 'W4',
    subject: 'wake',
    claim: '<NAME>_SERVICE_URL derivation drifts from the operator fixture',
    anchor: "replaceAll('-', '_')}_SERVICE_URL",
    replacement: "replaceAll('-', '')}_SERVICE_URL",
  },
  {
    id: 'W5',
    subject: 'wake',
    claim: 'KNEXT_WAKE_AHEAD=0 is ignored',
    anchor: "    if (env[WAKE_AHEAD_SWITCH_ENV] === '0') return calls;\n",
    replacement: '',
  },
  {
    id: 'W6',
    subject: 'wake',
    claim: 'an abort before the call leaves still sends it',
    anchor: 'controller.signal.aborted ? undefined : doFetch(',
    replacement: 'false ? undefined : doFetch(',
  },
  {
    id: 'S1',
    subject: 'nodeServer',
    claim: "node-server.ts's onSignal no longer aborts the primers before draining",
    anchor: '    abortPrimers();\n    log.info(',
    replacement: '    log.info(',
  },
  {
    id: 'S2',
    subject: 'supervisor',
    claim: 'the self-contained supervisor no longer aborts the primers on SIGTERM',
    anchor: "      globalThis[Symbol.for('knext.runtime.primerAbort')]?.abort();\n",
    replacement: '',
  },
  {
    id: 'L1',
    subject: 'list',
    claim: 'wake-ahead.cjs leaves the process-start primer list',
    anchor: "['arp-primer.cjs', 'wake-ahead.cjs']",
    replacement: "['arp-primer.cjs']",
  },
];

const prover = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: SPEC,
  subjects: {
    wake: 'packages/kn-next/src/adapters/wake-ahead.cjs',
    list: 'packages/kn-next/src/adapters/process-start-primers.cjs',
    nodeServer: 'packages/kn-next/src/adapters/node-server.ts',
    supervisor: 'packages/kn-next/src/adapters/standalone-self-contained-supervisor.cjs',
  },
});

console.log('=== mutation proof: wake-ahead primer (#2054) ===');
prover.preflight(MUTATIONS);
declareMutations(MUTATIONS.length);
prover.baseline();
prover.proveCanSeeRed({
  subject: 'wake',
  anchor: "const WAKE_FUNCTIONS_ENV = 'KNEXT_WAKE_FUNCTIONS';",
  replacement: "const WAKE_FUNCTIONS_ENV = 'KNEXT_WAKE_FUNCTIONZ';",
});
for (const m of MUTATIONS) {
  prover.run({ ...m, expect: 'red' });
  recordMutation();
}
prover.finish(MUTATIONS.length);
