#!/usr/bin/env node
/**
 * Mutation proof for the nested-workflow guard (issue #2659).
 *
 * Guard proved: `tests/no-nested-workflows.test.ts`, which holds
 * `scripts/lib/nested-workflow-scan.mjs` to its spec.
 *
 * Two kinds of row, both needed (a scan that is green because it reads nothing is
 * decoration):
 *   - SCANNER rows: one rule of the scanner is weakened; the fixtures must go red.
 *   - TREE rows: a violation is planted in the REAL tree (a nested workflow, the
 *     exact re-add the issue's acceptance criteria name); the real-tree test
 *     must go red. One NEGATIVE-CONTROL tree row plants an ordinary YAML manifest
 *     and must stay GREEN, so a guard that rejects everything cannot pass as
 *     "killed everything".
 *
 * Discipline (scripts/lib/guard-prover.mjs): every anchor occurs exactly once
 * (else ABORT in the preflight), every verdict is the runner's EXIT CODE, the
 * baseline must be green first, a canary must go red before any green below is
 * trusted, and the tree is checked clean between mutations. Planted files are
 * removed in a `finally`.
 *
 * Exit 0 = every row behaved as required; non-zero otherwise.
 *
 * Usage:
 *   node scripts/mutation-prove-2659-nested-workflows.mjs
 */

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertTreeClean, createGuardProver, gitRun, runSpecExit } from './lib/guard-prover.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = 'tests/no-nested-workflows.test.ts';
const SCAN = 'scripts/lib/nested-workflow-scan.mjs';

const SCANNER_ROWS = [
  {
    id: 'N01',
    subject: 'scan',
    claim: 'the nested .github/workflows directory rule is gone',
    anchor:
      'const nestedDir = NESTED_WORKFLOWS_DIR.test(file) && !file.startsWith(ROOT_WORKFLOWS);',
    replacement: 'const nestedDir = false;',
  },
  {
    id: 'N02',
    subject: 'scan',
    claim: 'no file is ever workflow-shaped',
    anchor: "return keys.has('on') && keys.has('jobs');",
    replacement: 'return false;',
  },
  {
    id: 'N03',
    subject: 'scan',
    claim: 'a trigger alone makes a file workflow-shaped (jobs no longer required)',
    anchor: "return keys.has('on') && keys.has('jobs');",
    replacement: "return keys.has('on');",
  },
  {
    id: 'N04',
    subject: 'scan',
    claim: 'jobs alone makes a file workflow-shaped (trigger no longer required)',
    anchor: "return keys.has('on') && keys.has('jobs');",
    replacement: "return keys.has('jobs');",
  },
  {
    id: 'N05',
    subject: 'scan',
    claim: 'root workflows are no longer exempt (the scan flags the live CI)',
    anchor: 'if (file.startsWith(ROOT_WORKFLOWS)) continue;',
    replacement: 'void 0;',
  },
  {
    id: 'N06',
    subject: 'scan',
    claim: 'agent worktrees (.claude) are walked',
    anchor: "['.git', 'node_modules', '.claude', 'dist', 'target']",
    replacement: "['.git', 'node_modules', 'dist', 'target']",
  },
  {
    id: 'N07',
    subject: 'scan',
    claim: '.git is walked',
    anchor: "['.git', 'node_modules', '.claude', 'dist', 'target']",
    replacement: "['node_modules', '.claude', 'dist', 'target']",
  },
  {
    id: 'N08',
    subject: 'scan',
    claim: 'an exclusion no longer clears its file',
    anchor: 'if (!nestedDir && Object.hasOwn(exclusions, file)) continue;',
    replacement: 'void 0;',
  },
  {
    id: 'N09',
    subject: 'scan',
    claim: 'a stale exclusion (file gone or no longer a workflow) is never reported',
    anchor:
      "if (!present.has(file) || !isWorkflowShaped(readFileSync(join(root, file), 'utf8'))) {",
    replacement: 'if (false) {',
  },
  {
    id: 'N10',
    subject: 'scan',
    claim: 'an exclusion without a reason is accepted',
    anchor: "if (typeof reason !== 'string' || reason.trim() === '') {",
    replacement: 'if (false) {',
  },
  {
    id: 'N11',
    subject: 'scan',
    claim: 'template-suffixed YAML (.yml.example, .tmpl) is no longer scanned',
    anchor: 'const yamlish = YAML_NAME.test(file);',
    replacement: 'const yamlish = /\\.ya?ml$/.test(file);',
  },
  {
    id: 'N12',
    subject: 'scan',
    claim: 'indented keys count as top-level keys',
    anchor: '/^(["\']?[A-Za-z_][\\w-]*["\']?)\\s*:/',
    replacement: '/^\\s*(["\']?[A-Za-z_][\\w-]*["\']?)\\s*:/',
  },
  {
    id: 'N13',
    subject: 'scan',
    claim: 'a quoted "on" key is not recognised as the trigger',
    anchor: "const stripQuotes = (key) => key.replace(/^[\"']|[\"']$/g, '');",
    replacement: 'const stripQuotes = (key) => key;',
  },
  {
    id: 'N14',
    subject: 'scan',
    claim: 'an exclusion is checked before the nested-dir rule (a nested file can be excluded)',
    anchor: 'if (!nestedDir && Object.hasOwn(exclusions, file)) continue;',
    replacement: 'if (Object.hasOwn(exclusions, file)) continue;',
  },
  {
    id: 'N15',
    subject: 'scan',
    claim: 'a nested-dir key in the exclusion list is accepted',
    anchor: 'if (NESTED_WORKFLOWS_DIR.test(file)) {',
    replacement: 'if (false) {',
  },
  {
    id: 'N16',
    subject: 'scan',
    claim: 'a BOM-prefixed on: key is not recognised',
    anchor: "const text = rawText.replace(/^\\uFEFF/, '');",
    replacement: 'const text = rawText;',
  },
  {
    id: 'N17',
    subject: 'scan',
    claim: 'flow-style mappings ({on: push, jobs: ...}) are not recognised',
    anchor: 'if (flow) {',
    replacement: 'if (false) {',
  },
  {
    id: 'N18',
    subject: 'scan',
    claim:
      'untracked working-tree files are scanned (the tracked-file list is no longer the source)',
    anchor: "['ls-files', '-z']",
    replacement: "['ls-files', '-z', '--cached', '--others']",
  },
];

