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
import ts from 'typescript';
import { LineCounter, parseDocument } from 'yaml';
import { unpairedTempDirs } from './scratch-space-scan.mjs';

/**
 * A changed file that is a supply-chain gate input: ANY file under `security/`, at any depth
 * and with any extension, except Markdown prose. Not only `*allowlist*`:
 * `govulncheck-exceptions.json`, `release-age-exceptions.json`, `dockerfile-base-exclusions.json`
 * and `bun-install-scripts.json` have the same "unknown keys FAIL" semantics as an allowlist and
 * used to run no gate at all. A new file under `security/` must be mapped or the check fails.
 */
export const GATE_INPUT_RE = /^security\/(?!.*\.md$).+$/;

export const changedGateInputs = (files) => files.filter((f) => GATE_INPUT_RE.test(f));
/** Older name, kept for callers that predate the widening. */
export const changedAllowlists = changedGateInputs;

// BEGIN branch-specific (GATE_TABLE, registry): differs between integration/v2 and main by design;
// everything outside this block must stay byte-identical (see `driftBetween`). The block holds DATA
// only: `const NAME = <object, array or string literal>` (identifier references and spreads allowed),
// no calls and no functions; `branchBlockProblems` enforces it, so the drift guard can evaluate it.
/**
 * How to invoke each gate that reads a gate input, by repo-relative script path.
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
  'scripts/audit-published.mjs': { needs: ['npm', 'bun'], runs: [[]] },
};

/**
 * The registry: for each security/ gate input, the gates that must pass when it changes,
 * and every OTHER reader that is known and deliberately not run, with the
 * reason. `scanReaders` finds readers by scanning the repo; any reader it finds
 * that is in neither list is UNREGISTERED, which fails the check and the test
 * in `tests/prepush-check.test.ts`. A reader added next month cannot be missed
 * by omission. An input may instead carry `exempt: <reason>` (see `planGateRuns`).
 */
export const GATE_INPUT_REGISTRY = {
  'security/gitleaks-allowlist.json': {
    gates: ['scripts/secret-scan.mjs'],
    other: {
      '.github/workflows/ci.yml': 'runs a registered gate; reads the file only through it',
      '.github/workflows/secret-scan-nightly.yml':
        'runs a registered gate; reads the file only through it',
    },
  },
  'security/npm-audit-allowlist.json': {
    gates: ['scripts/audit-published.mjs'],
    other: {
      'scripts/verify-allowlist-retirement.mjs':
        'nightly network probe of whether an entry still has an advisory; it does not judge the file',
      'scripts/precompile-closure-audit.mjs':
        'imports the retirement helper that lists this file, but judges only its own allowlist',
      '.github/workflows/allowlist-retirement-nightly.yml':
        'runs a registered gate; reads the file only through it',
      '.github/workflows/ci.yml': 'runs a registered gate; reads the file only through it',
      '.github/workflows/docs-deploy-oke.yml':
        'runs a registered gate; reads the file only through it',
      '.github/workflows/release.yml': 'runs a registered gate; reads the file only through it',
      '.github/workflows/supply-chain.yml':
        'runs a registered gate; reads the file only through it',
    },
  },
  'security/precompile-closure-allowlist.json': {
    gates: ['scripts/precompile-closure-audit.mjs'],
    other: {
      'scripts/verify-allowlist-retirement.mjs':
        'nightly network probe of whether an entry still has an advisory; it does not judge the file',
      '.github/workflows/allowlist-retirement-nightly.yml':
        'runs a registered gate; reads the file only through it',
      '.github/workflows/ci.yml': 'runs a registered gate; reads the file only through it',
      '.github/workflows/docs-deploy-oke.yml':
        'runs a registered gate; reads the file only through it',
      '.github/workflows/supply-chain.yml':
        'runs a registered gate; reads the file only through it',
    },
  },
  'security/govulncheck-exceptions.json': {
    gates: [],
    other: {
      'scripts/govulncheck-gate.mjs':
        'reads govulncheck JSON piped in per Go module, so it cannot run bare; the tests that name the file run its exception semantics',
      '.github/workflows/govulncheck-modules.yml':
        'runs a registered gate; reads the file only through it',
      '.github/workflows/govulncheck-nightly.yml':
        'runs a registered gate; reads the file only through it',
    },
  },
  'security/govulncheck-modules.json': {
    gates: [],
    other: {
      'scripts/govulncheck-gate.mjs':
        'reads govulncheck JSON piped in per Go module, so it cannot run bare; the tests that name the file run its exception semantics',
      '.github/workflows/govulncheck-modules.yml':
        'runs a registered gate; reads the file only through it',
      '.github/workflows/govulncheck-nightly.yml':
        'runs a registered gate; reads the file only through it',
    },
  },
  'security/protected-refs-exception.json': {
    gates: [],
    other: {
      'scripts/protected-refs-exception-status.mjs':
        'reports whether the dated exception suppresses the alert issue (always exits 0, fails closed to inactive); the tests that name the file run its semantics',
      '.github/workflows/z7-watchdog-nightly.yml':
        'runs a registered gate; reads the file only through it',
    },
  },
  'security/docs-closure-trivyignore.yaml': {
    gates: [],
    exempt:
      "consumed only by the Trivy step's `trivyignores:` input in the two workflows listed below; no script or test reads it by path, so those workflows are its gate and nothing here can run it",
    other: {
      '.github/workflows/ci.yml': 'runs a registered gate; reads the file only through it',
      '.github/workflows/docs-closure-nightly.yml':
        'runs a registered gate; reads the file only through it',
    },
  },
};
// END branch-specific

