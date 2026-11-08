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
 * mentions count too (conservative); trailing prose punctuation is stripped.
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

/** Every `dir/file` token in the text: candidates, kept only if they exist. */
function pathTokens(text) {
  const out = [];
  for (const m of text.matchAll(/(?:^|[\s'"=(`])(?:\.\/)?([A-Za-z0-9_][\w.-]*(?:\/[\w.-]+)+)/g)) {
    const p = m[1].replace(/[.,;:]+$/, '');
    if (!out.includes(p)) out.push(p);
  }
  return out;
}

/**
 * The Makefiles a `make` command runs: `-C dir` / `--directory=dir`, else the repo
 * root, every `working-directory:` and every literal `cd` target in the file
 * (which step a `make` is in is not worked out; any of them may be the one).
 */
function makefiles(text) {
  const workDirs = [
    ...[...text.matchAll(/working-directory\s*:\s*['"]?([^\s'"#]+)/g)].map((m) => m[1]),
    ...[...text.matchAll(/(?:^|[\s;&|(])cd\s+['"]?([\w./-]+)/gm)].map((m) => m[1]),
  ];
  const out = [];
  const add = (dir) => {
    const d = posix.normalize(dir.replace(/^['"]|['"]$/g, ''));
    for (const name of ['GNUmakefile', 'makefile', 'Makefile']) {
      const p = d === '.' ? name : `${d}/${name}`;
      if (!out.includes(p)) out.push(p);
    }
  };
  for (const m of text.matchAll(/(?:^|[\s;&|(])make(?![\w.-])([^\n;&|]*)/gm)) {
    const dir = /(?:^|\s)-C\s*(\S+)/.exec(m[1])?.[1] ?? /(?:^|\s)--directory=(\S+)/.exec(m[1])?.[1];
    if (dir !== undefined) add(dir);
    else for (const d of ['.', ...workDirs]) add(d);
  }
  return out;
}

/** YAML / shell comments removed: prose that names a test or a doc runs nothing. */
function withoutComments(text) {
  return text
    .split('\n')
    .map((l) => (/^\s*#/.test(l) ? '' : l.replace(/\s#\s.*$/, '')))
    .join('\n');
}

/**
 * The files a workflow (or a local action's `action.yml`) names directly.
 * `read(p)` returns a file's text, or null when it is absent. A `scripts/` or
 * `.github/actions/` mention counts whether or not the file exists (deleting a
 * script a release workflow runs is supply chain too); any other path token, and a
 * Makefile, counts only when it exists. A local action directory contributes every
 * file in it (and a `dir/` entry, so a file added under it counts too), and its
 * `action.yml` is read the same way once (not recursively).
 */
export function namedFiles(text, read, listUnder) {
  const out = new Set();
  const expandAction = (p, depth) => {
    const action = /^\.github\/actions\/[^/]+$/.exec(p.replace(/\/$/, ''));
    if (!action) return false;
    // The directory itself, as a `dir/` prefix: any file under it is named.
    out.add(`${action[0]}/`);
    for (const f of listUnder(`${action[0]}/`)) out.add(f);
    if (depth === 0) {
      for (const name of ['action.yml', 'action.yaml']) {
        const body = read(`${action[0]}/${name}`);
        if (body !== null) scan(body, depth + 1);
      }
    }
    return true;
  };
  const scan = (body, depth) => {
    const code = withoutComments(body);
    for (const p of referencedPaths(code)) if (!expandAction(p, depth)) out.add(p);
    for (const p of [...pathTokens(code), ...makefiles(code)]) {
      if (read(p) !== null) out.add(p);
      else expandAction(p, depth);
    }
  };
  scan(text, 0);
  return out;
}

/** A package install command (`bun install`, `npm ci`, `pnpm i`, `yarn add`, …). */
const INSTALL = /(?:^|[\s;&|(])(?:bun|npm|pnpm|yarn)\s+(?:install|i|ci|add)(?![\w-])/m;

/** What an install reads to decide the dependency set. */
export const INSTALL_INPUTS = ['package.json', 'bun.lock', 'bunfig.toml', '.npmrc'];

/**
 * The `supply-chain` finding from content: a changed credential-bearing workflow
 * (on either side), or a changed file a credential-bearing workflow names.
 * `repo.show(side, p)` reads a file (null when absent); `repo.listHead(prefix)`
 * lists the head tree.
 */
export function credentialWorkflowFindings(changes, repo) {
  const read = (p) => repo.show('head', p) ?? repo.show('base', p);
  const named = new Set();
  for (const wf of repo.listHead('.github/workflows/').filter((p) => WORKFLOW.test(p))) {
    const text = repo.show('head', wf);
    if (text === null || !workflowHoldsCredential(text)) continue;
    for (const p of namedFiles(text, read, (prefix) => repo.listHead(prefix))) named.add(p);
    // An install runs with the workflow's credentials in scope, so what decides the
    // dependency set is named too: the root manifest, the lockfile and npm/bun config.
    if (INSTALL.test(withoutComments(text))) for (const p of INSTALL_INPUTS) named.add(p);
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
    }
  }
  return hits.length === 0 ? [] : [finding('supply-chain', hits)];
}
