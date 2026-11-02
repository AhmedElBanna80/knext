#!/usr/bin/env node
/**
 * Mutation proof for the image half of the R8 supply-chain guard (#2044): every
 * workflow that publishes an image (found by behaviour, under any trigger) needs
 * an enforcing HIGH+CRITICAL Trivy gate, an SBOM and cosign that cannot be
 * disabled and are tied to the image; function template images need an SBOM and
 * cosign.
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
    claim: 'the publish job is confined to main (operator tags from other branches unpublished)',
    anchor: "      (github.event_name == 'push' || github.event_name == 'workflow_dispatch') &&",
    replacement: "      github.ref == 'refs/heads/main' &&",
  },
  {
    id: 'O7',
    subject: 'operator',
    claim: 'the operator Trivy gate becomes continue-on-error: true',
    anchor: "continue-on-error: ${{ steps.channel.outputs.publish != 'true' }}",
    replacement: 'continue-on-error: true',
  },
  {
    id: 'O8',
    subject: 'operator',
    claim: 'the operator Trivy gate narrows to LOW severity',
    anchor: '          severity: HIGH,CRITICAL',
    replacement: '          severity: LOW',
  },
  {
    id: 'O9',
    subject: 'operator',
    claim: 'the operator pushes a layout Trivy never scanned',
    anchor: 'crane push operator-oci "',
    replacement: 'crane push operator-oci-other "',
  },
  // ── the app image lane (supply-chain.yml), found by behaviour ────────────
  {
    id: 'S1',
    subject: 'app',
    claim: 'the app image Trivy gate becomes continue-on-error: true',
    anchor:
      "while every line stays gated.\n        continue-on-error: ${{ github.ref != 'refs/heads/main' && !startsWith(github.ref, 'refs/heads/integration/') }}",
    replacement: 'while every line stays gated.\n        continue-on-error: true',
  },
  {
    id: 'S2',
    subject: 'app',
    claim: 'the app image Trivy gate narrows to LOW severity',
    anchor: '          input: image-oci\n          severity: HIGH,CRITICAL',
    replacement: '          input: image-oci\n          severity: LOW',
  },
  {
    id: 'S3',
    subject: 'app',
    claim: 'the app image pushes a layout Trivy never scanned',
    anchor: 'crane push image-oci "',
    replacement: 'crane push image-oci-other "',
  },
  {
    id: 'S4',
    subject: 'app',
    claim: 'the app image is signed by mutable tag instead of digest',
    anchor: 'cosign sign --yes "${IMAGE}@${DIGEST}"',
    replacement: 'cosign sign --yes "${IMAGE}:${GITHUB_SHA}"',
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
    claim: 'Trivy exit-code enforcement is not checked',
    anchor: 'if (!enforced) out.push',
    replacement: 'if (false) out.push',
  },
  {
    id: 'E3',
    subject: 'engine',
    claim: 'continue-on-error is never judged',
    anchor: 'if (v !== false) {',
    replacement: 'if (false) {',
  },
  {
    id: 'E4',
    subject: 'engine',
    claim: 'a step `if` is never judged',
    anchor: 'if (evalExpr(step.if, ctx) !== true) {',
    replacement: 'if (false) {',
  },
  {
    id: 'E5',
    subject: 'engine',
    claim: 'the Trivy severity floor is not checked',
    anchor: 'if (sev && !(sev.includes',
    replacement: 'if (false && sev && !(sev.includes',
  },
  {
    id: 'E6',
    subject: 'engine',
    claim: 'the upstream ordering walk is cut (a push job need not wait for the scan)',
    anchor: '? needsOf(jobs[cur] ?? {})',
    replacement: '? []',
  },
  {
    id: 'E7',
    subject: 'engine',
    claim: 'template gate steps are accepted without being judged',
    anchor: 'if (valid.length) continue;',
    replacement: 'continue;',
  },
  {
    id: 'E8',
    subject: 'engine',
    claim: 'the "no workflow builds this template" check is removed',
    anchor: 'if (!builders.length) {',
    replacement: 'if (false) {',
  },
  {
    id: 'E9',
    subject: 'engine',
    claim: 'an empty workflow directory stops failing closed',
    anchor: 'if (files.length === 0) throw new Error(`no workflows found in ${dir}`);',
    replacement: 'void 0;',
  },
  {
    id: 'E10',
    subject: 'engine',
    claim: 'an unresolvable reusable workflow is skipped instead of failing',
    anchor: 'if (!local || !wfs.some((w) => w.file === local[1]))',
    replacement: 'if (false)',
  },
  {
    id: 'E11',
    subject: 'engine',
    claim: 'an unresolvable local action is skipped instead of failing',
    anchor: 'if (inner === null)',
    replacement: 'if (false)',
  },
  {
    id: 'E12',
    subject: 'engine',
    claim: 'run-step pushes (docker/crane/--push) are no longer discovered',
    anchor: 'return PUSH_RUN.test(code(s));',
    replacement: 'return false;',
  },
  {
    id: 'E13',
    subject: 'engine',
    claim: 'build-push-action pushes are no longer discovered',
    anchor: 'if (/^docker\\/build-push-action@/.test(uses(s))) {\n    const w = withOf(s);',
    replacement: 'if (false) {\n    const w = withOf(s);',
  },
  {
    id: 'E14',
    subject: 'engine',
    claim: 'the pushed-layout tie to the Trivy scan is removed',
    anchor: 'if (scanned.length > 0 && !scanned.includes(src) && !derived)',
    replacement: 'if (false)',
  },
  {
    id: 'E15',
    subject: 'engine',
    claim: 'cosign-before-push ordering is not checked',
    anchor: 'if (signAt !== -1 && signAt < pushAt)',
    replacement: 'if (false)',
  },
  {
    id: 'E16',
    subject: 'engine',
    claim: 'the cosign-by-digest tie is removed',
    anchor: 'if (cmds.some(',
    replacement: 'if (false && cmds.some(',
  },
  {
    id: 'E17',
    subject: 'engine',
    claim: 'a stale non-lane allowlist entry stops failing',
    anchor: 'if (!lanes.some((l) => l.wf.file === nl.file && l.id === nl.job))',
    replacement: 'if (false)',
  },
  {
    id: 'E18',
    subject: 'engine',
    claim: 'a vacuous scan (no operator lane discovered) stops failing',
    anchor: 'if (lanes.length === 0)',
    replacement: 'if (false)',
  },
  {
    id: 'E19',
    subject: 'engine',
    claim: 'a disabling job-level `if` is not judged',
    anchor: 'if (evalExpr(job.if, ctx) === false) {',
    replacement: 'if (false) {',
  },
  {
    id: 'E20',
    subject: 'engine',
    claim: 'the operator tag-from-any-branch job check is removed',
    anchor: 'if (tagCtx && evalExpr(job.if ?? true, tagCtx) === false)',
    replacement: 'if (false)',
  },
  {
    id: 'E21',
    subject: 'engine',
    claim: 'the evaluator treats an unknown operand as false (an unprovable gate passes as safe)',
    anchor: 'if (x === UNKNOWN || y === UNKNOWN) return UNKNOWN;\n    return true;',
    replacement: 'if (x === UNKNOWN || y === UNKNOWN) return false;\n    return true;',
  },
];

const prover = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: SPEC,
  subjects: {
    operator: '.github/workflows/operator-supply-chain.yml',
    app: '.github/workflows/supply-chain.yml',
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