/** Older name, kept for callers that predate the widening. */
export const ALLOWLIST_REGISTRY = GATE_INPUT_REGISTRY;

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

/** The test file the prepush guard itself keeps: it names every input as a fixture, so it reads none. */
const SELF_TESTS = new Set(['tests/prepush-check.test.ts']);

/** A read- or import-like call near a path literal: the path is passed somewhere that opens it. */
const READ_CONTEXT =
  /\b(?:read\w*|import|require|Bun\.file|JSON\.parse|load\w*|parse\w*|existsSync|statSync|spawnSync|execFileSync)\b/;

/**
 * Does `text` open the file `inputRel` BY ITS PATH? The path must appear as a whole quoted
 * string (`'security/x.json'`, `'../security/x.json'`) or as consecutive join segments
 * (`'security', 'x.json'`), so `my-x.json` or a prose mention does not count, and a read- or
 * import-like call must sit within two lines of it. Comments are ignored.
 * LIMIT: a path assembled at run time, or read through a helper with an unusual name, is not seen.
 */
export function readsByPath(text, inputRel) {
  const code = stripComments(text);
  const whole = new RegExp(`['"\`](?:[^'"\`\\n]*/)?${escapeRe(inputRel)}['"\`]`, 'g');
  const parts = inputRel.split('/').map(escapeRe).join('[\'"`]\\s*,\\s*[\'"`]');
  const segs = new RegExp(`['"\`]${parts}['"\`]`, 'g');
  const lines = code.split('\n');
  const offsets = [];
  let at = 0;
  for (const l of lines) {
    offsets.push(at);
    at += l.length + 1;
  }
  const lineOf = (idx) => offsets.findLastIndex((o) => o <= idx);
  for (const re of [whole, segs]) {
    for (const m of code.matchAll(re)) {
      const i = lineOf(m.index);
      const near = lines.slice(Math.max(0, i - 2), i + 3).join('\n');
      if (READ_CONTEXT.test(near)) return true;
    }
  }
  return false;
}

