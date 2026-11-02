#!/usr/bin/env node
/**
 * Mutation proof for the image half of the R8 supply-chain guard (#2044):
 * operator tags (Trivy, cosign, SBOM, any branch) and function template images
 * (SBOM, cosign).
 *
 * `.claude/rules/workflow.md`: "a guard that stays green when its subject is
 * removed is decoration." Each row removes one thing the guard protects, in the
 * real workflows or in the guard's own engine, and REQUIRES
 * `tests/image-supply-chain.test.ts` to go red. The shared driver
 * (`scripts/lib/guard-prover.mjs`) owns the discipline: verdicts by EXIT CODE
 * only, baseline green first, a canary that must go red, anchors that must occur
 * exactly once (else abort), byte-exact restore.
 *
 * The template `cosign` rows are the stale-gap direction: today the template
 * workflows have a NAMED known gap (no cosign), so ADDING a cosign step must red
 * the guard until the known-gap entry is deleted.
 *
 * Usage: node scripts/mutation-prove-2044-image-supply-chain.mjs
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGuardProver } from './lib/guard-prover.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = 'tests/image-supply-chain.test.ts';

const COSIGN_STEP = (title) =>
  `      - name: cosign mutant\n        run: cosign sign --yes "$IMG@$DIGEST"\n\n      - name: ${title}`;

const MUTATIONS = [
  // ── operator workflow ────────────────────────────────────────────────────
  {
    id: 'O1',
    subject: 'operator',
    claim: 'the operator tag lane loses its Trivy scan',
    anchor: 'uses: aquasecurity/trivy-action@',
    replacement: 'uses: aquasecurity/trivy-actio@',
  },
  {
    id: 'O2',
    subject: 'operator',
    claim: 'the operator Trivy scan stops failing the build (exit-code 0)',
    anchor: '          exit-code: "1"',
    replacement: '          exit-code: "0"',
  },
  {
    id: 'O3',
    subject: 'operator',
    claim: 'the operator tag lane loses its SBOM step',
    anchor: 'uses: anchore/sbom-action@',
    replacement: 'uses: anchore/sbom-actio@',
  },
  {
    id: 'O4',
    subject: 'operator',
    claim: 'the signing/publish job stops waiting for the Trivy + SBOM job',
    anchor: '    needs: [operator-image-supply-chain]',
    replacement: '    needs: []',
  },
  {
    id: 'O5',
    subject: 'operator',
    claim: 'a path filter lands on the push trigger (a tag from some branch could be skipped)',
    anchor: '    branches: [main]\n    tags:',
    replacement: "    branches: [main]\n    paths: ['packages/**']\n    tags:",
  },
  {
    id: 'O6',
    subject: 'operator',
    claim: 'the signing job is confined to main (operator tags from other branches unsigned)',
    anchor: "      (github.event_name == 'push' || github.event_name == 'workflow_dispatch') &&",
    replacement: "      github.ref == 'refs/heads/main' &&",
  },
  // ── function templates ───────────────────────────────────────────────────
  {
    id: 'T1',
    subject: 'gotpl',
    claim: 'the Go template image loses its SBOM step',
    anchor: 'uses: anchore/sbom-action@',
    replacement: 'uses: anchore/sbom-actio@',
  },
  {
    id: 'T2',
    subject: 'rusttpl',
    claim: 'the Rust template image loses its SBOM step',
    anchor: 'uses: anchore/sbom-action@',
    replacement: 'uses: anchore/sbom-actio@',
  },
  {
    id: 'T3',
    subject: 'gotpl',
    claim: 'the Go template image job stops building templates/go (the scan finds no image)',
    anchor: 'run: docker build -t "${IMAGE}:${GITHUB_SHA}" templates/go',
    replacement: 'run: docker build -t "${IMAGE}:${GITHUB_SHA}" templates/gx',
  },
  {
    id: 'T4',
    subject: 'gotpl',
    claim: 'cosign lands on the Go template: the known gap goes STALE and must be deleted',
    anchor: '      - name: Trivy scan — FAIL on HIGH/CRITICAL',
    replacement: COSIGN_STEP('Trivy scan — FAIL on HIGH/CRITICAL'),
  },
  {
    id: 'T5',
    subject: 'rusttpl',
    claim: 'cosign lands on the Rust template: the known gap goes STALE and must be deleted',
    anchor: '      - name: Trivy scan — FAIL on HIGH/CRITICAL',
    replacement: COSIGN_STEP('Trivy scan — FAIL on HIGH/CRITICAL'),
  },
  // ── the guard's own engine ───────────────────────────────────────────────
  {
    id: 'E1',
    subject: 'engine',
    claim: 'the cosign matcher stops recognising `cosign sign`/`attest`',
    anchor: 'export const isCosign = (s: Step) => /\\bcosign\\s+(sign|attest)\\b/.test(code(s));',
    replacement: 'export const isCosign = (s: Step) => /\\bcosign\\s+(nothing)\\b/.test(code(s));',
  },
  {
    id: 'E2',
    subject: 'engine',
    claim: 'Trivy enforcement accepts any exit-code',
    anchor: "return String(withOf(s)['exit-code']) === '1';",
    replacement: "return String(withOf(s)['exit-code']) !== 'undefined';",
  },
  {
    id: 'E3',
    subject: 'engine',
    claim: 'the branch-only condition check never fires',
    anchor: "if (typeof cond !== 'string') return false;",
    replacement: 'return false;',
  },
  {
    id: 'E4',
    subject: 'engine',
    claim: 'the upstream ordering walk is cut (cosign ordering no longer checked)',
    anchor: '? needsOf(jobs[cur] ?? {})',
    replacement: '? []',
  },
  {
    id: 'E5',
    subject: 'engine',
    claim: 'the template cosign check is removed',
    anchor: 'if (!steps.some(isCosign))',
    replacement: 'if (false)',
  },
  {
    id: 'E6',
    subject: 'engine',
    claim: 'the template SBOM check is removed',
    anchor: 'if (!steps.some(isSbom))',
    replacement: 'if (false)',
  },
  {
    id: 'E7',
    subject: 'engine',
    claim: 'the "no workflow builds this template" check is removed',
    anchor: 'if (!builders.length) {',
    replacement: 'if (false) {',
  },
  {
    id: 'E8',
    subject: 'engine',
    claim: 'an empty workflow directory stops failing closed',
    anchor: 'if (files.length === 0) throw new Error(`no workflows found in ${dir}`);',
    replacement: 'void 0;',
  },
  {
    id: 'E9',
    subject: 'engine',
    claim: 'a vacuous scan (no operator lane discovered) stops failing',
    anchor: 'if (lanes.length === 0)',
    replacement: 'if (false)',
  },
];

const prover = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: SPEC,
  subjects: {
    operator: '.github/workflows/operator-supply-chain.yml',
    gotpl: '.github/workflows/go-template.yml',
    rusttpl: '.github/workflows/rust-template.yml',
    engine: 'tests/helpers/image-supply-chain.ts',
  },
});

console.log('=== mutation proof: image supply-chain guard (#2044) ===');
prover.preflight(MUTATIONS);
declareMutations(MUTATIONS.length);
prover.baseline();
prover.proveCanSeeRed({
  subject: 'engine',
  anchor: 'export const REPO_ROOT = resolve(import.meta.dirname',
  replacement: 'export const REPO_ROOT = resolve(import.meta.dirnamx',
});
for (const m of MUTATIONS) {
  prover.run({ ...m, expect: 'red' });
  recordMutation();
}
prover.finish(MUTATIONS.length);
