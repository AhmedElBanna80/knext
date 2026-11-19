import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  changedAllowlists,
  changedTestFiles,
  discoverAllowlistGates,
  globToRegExp,
  groupByArea,
  newEntries,
  outOfScope,
  parseScopeLines,
  planGateRuns,
  staticTempDirFindings,
} from '../scripts/lib/prepush-check.mjs';
import { runChecks } from '../scripts/prepush-check.mjs';

/**
 * GUARDS for scripts/prepush-check.mjs. Every check is asserted both ways: the
 * defect it exists for is caught, and the clean case is not accused.
 */

const made: string[] = [];
const fixture = (): string => {
  const d = mkdtempSync(join(tmpdir(), 'prepush-check-test-'));
  made.push(d);
  return d;
};
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

const put = (root: string, rel: string, body: string) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), body);
};
const git = (root: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd: root, encoding: 'utf8' });

describe('allowlist gate discovery', () => {
  it('matches only security allowlist json files', () => {
    expect(
      changedAllowlists([
        'security/osv-allowlist.json',
        'security/gitleaks-allowlist.json',
        'security/bun-install-scripts.json',
        'docs/osv-allowlist.json',
        'security/sub/osv-allowlist.json',
      ]),
    ).toEqual(['security/osv-allowlist.json', 'security/gitleaks-allowlist.json']);
  });

  it('finds readers by scanning, skipping provers and lib', () => {
    const root = fixture();
    put(root, 'scripts/gate-a.mjs', "readFileSync('security/x-allowlist.json')");
    put(root, 'scripts/mutation-prove-a.mjs', 'x-allowlist.json');
    put(root, 'scripts/lib/helper.mjs', 'x-allowlist.json');
    put(root, 'scripts/other.mjs', 'nothing here');
    expect(discoverAllowlistGates(join(root, 'scripts'), 'security/x-allowlist.json')).toEqual([
      'gate-a.mjs',
    ]);
  });

  it('plans one run per table row and reports a reader with no invocation', () => {
    const root = fixture();
    put(root, 'scripts/known.mjs', 'x-allowlist.json');
    put(root, 'scripts/stranger.mjs', 'x-allowlist.json');
    const table = { 'known.mjs': { needs: [], runs: [['--a'], ['--b']] } };
    const { runs, unknown } = planGateRuns(
      join(root, 'scripts'),
      ['security/x-allowlist.json'],
      table,
    );
    expect(runs.map((r) => r.args)).toEqual([['--a'], ['--b']]);
    expect(unknown).toEqual([{ allowlist: 'security/x-allowlist.json', script: 'stranger.mjs' }]);
  });

  it('the shipped table covers every real reader of every real allowlist', () => {
    const root = join(import.meta.dir, '..');
    const all = ['gitleaks', 'npm-audit', 'osv', 'precompile-closure'].map(
      (n) => `security/${n}-allowlist.json`,
    );
    const { runs, unknown } = planGateRuns(join(root, 'scripts'), all);
    expect(unknown).toEqual([]);
    expect(new Set(runs.map((r) => r.script))).toEqual(
      new Set([
        'secret-scan.mjs',
        'precompile-closure-audit.mjs',
        'osv-gate.mjs',
        'audit-shipped-npm.mjs',
        'audit-published.mjs',
      ]),
    );
  });
});

describe('leak and static helpers', () => {
  it('newEntries reports only what appeared', () => {
    expect(newEntries(['a', 'b'], ['b', 'c', 'd'])).toEqual(['c', 'd']);
    expect(newEntries(['a'], ['a'])).toEqual([]);
  });

  it('static scan flags an unremoved mkdtemp, accepts a paired one, honours the baseline', () => {
    const root = fixture();
    put(root, 'tests/leaky.test.ts', "const d = mkdtempSync(join(tmpdir(), 'x-'));");
    put(
      root,
      'tests/clean.test.ts',
      "const d = mkdtempSync(join(tmpdir(), 'x-'));\nafterAll(() => rmSync(d, { recursive: true }));",
    );
    put(root, 'scripts/not-a-test.mjs', "const d = mkdtempSync(join(tmpdir(), 'x-'));");
    const files = ['tests/leaky.test.ts', 'tests/clean.test.ts', 'scripts/not-a-test.mjs'];
    expect(staticTempDirFindings(root, files)).toEqual([
      { file: 'tests/leaky.test.ts', sites: 1, baseline: 0 },
    ]);
    expect(staticTempDirFindings(root, files, { 'tests/leaky.test.ts': 1 })).toEqual([]);
  });
});

