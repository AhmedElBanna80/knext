/**
 * Credential-bearing workflows and the files they name. A PR fires the
 * supply-chain trigger when it changes such a workflow, or a file one names
 * directly: a script, a Makefile it runs, or a local action (all of its files).
 *
 * Deliberately one level deep. What those files import or spawn in turn is not
 * followed: the transitive analysis this replaced grew to thousands of lines and
 * still needed a reviewed allowlist to stop firing on every PR, while the real
 * supply-chain controls (pinned actions, npm audit, SBOM, cosign, secret scan)
 * are separate gates. This trigger asks a PR to acknowledge the obvious edits.
 */

import { posix } from 'node:path';
import { finding } from './catalogue.mjs';

export const WORKFLOW = /^\.github\/workflows\/[^/]+\.ya?ml$/;

/**
 * Secrets that do NOT make a workflow credential-bearing for this check:
 *   - GITHUB_TOKEN: per-run and repo-scoped; its scope is the `permissions:` block;
 *   - CODECOV_TOKEN: an upload-only coverage token in `ci.yml`. Counting it would
 *     make every `ci.yml` edit fire.
 */
export const LOW_PRIVILEGE_SECRETS = new Set(['GITHUB_TOKEN', 'CODECOV_TOKEN']);

/**
 * Does this workflow put a credential in scope? Read as text, so no YAML shape can
 * hide it: any other `secrets.<NAME>`, a `secrets[...]` index (name unknowable),
 * `toJSON(secrets)`, `id-token: write`, `permissions: write-all`, or a
 * `packages`/`contents`/`attestations: write` grant.
 */
