#!/usr/bin/env node
/**
 * Mutation proof for #2106's (baseline tracking: #2650) Docker Hub mirror guard
 * (`scripts/docker-hub-mirror-guard.mjs`, `tests/docker-hub-mirror-guard.test.ts`).
 *
 * Same shared harness/discipline as the other provers: `mutate` asserts the anchor
 * occurs exactly once and aborts otherwise; every mutation is scored by the spec's
 * EXIT CODE (never grepped output); each is restored before the next.
 *
 * Usage: node scripts/mutation-prove-docker-hub-mirror-guard.mjs
 */

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSpecRunner } from './lib/ci-blocking-gate-proof.mjs';
import { mutate, restore, snapshot } from './lib/mutation-harness.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const SPEC = 'tests/docker-hub-mirror-guard.test.ts';

const PROOF = {
  subjects: {
    guard: 'scripts/docker-hub-mirror-guard.mjs',
    ci: '.github/workflows/ci.yml',
    action: '.github/actions/docker-hub-mirror/action.yml',
    bunBase: '.github/workflows/bun-base-build.yml',
  },
};

const RUNNER = resolveSpecRunner(REPO_ROOT);

function specPasses() {
  const r = spawnSync(RUNNER.command, [...RUNNER.args, ...RUNNER.runArgs(SPEC)], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return r.status === 0;
}

const MUTATIONS = [
  {
    label: 'scanner: a pulling job with no mirror step is no longer a violation',
    subject: 'guard',
    anchor: '      if (mirrored < 0 || mirrored > first) {',
    replacement: '      if (false) {',
  },
  {
    label: 'scanner: a mirror step AFTER the first pull is accepted',
    subject: 'guard',
    anchor: '      if (mirrored < 0 || mirrored > first) {',
    replacement: '      if (mirrored < 0) {',
  },
  {
    label: 'scanner: jobs are never considered pulling',
    subject: 'guard',
    anchor: '      if (first < 0) continue;',
    replacement: '      continue;',
  },
  {
    label: 'scanner: a script that itself pulls is not followed',
    subject: 'guard',
    anchor: "    if (existsSync(p) && PULLING_SCRIPT.test(readFileSync(p, 'utf8'))) return true;",
    replacement: '    if (false) return true;',
  },
  {
    label: 'scanner: services/container images are never judged (any Docker Hub ref passes)',
    subject: 'guard',
    anchor:
      "  if (typeof ref !== 'string') return true; // expression-only refs are judged by the author",
    replacement: '  return true;',
  },
  {
    label: 'scanner: setup-buildx without a buildkitd config is accepted',
    subject: 'guard',
    anchor:
      "        if (!w['buildkitd-config'] && !w['buildkitd-config-inline'] && w.driver !== 'docker') {",
    replacement: '        if (false) {',
  },
  {
    label: 'real workflow: a services image reverts to an anonymous Docker Hub ref',
    subject: 'ci',
    anchor: 'image: mirror.gcr.io/library/postgres:16@',
    replacement: 'image: postgres:16@',
  },
  {
    label: 'scanner: a mirrored ref no longer needs its digest',
    subject: 'guard',
    anchor: '  if (ref.startsWith(`${MIRROR_HOST}/`)) return /@sha256:[0-9a-f]{64}$/.test(ref);',
    replacement: '  if (ref.startsWith(`${MIRROR_HOST}/`)) return true;',
  },
  {
    label: 'scanner: a mirrored ref inside a run step no longer needs its pin',
    subject: 'guard',
    anchor: '          if (!/@sha256:[0-9a-f]{64}$/.test(m[0])) {',
    replacement: '          if (false) {',
  },
  {
    label: 'composite action: the daemon registry-mirrors setting is dropped',
    subject: 'action',
    anchor: '{"registry-mirrors": ["https://mirror.gcr.io"]}',
    replacement: '{"x": ["https://mirror.gcr.io"]}',
  },
  {
    label: '#2650 baseline: an ADDED pull in a deferred file is no longer drift',
    subject: 'guard',
    anchor: '    const added = multisetMinus(actual, want);',
    replacement: '    const added = [];',
  },
  {
    label: '#2650 baseline: a REMOVED (stale) baseline pull is no longer drift',
    subject: 'guard',
    anchor: '    const removed = multisetMinus(want, actual);',
    replacement: '    const removed = [];',
  },
  {
    label: '#2650 baseline: pull counting ignores multiplicity (set membership only)',
    subject: 'guard',
    anchor: '  return out.sort();\n}\n\n/** Multiset difference a - b. */',
    replacement: '  return [...new Set(out)].sort();\n}\n\n/** Multiset difference a - b. */',
  },
  {
    label: '#2650 real file: a new docker run alpine appears in a deferred file',
    subject: 'bunBase',
    anchor: 'docker run --rm -v "$PWD/out:/w:ro"',
    replacement: 'docker run alpine true; docker run --rm -v "$PWD/out:/w:ro"',
  },
  {
    label: '#2650 real file: the deferred pull is removed (stale baseline)',
    subject: 'bunBase',
    anchor: 'docker run --rm -v "$PWD/out:/w:ro"',
    replacement: 'echo --rm -v "$PWD/out:/w:ro"',
  },
  {
    label: '#2650 baseline: the image token is dropped from an entry (verb only)',
    subject: 'guard',
    anchor: "out.push(`${p}: ${line.slice(m.index).replace(/\\s+/g, ' ').trim()}`);",
    replacement: "out.push(`${p}: ${m[0].replace(/\\s+/g, ' ')}`);",
  },
  {
    label: '#2650 coverage: `docker create` is no longer a pull',
    subject: 'guard',
    anchor: '(?:build|buildx|pull|run|create|compose|load)',
    replacement: '(?:build|buildx|pull|run|compose|load)',
  },
  {
    label: '#2650 coverage: `docker image|container <verb>` long forms are no longer pulls',
    subject: 'guard',
    anchor: '\\s+(?:(?:image|container)\\s+)?(?:build|',
    replacement: '\\s+(?:build|',
  },
  {
    label: '#2650 coverage: `uses: docker://` is no longer a pull',
    subject: 'guard',
    anchor: '|\\\\buses:\\\\s*[\'"]?docker://`,',
    replacement: '`,',
  },
  {
    label: '#2650 coverage: workflow services: images are no longer tracked',
    subject: 'guard',
    anchor:
      'if (/\\.ya?ml$/.test(rel)) for (const c of containerImages(rawWf)) out.push(`${rel}: ${c}`);',
    replacement: '',
  },
  {
    label: '#2650 coverage: workflow container: images are no longer tracked',
    subject: 'guard',
    anchor: '    if (job.container) {',
    replacement: '    if (false) {',
  },
  {
    label: '#2650 transitive: scripts referenced by a followed script are not followed',
    subject: 'guard',
    anchor: '      queue.push(p);',
    replacement: '',
  },
  {
    label: '#2650 fail closed: a referenced script that is missing is skipped, not an error',
    subject: 'guard',
    anchor: '      if (!existsSync(abs)) {',
    replacement: '      if (!existsSync(abs)) continue;\n      if (false) {',
  },
  {
    label: '#2650 entries: shell line continuations are not joined (image on the next line lost)',
    subject: 'guard',
    anchor: "text.replace(/\\\\\\n\\s*/g, ' ')",
    replacement: 'text',
  },
  {
    label: '#2650 refs: a .json under scripts/ is mistaken for a .js script reference',
    subject: 'guard',
    anchor:
      'const ANY_SCRIPT_REF = /(?:^|[^\\w.-])((?:\\.\\/)?scripts\\/[\\w./-]+\\.(?:sh|mjs|js|ts)(?![\\w]))/g;',
    replacement:
      'const ANY_SCRIPT_REF = /(?:^|[^\\w.-])((?:\\.\\/)?scripts\\/[\\w./-]+\\.(?:sh|mjs|js|ts))/g;',
  },
  {
    label: '#2650 refs: JS block-comment lines are scanned as code (false script refs)',
    subject: 'guard',
    anchor: '(?:#|\\/\\/|\\*|\\/\\*)',
    replacement: '(?:#)',
  },
  {
    label: '#2650 real file: a stale closed-tracker TODO returns to a workflow under .github/',
    subject: 'bunBase',
    anchor: 'TODO(#2650): the smoke-test',
    replacement: `TODO(#${2100 + 6}): the smoke-test`,
  },
];

declareMutations(MUTATIONS.length);

console.log('Baseline: the spec must be GREEN before anything is mutated.');
if (!specPasses()) {
  console.error('FATAL: baseline is not green to begin with');
  process.exit(1);
}
console.log('   ok baseline green\n');

const decorative = [];
for (const m of MUTATIONS) {
  console.log(`── mutation: ${m.label}`);
  const snap = snapshot(resolve(REPO_ROOT, PROOF.subjects[m.subject]));
  try {
    mutate(snap, m.anchor, m.replacement);
    if (specPasses()) {
      console.log('   x DECORATION: the spec stayed GREEN with the behaviour removed');
      decorative.push(m.label);
    } else {
      console.log('   ok went RED as required');
    }
    recordMutation();
  } finally {
    restore(snap);
  }
  if (!specPasses()) {
    console.error(`   FATAL: ${SPEC} did not go green again after restore`);
    process.exit(1);
  }
}

console.log(
  `\n${MUTATIONS.length - decorative.length} caught, ${decorative.length} decorative, of ${MUTATIONS.length}.`,
);
if (decorative.length > 0) {
  for (const label of decorative) console.error(`DECORATIVE: ${label}`);
  process.exit(1);
}
