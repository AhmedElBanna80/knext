/**
 * Pure logic for `scripts/prepush-check.mjs`, the pre-push guard for the three
 * defect classes that reached CI or merged in one sprint: a gate that rejected
 * a changed allowlist because nobody ran it, tests that leaked temp dirs, and a
 * PR that silently reverted another PR's files.
 *
 * Nothing here runs a gate or a test on import. The spawns live in the CLI and
 * are injected where a function needs one, so every check can be driven from a
 * fixture.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, normalize } from 'node:path';
import { unpairedTempDirs } from './scratch-space-scan.mjs';

/** A changed file that is a supply-chain allowlist. */
export const ALLOWLIST_RE = /^security\/[^/]*allowlist[^/]*\.json$/;

export const changedAllowlists = (files) => files.filter((f) => ALLOWLIST_RE.test(f));

/**
 * How to invoke each gate that reads an allowlist, by repo-relative script path.
 * `runs: 'workflows'` derives the argument sets from the workflow steps that
 * invoke the script (see `deriveWorkflowArgSets`), so a new covered app is
 * picked up rather than forgotten.
 *
 * `needs` are binaries that must be on PATH. A missing one is UNVERIFIED, which
 * fails unless the caller passes --allow-missing-tools: "I could not run the
 * gate" is not "the gate passed".
 */
export const GATE_TABLE = {
  'scripts/secret-scan.mjs': { needs: ['gitleaks'], runs: [[]] },
  'scripts/precompile-closure-audit.mjs': {
    needs: ['syft', 'grype'],
    sbom: true,
    runs: 'workflows',
  },
  'scripts/osv-gate.mjs': { needs: ['osv-scanner'], scanner: true, base: true, runs: [[]] },
  'scripts/audit-shipped-npm.mjs': { needs: ['osv-scanner', 'npm'], scanner: true, runs: [[]] },
  'scripts/audit-published.mjs': { needs: ['npm', 'bun'], runs: [[]] },
};

/**
 * The registry: for each allowlist, the gates that must pass when it changes,
 * and every OTHER reader that is known and deliberately not run, with the
 * reason. `scanReaders` finds readers by scanning the repo; any reader it finds
 * that is in neither list is UNREGISTERED, which fails the check and the test
 * in `tests/prepush-check.test.ts`. A reader added next month cannot be missed
 * by omission.
 */
const PROBE = {
  'scripts/verify-allowlist-retirement.mjs':
    'nightly network probe of whether an entry still has an advisory; it does not judge the file',
};
const OWN_ALLOWLIST = {
  'scripts/precompile-closure-audit.mjs':
    'imports the retirement helper that lists this file, but judges only its own allowlist',
};

export const ALLOWLIST_REGISTRY = {
  'security/gitleaks-allowlist.json': {
    gates: ['scripts/secret-scan.mjs'],
    other: {},
  },
  'security/npm-audit-allowlist.json': {
    gates: ['scripts/audit-published.mjs', 'scripts/audit-shipped-npm.mjs'],
    other: {
      ...PROBE,
      ...OWN_ALLOWLIST,
      '.github/workflows/shipped-artifacts-nightly.yml':
        'issue-body text naming the file; its gate steps are the scripts above',
    },
  },
  'security/osv-allowlist.json': {
    gates: ['scripts/osv-gate.mjs', 'scripts/audit-shipped-npm.mjs'],
    other: {
      ...PROBE,
      ...OWN_ALLOWLIST,
      'scripts/release-age-gate.mjs':
        'imports the OSV base picker; judges security/release-age-exceptions.json, not this file',
      '.github/workflows/shipped-artifacts-nightly.yml':
        'issue-body text naming the file; its gate steps are the scripts above',
    },
  },
  'security/precompile-closure-allowlist.json': {
    gates: ['scripts/precompile-closure-audit.mjs'],
    other: { ...PROBE },
  },
};

