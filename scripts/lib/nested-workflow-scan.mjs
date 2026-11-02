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
 * Not scanned: `.git`, `node_modules`, `.claude` (agent worktrees hold full
 * copies of the tree, so they would double-report), `dist`, `target`.
 *
 * The test is `tests/no-nested-workflows.test.ts`; the mutation proof is
 * `scripts/mutation-prove-2659-nested-workflows.mjs`.
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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
export function isWorkflowShaped(text) {
  const keys = new Set();
  for (const line of text.split('\n')) {
    // A top-level key starts in column 0; comments, list items and indented data do not.
    const m = /^(["']?[A-Za-z_][\w-]*["']?)\s*:/.exec(line);
    if (m) keys.add(stripQuotes(m[1]));
  }
  return keys.has('on') && keys.has('jobs');
}

function walk(root, dir, out) {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const abs = join(dir, name);
    const st = statSync(abs);
    if (st.isDirectory()) walk(root, abs, out);
    else if (st.isFile()) out.push(relative(root, abs).split('\\').join('/'));
  }
}

/**
 * @param {string} [root]
 * @param {{exclusions?: Record<string, string>}} [opts]
 * @returns {{violations: Array<{file: string, rule: string, detail: string}>, scanned: number}}
 */
export function scanForNestedWorkflows(root = REPO_ROOT, opts = {}) {
  const exclusions = opts.exclusions ?? INTENTIONAL_TEMPLATES;
  const files = [];
  walk(root, root, files);
  const violations = [];
  let scanned = 0;

  for (const file of files) {
    const nestedDir = NESTED_WORKFLOWS_DIR.test(file) && !file.startsWith(ROOT_WORKFLOWS);
    const yamlish = YAML_NAME.test(file);
    if (!nestedDir && !yamlish) continue;
    scanned++;
    if (file.startsWith(ROOT_WORKFLOWS)) continue;
    if (Object.hasOwn(exclusions, file)) continue;
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
