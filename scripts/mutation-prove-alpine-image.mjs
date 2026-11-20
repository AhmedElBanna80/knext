#!/usr/bin/env node
/**
 * Mutation proof for the alpine-image docker e2e guard (#897 SIGTERM drain on the
 * shipped binary, ADR-0042 A1 + A9).
 *
 * WHY THIS PROVER IS DOCKER-GATED. The guard's `beforeAll` runs `./build.sh` and a
 * full `docker build`, then boots three alpine containers, so every mutation repeats
 * that. It therefore needs docker, which the nightly lane's runners have. Where docker
 * is absent this prover prints the lane's SKIP marker and exits 0 WITHOUT declaring
 * or recording any mutation: the lane reports SKIP (never ok), and the aggregate job
 * turns it into a finding, so a skipped run is never counted as proved. The guard
 * itself has no skip path (a missing docker is a hard failure there); only the
 * prover, which must not run the guard without its prerequisite, may skip.
 *
 * THE SUBJECT is the reference `examples/bun-exec/Dockerfile`: each mutation is a way
 * the image could stop being what the guard claims, plus a negative control.
 *
 * Every Dockerfile replacement below is multi-line on purpose. The harness puts its
 * residue marker on its own line for those, whereas a trailing `# marker` on an
 * exec-form `CMD [...]` would make Docker re-parse it as shell form and change what
 * is being tested.
 *
 * DISCIPLINE (`.claude/rules/workflow.md`): exit codes only; green baseline; a canary
 * red first; anchors exactly once or abort; clean tree between mutations.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGuardProver, skipUnlessDocker } from './lib/guard-prover.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = 'examples/bun-exec/test/alpine-image.docker-e2e.test.ts';

skipUnlessDocker();

const DOCKERFILE = { commentPrefix: '#' };

const MUTATIONS = [
  {
    id: 'M1',
    expect: 'red',
    claim:
      "libstdc++/libgcc are no longer installed (A9) — bun's musl binary is dynamically linked, so the container dies with exit 127",
    subject: 'dockerfile',
    options: DOCKERFILE,
    anchor: 'RUN apk upgrade --no-cache && apk add --no-cache libstdc++ libgcc',
    replacement: 'RUN apk upgrade --no-cache\n',
  },
  {
    id: 'M2',
    expect: 'red',
    claim: 'the static-asset dir is no longer copied into the image — every asset request 404s',
    subject: 'dockerfile',
    options: DOCKERFILE,
    anchor: 'COPY .output/public /app/.output/public',
    replacement: '',
  },
  {
    id: 'M3',
    expect: 'red',
    claim:
      'the binary runs under a shell that does not forward SIGTERM (#897) — no drain, no exit 0',
    subject: 'dockerfile',
    options: DOCKERFILE,
    anchor: 'CMD ["/app/server"]',
    replacement: 'CMD ["/bin/sh", "-c", "/app/server; exit $?"]\n',
  },
  {
    id: 'M4',
    expect: 'green',
    claim: 'EXPOSE is narrowed — publishing is explicit (`--publish`), so the guard must not care',
    subject: 'dockerfile',
    options: DOCKERFILE,
    anchor: 'EXPOSE 3000 9464',
    replacement: 'EXPOSE 3000\n',
  },
];

const prover = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: SPEC,
  subjects: { dockerfile: 'examples/bun-exec/Dockerfile' },
});

console.log(`=== mutation proof: ${SPEC} (#897 alpine image, docker-gated) ===`);
prover.preflight(MUTATIONS);
declareMutations(MUTATIONS.length);
prover.baseline();

// The canary is the A9 defect itself: if the runner cannot see that, nothing below
// is worth reading.
prover.proveCanSeeRed({
  subject: 'dockerfile',
  options: DOCKERFILE,
  anchor: 'RUN apk upgrade --no-cache && apk add --no-cache libstdc++ libgcc',
  replacement: 'RUN apk upgrade --no-cache\n',
});

console.log('\n=== mutations ===');
for (const m of MUTATIONS) {
  prover.run(m);
  recordMutation();
}

prover.finish(MUTATIONS.length);
