#!/usr/bin/env node
/**
 * `node scripts/prepush-check.mjs` — run before pushing (agents included).
 *
 * Four checks over the diff from the merge base to your working tree:
 *
 *  1. GATES ON CHANGED DATA. If `security/*allowlist*.json` changed, run every
 *     gate that reads that file against the repo copy (found by scanning
 *     `scripts/`, run per `GATE_TABLE`). Non-zero exit fails. A gate whose tool
 *     is not installed is UNVERIFIED and fails too, unless --allow-missing-tools.
 *  2. TEMP-DIR LEAKS. Snapshot `tmpdir()` and the repo's untracked top-level
 *     entries, run the changed test files, snapshot again, fail on new entries.
 *     Anything else writing to the machine's tmpdir while this runs shows up as
 *     a leak; rerun when the machine is quiet before blaming your tests.
 *  3. STATIC SCAN. Every `mkdtemp` in `tests/**` must reach a removal, by the
 *     same scanner (`scratch-space-scan.mjs`) and per-file baseline
 *     (`tests/scratch-space-exceptions.json`) as `tests/temp-dirs-outside-the-repo.test.ts`.
 *  4. SCOPE REPORT. `git diff --stat <merge-base>...HEAD` grouped by top-level
 *     area. With a declared scope (--scope a/**,b/*.ts, or a `Scope:` line in a
 *     commit body or PR body) any file outside it FAILS; with none declared it
 *     WARNS.
 *
 * Options: --base <ref> (default: personal/integration/v2, origin/integration/v2,
 * origin/main), --scope <glob,...>, --pr-body-file <path> (or env PR_BODY),
 * --allow-missing-tools, --skip-gates, --skip-tests, --root <dir>.
 *
 * Exit: 0 clean (warnings allowed); 1 any failure. No git hook is installed.
 */

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  changedAllowlists,
  changedTestFiles,
  groupByArea,
  newEntries,
  outOfScope,
  parseScopeLines,
  planGateRuns,
  staticTempDirFindings,
} from './lib/prepush-check.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const BASES = ['personal/integration/v2', 'origin/integration/v2', 'origin/main'];

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
    spawnSync('node', [join('scripts', script), ...args], { cwd: root, stdio: 'inherit' }).status,
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
  const say = (s = '') => console.log(s);

  const base =
    opts.base ??
    BASES.find(
      (b) => spawnSync('git', ['rev-parse', '--verify', '-q', b], { cwd: root }).status === 0,
    );
  if (!base) {
    failures.push(`no base ref found (tried ${BASES.join(', ')}); pass --base <ref>`);
    return { exit: 1, failures, warnings };
  }
  const mergeBase = git(root, ['merge-base', 'HEAD', base]).trim();
  say(`prepush-check: base ${base}, merge-base ${mergeBase.slice(0, 12)}`);

  // Committed + working-tree changes since the merge base.
  const changed = git(root, ['diff', '--name-only', '--diff-filter=ACMRD', mergeBase])
    .split('\n')
    .filter(Boolean);

  // 1. gates on changed data
  say('\n=== 1. gates on changed allowlists ===');
  const allowlists = changedAllowlists(changed);
  if (opts.skipGates) warnings.push('gates skipped by --skip-gates');
  else if (allowlists.length === 0) say('no security/*allowlist*.json changed; nothing to run');
  else {
    say(`changed: ${allowlists.join(', ')}`);
    const { runs, unknown } = planGateRuns(join(root, 'scripts'), allowlists, opts.gateTable);
    for (const u of unknown) {
      failures.push(
        `${u.script} reads ${u.allowlist} but has no invocation in GATE_TABLE (scripts/lib/prepush-check.mjs); add it so it is run`,
      );
    }
    let sbomDir;
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
          sbomDir ??= mkdtempSync(join(tmpdir(), 'prepush-sbom-'));
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
  const tests = changedTestFiles(changed).filter((f) => existsSync(join(root, f)));
  if (opts.skipTests) warnings.push('leak scan skipped by --skip-tests');
  else if (tests.length === 0) say('no changed test files; nothing to run');
  else {
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
  const committed = git(root, ['diff', '--name-only', `${mergeBase}...HEAD`])
    .split('\n')
    .filter(Boolean);
  for (const [area, fs] of groupByArea(committed)) say(`  ${area}/: ${fs.length} file(s)`);
  let globs = opts.scope ?? [];
  if (globs.length === 0)
    globs = parseScopeLines(git(root, ['log', '--format=%B', `${mergeBase}..HEAD`]));
  if (globs.length === 0) {
    const body = opts.prBody ?? process.env.PR_BODY ?? '';
    globs = parseScopeLines(body);
  }
  if (globs.length === 0) {
    warnings.push(
      'no scope declared (--scope, or a `Scope:` line in a commit/PR body); cannot flag out-of-scope files',
    );
  } else {
    say(`declared scope: ${globs.join(', ')}`);
    for (const f of outOfScope(committed, globs)) failures.push(`out of scope: ${f}`);
  }

  say('');
  for (const w of warnings) say(`WARN  ${w}`);
  for (const f of failures) say(`FAIL  ${f}`);
  say(failures.length === 0 ? 'prepush-check OK' : `prepush-check FAILED (${failures.length})`);
  return { exit: failures.length === 0 ? 0 : 1, failures, warnings };
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
