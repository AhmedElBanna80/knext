import { afterAll, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  INTENTIONAL_TEMPLATES,
  isWorkflowShaped,
  scanForNestedWorkflows,
} from '../scripts/lib/nested-workflow-scan.mjs';

/**
 * Guard: GitHub Actions loads workflows ONLY from the repository-root
 * `.github/workflows/`. A workflow file anywhere else is dead text that reads
 * like live CI/CD — five such files lived under `packages/` (#2659), one of
 * them the documented gateway release path, and nothing in the repo said
 * they never ran.
 *
 * Two halves, both asserted:
 *   - the scan FLAGS a nested `.github/workflows/*` file, and a workflow-shaped
 *     YAML (top-level `on:` + `jobs:`) at any other path;
 *   - it does NOT flag root workflows, ordinary YAML (a k8s manifest, a file
 *     with `jobs:` but no trigger), or an explicitly justified template.
 * And the real tree must be clean.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..');

const tracked: string[] = [];
afterAll(() => {
  for (const dir of tracked) rmSync(dir, { recursive: true, force: true });
});

const WORKFLOW = `name: x
on:
  push:
    branches: [main]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - run: echo hi
`;

function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'nested-wf-'));
  tracked.push(root);
  for (const [rel, body] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
  }
  execFileSync('git', ['init', '-q'], { cwd: root });
  execFileSync('git', ['add', '-A', '-f'], { cwd: root });
  return root;
}

const paths = (root: string, exclusions = {}) =>
  scanForNestedWorkflows(root, { exclusions }).violations.map((v: { file: string }) => v.file);

describe('isWorkflowShaped', () => {
  it('accepts a top-level on: + jobs: document', () => {
    expect(isWorkflowShaped(WORKFLOW)).toBe(true);
  });
  it('accepts a quoted "on" key', () => {
    expect(isWorkflowShaped('"on": push\njobs:\n  a:\n    runs-on: x\n')).toBe(true);
  });
  it('rejects jobs: with no trigger (not a workflow)', () => {
    expect(isWorkflowShaped('jobs:\n  a: 1\n')).toBe(false);
  });
  it('rejects a trigger with no jobs', () => {
    expect(isWorkflowShaped('on: push\nname: x\n')).toBe(false);
  });
  it('ignores an indented on:/jobs: (nested data, not top-level keys)', () => {
    expect(isWorkflowShaped('data:\n  on: 1\n  jobs: 2\n')).toBe(false);
  });
  it('accepts a BOM-prefixed on: key', () => {
    expect(isWorkflowShaped(`\uFEFFon: push\njobs:\n  a:\n    runs-on: x\n`)).toBe(true);
  });
  it('accepts a flow-style mapping', () => {
    expect(isWorkflowShaped('{on: push, jobs: {a: {runs-on: x}}}\n')).toBe(true);
  });
  it('rejects a flow-style mapping with no trigger', () => {
    expect(isWorkflowShaped('{name: x, jobs: {a: {runs-on: x}}}\n')).toBe(false);
  });
  it('ignores keys that only appear in comments', () => {
    expect(isWorkflowShaped('# on: push\n# jobs:\nkind: ConfigMap\n')).toBe(false);
  });
});

describe('scanForNestedWorkflows: flags', () => {
  it('a nested .github/workflows file, even one that is not workflow-shaped', () => {
    const root = fixture({ 'packages/a/.github/workflows/ci.yml': 'name: stub\n' });
    expect(paths(root)).toEqual(['packages/a/.github/workflows/ci.yml']);
  });
  it('a nested .yaml under .github/workflows', () => {
    const root = fixture({ 'apps/b/.github/workflows/cd.yaml': WORKFLOW });
    expect(paths(root)).toEqual(['apps/b/.github/workflows/cd.yaml']);
  });
  it('a workflow-shaped YAML at an arbitrary path', () => {
    const root = fixture({ 'packages/a/deploy/release.yml': WORKFLOW });
    expect(paths(root)).toEqual(['packages/a/deploy/release.yml']);
  });
  it('a workflow-shaped template suffix (.yml.example)', () => {
    const root = fixture({ 'templates/t/ci.yml.example': WORKFLOW });
    expect(paths(root)).toEqual(['templates/t/ci.yml.example']);
  });
  it('a workflow-shaped file named .yml under a root .github/ outside workflows/', () => {
    const root = fixture({ '.github/scripts/ci.yml': WORKFLOW });
    expect(paths(root)).toEqual(['.github/scripts/ci.yml']);
  });
});

describe('scanForNestedWorkflows: does not flag', () => {
  it('root .github/workflows files', () => {
    const root = fixture({ '.github/workflows/ci.yml': WORKFLOW });
    expect(paths(root)).toEqual([]);
  });
  it('an ordinary k8s manifest and a jobs-only config', () => {
    const root = fixture({
      'deploy/10-app.yaml': 'apiVersion: v1\nkind: ConfigMap\ndata:\n  on: "1"\n',
      'config/jobs.yml': 'jobs:\n  - nightly\n',
    });
    expect(paths(root)).toEqual([]);
  });
  it('anything under node_modules, .git or .claude (not tracked source)', () => {
    const root = fixture({
      'node_modules/x/.github/workflows/ci.yml': WORKFLOW,
      '.git/hooks/w.yml': WORKFLOW,
      '.claude/worktrees/a/packages/p/.github/workflows/ci.yml': WORKFLOW,
    });
    expect(paths(root)).toEqual([]);
  });
});

describe('scanForNestedWorkflows: exclusion list', () => {
  const rel = 'packages/a/docs/release/cd.workflow.yml';
  it('honours an exclusion that carries a reason', () => {
    const root = fixture({ [rel]: WORKFLOW });
    expect(paths(root, { [rel]: 'inactive template awaiting a decision' })).toEqual([]);
  });
  it('the same file WITHOUT the exclusion is flagged (the exclusion is what clears it)', () => {
    const root = fixture({ [rel]: WORKFLOW });
    expect(paths(root)).toEqual([rel]);
  });
  it('fails on an exclusion with an empty reason', () => {
    const root = fixture({ [rel]: WORKFLOW });
    const res = scanForNestedWorkflows(root, { exclusions: { [rel]: '  ' } });
    expect(res.violations.map((v: { rule: string }) => v.rule)).toContain('exclusion-no-reason');
  });
  it('fails on a stale exclusion whose file no longer exists', () => {
    const root = fixture({ 'x.txt': '' });
    const res = scanForNestedWorkflows(root, { exclusions: { [rel]: 'was a template' } });
    expect(res.violations.map((v: { rule: string }) => v.rule)).toContain('exclusion-stale');
  });
  it('fails on an exclusion whose file is no longer workflow-shaped', () => {
    const root = fixture({ [rel]: 'kind: ConfigMap\n' });
    const res = scanForNestedWorkflows(root, { exclusions: { [rel]: 'was a template' } });
    expect(res.violations.map((v: { rule: string }) => v.rule)).toContain('exclusion-stale');
  });
});

describe('scanForNestedWorkflows: nested dir can never be excluded', () => {
  const nested = 'packages/a/.github/workflows/cd.yml';
  it('flags a nested workflow even when listed in exclusions', () => {
    const root = fixture({ [nested]: WORKFLOW });
    const res = scanForNestedWorkflows(root, { exclusions: { [nested]: 'pretend it is fine' } });
    const rules = res.violations.map((v: { rule: string }) => v.rule);
    expect(rules).toContain('nested-workflow-dir');
    expect(rules).toContain('exclusion-nested');
  });
  it('flags a BOM-prefixed workflow-shaped file', () => {
    const root = fixture({ 'a/ci.yml': `\uFEFFon: push\njobs:\n  a:\n    runs-on: x\n` });
    expect(paths(root)).toEqual(['a/ci.yml']);
  });
  it('ignores untracked files (only tracked files are scanned)', () => {
    const root = fixture({ 'x.txt': '' });
    mkdirSync(join(root, 'p'), { recursive: true });
    writeFileSync(join(root, 'p/untracked.yml'), WORKFLOW);
    expect(paths(root)).toEqual([]);
  });
});

describe('the real repository tree', () => {
  it('has no workflow outside the root .github/workflows (modulo the justified list)', () => {
    const res = scanForNestedWorkflows(REPO_ROOT);
    expect(res.violations).toEqual([]);
  });
  it('every intentional template is justified with a real reason', () => {
    for (const [file, reason] of Object.entries(INTENTIONAL_TEMPLATES)) {
      expect(reason.trim().length).toBeGreaterThan(20);
      expect(file.startsWith('.github/workflows/')).toBe(false);
    }
  });
  it('the scan really reads the tree (the root workflows exist and are not flagged)', () => {
    const res = scanForNestedWorkflows(REPO_ROOT);
    expect(res.scanned).toBeGreaterThan(50);
  });
});
