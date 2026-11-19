#!/usr/bin/env node
/**
 * `node scripts/prepush-check.mjs` — run before pushing (agents included).
 *
 * Four checks over the diff from the merge base to your working tree:
 *
 *  1. GATES ON CHANGED DATA. If ANY `security/*.json` or `.yaml` changed (not only
 *     `*allowlist*`), run every gate that reads that file against the repo copy (found by
 *     scanning `scripts/`, workflows and manifests, run per `GATE_TABLE`), plus every test under
 *     `tests/` that names the file. Non-zero exit fails. A gate whose tool is not installed is
 *     UNVERIFIED and fails too, unless --allow-missing-tools. A changed input that NOTHING gates
 *     (no registry entry, or no script gate and no naming test) FAILS as unmapped.
 *  2. TEMP-DIR LEAKS. Snapshot `tmpdir()` and the repo's untracked top-level
 *     entries, run the changed test files, snapshot again, fail on new entries.
 *     Anything else writing to the machine's tmpdir while this runs shows up as
 *     a leak; rerun when the machine is quiet before blaming your tests.
 *  3. STATIC SCAN. Every `mkdtemp` in `tests/**` must reach a removal, by the
 *     same scanner (`scratch-space-scan.mjs`) and per-file baseline
 *     (`tests/scratch-space-exceptions.json`) as `tests/temp-dirs-outside-the-repo.test.ts`.
 *     Every documented `exempt` registry entry is printed as a NOTICE on EVERY run.
 *  4. SCOPE REPORT. `git diff --stat <merge-base>...HEAD` grouped by top-level
 *     area. With a declared scope (--scope a/**,b/*.ts, or a `Scope:` line in a
 *     commit body or PR body) any file outside it FAILS; with none declared it
 *     WARNS.
 *
 * Reader discovery scans `scripts/**`, `.github/workflows`, `.github/actions`, and the `scripts` of
 * every `package.json`, following imports and `node|bun|bash|sh <path>` invocations, and treats a
 * source that lists `security/` itself (readdir, glob, `security/*`) as reading every allowlist.
 * LIMIT: a path built at run time (concatenation, a variable) cannot be seen statically; keep
 * allowlist paths literal. A closure audit invoked with no `--app`/`--closure` fails, never runs.
 *
 * Basis for every check: merge-base...HEAD plus uncommitted changes (reported as such).
 * With no changed test file, the tests that import the changed source run instead;
 * if there are none, the leak scan is reported as NOT exercised (a WARN, never a pass).
 * Only lines of the form `Scope: glob, glob` are read; other phrasing is ignored.
 *
 * Options: --base <ref> (default: of personal|origin integration/v2 and main, the ref the
 * branch forked from most recently), --scope <glob,...>, --pr-body-file <path> (or env PR_BODY),
 * --require-scope (CI: the PR body is the ONLY scope source; a missing scope, a scope that spans
 * the repo, or a brace glob FAILS), --allow-missing-tools, --skip-gates (execution only; the input-to-gate mapping is
 * still checked), --skip-tests, --root <dir>.
 *
 * CI (`.github/workflows/prepush-check.yml`) runs it with --require-scope --skip-gates
 * --skip-tests. It therefore does NOT execute gates or tests: each gate runs in its own
 * workflow, and this job proves a scope was declared and every input maps to a gate.
 *
 * Exit: 0 clean (warnings allowed); 1 any failure. No git hook is installed.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  bracedScopes,
  GATE_INPUT_REGISTRY,
  broadScopes,
  changedGateInputs,
  changedTestFiles,
  groupByArea,
  newEntries,
  outOfScope,
  parseScopeLines,
  pickBase,
  planGateRuns,
  staticTempDirFindings,
  testsCovering,
} from './lib/prepush-check.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
/** Cap on tests run when falling back to covering tests, to keep the check quick. */
const MAX_COVERING_TESTS = 20;
/** Candidate base refs; `pickBase` takes the one the branch forked from most recently. */
const BASES = ['personal/integration/v2', 'origin/integration/v2', 'personal/main', 'origin/main'];

/**
 * `[commits from ref's merge-base with HEAD to HEAD, commits from that merge-base to ref]`,
 * or null when `ref` does not resolve or shares no history with HEAD.
 */