const SCRIPT_EXT = /\.(?:mjs|cjs|js|ts|sh)$/;
/** This check's own files hold the registry, so they name every allowlist by design. */
const SELF = new Set(['scripts/prepush-check.mjs', 'scripts/lib/prepush-check.mjs']);
const IMPORT_SPEC = /(?:from\s*|import\s*\(?\s*|require\s*\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g;

function walk(root, rel, out = []) {
  const abs = join(root, rel);
  if (!existsSync(abs)) return out;
  for (const e of readdirSync(abs, { withFileTypes: true })) {
    const r = `${rel}/${e.name}`;
    if (e.isDirectory()) {
      if (e.name !== 'node_modules') walk(root, r, out);
    } else out.push(r);
  }
  return out;
}

/** Drop full-line `#` and `//` comments so prose mentioning a file is not a read. */
const stripComments = (text) =>
  text
    .split('\n')
    .filter((l) => !/^\s*(?:#|\/\/|\*|\/\*)/.test(l))
    .join('\n');

function edgesOf(root, rel, text) {
  const out = new Set();
  for (const m of text.matchAll(IMPORT_SPEC)) {
    const target = normalize(join(dirname(rel), m[1]));
    out.add(target);
  }
  return [...out];
}

/**
 * Every script under `scripts/**` (provers excluded) that reads the allowlist,
 * directly by name or through anything it imports or invokes, and every
 * workflow step that names it. Scanning, not listing.
 *
 * @returns {{ scripts: string[], workflows: string[] }}
 */
export function scanReaders(root, allowlistRel) {
  const name = allowlistRel.split('/').pop();
  const files = walk(root, 'scripts').filter(
    (f) => SCRIPT_EXT.test(f) && !SELF.has(f) && !/\/mutation-prove-[^/]*$/.test(f),
  );
  const text = new Map(files.map((f) => [f, readFileSync(join(root, f), 'utf8')]));
  const direct = new Set(files.filter((f) => stripComments(text.get(f)).includes(name)));
  // Fixed point over import / invoke edges: a script reading the file through a
  // lib it imports is a reader too.
  const reads = new Set(direct);
  for (let grew = true; grew; ) {
    grew = false;
    for (const f of files) {
      if (reads.has(f)) continue;
      if (edgesOf(root, f, text.get(f)).some((t) => reads.has(t))) {
        reads.add(f);
        grew = true;
      }
    }
  }
  const scripts = [...reads].filter((f) => !f.startsWith('scripts/lib/')).sort();
  const wfDir = '.github/workflows';
  const workflows = existsSync(join(root, wfDir))
    ? readdirSync(join(root, wfDir))
        .filter((f) => /\.ya?ml$/.test(f))
        .map((f) => `${wfDir}/${f}`)
        .filter((f) => stripComments(readFileSync(join(root, f), 'utf8')).includes(name))
        .sort()
    : [];
  return { scripts, workflows };
}

/**
 * The argument sets workflow steps pass to `script`: the `--app` / `--closure` /
 * `--shape` flags on each non-comment line that invokes it.
 */
export function deriveWorkflowArgSets(root, script) {
  const wfDir = '.github/workflows';
  const sets = new Map();
  if (!existsSync(join(root, wfDir))) return [];
  for (const f of readdirSync(join(root, wfDir)).filter((n) => /\.ya?ml$/.test(n))) {
    for (const line of stripComments(readFileSync(join(root, wfDir, f), 'utf8')).split('\n')) {
      const at = line.indexOf(script);
      if (at === -1) continue;
      const toks = line
        .slice(at + script.length)
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      const args = [];
      for (let i = 0; i < toks.length; i++) {
        if (/^--(?:app|closure|shape)$/.test(toks[i]) && toks[i + 1]) {
          args.push(toks[i], toks[i + 1]);
          i += 1;
        }
      }
      sets.set(args.join(' '), args);
    }
  }
  return [...sets.values()].sort((a, b) => a.join(' ').localeCompare(b.join(' ')));
}

/**
 * Expand the changed allowlists into concrete commands. `unknown` is every
 * reader the scan found that the registry neither runs nor excuses.
 *
 * @param {string} root
 * @param {string[]} allowlists
 * @param {Record<string, any>} [table]
 * @param {Record<string, {gates: string[], other: Record<string, string>}>} [registry]
 * @returns {{ runs: {allowlist: string, script: string, args: string[], entry: any}[], unknown: {allowlist: string, script: string}[] }}
 */
export function planGateRuns(root, allowlists, table = GATE_TABLE, registry = ALLOWLIST_REGISTRY) {
  const runs = [];
  const unknown = [];
  const seen = new Set();
  for (const allowlist of allowlists) {
    const reg = registry[allowlist] ?? { gates: [], other: {} };
    const { scripts, workflows } = scanReaders(root, allowlist);
    for (const r of [...scripts, ...workflows]) {
      if (!reg.gates.includes(r) && !(r in reg.other)) unknown.push({ allowlist, script: r });
    }
    for (const script of reg.gates) {
      const entry = table[script];
      if (!entry) {
        unknown.push({ allowlist, script });
        continue;
      }
      const argSets = entry.runs === 'workflows' ? deriveWorkflowArgSets(root, script) : entry.runs;
      if (argSets.length === 0) {
        unknown.push({
          allowlist,
          script: `${script} (no workflow step found to derive args from)`,
        });
      }
      argSets.forEach((args, i) => {
        const key = `${script}#${i}`;
        if (seen.has(key)) return;
        seen.add(key);
        runs.push({ allowlist, script, args, entry });
      });
    }
  }
  return { runs, unknown };
}

/** Entries in `after` that were not in `before`. */
export function newEntries(before, after) {
  const was = new Set(before);
  return [...after].filter((e) => !was.has(e)).sort();
}

/** `mkdtemp` sites in `tests/**` that never reach a removal, past each file's recorded baseline. */
export function staticTempDirFindings(root, files, baseline = {}) {
  const out = [];
  for (const f of files) {
    if (!f.startsWith('tests/') || !existsSync(join(root, f))) continue;
    const n = unpairedTempDirs(readFileSync(join(root, f), 'utf8')).length;
    const allowed = baseline[f] ?? 0;
    if (n > allowed) out.push({ file: f, sites: n, baseline: allowed });
  }
  return out;
}

/** `Scope: a/**, b/*.ts` lines out of a commit or PR body. */
export function parseScopeLines(text) {
  const globs = [];
  for (const m of (text ?? '').matchAll(/^[ \t]*Scope:[ \t]*(.+)$/gim)) {
    for (const g of m[1].split(',')) if (g.trim()) globs.push(g.trim());
  }
  return globs;
}

/** `**` crosses directories, `*` and `?` do not. A bare directory means everything under it. */
export function globToRegExp(glob) {
  let g = glob.replace(/^\.\//, '');
  if (g.endsWith('/')) g += '**';
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') {
      i += 1;
      if (g[i + 1] === '/') {
        i += 1;
        re += '(?:.*/)?';
      } else re += '.*';
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/** Files that match none of the declared scope globs. */
export function outOfScope(files, globs) {
  const res = globs.map(globToRegExp);
  return files.filter((f) => !res.some((r) => r.test(f)));
}

/** Group paths by their top-level directory; root files group as `(root)`. */
export function groupByArea(files) {
  const groups = new Map();
  for (const f of files) {
    const area = f.includes('/') ? f.slice(0, f.indexOf('/')) : '(root)';
    if (!groups.has(area)) groups.set(area, []);
    groups.get(area).push(f);
  }
  return new Map([...groups].sort(([a], [b]) => a.localeCompare(b)));
}

/** Test files among the changed ones, as the runner should receive them. */
export const changedTestFiles = (files) => files.filter((f) => /\.test\.(?:[cm]?[jt]sx?)$/.test(f));

const escapeRe = (t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * Tests that import one of the changed source files, found by reading each
 * test's text for the source's path (with or without extension). Cheap and
 * one-hop on purpose: it finds the direct covering test, not every transitive one.
 *
 * @returns {string[]} sorted repo-relative test files
 */
export function testsCovering(root, sources, testFiles) {
  const res = sources
    .filter((f) => SCRIPT_EXT.test(f) && !changedTestFiles([f]).length)
    .map((f) => new RegExp(`${escapeRe(f.replace(SCRIPT_EXT, ''))}(?:\\.[cm]?[jt]sx?)?['"\`]`));
  if (res.length === 0) return [];
  return testFiles
    .filter((t) => existsSync(join(root, t)))
    .filter((t) => {
      const text = readFileSync(join(root, t), 'utf8');
      return res.some((r) => r.test(text));
    })
    .sort();
}