/** A token that names a test file, as opposed to a flag or a flag's value (`--shard 1/4`). */
const TEST_PATH_TOKEN = /\.[cm]?[jt]sx?$/;
/** A directory argument: ends in `/`, or has a path separator and is not a `1/4` shard. */
const DIR_TOKEN = /^(?!\d+\/\d+$)(?:.*\/$|[^/\s-][^\s]*\/[^\s]+)$/;
/** `scripts/bun-test.mjs` and the tokens after it, up to a shell separator. */
const BUN_TEST_CMD = /\bscripts\/bun-test\.mjs\b([^|&;>\n]*)/;

/**
 * Is this line `bun-test.mjs` run over the whole suite: no token after it names a test file?
 * Flags and their values (`--coverage`, `--shard 1/4`, `--timeout=30000`) do not narrow it; a
 * file or a directory argument (`tests/`, `packages/x/src`) does.
 */
export function runsWholeSuite(line) {
  const m = BUN_TEST_CMD.exec(line.trim().replace(/^(?:-\s*)?run:\s*/, ''));
  if (!m) return false;
  return !m[1]
    .split(/\s+/)
    .filter(Boolean)
    .some((t) => TEST_PATH_TOKEN.test(t) || DIR_TOKEN.test(t));
}

/** Test files the whole-suite run partitions out; they run only where a workflow names them. */
const PARTITIONED = /\.(?:docker-e2e|kind-e2e|e2e)\.test\./;
/** An `if:` that holds on every pull request event. Anything else is a job that may not run. */
const ALWAYS_TRUE =
  /^(?:\$\{\{\s*)?(?:true|always\(\)|github\.event_name\s*==\s*'pull_request'|github\.event_name\s*!=\s*'merge_group')(?:\s*\}\})?$/;

/**
 * Index the `if:` guards of a workflow by line. The text is parsed as YAML (the `yaml` package), so
 * a blank line inside a step, a trailing `# comment` on an `if:`, quoting and flow style all read
 * the way GitHub reads them. Returns `lineGuards(i)`: the `if:` of the step holding line `i` and of
 * its job, or `null` when the file is not valid YAML (the caller then refuses the line: fail closed).
 *
 * @param {string} wfText
 * @returns {(i: number) => string[] | null}
 */
function workflowGuards(wfText) {
  const lc = new LineCounter();
  const doc = parseDocument(wfText, { lineCounter: lc });
  if (doc.errors.length > 0) return () => null;
  /** @type {{ from: number, to: number, guard: string | null }[]} */
  const regions = [];
  const guardOf = (node) => {
    const v = node?.get?.('if');
    return v === undefined || v === null ? null : String(v).trim();
  };
  const jobs = doc.get('jobs', true);
  for (const jp of jobs?.items ?? []) {
    const job = jp.value;
    if (!job?.range) continue;
    const jobGuard = guardOf(job);
    regions.push({ from: job.range[0], to: job.range[2], guard: jobGuard });
    for (const step of job.get('steps', true)?.items ?? []) {
      if (step?.range)
        regions.push({ from: step.range[0], to: step.range[2], guard: guardOf(step) });
    }
  }
  return (i) => {
    const line = lc.lineStarts[i];
    if (line === undefined) return [];
    const end = (lc.lineStarts[i + 1] ?? wfText.length + 1) - 1;
    const at = Math.max(line, end - 1);
    return regions.filter((r) => at >= r.from && at < r.to && r.guard !== null).map((r) => r.guard);
  };
}

/**
 * Is `testFile` run by some workflow? Either a workflow command names its path, or a workflow
 * runs the whole suite (`runsWholeSuite`) and the file is not one the suite partitions out
 * (`*.docker-e2e.test.*`, `*.kind-e2e.test.*`, `*.e2e.test.*`). A step or job whose `if:` is not
 * always true on a pull request is refused: it may not run.
 * LIMIT: workflow TRIGGER filters (`paths:`, `branches:`) and `needs:` are not evaluated, and an
 * `if:` is judged by shape only (`true`, `always()`, a pull_request event check pass; anything
 * else is refused), so a gated-off job can still count and an exotic always-true guard is refused.
 */