describe('scope helpers', () => {
  it('parses Scope lines, comma separated, ignoring other text', () => {
    expect(parseScopeLines('fix\n\nScope: scripts/**, tests/a.test.ts\nbody Scope: no')).toEqual([
      'scripts/**',
      'tests/a.test.ts',
    ]);
    expect(parseScopeLines('nothing')).toEqual([]);
  });

  it('globs: ** crosses directories, * does not, a bare dir covers its subtree', () => {
    expect(globToRegExp('scripts/**').test('scripts/lib/a.mjs')).toBe(true);
    expect(globToRegExp('scripts/*.mjs').test('scripts/lib/a.mjs')).toBe(false);
    expect(globToRegExp('scripts/*.mjs').test('scripts/a.mjs')).toBe(true);
    expect(globToRegExp('scripts/').test('scripts/lib/a.mjs')).toBe(true);
    expect(globToRegExp('**/a.ts').test('a.ts')).toBe(true);
    expect(globToRegExp('a.b').test('aXb')).toBe(false);
  });

  it('flags files outside the scope and groups by area', () => {
    const files = ['scripts/a.mjs', 'security/x.json', 'README.md'];
    expect(outOfScope(files, ['scripts/**'])).toEqual(['security/x.json', 'README.md']);
    expect(outOfScope(files, ['scripts/**', 'security/**', 'README.md'])).toEqual([]);
    expect([...groupByArea(files).keys()]).toEqual(['(root)', 'scripts', 'security']);
  });

  it('picks changed test files only', () => {
    expect(changedTestFiles(['tests/a.test.ts', 'tests/helpers/x.ts', 'a.test.mjs'])).toEqual([
      'tests/a.test.ts',
      'a.test.mjs',
    ]);
  });
});

