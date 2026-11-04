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
    id: 'D06',
    subject: 'goTemplate',
    claim: 'one golang pin goes back to the digest it had before the re-pin (#2665)',
    anchor:
      'golang:1.26.10@sha256:670bb5aa5349ae03b8516764718486f4f16399134bdc9acd0c46a23f043ab05c',
    replacement:
      'golang:1.26.10@sha256:24a707af49702fa44f02785475d02fb752f6982d3e9c0afb7696e1f0204e7ce9',
    options: DOCKER,
  },
  {
    id: 'C07',
    subject: 'lib',
    claim: 'continuation lines are no longer joined (COPY --from on a later line is missed)',
    anchor: 'if (trimmed.endsWith(escapeChar)) {',
    replacement: 'if (false) {',
    options: JS,
  },
  {
    id: 'C08',
    subject: 'lib',
    claim: 'RUN --mount=...,from=<image> is no longer read',
    anchor: 'const run = /^RUN\\s+(.*)$/i.exec(line);',
    replacement: 'const run = null;',
    options: JS,
  },
  {
    id: 'C12',
    subject: 'lib',
    claim: 'a --mount value is split on commas, so a quoted "from=..." field is missed (#2712)',
    anchor: 'const fields = csvFields(mount[1]);',
    replacement: "const fields = mount[1].split(',');",
    options: JS,
  },
  {
    id: 'C13',
    subject: 'lib',
    claim: 'ONBUILD triggers are no longer read (#2712)',
    anchor: "const line = item.line.replace(/^ONBUILD\\s+/i, '');",
    replacement: 'const line = item.line;',
    options: JS,
  },
  {
    id: 'C14',
    subject: 'lib',
    claim: '# escape= is parsed but its character is ignored (#2712)',
    anchor: ') escapeChar = directive[2];',
    replacement: ") escapeChar = '\\\\';",
    options: JS,
  },
  {
    id: 'C15',
    subject: 'lib',
    claim: 'an unusable # escape= value is silently accepted (#2712)',
    anchor: 'else yield { error: trimmed, number: index + 1 };',
    replacement: 'else continue;',
    options: JS,
  },
  {
    id: 'C16',
    subject: 'lib',
    claim: 'a numeric --from is a stage even when no such stage exists (#2712)',
    anchor: 'Number(image) < ctx.count',
    replacement: 'Number(image) < 1e9',
    options: JS,
  },
  {
    id: 'C17',
    subject: 'lib',
    claim: 'a numeric RUN --mount from= is flagged again; only COPY keeps the exception (#2712)',
    anchor: "origin !== 'FROM' && /^\\d+$/",
    replacement: "origin === 'COPY' && /^\\d+$/",
    options: JS,
  },
  {
    id: 'C18',
    subject: 'lib',
    claim: 'stage names match case-sensitively again (#2712)',
    anchor: 'ctx.names.has(image.toLowerCase())',
    replacement: 'ctx.names.has(image)',
    options: JS,
  },
  {
    id: 'C19',
    subject: 'lib',
    claim: 'heredoc bodies are read as instructions again (#2712)',
    anchor: 'for (const delimiter of heredocDelimiters(line)) {',
    replacement: 'for (const delimiter of []) {',
    options: JS,
  },
  {
    id: 'C20',
    subject: 'lib',
    claim: 'an unterminated heredoc passes instead of failing (#2712)',
    anchor: 'if (!closed) yield { error: `<<${delimiter}`, number: start };',
    replacement: 'if (!closed) continue;',
    options: JS,
  },
  {
    id: 'C21',
    subject: 'lib',
    claim: 'an unclosed quote in a flag no longer fails the parse (#2712)',
    anchor: "if (quote !== '') return { flags, ok: false };",
    replacement: "if (quote !== '') return { flags, ok: true };",
    options: JS,
  },
  {
    id: 'C22',
    subject: 'lib',
    claim: 'a bare quote inside an unquoted mount field is accepted instead of failing (#2712)',
    anchor: `if (value[position] === '"') return null;`,
    replacement: 'if (false) return null;',
    options: JS,
  },
  {
    id: 'C23',
    subject: 'lib',
    claim: 'an escape directive is honoured even when it is not at the top of the file (#2712)',
    anchor: 'directives = false;',
    replacement: 'directives = true;',
    options: JS,
  },
  {
    id: 'C24',
    subject: 'lib',
    claim: 'a quoted COPY --from value is no longer unquoted (#2712)',
    anchor: 'classify(unquote(source[1]), file, number, ctx, ',
    replacement: 'classify(source[1], file, number, ctx, ',
    options: JS,
  },
  {
    id: 'C09',
    subject: 'lib',
    claim: 'an exclusion naming a digest also masks every other digest',
    anchor: 'if (entry.digest && entry.digest !== ref.digest) return false;',
    replacement: 'if (false) return false;',
    options: JS,
  },
  {
    id: 'C10',
    subject: 'lib',
    claim: 'a registry-resolution exclusion is accepted without naming a digest',
    anchor: "if (!DIGEST.test(entry.digest ?? '')) {",
    replacement: 'if (false) {',
    options: JS,
  },
  {
    id: 'C11',
    subject: 'lib',
    claim: 'a registry-resolution exclusion is accepted without naming a file',
    anchor: "if (!entry.file) return 'a registry-resolution exclusion needs an exact",
    replacement: "if (false) return 'a registry-resolution exclusion needs an exact",
    options: JS,
  },
  {
    id: 'N03',
    subject: 'verify',
    claim: 'the nightly resolver stops passing the pinned digest to the exclusion match',
    anchor: 'image: pin.ref, digest: pin.digest }',
    replacement: 'image: pin.ref }',
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