export function ciRunsTest(root, testFile) {
  const wfDir = '.github/workflows';
  if (!existsSync(join(root, wfDir))) return false;
  for (const f of readdirSync(join(root, wfDir)).filter((n) => /\.ya?ml$/.test(n))) {
    const wfText = joinContinuations(stripComments(readFileSync(join(root, wfDir, f), 'utf8')));
    const lines = wfText.split('\n');
    const guardsAt = workflowGuards(wfText);
    for (const [i, line] of lines.entries()) {
      const names = line.includes(testFile) && /\b(?:bun-test\.mjs|bun test|vitest)\b/.test(line);
      const whole = runsWholeSuite(line) && !PARTITIONED.test(testFile);
      if (!names && !whole) continue;
      const guards = guardsAt(i);
      if (guards?.every((g) => ALWAYS_TRUE.test(g))) return true;
    }
  }
  return false;
}

/**
 * Tests under `tests/` that READ the input file by its path (`readsByPath`) AND that some
 * workflow runs (`ciRunsTest`). Such a test asserts the file's schema and semantics, so it is
 * that input's gate when no script is (e.g. `bun-install-scripts.json`). A test that merely
 * mentions the name, or that no workflow runs, is not a gate. One hop on purpose.
 *
 * @returns {string[]} sorted repo-relative test files
 */