const WORKFLOW = `name: planted
on:
  push:
jobs:
  b:
    runs-on: ubuntu-latest
    steps:
      - run: echo planted
`;

const TREE_ROWS = [
  {
    id: 'T01',
    expect: 'red',
    claim: 'the issue AC: re-adding packages/scale-zero-pg/.github/workflows/ci.yml',
    file: 'packages/scale-zero-pg/.github/workflows/ci.yml',
    body: WORKFLOW,
  },
  {
    id: 'T02',
    expect: 'red',
    claim: 'a nested workflow-shaped YAML at an arbitrary path (not under .github/)',
    file: 'packages/scale-zero-pg/deploy/release.yml',
    body: WORKFLOW,
  },
  {
    id: 'T03',
    expect: 'red',
    claim: 'a nested .github/workflows file that is not even workflow-shaped',
    file: 'apps/docs/.github/workflows/stub.yml',
    body: 'name: stub\n',
  },
  {
    id: 'T04',
    expect: 'green',
    claim: 'NEGATIVE CONTROL: an ordinary k8s manifest is not a workflow',
    file: 'packages/scale-zero-pg/deploy/zz-planted-config.yaml',
    body: 'apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: x\ndata:\n  on: "1"\n',
  },
];

const prover = createGuardProver({ repoRoot: REPO_ROOT, spec: SPEC, subjects: { scan: SCAN } });
const rows = SCANNER_ROWS;

console.log('=== mutation proof: nested-workflow guard (#2659) ===');
prover.preflight(rows);
declareMutations(rows.length + TREE_ROWS.length);

prover.baseline();
prover.proveCanSeeRed({
  subject: 'scan',
  anchor: "return keys.has('on') && keys.has('jobs');",
  replacement: 'return false;',
});
for (const m of rows) {
  prover.run({ ...m, expect: 'red' });
  recordMutation();
}
prover.finish(rows.length);

console.log('\n=== real-tree rows ===');
const failures = [];
for (const t of TREE_ROWS) {
  assertTreeClean(REPO_ROOT, `before ${t.id}`);
  const abs = resolve(REPO_ROOT, t.file);
  let status;
  try {
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, t.body);
    gitRun(REPO_ROOT, ['add', '-f', '--', t.file]);
    status = runSpecExit(REPO_ROOT, SPEC);
  } finally {
    gitRun(REPO_ROOT, ['rm', '-q', '--cached', '-f', '--', t.file]);
    rmSync(abs, { force: true });
    // Remove the directories the plant created, only if they are now empty.
    for (let d = dirname(abs); d !== REPO_ROOT; d = dirname(d)) {
      try {
        rmSync(d, { recursive: false });
      } catch {
        break;
      }
    }
  }
  assertTreeClean(REPO_ROOT, `after ${t.id}`);
  const ok = t.expect === 'red' ? status !== 0 : status === 0;
  if (!ok) failures.push(`${t.id}: expected ${t.expect}, got exit ${status} - ${t.claim}`);
  console.log(
    `   ${t.id} expect=${t.expect} exit=${status} ${ok ? (t.expect === 'red' ? 'KILLED' : 'TOLERATED') : '*** SURVIVED ***'} - ${t.claim}`,
  );
  recordMutation();
}
if (failures.length > 0) {
  console.error(`\n${failures.length} tree row(s) did NOT behave as required:`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log(
  `\n${TREE_ROWS.length} tree row(s) behaved as required; tree restored clean. ALL ROWS OK.`,
);
