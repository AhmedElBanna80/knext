/**
 * The nested-workflow scan (#2659).
 *
 * GitHub Actions loads workflows ONLY from the repository-root
 * `.github/workflows/`. A workflow file anywhere else never runs, yet reads like
 * live CI/CD: five such files lived under `packages/`, one of them the documented
 * gateway release path.
 *
 * What it flags (each a violation, never a pass):
 *   nested-workflow-dir   any file under a `.github/workflows/` directory that is
 *                         not the repository-root one, whatever its content.
 *   workflow-shaped-yaml  any other YAML (or template-suffixed YAML) whose
 *                         top-level keys include both a trigger (`on`) and
 *                         `jobs` - a workflow by shape - anywhere but the root
 *                         `.github/workflows/`.
 *   exclusion-no-reason   an {@link INTENTIONAL_TEMPLATES} entry with no reason.
 *   exclusion-stale       an exclusion whose file is gone, or is no longer
 *                         workflow-shaped: an exclusion list that outlives its
 *                         subject silently widens the hole.
 *
 * Shape is read textually (top-level `on:` / `jobs:` lines), not by parsing the
 * YAML: a file that does not parse (a Helm-style template, say) must still be
 * caught rather than skipped.
 *
 * Scanned: tracked files only (`git ls-files`). Not scanned: `.git`, `node_modules`, `.claude` (agent worktrees hold full
 * copies of the tree, so they would double-report), `dist`, `target`.
 *
 * The test is `tests/no-nested-workflows.test.ts`; the mutation proof is
 * `scripts/mutation-prove-2659-nested-workflows.mjs`.
 */

import { lstatSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gitRun } from './guard-prover.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Workflow-shaped files that are INTENTIONALLY not in the root workflows
 * directory. Key = repo-relative path, value = why it is allowed to stay.
 * Every entry is re-checked on each run (it must exist and still be
 * workflow-shaped), so this cannot silently outlive its file.
 */
export const INTENTIONAL_TEMPLATES = {
  'packages/scale-zero-pg/docs/release/gateway-cd.workflow.yml':
    'Inactive template of the gateway image CD. Activating it publishes to OCIR using a registry credential, which needs an explicit founder decision (secret names differ from the repo secrets; digest-pin workflow is manual today). Kept as a file so activation is a `git mv` into the root workflows directory, not a rewrite.',
};

const SKIP_DIRS = new Set(['.git', 'node_modules', '.claude', 'dist', 'target']);
const YAML_NAME = /\.ya?ml(\.[A-Za-z0-9_-]+)?$|\.(tmpl|tpl|template|example)$/;
const ROOT_WORKFLOWS = '.github/workflows/';
const NESTED_WORKFLOWS_DIR = /(^|\/)\.github\/workflows\//;

const stripQuotes = (key) => key.replace(/^["']|["']$/g, '');

/** True when the text has a top-level trigger key AND a top-level `jobs` key. */
export function isWorkflowShaped(rawText) {
  const text = rawText.replace(/^\uFEFF/, '');
  const keys = new Set();
  // Flow-style document: `{on: push, jobs: {...}}` - keys inside the top-level braces.
  const flow = /^\s*\{([\s\S]*)\}\s*$/.exec(text.replace(/^(\s*#.*\n)+/, ''));
  if (flow) {
    let depth = 0;
    let buf = '';
    const take = () => {
      const k = /^\s*(["']?[A-Za-z_][\w-]*["']?)\s*:/.exec(buf);
      if (k) keys.add(stripQuotes(k[1]));
      buf = '';
    };
    for (const ch of flow[1]) {
      if (ch === '{' || ch === '[') depth++;
      else if (ch === '}' || ch === ']') depth--;
      if (ch === ',' && depth === 0) take();
      else buf += ch;
    }
    take();
  }
  for (const line of text.split('\n')) {
    // A top-level key starts in column 0; comments, list items and indented data do not.
    const m = /^(["']?[A-Za-z_][\w-]*["']?)\s*:/.exec(line);
    if (m) keys.add(stripQuotes(m[1]));
  }
  return keys.has('on') && keys.has('jobs');
}

/** Tracked regular files; symlinks and deleted paths are skipped. */
function trackedFiles(root) {
  const out = gitRun(root, ['ls-files', '-z'], { maxBuffer: 256 * 1024 * 1024 });
  const files = [];
  for (const file of out.split('\0')) {
    if (!file || file.split('/').some((seg) => SKIP_DIRS.has(seg))) continue;
    try {
      if (lstatSync(join(root, file)).isFile()) files.push(file);
    } catch {
      // tracked but deleted in the working tree
    }
  }
  return files;
}

/**
 * @param {string} [root]
 * @param {{exclusions?: Record<string, string>}} [opts]
 * @returns {{violations: Array<{file: string, rule: string, detail: string}>, scanned: number}}
 */
export function scanForNestedWorkflows(root = REPO_ROOT, opts = {}) {
  const exclusions = opts.exclusions ?? INTENTIONAL_TEMPLATES;
  const files = trackedFiles(root);
  const violations = [];
  let scanned = 0;

  for (const file of files) {
    const nestedDir = NESTED_WORKFLOWS_DIR.test(file) && !file.startsWith(ROOT_WORKFLOWS);
    const yamlish = YAML_NAME.test(file);
    if (!nestedDir && !yamlish) continue;
    scanned++;
    if (file.startsWith(ROOT_WORKFLOWS)) continue;
    // A nested .github/workflows file can NEVER be excluded: it is dead text whatever
    // the list says. Only workflow-shaped YAML elsewhere may be a justified template.
    if (!nestedDir && Object.hasOwn(exclusions, file)) continue;
    if (nestedDir) {
      violations.push({
        file,
        rule: 'nested-workflow-dir',
        detail:
          'GitHub only loads workflows from the root .github/workflows/; this file never runs',
      });
    } else if (isWorkflowShaped(readFileSync(join(root, file), 'utf8'))) {
      violations.push({
        file,
        rule: 'workflow-shaped-yaml',
        detail:
          'workflow-shaped YAML outside the root .github/workflows/; move it there, delete it, or add a justified INTENTIONAL_TEMPLATES entry',
      });
    }
  }

  const present = new Set(files);
  for (const [file, reason] of Object.entries(exclusions)) {
    if (NESTED_WORKFLOWS_DIR.test(file)) {
      violations.push({
        file,
        rule: 'exclusion-nested',
        detail: 'a nested .github/workflows file cannot be an intentional template',
      });
    }
    if (typeof reason !== 'string' || reason.trim() === '') {
      violations.push({
        file,
        rule: 'exclusion-no-reason',
        detail: 'an exclusion must say why it is allowed to stay',
      });
    }
    if (!present.has(file) || !isWorkflowShaped(readFileSync(join(root, file), 'utf8'))) {
      violations.push({
        file,
        rule: 'exclusion-stale',
        detail: 'the excluded file is missing or no longer workflow-shaped; drop the entry',
      });
    }
  }
  return { violations, scanned };
}