function distanceFrom(root, ref) {
  const q = (args) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  if (q(['rev-parse', '--verify', '-q', ref]).status !== 0) return null;
  const mb = q(['merge-base', 'HEAD', ref]);
  if (mb.status !== 0) return null;
  const m = mb.stdout.trim();
  const mine = q(['rev-list', '--count', `${m}..HEAD`]);
  const theirs = q(['rev-list', '--count', `${m}..${ref}`]);
  return mine.status === 0 && theirs.status === 0
    ? [Number(mine.stdout.trim()), Number(theirs.stdout.trim())]
    : null;
}

function git(root, args) {
  const r = spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

const onPath = (bin) => spawnSync('which', [bin], { encoding: 'utf8' }).status === 0;
const which = (bin) => spawnSync('which', [bin], { encoding: 'utf8' }).stdout.trim();

/** Default spawns; tests replace them. */
export const REAL_DEPS = {
  onPath,
  which,
  runGate: (root, script, args) =>
    spawnSync('node', [script, ...args], { cwd: root, stdio: 'inherit' }).status,
  runTests: (root, files) =>
    spawnSync('node', ['scripts/bun-test.mjs', ...files], { cwd: root, stdio: 'inherit' }).status,
  tmpRoot: () => tmpdir(),
};

function snapshot(root, deps) {
  return {
    tmp: new Set(readdirSync(deps.tmpRoot())),
    untracked: new Set(
      git(root, ['ls-files', '-o', '--exclude-standard', '--directory'])
        .split('\n')
        .filter(Boolean),
    ),
  };
}

/**
 * @returns {{ exit: number, failures: string[], warnings: string[] }}
 */
export function runChecks(opts, deps = REAL_DEPS) {
  const root = opts.root;
  const failures = [];
  const warnings = [];
  const notices = [];
  const say = (s = '') => console.log(s);

  const base = opts.base ?? pickBase(BASES, (b) => distanceFrom(root, b));
  if (!base) {
    failures.push(`no base ref found (tried ${BASES.join(', ')}); pass --base <ref>`);
    return { exit: 1, failures, warnings };
  }
  // Every documented exemption is listed on EVERY run, not only when its file changes: an
  // input that nothing local can gate is a standing fact worth seeing, not a one-off.
  for (const [input, r] of Object.entries(opts.registry ?? GATE_INPUT_REGISTRY)) {
    if (r.exempt) notices.push(`${input} has no local gate (documented exemption): ${r.exempt}`);
  }
  const mergeBase = git(root, ['merge-base', 'HEAD', base]).trim();
  say(`prepush-check: base ${base}, merge-base ${mergeBase.slice(0, 12)}`);

  // ONE basis for every check: merge-base...HEAD, plus uncommitted changes
  // (tracked edits and untracked files), which are reported as such.
  const lines = (args) => git(root, args).split('\n').filter(Boolean);
  const committed = lines(['diff', '--name-only', `${mergeBase}...HEAD`]);
  const uncommitted = [
    ...new Set([
      ...lines(['diff', '--name-only', 'HEAD']),
      ...lines(['ls-files', '-o', '--exclude-standard']),
    ]),
  ].sort();
  const changed = [...new Set([...committed, ...uncommitted])].sort();
  if (uncommitted.length > 0) {
    warnings.push(
      `${uncommitted.length} uncommitted file(s) included in every check: ${uncommitted.join(', ')}`,
    );
  }

  // 1. gates on changed data
  say('\n=== 1. gates on changed security/ gate inputs ===');
  const allowlists = changedGateInputs(changed);
  if (allowlists.length === 0)
    say('no security/*.json (or .yaml) gate input changed; nothing to run');
  else {
    say(`changed: ${allowlists.join(', ')}`);
    const {
      runs,
      unknown,
      tests: gateTests,
      unmapped,
    } = planGateRuns(root, allowlists, opts.gateTable, opts.registry);
    // Mapping is checked even when execution is skipped: an input nothing gates is a defect
    // regardless of whether this run can execute gates.
    for (const u of unmapped) {
      failures.push(
        `${u} is a security/ gate input that no gate is mapped to: add it to GATE_INPUT_REGISTRY (scripts/lib/prepush-check.mjs) with a gate script, a test that reads it by path and that CI runs, or an exempt reason`,
      );
    }
    for (const u of unknown) {
      failures.push(
        `${u.script} reads ${u.allowlist} but is not in GATE_INPUT_REGISTRY (scripts/lib/prepush-check.mjs) as a gate or an excused reader; register it so it is run or explained`,
      );
    }
    if (opts.skipGates) {
      warnings.push(
        'gates NOT executed (--skip-gates); only the input-to-gate mapping was checked',
      );
    } else {
      runGates(runs, gateTests);
    }
  }

  function runGates(runs, gateTests) {
    if (gateTests.length > 0) {
      say(`\n--- tests that name the changed input(s): ${gateTests.join(', ')}`);
      if (!deps.onPath('bun')) {
        const msg = `${gateTests.join(' ')}: UNVERIFIED, bun not on PATH`;
        (opts.allowMissingTools ? warnings : failures).push(msg);
      } else {
        const status = deps.runTests(root, gateTests);
        if (status !== 0) failures.push(`gate tests ${gateTests.join(' ')}: exit ${status}`);
      }
    }
    let sbomDir = '';
    const needsSbom = runs.some((r) => r.entry.sbom);
    if (needsSbom) {
      sbomDir = mkdtempSync(join(tmpdir(), 'prepush-sbom-'));
    }
    try {
      for (const r of runs) {
        const label = `${r.script} ${r.args.join(' ')}`.trim();
        const missing = r.entry.needs.filter((b) => !deps.onPath(b));
        if (missing.length > 0) {
          const msg = `${label}: UNVERIFIED, ${missing.join(', ')} not on PATH`;
          (opts.allowMissingTools ? warnings : failures).push(msg);
          continue;
        }
        const args = [...r.args];
        if (r.entry.scanner) args.push('--scanner', deps.which('osv-scanner'));
        if (r.entry.base) args.push('--base', mergeBase);
        if (r.entry.sbom) {
          args.push('--sbom-out', join(sbomDir, 'sbom.cdx.json'));
        }
        say(`\n--- ${label}`);
        const status = deps.runGate(root, r.script, args);
        if (status !== 0) failures.push(`${label}: exit ${status}`);
      }
    } finally {
      if (sbomDir) rmSync(sbomDir, { recursive: true, force: true });
    }
  }

  // 2. temp-dir leak scan around the changed tests
  say('\n=== 2. temp-dir leak scan ===');
  const allTests = [
    ...lines(['ls-files', 'tests']),
    ...lines(['ls-files', '-o', '--exclude-standard', 'tests']),
  ].filter((f) => changedTestFiles([f]).length > 0);
  let tests = changedTestFiles(changed).filter((f) => existsSync(join(root, f)));
  if (tests.length === 0 && !opts.skipTests) {
    // Only source changed: fall back to the tests that import it.
    tests = testsCovering(root, changed, allTests).slice(0, MAX_COVERING_TESTS);
    if (tests.length > 0)
      say(`no changed tests; running ${tests.length} test(s) that import the changed source`);
  }
  if (opts.skipTests) warnings.push('leak scan skipped by --skip-tests');
  else if (tests.length === 0) {
    warnings.push(
      'leak scan NOT exercised: no changed test files and no test imports the changed source, so nothing ran to leak',
    );
  } else {
    const before = snapshot(root, deps);
    const status = deps.runTests(root, tests);
    const after = snapshot(root, deps);
    if (status !== 0) failures.push(`changed tests failed (exit ${status})`);
    const leakedTmp = newEntries(before.tmp, after.tmp);
    const leakedRepo = newEntries(before.untracked, after.untracked);
    for (const e of leakedTmp) failures.push(`temp-dir leak: new entry in ${deps.tmpRoot()}: ${e}`);
    for (const e of leakedRepo) failures.push(`repo leak: new untracked entry at repo root: ${e}`);
    say(
      `ran ${tests.length} file(s); new tmp entries ${leakedTmp.length}, new untracked ${leakedRepo.length}`,
    );
  }

  // 3. static mkdtemp scan
  say('\n=== 3. static mkdtemp scan (tests/**) ===');
  const baselinePath = join(root, 'tests/scratch-space-exceptions.json');
  const baseline = existsSync(baselinePath)
    ? (JSON.parse(readFileSync(baselinePath, 'utf8')).unremovedTempDirs?.files ?? {})
    : {};
  const tracked = git(root, ['ls-files', 'tests']).split('\n').filter(Boolean);
  const untrackedTests = git(root, ['ls-files', '-o', '--exclude-standard', 'tests'])
    .split('\n')
    .filter(Boolean);
  const findings = staticTempDirFindings(
    root,
    [...tracked, ...untrackedTests].filter((f) => /\.(?:[cm]?[jt]sx?)$/.test(f)),
    baseline,
  );
  for (const f of findings) {
    failures.push(
      `${f.file}: ${f.sites} mkdtemp without a paired rmSync (baseline ${f.baseline}); remove it in a finally or afterAll`,
    );
  }
  say(
    findings.length === 0 ? 'every mkdtemp reaches a removal' : `${findings.length} file(s) leak`,
  );

  // 4. scope report
  say('\n=== 4. scope report ===');
  say(git(root, ['diff', '--stat', `${mergeBase}...HEAD`]).trimEnd());
  if (uncommitted.length > 0) say(`uncommitted (not in the stat above): ${uncommitted.join(', ')}`);
  for (const [area, fs] of groupByArea(changed)) say(`  ${area}/: ${fs.length} file(s)`);
  const prBody = opts.prBody ?? process.env.PR_BODY ?? '';
  let globs;
  if (opts.requireScope) {
    // CI: the PR body is the ONLY source. A commit trailer or --scope can be rewritten by
    // whoever pushes (rebase, amend) to widen the scope after the fact, so neither counts.
    globs = parseScopeLines(prBody);
  } else {
    globs = opts.scope ?? [];
    if (globs.length === 0)
      globs = parseScopeLines(git(root, ['log', '--format=%B', `${mergeBase}..HEAD`]));
    if (globs.length === 0) globs = parseScopeLines(prBody);
  }
  if (globs.length === 0) {
    const msg =
      'no scope declared (--scope, or a `Scope:` line in a commit/PR body); cannot flag out-of-scope files';
    if (opts.requireScope) {
      failures.push(
        'no `Scope: <glob>, <glob>` line in the PR body; declare what this PR touches (CI reads the PR body only)',
      );
    } else warnings.push(msg);
  } else {
    say(`declared scope: ${globs.join(', ')}`);
    const braced = bracedScopes(globs);
    if (braced.length > 0) {
      failures.push(
        `scope uses brace alternation (${braced.join(', ')}); scope lines are split on commas, so \`{a,b}\` would be cut in two. List each glob separately`,
      );
    }
    const broad = broadScopes(globs, lines(['ls-files']));
    if (broad.length > 0) {
      const msg = `scope is too broad (${broad.join(', ')}): it matches a path no repo has, or spans at least 75% of the top-level directories or more than 60% of tracked files, so it declares nothing`;
      (opts.requireScope ? failures : warnings).push(msg);
    }
    if (braced.length === 0) {
      for (const f of outOfScope(changed, globs)) failures.push(`out of scope: ${f}`);
    }
  }

  say('');
  for (const n of notices) say(`NOTICE  ${n}`);
  for (const w of warnings) say(`WARN  ${w}`);
  for (const f of failures) say(`FAIL  ${f}`);
  say(failures.length === 0 ? 'prepush-check OK' : `prepush-check FAILED (${failures.length})`);
  return { exit: failures.length === 0 ? 0 : 1, failures, warnings, notices };
}

function parseArgs(argv) {
  const o = { root: resolve(HERE, '..') };
  const val = (i) => argv[i + 1];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--base') o.base = val(i++);
    else if (a === '--root') o.root = resolve(val(i++));
    else if (a === '--scope')
      o.scope = val(i++)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
    else if (a === '--pr-body-file') o.prBody = readFileSync(val(i++), 'utf8');
    else if (a === '--require-scope') o.requireScope = true;
    else if (a === '--allow-missing-tools') o.allowMissingTools = true;
    else if (a === '--skip-gates') o.skipGates = true;
    else if (a === '--skip-tests') o.skipTests = true;
    else throw new Error(`unknown argument ${a}`);
  }
  return o;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(runChecks(parseArgs(process.argv.slice(2))).exit);
}
