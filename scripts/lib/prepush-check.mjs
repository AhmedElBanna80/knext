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
/** Workflows and manifests that RUN a registered gate: they reach the file only through it. */
const runners = (files) =>
  Object.fromEntries(
    files.map((f) => [f, 'runs a registered gate; reads the file only through it']),
  );

export const ALLOWLIST_REGISTRY = {
  'security/gitleaks-allowlist.json': {
    gates: ['scripts/secret-scan.mjs'],
    other: runners(['.github/workflows/ci.yml', '.github/workflows/secret-scan-nightly.yml']),
  },
  'security/npm-audit-allowlist.json': {
    gates: ['scripts/audit-published.mjs', 'scripts/audit-shipped-npm.mjs'],
    other: {
      ...PROBE,
      ...OWN_ALLOWLIST,
      ...runners([
        '.github/workflows/allowlist-retirement-nightly.yml',
        '.github/workflows/ci.yml',
        '.github/workflows/docs-deploy-oke.yml',
        '.github/workflows/release.yml',
        '.github/workflows/shipped-artifacts-nightly.yml',
        '.github/workflows/supply-chain.yml',
      ]),
    },
  },
  'security/osv-allowlist.json': {
    gates: ['scripts/osv-gate.mjs', 'scripts/audit-shipped-npm.mjs'],
    other: {
      ...PROBE,
      ...OWN_ALLOWLIST,
      'scripts/release-age-gate.mjs':
        'imports the OSV base picker; judges security/release-age-exceptions.json, not this file',
      ...runners([
        '.github/workflows/allowlist-retirement-nightly.yml',
        '.github/workflows/ci.yml',
        '.github/workflows/docs-deploy-oke.yml',
        '.github/workflows/osv-scan.yml',
        '.github/workflows/release-age.yml',
        '.github/workflows/shipped-artifacts-nightly.yml',
        '.github/workflows/supply-chain.yml',
      ]),
    },
  },
  'security/precompile-closure-allowlist.json': {
    gates: ['scripts/precompile-closure-audit.mjs'],
    other: {
      ...PROBE,
      ...runners([
        '.github/workflows/allowlist-retirement-nightly.yml',
        '.github/workflows/ci.yml',
        '.github/workflows/docs-deploy-oke.yml',
        '.github/workflows/supply-chain.yml',
      ]),
    },
  },
};