export function scanTestReaders(root, inputRel) {
  return walk(root, 'tests')
    .filter((f) => /\.test\.(?:[cm]?[jt]sx?)$/.test(f) && !SELF_TESTS.has(f))
    .filter((f) => readsByPath(readFileSync(join(root, f), 'utf8'), inputRel))
    .filter((f) => ciRunsTest(root, f))
    .sort();
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
 * @param {Record<string, {gates: string[], other: Record<string, string>, exempt?: string}>} [registry]
 * `tests` are the test files that name a changed input (run as its gate). `unmapped` is every
 * changed input that NOTHING gates: no registry entry, or an entry with no script gate and no
 * test naming the file. An input nothing runs is a defect, never a pass.
 *
 * An entry may instead carry `exempt: <reason>` when its only gate is a workflow step that
 * nothing local can run; that counts as mapped and is reported (`exempt`) every run, so the
 * exemption is visible, not silent.
 *
 * @returns {{ runs: {allowlist: string, script: string, args: string[], entry: any}[], unknown: {allowlist: string, script: string}[], tests: string[], unmapped: string[], exempt: {input: string, reason: string}[] }}
 */
export function planGateRuns(root, allowlists, table = GATE_TABLE, registry = GATE_INPUT_REGISTRY) {
  const runs = [];
  const unknown = [];
  const unmapped = [];
  const exempt = [];
  const tests = new Set();
  const seen = new Set();
  for (const allowlist of allowlists) {
    const reg = registry[allowlist] ?? { gates: [], other: {} };
    const testReaders = scanTestReaders(root, allowlist);
    for (const t of testReaders) tests.add(t);
    const gated = reg.gates.length > 0 || testReaders.length > 0 || Boolean(reg.exempt);
    if (reg.exempt && !reg.gates.length && !testReaders.length) {
      exempt.push({ input: allowlist, reason: reg.exempt });
    }
    if (!(allowlist in registry) || !gated) {
      unmapped.push(allowlist);
    }
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
  return { runs, unknown, tests: [...tests].sort(), unmapped, exempt };
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

/**
 * The text a reviewer actually sees: `<!-- -->` HTML comments (an unclosed one runs to the end)
 * and ``` / ~~~ fenced blocks (an unclosed fence runs to the end) removed, a comment inside a
 * fence staying literal and a fence inside a comment staying hidden.
 */
export function visibleMarkdown(text) {
  const out = [];
  let inComment = false;
  let fence = null; // { ch, len } while inside a fenced block
  for (const raw of (text ?? '').split('\n')) {
    if (fence) {
      const close = raw.match(/^ {0,3}(`{3,}|~{3,})[ \t\r]*$/);
      if (close && close[1][0] === fence.ch && close[1].length >= fence.len) fence = null;
      continue;
    }
    let line = '';
    let rest = raw;
    while (rest.length > 0) {
      if (inComment) {
        const end = rest.indexOf('-->');
        if (end === -1) rest = '';
        else {
          inComment = false;
          rest = rest.slice(end + 3);
        }
      } else {
        const start = rest.indexOf('<!--');
        if (start === -1) {
          line += rest;
          rest = '';
        } else {
          line += rest.slice(0, start);
          inComment = true;
          rest = rest.slice(start + 4);
        }
      }
    }
    const open = line.match(/^ {0,3}(`{3,}|~{3,})/);
    if (open) {
      fence = { ch: open[1][0], len: open[1].length };
      continue;
    }
    out.push(line);
  }
  return out.join('\n');
}

/** Every visible `Scope:` line's text, in order. */
function scopeLineTexts(text) {
  // A GitHub-UI PR body is CRLF; JS `$` and `.` both stop at `\r`, so no normalising is needed
  // (pinned by a CRLF test below, so a regex change that breaks it is caught).
  return [...visibleMarkdown(text).matchAll(/^[ \t]*Scope:[ \t]*(.+)$/gim)].map((m) => m[1]);
}

/** How many `Scope:` lines a reviewer can see in a commit or PR body. */
export function countScopeLines(text) {
  return scopeLineTexts(text).length;
}

/** `Scope: a/**, b/*.ts` lines out of a commit or PR body; hidden (comment/fence) lines never count. */
export function parseScopeLines(text) {
  const globs = [];
  for (const line of scopeLineTexts(text)) {
    for (const g of line.split(',')) if (g.trim()) globs.push(g.trim());
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

/** A path no repo has: a scope that matches it is a wildcard over directories, not a claim. */
const PROBE_PATH = '__scope_probe__/a/b';
/** Judge breadth only in a repo big enough for the ratios to mean something. */
const MIN_TRACKED_FILES = 20;
const MIN_AREAS = 5;
/** A scope touching this share of the tracked top-level directories spans the repo. */
export const BROAD_AREA_SHARE = 0.75;
/** A scope matching this share of all tracked files spans the repo. */
export const BROAD_FILE_SHARE = 0.6;

/**
 * Scope globs that together cover the repo: a declared scope that cannot be violated.
 * Judged by what the globs MATCH, never by their spelling, against the repo's ACTUAL tracked
 * files (`tracked`, e.g. `git ls-files`), so the list of areas cannot go stale:
 *
 *  1. matches a path that exists nowhere (`__scope_probe__/a/b`): a wildcard over directories
 *     (`**`, `**\/*`, `./**`, `*\/**`);
 *  2. touches at least BROAD_AREA_SHARE (75%) of the tracked top-level directories, i.e. at
 *     least one tracked file in each (this is what stops `**\/*.ts, **\/*.md`);
 *  3. matches more than BROAD_FILE_SHARE (60%) of all tracked files.
 *
 * Rules 2 and 3 apply only when the repo has at least 20 tracked files and 5 top-level
 * directories; below that the ratios say nothing. 75% / 60% are judgement: a legitimate PR here
 * (scripts + tests + docs + .github + security) touches 5 of 21 directories and 31% of files;
 * `packages/**` alone is 1 of 21 directories and 48% of files and is not flagged.
 *
 * @param {string[]} globs
 * @param {string[]} [tracked] repo-relative tracked files
 * @returns {string[]} the offending globs (every glob when only their union is too broad)
 */
export function broadScopes(globs, tracked = []) {
  const areas = [...new Set(tracked.filter((f) => f.includes('/')).map((f) => f.split('/')[0]))];
  const judgeRatios = tracked.length >= MIN_TRACKED_FILES && areas.length >= MIN_AREAS;
  const broad = (gs) => {
    const res = gs.map(globToRegExp);
    const any = (f) => res.some((r) => r.test(f));
    if (any(PROBE_PATH)) return true;
    if (!judgeRatios) return false;
    const hit = tracked.filter(any);
    if (hit.length > tracked.length * BROAD_FILE_SHARE) return true;
    const touched = areas.filter((a) => hit.some((f) => f.startsWith(`${a}/`)));
    return touched.length >= areas.length * BROAD_AREA_SHARE;
  };
  const alone = globs.filter((g) => broad([g]));
  if (alone.length > 0) return alone;
  return broad(globs) ? [...globs] : [];
}

/**
 * Globs that use brace alternation (`{a,b}`). Scope lines are split on commas, so a brace glob
 * would be cut into two broken ones; it is rejected rather than misread.
 */
export const bracedScopes = (globs) => globs.filter((g) => /[{}]/.test(g));

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

/**
 * Choose the base ref a branch forks from: of the candidates that exist, the one whose
 * merge-base with HEAD is nearest HEAD (fewest commits from it to HEAD). A branch cut from
 * main gets main, a branch cut from integration/v2 gets that, with no hardcoded order to
 * go stale. A tie (both forked from the same commit) goes to the ref with fewer commits of
 * its own past that commit, i.e. the one the branch could not have been cut from later; a
 * remaining tie goes to the earlier candidate.
 *
 * @param {string[]} candidates refs in preference order
 * @param {(ref: string) => [number, number] | null | undefined} distance `[commits from the ref's
 *   merge-base with HEAD to HEAD, commits from that merge-base to the ref]`, or null when the
 *   ref does not exist
 * @returns {string | undefined}
 */
export function pickBase(candidates, distance) {
  let best;
  let bestScore;
  for (const c of candidates) {
    const score = distance(c);
    if (!score) continue;
    if (
      !bestScore ||
      score[0] < bestScore[0] ||
      (score[0] === bestScore[0] && score[1] < bestScore[1])
    ) {
      best = c;
      bestScore = score;
    }
  }
  return best;
}

export const BRANCH_BEGIN = '// BEGIN branch-specific';
export const BRANCH_END = '// END branch-specific';

/**
 * `text` with the branch-specific block (GATE_TABLE + registry) removed. A marker is a LINE that
 * starts with the marker text, so a string constant naming it does not count. Throws unless
 * there is exactly one BEGIN and one END, in that order: a copy that lost or doubled a marker
 * must not compare as "identical".
 */
export function stripBranchSpecific(text) {
  const lines = text.split('\n');
  const at = (marker) => lines.flatMap((l, i) => (l.startsWith(marker) ? [i] : []));
  const begins = at(BRANCH_BEGIN);
  const ends = at(BRANCH_END);
  if (begins.length !== 1 || ends.length !== 1) {
    throw new Error(
      `expected exactly one BEGIN and one END branch-specific marker, got ${begins.length}/${ends.length}`,
    );
  }
  if (ends[0] < begins[0]) throw new Error('branch-specific END marker comes before BEGIN');
  return [...lines.slice(0, begins[0]), ...lines.slice(ends[0] + 1)].join('\n');
}

/**
 * Compare two copies of the check's source outside the branch-specific block. The two long-lived
 * branches carry the same code and differ only in which gates and security/ files they register;
 * anything else that differs is drift.
 *
 * @param {string} a
 * @param {string} b
 * @returns {{ same: boolean, line?: number, a?: string, b?: string }} the first differing line, 1-based
 */
export function driftBetween(a, b) {
  const x = stripBranchSpecific(a).split('\n');
  const y = stripBranchSpecific(b).split('\n');
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    if (x[i] !== y[i]) return { same: false, line: i + 1, a: x[i], b: y[i] };
  }
  return { same: true };
}

/**
 * Why the branch-specific block is NOT plain data, as a list of problems (empty = fine). The
 * block is parsed with the TypeScript parser (no hand-written scanner), and every top-level
 * statement must be a `const NAME = <literal>` whose initializer is a pure literal tree: an
 * object with plain keys (no computed key, shorthand, spread, method or accessor), an array of
 * literals, a string, number, boolean, null, regex, or a template with no `${}`. An identifier
 * reference, a spread, a call, `new`, a tagged template or any other statement is a problem,
 * because the drift guard evaluates this block and logic hidden in it would be logic the two
 * branches could silently differ on.
 *
 * @param {string} text a full copy of the lib
 * @returns {string[]}
 */
export function branchBlockProblems(text) {
  const lines = text.split('\n');
  const begin = lines.findIndex((l) => l.startsWith(BRANCH_BEGIN));
  const end = lines.findIndex((l) => l.startsWith(BRANCH_END));
  if (begin < 0 || end < begin) return ['the branch-specific markers are missing or out of order'];
  const src = lines.slice(begin + 1, end).join('\n');
  const sf = ts.createSourceFile('block.mjs', src, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
  const problems = [];
  const syntax = sf.parseDiagnostics ?? [];
  for (const d of syntax)
    problems.push(`syntax error: ${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`);
  const K = ts.SyntaxKind;
  const keyOk = (n) =>
    n.kind === K.Identifier || n.kind === K.StringLiteral || n.kind === K.NumericLiteral;
  const lit = (n) => {
    switch (n.kind) {
      case K.StringLiteral:
      case K.NumericLiteral:
      case K.NoSubstitutionTemplateLiteral:
      case K.RegularExpressionLiteral:
      case K.TrueKeyword:
      case K.FalseKeyword:
      case K.NullKeyword:
        return true;
      case K.PrefixUnaryExpression:
        return n.operator === K.MinusToken && n.operand.kind === K.NumericLiteral;
      case K.ArrayLiteralExpression:
        return n.elements.every(lit);
      case K.ObjectLiteralExpression:
        return n.properties.every(
          (p) => p.kind === K.PropertyAssignment && keyOk(p.name) && lit(p.initializer),
        );
      default:
        return false;
    }
  };
  for (const s of sf.statements) {
    const head = s.getText(sf).slice(0, 40);
    const isConst =
      s.kind === K.VariableStatement && (s.declarationList.flags & ts.NodeFlags.Const) !== 0;
    const mods = (s.modifiers ?? []).every((m) => m.kind === K.ExportKeyword);
    if (!isConst || !mods) {
      problems.push(`a statement that is not a const declaration: ${head}`);
      continue;
    }
    for (const d of s.declarationList.declarations) {
      if (d.name.kind !== K.Identifier || !d.initializer || !lit(d.initializer))
        problems.push(`a const whose value is not a pure literal: ${d.getText(sf).slice(0, 40)}`);
    }
  }
  return problems;
}

/** The registry and gate table out of a copy's branch-specific block. Throws if the block is not data. */
export function evalBranchBlock(text) {
  const problems = branchBlockProblems(text);
  if (problems.length > 0)
    throw new Error(`branch-specific block is not data: ${problems.join('; ')}`);
  const lines = text.split('\n');
  const begin = lines.findIndex((l) => l.startsWith(BRANCH_BEGIN));
  const end = lines.findIndex((l) => l.startsWith(BRANCH_END));
  const body = lines
    .slice(begin + 1, end)
    .join('\n')
    .replace(/^export\s+/gm, '');
  return new Function(`${body}\nreturn { GATE_TABLE, GATE_INPUT_REGISTRY };`)();
}

/** Names of the registry entries that carry an `exempt` reason, sorted. */
export const exemptInputs = (registry) =>
  Object.entries(registry)
    .filter(([, r]) => r.exempt)
    .map(([k]) => k)
    .sort();