export function workflowHoldsCredential(text) {
  if (/id-token\s*:\s*['"]?write/.test(text)) return true;
  if (/permissions\s*:\s*['"]?write-all/.test(text)) return true;
  if (/(?:^|[\s{,])(?:packages|contents|attestations)\s*:\s*['"]?write\b/m.test(text)) return true;
  if (/toJSON\s*\(\s*secrets\s*\)/i.test(text)) return true;
  if (/secrets\s*\[/.test(text)) return true;
  for (const m of text.matchAll(/secrets\.([A-Za-z0-9_-]+)/g)) {
    if (!LOW_PRIVILEGE_SECRETS.has(m[1])) return true;
  }
  return false;
}

/**
 * Repo paths a workflow mentions under `scripts/` or `.github/actions/`. Comment
 * mentions count too (conservative): `namedFiles` passes the text with comments.
 * Trailing prose punctuation is stripped.
 */
export function referencedPaths(text) {
  const out = [];
  for (const m of text.matchAll(
    /(?:^|[^A-Za-z0-9_./-])(?:\.\/)?((?:scripts|\.github\/actions)\/[A-Za-z0-9_./-]+)/g,
  )) {
    const p = m[1].replace(/[.,;:]+$/, '');
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

/** Prefixes that stand for the checkout root. */
const WORKSPACE_PREFIX = /\$\{\{\s*github\.workspace\s*\}\}\/|\$\{?GITHUB_WORKSPACE\}?\//g;

/** Prefixes that stand for the running local action's own directory. */
const ACTION_PATH_PREFIX = /\$\{\{\s*github\.action_path\s*\}\}\/|\$\{?GITHUB_ACTION_PATH\}?\//g;

/**
 * The text every rule reads: the checkout-root prefix stripped, so the path after
 * it reads as repo-relative; the action-path prefix replaced by `actionDir/` (in a
 * local action's `action.yml`), or stripped where there is no action; and (unless
 * `comments`) full-line YAML / shell comments removed. A trailing ` # ...` stays:
 * it cannot be told apart from a `#` inside a string.
 */
export function prepare(text, { comments = false, actionDir = '' } = {}) {
  const body = comments
    ? text
    : text
        .split('\n')
        .map((l) => (/^\s*#/.test(l) ? '' : l))
        .join('\n');
  return body
    .replace(WORKSPACE_PREFIX, '')
    .replace(ACTION_PATH_PREFIX, actionDir ? `${actionDir}/` : '');
}

/** A script file name: what a bare token (no directory) must look like to count. */
const SCRIPT_FILE = /\.(?:sh|bash|mjs|cjs|js|ts|py)$/;

/**
 * Path tokens: `dir/file` anywhere (a dot-directory such as `.github/scripts/x.sh`
 * included), or a bare script name (`release.sh`). Kept only when they exist, so
 * prose and build outputs drop out.
 */
function pathTokens(text) {
  const out = [];
  for (const m of text.matchAll(
    /(?:^|[\s'"=(`&;|])(?:\.\/)?(\.?[A-Za-z0-9_][\w.-]*(?:\/[\w.-]+)*)/g,
  )) {
    const p = m[1].replace(/[.,;:]+$/, '');
    if ((p.includes('/') || SCRIPT_FILE.test(p)) && !out.includes(p)) out.push(p);
  }
  return out;
}

/** The directories a relative path may be resolved from: the root, every `working-directory:` and literal `cd` target. */
function bases(text) {
  const out = ['.'];
  for (const m of text.matchAll(/working-directory\s*:\s*['"]?([^\s'"#]+)/g)) out.push(m[1]);
  for (const m of text.matchAll(/(?:^|[\s;&|(])cd\s+['"]?([\w./-]+)/gm)) out.push(m[1]);
  return [...new Set(out.map((d) => posix.normalize(d.replace(/^['"]|['"]$/g, ''))))];
}

const at = (base, p) => (base === '.' ? posix.normalize(p) : posix.normalize(`${base}/${p}`));

/**
 * The Makefiles a `make` command runs: `-C dir` / `--directory=dir`, else every
 * base (which step a `make` is in is not worked out; any of them may be the one).
 * GNU make's lookup order: GNUmakefile, makefile, Makefile.
 */
function makefiles(text) {
  const out = [];
  const add = (dir) => {
    for (const name of ['GNUmakefile', 'makefile', 'Makefile']) {
      const p = at(dir, name);
      if (!out.includes(p)) out.push(p);
    }
  };
  for (const m of text.matchAll(/(?:^|[\s;&|(])make(?![\w.-])([^\n;&|]*)/gm)) {
    const dir = /(?:^|\s)-C\s*(\S+)/.exec(m[1])?.[1] ?? /(?:^|\s)--directory=(\S+)/.exec(m[1])?.[1];
    if (dir !== undefined) add(posix.normalize(dir.replace(/^['"]|['"]$/g, '')));
    else for (const d of bases(text)) add(d);
  }
  return out;
}

/**
 * The files a workflow (or a local action's `action.yml` / `action.yaml`) names
 * directly. `read(p)` returns a file's text, or null when it is absent.
 *   - A `scripts/` or `.github/actions/` mention counts whether or not the file
 *     exists (deleting a script a release workflow runs is supply chain too),
 *     comments included. When it is a DIRECTORY (`working-directory:
 *     scripts/release`, a local action) every file under it counts, and a `dir/`
 *     entry makes a file added there count too.
 *   - Any other path token (a `dir/file`, or a bare script name), resolved against
 *     every base, counts only when it exists, comments excluded. A directory named
 *     elsewhere (an app build context) does not cover its files.
 *   - A Makefile a `make` command runs counts when it exists.
 * A local action's `action.yml` is read the same way once (not recursively).
 */
export function namedFiles(text, read, listUnder) {
  const out = new Set();
  const expandDir = (p, depth) => {
    const dir = posix.normalize(p.replace(/^\.\//, '').replace(/\/$/, ''));
    const files = listUnder(`${dir}/`);
    // A local action: under .github/actions/, or any directory a `uses: ./dir`
    // names that holds an action.yml / action.yaml.
    const action =
      /^\.github\/actions\/[^/]+$/.test(dir) ||
      read(`${dir}/action.yml`) !== null ||
      read(`${dir}/action.yaml`) !== null;
    if (files.length === 0 && !action) return false;
    out.add(`${dir}/`);
    for (const f of files) out.add(f);
    if (action && depth === 0) {
      for (const name of ['action.yml', 'action.yaml']) {
        const body = read(`${dir}/${name}`);
        if (body !== null) scan(body, depth + 1, dir);
      }
    }
    return true;
  };
  const scan = (body, depth, actionDir = '') => {
    const code = prepare(body, { actionDir });
    for (const p of referencedPaths(prepare(body, { comments: true, actionDir }))) {
      if (!expandDir(p, depth)) out.add(p);
    }
    // `uses: ./dir` is a local action wherever it lives, when the directory holds one.
    for (const m of code.matchAll(/\buses\s*:\s*['"]?\.\/([\w./-]+?)\/?['"]?\s*$/gm)) {
      const d = posix.normalize(m[1]);
      if (read(`${d}/action.yml`) !== null || read(`${d}/action.yaml`) !== null)
        expandDir(d, depth);
    }
    const dirs = bases(code);
    for (const t of pathTokens(code)) {
      for (const p of dirs.map((d) => at(d, t))) if (read(p) !== null) out.add(p);
    }
    for (const p of makefiles(code)) if (read(p) !== null) out.add(p);
  };
  scan(text, 0);
  return out;
}

/**
 * What a package install reads to decide the dependency set, per manager. The
 * `package.json` beside it is checked separately: only its dependency keys count.
 */
export const INSTALL_INPUTS = Object.freeze({
  bun: ['bun.lock', 'bun.lockb', 'bunfig.toml', '.npmrc'],
  npm: ['package-lock.json', 'npm-shrinkwrap.json', '.npmrc'],
  pnpm: ['pnpm-lock.yaml', 'pnpm-workspace.yaml', '.npmrc'],
  yarn: ['yarn.lock', '.yarnrc.yml', '.yarnrc'],
});

/**
 * A package install command, by manager: the verb follows the manager, or its
 * `-flag` options (each with an optional value), on the same line
 * (`npm --prefix x ci`, `pnpm -r install`, `bun install`, `yarn add`). `npm run ci`
 * is not one: `run` is not a flag.
 */
const INSTALL =
  /(?:^|[\s;&|(])(bun|npm|pnpm|yarn)(?:[ \t]+-[^\s;&|]+(?:[ \t]+[^\s;&|-][^\s;&|]*)?)*[ \t]+(?:install|i|ci|add)(?![\w-])/gm;

/** The managers a workflow runs an install with. */
export function installManagers(text) {
  return [...new Set([...prepare(text).matchAll(INSTALL)].map((m) => m[1]))];
}

/** Where an install may run: the root and every `working-directory:` / `cd` target. */
export function installDirs(text) {
  return bases(prepare(text));
}

/** The `package.json` keys that decide what an install fetches and runs. */
export const DEPENDENCY_KEYS = [
  'dependencies',
  'devDependencies',
  'optionalDependencies',
  'peerDependencies',
  'overrides',
  'resolutions',
  'workspaces',
  'trustedDependencies',
  'packageManager',
];

/** Did the dependency keys of a manifest change? An unparseable side counts as a change. */
export function dependenciesChanged(beforeText, afterText) {
  const pick = (t) => {
    if (t === null) return 'null';
    try {
      const o = JSON.parse(t);
      return JSON.stringify(Object.fromEntries(DEPENDENCY_KEYS.map((k) => [k, o?.[k] ?? null])));
    } catch {
      return Symbol('unparseable');
    }
  };
  return pick(beforeText) !== pick(afterText);
}

/**
 * The `supply-chain` finding from content: a changed credential-bearing workflow
 * (on either side), or a changed file a credential-bearing workflow names. A
 * workflow that runs a package install also names that manager's lockfile and
 * config, and the `package.json` when its dependency keys change, at the root and
 * in every `working-directory:` / `cd` target: an install script runs with the
 * workflow's credentials in scope.
 */
export function credentialWorkflowFindings(changes, repo) {
  const read = (p) => repo.show('head', p) ?? repo.show('base', p);
  const named = new Set();
  const manifests = new Set(); // the package.json files an install reads
  for (const wf of repo.listHead('.github/workflows/').filter((p) => WORKFLOW.test(p))) {
    const text = repo.show('head', wf);
    if (text === null || !workflowHoldsCredential(text)) continue;
    for (const p of namedFiles(text, read, (prefix) => repo.listHead(prefix))) named.add(p);
    // Installs in the workflow and in every local action it uses.
    const actionYmls = [...named]
      .filter((n) => n.endsWith('/'))
      .flatMap((d) => ['action.yml', 'action.yaml'].map((f) => read(`${d}${f}`)))
      .filter((t) => t !== null);
    for (const body of [text, ...actionYmls]) {
      const dirs = installDirs(body);
      for (const m of installManagers(body)) {
        for (const d of dirs) {
          for (const p of INSTALL_INPUTS[m]) named.add(at(d, p));
          manifests.add(at(d, 'package.json'));
        }
      }
    }
  }
  const hits = [];
  for (const c of changes) {
    if (hits.includes(c.path)) continue;
    if (WORKFLOW.test(c.path)) {
      const sides = [repo.show('base', c.path), repo.show('head', c.path)];
      if (sides.some((t) => t !== null && workflowHoldsCredential(t))) hits.push(c.path);
    } else if (
      named.has(c.path) ||
      [...named].some((n) => n.endsWith('/') && c.path.startsWith(n))
    ) {
      hits.push(c.path);
    } else if (
      manifests.has(c.path) &&
      dependenciesChanged(repo.show('base', c.path), repo.show('head', c.path))
    ) {
      hits.push(c.path);
    }
  }
  return hits.length === 0 ? [] : [finding('supply-chain', hits)];
}