describe('runChecks end to end on a fixture repo', () => {
  let quiet: ReturnType<typeof spyOn>;
  beforeAll(() => {
    quiet = spyOn(console, 'log').mockImplementation(() => {});
  });
  afterAll(() => quiet.mockRestore());

  const table = { 'gate.mjs': { needs: ['fakebin'], runs: [[]] } };
  function repo(): string {
    const root = fixture();
    git(root, 'init', '-q', '-b', 'main');
    put(root, 'scripts/gate.mjs', '// reads security/x-allowlist.json\n');
    put(root, 'security/x-allowlist.json', '[]');
    put(root, 'README.md', 'base');
    git(root, 'add', '.');
    git(root, 'commit', '-q', '-m', 'base');
    git(root, 'switch', '-q', '-c', 'feature');
    return root;
  }
  const commit = (root: string, msg = 'change') => {
    git(root, 'add', '.');
    git(root, 'commit', '-q', '-m', msg);
  };
  const deps = (over: Record<string, unknown> = {}) => ({
    onPath: () => true,
    which: () => '/bin/x',
    runGate: () => 0,
    runTests: () => 0,
    tmpRoot: () => '',
    ...over,
  });
  const opts = (root: string, over: Record<string, unknown> = {}) => ({
    root,
    base: 'main',
    scope: ['security/**', 'tests/**'],
    gateTable: table,
    ...over,
  });

  it('runs the gate on a changed allowlist and fails on a non-zero exit', () => {
    const root = repo();
    put(root, 'security/x-allowlist.json', '["new"]');
    commit(root);
    const ran: string[] = [];
    const bad = runChecks(
      opts(root),
      deps({ tmpRoot: () => root + '/.', runGate: (_r: string, s: string) => (ran.push(s), 1) }),
    );
    expect(ran).toEqual(['gate.mjs']);
    expect(bad.failures.some((f) => f.startsWith('gate.mjs: exit 1'))).toBe(true);
    const good = runChecks(opts(root), deps({ tmpRoot: () => root }));
    expect(good.failures).toEqual([]);
  });

  it('does not run a gate when no allowlist changed', () => {
    const root = repo();
    put(root, 'security/other.json', '[]');
    commit(root);
    let ran = 0;
    runChecks(opts(root), deps({ tmpRoot: () => root, runGate: () => (ran++, 1) }));
    expect(ran).toBe(0);
  });

  it('treats a missing tool as unverified (fail) unless allowed (warn)', () => {
    const root = repo();
    put(root, 'security/x-allowlist.json', '["new"]');
    commit(root);
    const d = deps({ tmpRoot: () => root, onPath: () => false });
    expect(runChecks(opts(root), d).failures.join()).toContain('UNVERIFIED');
    const soft = runChecks(opts(root, { allowMissingTools: true }), d);
    expect(soft.failures).toEqual([]);
    expect(soft.warnings.join()).toContain('UNVERIFIED');
  });

  it('fails on a reader of the allowlist that has no invocation', () => {
    const root = repo();
    put(root, 'scripts/second.mjs', 'security/x-allowlist.json');
    put(root, 'security/x-allowlist.json', '["new"]');
    commit(root);
    const r = runChecks(opts(root, { scope: ['**'] }), deps({ tmpRoot: () => root }));
    expect(r.failures.join()).toContain('second.mjs reads security/x-allowlist.json');
  });

  it('fails when changed tests leak into tmpdir or the repo root, and not otherwise', () => {
    const root = repo();
    const tmp = fixture();
    put(root, 'tests/a.test.ts', 'x');
    commit(root);
    const leakTmp = runChecks(
      opts(root),
      deps({ tmpRoot: () => tmp, runTests: () => (mkdirSync(join(tmp, 'leaked-x')), 0) }),
    );
    expect(leakTmp.failures.join()).toContain('temp-dir leak: new entry');
    const leakRepo = runChecks(
      opts(root),
      deps({ tmpRoot: () => tmp, runTests: () => (mkdirSync(join(root, 'fixture-leak')), 0) }),
    );
    expect(leakRepo.failures.join()).toContain(
      'repo leak: new untracked entry at repo root: fixture-leak/',
    );
    rmSync(join(root, 'fixture-leak'), { recursive: true });
    const clean = runChecks(opts(root), deps({ tmpRoot: () => tmp }));
    expect(clean.failures).toEqual([]);
  });

  it('fails the static scan on a test with an unremoved mkdtemp', () => {
    const root = repo();
    put(root, 'tests/leaky.test.ts', "const d = mkdtempSync(join(tmpdir(), 'x-'));");
    commit(root);
    const r = runChecks(opts(root), deps({ tmpRoot: () => root }));
    expect(r.failures.join()).toContain('tests/leaky.test.ts: 1 mkdtemp without a paired rmSync');
  });

  it('flags out-of-scope files when a scope is declared and only warns when none is', () => {
    const root = repo();
    put(root, 'README.md', 'reverted by accident');
    put(root, 'security/y.json', '[]');
    commit(root, 'change\n\nScope: security/**');
    const noFlag = runChecks(opts(root, { scope: undefined }), deps({ tmpRoot: () => root }));
    expect(noFlag.failures).toEqual(['out of scope: README.md']);
    const undeclared = repo();
    put(undeclared, 'README.md', 'x');
    commit(undeclared, 'no scope here');
    const w = runChecks(
      opts(undeclared, { scope: undefined }),
      deps({ tmpRoot: () => undeclared }),
    );
    expect(w.failures).toEqual([]);
    expect(w.warnings.join()).toContain('no scope declared');
  });
});