const SCRIPT_EXT = /\.(?:mjs|cjs|js|ts|sh)$/;
/** This check's own files hold the registry, so they name every allowlist by design. */
const SELF = new Set(['scripts/prepush-check.mjs', 'scripts/lib/prepush-check.mjs']);
const IMPORT_SPEC = /(?:from\s*|import\s*\(?\s*|require\s*\(\s*)['"](\.{1,2}\/[^'"]+)['"]/g;
/** `node x.mjs`, `bun run x.ts`, `bash x.sh`, `sh x`: an invocation of a script by path. */
const INVOKE =
  /\b(?:node|bun|bash|sh|zsh)\s+(?:run\s+|-[-\w=]+\s+)*["']?((?:\$\{?[A-Za-z_]+\}?\/|\.\/)?[\w./@-]+)/g;
/**
 * A source that lists the `security/` directory itself (readdir / glob over it,
 * or a `security/*` pattern) reads every allowlist in it without naming one.
 */
const DIR_READ = [
  /\b(?:readdir|readdirSync|opendir|opendirSync|glob|globSync|Glob|scandir)\b[^;\n]*['"`](?:[\w./${}-]*\/)?security\/?(?:\*[^'"`]*)?['"`]/,
  /\bsecurity\/\*/,
];

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

/** Join shell `\\` line continuations, so a multi-line `run:` is one command line. */
export const joinContinuations = (text) => text.replace(/\\[ \t]*\r?\n[ \t]*/g, ' ');

/** What the scan reads of a file: a manifest contributes its `scripts` commands only, not prose keys. */
function scannedText(root, f) {
  const raw = readFileSync(join(root, f), 'utf8');
  if (!f.endsWith('package.json')) return stripComments(raw);
  try {
    return Object.values(JSON.parse(raw).scripts ?? {}).join('\n');
  } catch {
    return raw;
  }
}

/** Every candidate file the scan reads: scripts, workflows, composite actions, package manifests. */
function scanFiles(root) {
  const files = [];
  for (const f of walk(root, 'scripts')) {
    if (SCRIPT_EXT.test(f) && !SELF.has(f) && !/\/mutation-prove-[^/]*$/.test(f)) files.push(f);
  }
  for (const f of walk(root, '.github/workflows')) if (/\.ya?ml$/.test(f)) files.push(f);
  for (const f of walk(root, '.github/actions')) {
    if (/\.(?:ya?ml|sh|mjs|cjs|js)$/.test(f)) files.push(f);
  }
  const manifests = ['package.json'];
  for (const d of ['packages', 'apps']) {
    if (existsSync(join(root, d))) {
      for (const e of readdirSync(join(root, d), { withFileTypes: true })) {
        if (e.isDirectory()) manifests.push(`${d}/${e.name}/package.json`);
      }
    }
  }
  for (const m of manifests) if (existsSync(join(root, m))) files.push(m);
  return files;
}

const bucketOf = (f) =>
  f.startsWith('scripts/') ? 'scripts' : f.startsWith('.github/') ? 'workflows' : 'manifests';

function edgesOf(rel, text) {
  const out = new Set();
  for (const m of text.matchAll(IMPORT_SPEC)) out.add(normalize(join(dirname(rel), m[1])));
  for (const m of joinContinuations(text).matchAll(INVOKE)) {
    const p = m[1].replace(/^(?:\$\{?[A-Za-z_]+\}?\/|\.\/)/, '');
    out.add(normalize(p));
    out.add(normalize(join(dirname(rel), p)));
  }
  return [...out];
}

/**
 * Every file that reads the allowlist: by name, by listing the `security/`
 * directory, or through anything it imports or invokes (`import`, `require`,
 * `node|bun|bash|sh <path>`, in scripts, workflows, composite actions and
 * `package.json` scripts). Scanning, not listing.
 *
 * LIMIT, stated rather than chased: a path built at run time (string
 * concatenation, a template over a variable) names no file this scan can see.
 * Such a reader is invisible here; keep allowlist paths literal. So are
 * `bun run <package-script-name>` hops and a script path held in a variable.
 *
 * @returns {{ scripts: string[], workflows: string[], manifests: string[] }}
 */
export function scanReaders(root, allowlistRel) {
  const name = allowlistRel.split('/').pop();
  const files = scanFiles(root);
  const text = new Map(files.map((f) => [f, scannedText(root, f)]));
  const direct = new Set(
    files.filter((f) => text.get(f).includes(name) || DIR_READ.some((r) => r.test(text.get(f)))),
  );
  // Fixed point over import / invoke edges: a script reading the file through a
  // lib it imports, or a script it runs, is a reader too.
  const reads = new Set(direct);
  for (let grew = true; grew; ) {
    grew = false;
    for (const f of files) {
      if (reads.has(f)) continue;
      if (edgesOf(f, text.get(f)).some((t) => reads.has(t))) {
        reads.add(f);
        grew = true;
      }
    }
  }
  const out = { scripts: [], workflows: [], manifests: [] };
  for (const f of [...reads].sort()) {
    if (f.startsWith('scripts/lib/')) continue;
    out[bucketOf(f)].push(f);
  }
  return out;
}

/**
 * Every workflow command that invokes `script`, with the `--app` / `--closure` /
 * `--shape` flags it passes. YAML `\` continuations are joined first, so flags on
 * a later line are not lost. A line naming the script with no runner in front of
 * it (a path filter, a comment) is not an invocation.
 *
 * @returns {{ file: string, args: string[] }[]}
 */
export function workflowInvocations(root, script) {
  const wfDir = '.github/workflows';
  const out = [];
  if (!existsSync(join(root, wfDir))) return out;
  const runner = new RegExp(`\\b(?:node|bun|bash|sh)\\b[^\\n]*?${escapeRe(script)}`);
  for (const f of readdirSync(join(root, wfDir)).filter((n) => /\.ya?ml$/.test(n))) {
    const joined = joinContinuations(stripComments(readFileSync(join(root, wfDir, f), 'utf8')));
    for (const line of joined.split('\n')) {
      if (!runner.test(line)) continue;
      const toks = line
        .slice(line.indexOf(script) + script.length)
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
      out.push({ file: `${wfDir}/${f}`, args });
    }
  }
  return out;
}

/** The distinct, non-empty argument sets workflow steps pass to `script`. */
export function deriveWorkflowArgSets(root, script) {
  const sets = new Map();
  for (const { args } of workflowInvocations(root, script)) {
    if (args.some((a) => a === '--app' || a === '--closure')) sets.set(args.join(' '), args);
  }
  return [...sets.values()].sort((a, b) => a.join(' ').localeCompare(b.join(' ')));
}

/** Invocations naming neither `--app` nor `--closure`: they would scan the default tree, never a covered app. */
export const bareInvocations = (root, script) =>
  workflowInvocations(root, script).filter(
    ({ args }) => !args.some((a) => a === '--app' || a === '--closure'),
  );

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
    const { scripts, workflows, manifests } = scanReaders(root, allowlist);
    for (const r of [...scripts, ...workflows, ...manifests]) {
      if (!reg.gates.includes(r) && !(r in reg.other)) unknown.push({ allowlist, script: r });
    }
    for (const script of reg.gates) {
      const entry = table[script];
      if (!entry) {
        unknown.push({ allowlist, script });
        continue;
      }
      const fromWorkflows = entry.runs === 'workflows';
      if (fromWorkflows) {
        // Fail closed: an invocation with no --app/--closure is never run bare.
        for (const b of bareInvocations(root, script)) {
          unknown.push({
            allowlist,
            script: `${script} (invoked with no --app/--closure in ${b.file}; refusing to run it bare)`,
          });
        }
      }
      const argSets = fromWorkflows ? deriveWorkflowArgSets(root, script) : entry.runs;
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
