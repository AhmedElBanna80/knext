#!/usr/bin/env node
/**
 * Mutation proof for the Dockerfile base-image digest guard (issue #2660).
 *
 * Guard proved: tests/dockerfile-base-image-digests.test.ts, which owns FORM and
 * CONSISTENCY at PR time (a digest is present, the reference parses, one repo:tag
 * maps to one digest) and the nightly resolver's Dockerfile scope.
 *
 * Two kinds of row. Tree rows reintroduce the defect in a shipped Dockerfile (the
 * old distroless digests, a missing digest, a build-arg FROM). Checker rows break
 * the scanner itself: each one leaves the tree consistent, so only a fixture that
 * exercises that exact behaviour can notice.
 *
 * Discipline (scripts/lib/guard-prover.mjs): every anchor occurs exactly once
 * (else ABORT), every verdict is the runner's EXIT CODE, the baseline must be
 * green first, a CANARY must go red before any green below is trusted, the tree
 * is checked clean between mutations. Run on a COMMITTED tree.
 *
 * Exit 0 = every row went red; non-zero otherwise.
 *
 * Usage: node scripts/mutation-prove-2660-dockerfile-digests.mjs
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGuardProver } from './lib/guard-prover.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = 'tests/dockerfile-base-image-digests.test.ts';

const DOCKER = { commentPrefix: '#' };
const JS = { commentPrefix: '/*' };

const CURRENT = 'sha256:25ac8f0c3b2334a9eb05452266bd4697864a8c8ef0ef71e5e6480d7f92868329';
// Real digests the registry served before; deliberately NOT fabricated.
const OLD_OPERATOR = 'sha256:963fa6c544fe5ce420f1f54fb88b6fb01479f054c8056d0f74cc2c6000df5240';
const OLD_OTHERS = 'sha256:e2e927ec666bae08560abb3c55d0659eceabb657f56b6782ab500a9fc7f555e3';
const ALPINE320 = 'sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc';

const MUTATIONS = [
  {
    id: 'D01',
    subject: 'operator',
    claim: 'the operator image goes back to its older distroless digest',
    anchor: `static:nonroot@${CURRENT}`,
    replacement: `static:nonroot@${OLD_OPERATOR}`,
    options: DOCKER,
  },
  {
    id: 'D02',
    subject: 'gateway',
    claim: 'the scale-zero-pg gateway goes back to the other older distroless digest',
    anchor: `static:nonroot@${CURRENT}`,
    replacement: `static:nonroot@${OLD_OTHERS}`,
    options: DOCKER,
  },
  {
    id: 'D03',
    subject: 'rust',
    claim: 'the rust template drifts to the older digest while the others stay current',
    anchor: `static:nonroot@${CURRENT}`,
    replacement: `static:nonroot@${OLD_OTHERS}`,
    options: DOCKER,
  },
  {
    id: 'D04',
    subject: 'bakeoff',
    claim: 'the bake-off alpine loses its digest again',
    anchor: `alpine:3.20@${ALPINE320}`,
    replacement: 'alpine:3.20',
    options: DOCKER,
  },
  {
    id: 'D05',
    subject: 'goTemplate',
    claim: 'the go template takes its runtime base from a build arg',
    anchor: `FROM gcr.io/distroless/static:nonroot@${CURRENT}`,
    replacement: 'FROM ${RUNTIME_BASE}',
    options: DOCKER,
  },
  {
    id: 'C01',
    subject: 'lib',
    claim: 'the checker no longer reports one tag with two digests',
    anchor: 'digests.size > 1 &&',
    replacement: 'digests.size > 999 &&',
    options: JS,
  },
  {
    id: 'C02',
    subject: 'lib',
    claim: 'the checker treats a digest-less reference as a stage alias',
    anchor: "if (!digest) return { ...base, kind: 'unpinned', key };",
    replacement: "if (!digest) return { ...base, kind: 'stage' };",
    options: JS,
  },
  {
    id: 'C03',
    subject: 'lib',
    claim: 'the checker accepts a reference it cannot parse',
    anchor: "if (!IMAGE_TOKEN.test(image)) return { ...base, kind: 'unparseable' };",
    replacement: 'if (false) return undefined;',
    options: JS,
  },
  {
    id: 'C04',
    subject: 'lib',
    claim: 'an expired exclusion keeps suppressing findings',
    anchor: 'if (exclusionProblem(entry) || isExpired(entry, today)) return false;',
    replacement: 'if (exclusionProblem(entry)) return false;',
    options: JS,
  },
  {
    id: 'C05',
    subject: 'lib',
    claim: 'the walk descends into node_modules',
    anchor: 'if (SKIP_DIRS.has(entry.name)) continue;',
    replacement: 'if (false) continue;',
    options: JS,
  },
  {
    id: 'C06',
    subject: 'lib',
    claim: 'the walk stops recognising `<name>.Dockerfile` files',
    anchor: '|[^/]+\\.Dockerfile)$/',
    replacement: ')$/',
    options: JS,
  },
  {
    id: 'N01',
    subject: 'verify',
    claim: 'the nightly resolver no longer reads Dockerfiles',
    anchor: '...discoverSources(repoRoot), ...dockerfiles]',
    replacement: '...discoverSources(repoRoot)]',
    options: JS,
  },
  {
    id: 'N02',
    subject: 'verify',
    claim: 'the nightly resolver ignores expiry-aware exclusions for Dockerfiles',
    anchor: 'dockerfiles.includes(pin.file) &&',
    replacement: 'false &&',
    options: JS,
  },
];

// The canary: a real mutation of a real subject. If this stays green the harness
// cannot see red and nothing below means anything.
const CANARY = {
  subject: 'operator',
  anchor: `static:nonroot@${CURRENT}`,
  replacement: `static:nonroot@${OLD_OPERATOR}`,
  options: DOCKER,
};

declareMutations(MUTATIONS.length);
console.log(`mutation-prove-2660-dockerfile-digests: ${MUTATIONS.length} mutations declared`);

const prover = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: SPEC,
  subjects: {
    operator: 'packages/kn-next-operator/Dockerfile',
    gateway: 'packages/scale-zero-pg/gateway/Dockerfile',
    rust: 'templates/rust/Dockerfile',
    goTemplate: 'templates/go/Dockerfile',
    bakeoff: 'packages/scale-zero-pg/bakeoff/gateway-exec.Dockerfile',
    lib: 'scripts/lib/dockerfile-base-images.mjs',
    verify: 'scripts/verify-image-pins.mjs',
  },
});
prover.preflight(MUTATIONS);
prover.baseline();
prover.proveCanSeeRed(CANARY);

for (const m of MUTATIONS) {
  prover.run({ ...m, expect: 'red' });
  recordMutation();
}
prover.finish(MUTATIONS.length);
