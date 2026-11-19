import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  bareInvocations,
  bracedScopes,
  branchBlockProblems,
  broadScopes,
  ciRunsTest,
  driftBetween,
  evalBranchBlock,
  exemptInputs,
  changedGateInputs,
  changedTestFiles,
  deriveWorkflowArgSets,
  GATE_INPUT_REGISTRY,
  GATE_TABLE,
  globToRegExp,
  groupByArea,
  newEntries,
  outOfScope,
  parseScopeLines,
  pickBase,
  planGateRuns,
  readsByPath,
  runsWholeSuite,
  scanReaders,
  scanTestReaders,
  staticTempDirFindings,
  stripBranchSpecific,
  testsCovering,
} from '../scripts/lib/prepush-check.mjs';
import { main as driftMain } from '../scripts/prepush-lib-drift.mjs';
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
/** Remove every fixture dir. Idempotent, so it can run from afterAll AND from an exit/signal path. */
const cleanup = () => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
};
afterAll(cleanup);
// A run that is killed or exits abnormally skips afterAll; these cover that path, so a
// fixture never outlives the process (the leftovers the prepush leak scan then reds on).
process.on('exit', cleanup);
for (const [sig, code] of [
  ['SIGINT', 130],
  ['SIGTERM', 143],
  ['SIGHUP', 129],
] as const) {
  process.once(sig, () => {
    cleanup();
    process.exit(code);
  });
}

const put = (root: string, rel: string, body: string) => {
  mkdirSync(dirname(join(root, rel)), { recursive: true });
  writeFileSync(join(root, rel), body);
};
const git = (root: string, ...args: string[]) =>
  execFileSync(
    'git',
    [
      '-c',
      'commit.gpgsign=false',
      '-c',
      'user.name=knext-test',
      '-c',
      'user.email=knext-test@example.invalid',
      ...args,
    ],
    { cwd: root, encoding: 'utf8' },
  );

describe('allowlist gate discovery', () => {
  it('matches every file under security/ at any depth and extension, except Markdown prose', () => {
    expect(
      changedGateInputs([
        'security/a-allowlist.json',
        'security/b-exceptions.json',
        'security/c.yaml',
        'security/d.yml',
        'security/e.txt',
        'security/noext',
        'security/sub/deep/f.json',
        'security/README.md',
        'security/sub/NOTES.md',
        'docs/a-allowlist.json',
        'xsecurity/a.json',
      ]),
    ).toEqual([
      'security/a-allowlist.json',
      'security/b-exceptions.json',
      'security/c.yaml',
      'security/d.yml',
      'security/e.txt',
      'security/noext',
      'security/sub/deep/f.json',
    ]);
  });

  it('scans readers: direct, via an imported lib, not comments, not provers; workflows too', () => {
    const root = fixture();
    put(root, 'scripts/direct.mjs', "readFileSync('security/x-allowlist.json')");
    put(root, 'scripts/lib/shared.mjs', "export const P = 'security/x-allowlist.json';");
    put(root, 'scripts/via-lib.mjs', "import { P } from './lib/shared.mjs';");
    put(root, 'scripts/sub/deep.sh', 'node -e "require(\'../lib/shared.mjs\')"');
    put(root, 'scripts/sub/deep.mjs', "import('../lib/shared.mjs');");
    put(
      root,
      'scripts/comment-only.mjs',
      '// see security/x-allowlist.json\n/* x-allowlist.json */',
    );
    put(root, 'scripts/mutation-prove-a.mjs', "'x-allowlist.json'");
    put(root, 'scripts/unrelated.mjs', "import './lib/other.mjs'");
    put(root, 'scripts/lib/other.mjs', 'export {}');
    put(root, '.github/workflows/w.yml', 'steps:\n  - run: cat security/x-allowlist.json\n');
    put(root, '.github/workflows/c.yml', '# security/x-allowlist.json\n');
    expect(scanReaders(root, 'security/x-allowlist.json')).toEqual({
      manifests: [],
      scripts: [
        'scripts/direct.mjs',
        'scripts/sub/deep.mjs',
        'scripts/sub/deep.sh',
        'scripts/via-lib.mjs',
      ],
      workflows: ['.github/workflows/w.yml'],
    });
  });

  it('plans gate runs from the registry and reports any unregistered reader', () => {
    const root = fixture();
    put(root, 'scripts/known.mjs', 'x-allowlist.json');
    put(root, 'scripts/stranger.mjs', 'x-allowlist.json');
    put(root, 'scripts/lib/shared.mjs', 'x-allowlist.json');
    put(root, 'scripts/transitive.mjs', "import './lib/shared.mjs'");
    put(root, 'scripts/excused.mjs', 'x-allowlist.json');
    put(root, '.github/workflows/w.yml', '  - run: node scripts/audit.mjs --app apps/a\n');
    put(
      root,
      '.github/workflows/v.yml',
      '  - run: node scripts/audit.mjs --app apps/b --closure c\n',
    );
    put(root, 'scripts/audit.mjs', 'x-allowlist.json');
    const table: any = {
      'scripts/known.mjs': { needs: [], runs: [['--a'], ['--b']] },
      'scripts/audit.mjs': { needs: [], runs: 'workflows' },
    };
    const registry = {
      'security/x-allowlist.json': {
        gates: ['scripts/known.mjs', 'scripts/audit.mjs'],
        other: {
          'scripts/excused.mjs': 'reason',
          '.github/workflows/w.yml': 'runner',
          '.github/workflows/v.yml': 'runner',
        },
      },
    };
    const { runs, unknown } = planGateRuns(root, ['security/x-allowlist.json'], table, registry);
    expect(runs.map((r) => `${r.script} ${r.args.join(' ')}`)).toEqual([
      'scripts/known.mjs --a',
      'scripts/known.mjs --b',
      'scripts/audit.mjs --app apps/a',
      'scripts/audit.mjs --app apps/b --closure c',
    ]);
    expect(unknown.map((u) => u.script).sort()).toEqual([
      'scripts/stranger.mjs',
      'scripts/transitive.mjs',
    ]);
  });

  it('a registry gate with no table entry, or no derivable args, is reported', () => {
    const root = fixture();
    put(root, 'scripts/g.mjs', 'x-allowlist.json');
    const registry = { 'security/x-allowlist.json': { gates: ['scripts/g.mjs'], other: {} } };
    const none = planGateRuns(root, ['security/x-allowlist.json'], {}, registry);
    expect(none.unknown.map((u) => u.script)).toEqual(['scripts/g.mjs']);
    const noWf = planGateRuns(
      root,
      ['security/x-allowlist.json'],
      { 'scripts/g.mjs': { needs: [], runs: 'workflows' } } as any,
      registry,
    );
    expect(noWf.unknown[0].script).toContain('no workflow step found');
  });

  it('joins YAML continuation lines and never runs a closure audit bare', () => {
    const root = fixture();
    put(
      root,
      '.github/workflows/a.yml',
      'steps:\n  - run: |\n      node scripts/audit.mjs \\\n        --app apps/multi\n' +
        "  - run: node scripts/audit.mjs --closure examples/c\n  - paths: ['scripts/audit.mjs']\n" +
        '  # run: node scripts/audit.mjs\n',
    );
    expect(deriveWorkflowArgSets(root, 'scripts/audit.mjs')).toEqual([
      ['--app', 'apps/multi'],
      ['--closure', 'examples/c'],
    ]);
    expect(bareInvocations(root, 'scripts/audit.mjs')).toEqual([]); // comments and path filters are not invocations
    put(root, '.github/workflows/b.yml', 'steps:\n  - run: node scripts/audit.mjs\n');
    put(root, 'scripts/audit.mjs', 'x-allowlist.json');
    const registry = {
      'security/x-allowlist.json': {
        gates: ['scripts/audit.mjs'],
        other: Object.fromEntries(
          ['a', 'b'].map((n) => [`.github/workflows/${n}.yml`, 'runner'] as const),
        ),
      },
    };
    const table: any = { 'scripts/audit.mjs': { needs: [], runs: 'workflows' } };
    const { runs, unknown } = planGateRuns(root, ['security/x-allowlist.json'], table, registry);
    expect(runs.map((r) => r.args.join(' '))).toEqual(['--app apps/multi', '--closure examples/c']);
    expect(unknown.map((u) => u.script).join()).toContain('refusing to run it bare');
    expect(runs.some((r) => r.args.length === 0)).toBe(false);
  });

  it('follows node/bun/bash/sh invocations and package.json scripts as edges', () => {
    const root = fixture();
    put(root, 'scripts/reader.mjs', "read('security/x-allowlist.json')");
    put(root, 'scripts/by-node.sh', 'node scripts/reader.mjs');
    put(root, 'scripts/by-bash.sh', 'bash ./by-node.sh');
    put(root, 'scripts/by-bun.ts', "// bun scripts/reader.mjs\nrun('bun run scripts/reader.mjs')");
    put(root, 'scripts/by-sh.sh', 'sh "$ROOT/scripts/by-node.sh"');
    put(root, 'scripts/not-an-invocation.mjs', "log('scripts/reader.mjs')");
    put(root, '.github/workflows/w.yml', '  - run: bash scripts/by-bash.sh\n');
    put(root, '.github/actions/a/action.yml', 'run: node scripts/reader.mjs\n');
    put(
      root,
      'package.json',
      JSON.stringify({
        '//note': 'x-allowlist.json',
        scripts: { gate: 'node scripts/reader.mjs' },
      }),
    );
    put(
      root,
      'packages/p/package.json',
      JSON.stringify({ '//note': 'x-allowlist.json', scripts: {} }),
    );
    expect(scanReaders(root, 'security/x-allowlist.json')).toEqual({
      scripts: [
        'scripts/by-bash.sh',
        'scripts/by-bun.ts',
        'scripts/by-node.sh',
        'scripts/by-sh.sh',
        'scripts/reader.mjs',
      ],
      workflows: ['.github/actions/a/action.yml', '.github/workflows/w.yml'],
      manifests: ['package.json'],
    });
  });

  it('flags sources that list the security directory as readers of every allowlist', () => {
    const root = fixture();
    put(root, 'scripts/ls.mjs', "readdirSync(join(root, 'security')).map(read)");
    put(root, 'scripts/glob.mjs', "for await (const f of glob('security/*.json')) use(f)");
    put(root, 'scripts/loop.sh', 'for f in security/*.json; do cat "$f"; done');
    put(root, 'scripts/docs.mjs', "readdirSync('docs')");
    put(root, 'scripts/comment.mjs', "// readdirSync('security')");
    put(root, '.github/actions/a/run.sh', 'ls security/*');
    const r = scanReaders(root, 'security/anything-allowlist.json');
    expect(r.scripts).toEqual(['scripts/glob.mjs', 'scripts/loop.sh', 'scripts/ls.mjs']);
    expect(r.workflows).toEqual(['.github/actions/a/run.sh']);
  });

  describe('against the real repo', () => {
    const root = join(import.meta.dir, '..');
    const walkSec = (rel: string): string[] =>
      readdirSync(join(root, rel), { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walkSec(`${rel}/${e.name}`) : [`${rel}/${e.name}`],
      );
    const onDisk = walkSec('security').filter((f) => !f.endsWith('.md'));

    it('registers every security/ data file on disk, and nothing else', () => {
      expect(Object.keys(GATE_INPUT_REGISTRY).sort()).toEqual([...onDisk].sort());
    });

    it('every script and workflow that reads an allowlist is a registered gate or excused reader', () => {
      for (const allowlist of Object.keys(GATE_INPUT_REGISTRY)) {
        const reg = GATE_INPUT_REGISTRY[allowlist as keyof typeof GATE_INPUT_REGISTRY];
        const { scripts, workflows } = scanReaders(root, allowlist);
        const known = new Set([...reg.gates, ...Object.keys(reg.other)]);
        expect(
          [...scripts, ...workflows].filter((r) => !known.has(r)),
          `${allowlist} is read by something the registry does not list`,
        ).toEqual([]);
      }
    });

    it('registry entries are live: each gate really reads its allowlist and has a table row', () => {
      for (const [allowlist, reg] of Object.entries(GATE_INPUT_REGISTRY)) {
        const { scripts, workflows } = scanReaders(root, allowlist);
        const found = new Set([...scripts, ...workflows]);
        for (const g of reg.gates) {
          expect(found.has(g), `${g} no longer reads ${allowlist}`).toBe(true);
          expect(g in GATE_TABLE, `${g} has no GATE_TABLE row`).toBe(true);
        }
        for (const o of Object.keys(reg.other)) {
          expect(found.has(o), `${o} no longer reads ${allowlist}; drop its excuse`).toBe(true);
        }
      }
      for (const [input, reg] of Object.entries(GATE_INPUT_REGISTRY)) {
        expect(
          reg.gates.length + scanTestReaders(root, input).length + (reg.exempt ? 1 : 0),
          `${input} has no gate: no registered script, no CI-run test reading it, no exemption`,
        ).toBeGreaterThan(0);
      }
      for (const g of Object.keys(GATE_TABLE)) {
        expect(
          Object.values(GATE_INPUT_REGISTRY).some((r) => r.gates.includes(g)),
          `${g} is in GATE_TABLE but gates no allowlist`,
        ).toBe(true);
      }
    });

    it('the precompile-closure targets are derived from the workflows, matching the known set', () => {
      const derived = deriveWorkflowArgSets(root, 'scripts/precompile-closure-audit.mjs').map((a) =>
        a.join(' '),
      );
      expect(derived).toEqual([
        '--app apps/docs',
        '--app apps/file-manager',
        '--closure examples/bun-exec',
      ]);
    });
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

  const table = { 'scripts/gate.mjs': { needs: ['fakebin'], runs: [[]] } };
  const registry = {
    'security/x-allowlist.json': { gates: ['scripts/gate.mjs'], other: {} },
  };
  function repo(): string {
    const root = fixture();
    git(root, 'init', '-q', '-b', 'main');
    put(root, 'scripts/gate.mjs', "readFileSync('security/x-allowlist.json');\n");
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
    registry,
    ...over,
  });

  it('runs the gate on a changed allowlist and fails on a non-zero exit', () => {
    const root = repo();
    put(root, 'security/x-allowlist.json', '["new"]');
    commit(root);
    const ran: string[] = [];
    const bad = runChecks(
      opts(root),
      deps({ tmpRoot: () => `${root}/.`, runGate: (_r: string, s: string) => (ran.push(s), 1) }),
    );
    expect(ran).toEqual(['scripts/gate.mjs']);
    expect(bad.failures.some((f) => f.startsWith('scripts/gate.mjs: exit 1'))).toBe(true);
    const good = runChecks(opts(root), deps({ tmpRoot: () => root }));
    expect(good.failures).toEqual([]);
  });

  it('does not run a gate when no allowlist changed', () => {
    const root = repo();
    put(root, 'docs/other.json', '[]');
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
    put(root, 'scripts/second.mjs', "read('security/x-allowlist.json')");
    put(root, 'security/x-allowlist.json', '["new"]');
    commit(root);
    const r = runChecks(opts(root, { scope: ['**'] }), deps({ tmpRoot: () => root }));
    expect(r.failures.join()).toContain('scripts/second.mjs reads security/x-allowlist.json');
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
    put(root, 'security/y.md', '[]');
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

  it('uses one basis: uncommitted changes count for gates, scope and area, and are flagged', () => {
    const root = repo();
    put(root, 'README.md', 'committed');
    commit(root);
    put(root, 'security/x-allowlist.json', '["uncommitted"]'); // tracked edit, not committed
    put(root, 'untracked-new.txt', 'x'); // untracked
    const ran: string[] = [];
    const r = runChecks(
      opts(root, { scope: ['README.md'] }),
      deps({
        tmpRoot: () => root,
        runGate: (_r: string, s: string) => (ran.push(s), 0),
      }),
    );
    expect(ran).toEqual(['scripts/gate.mjs']);
    expect(r.failures.sort()).toEqual([
      'out of scope: security/x-allowlist.json',
      'out of scope: untracked-new.txt',
    ]);
    expect(r.warnings.join()).toContain('2 uncommitted file(s) included in every check');
  });

  it('with only source changed, runs the tests that import it; with none, WARNs not-exercised', () => {
    const root = repo();
    put(root, 'scripts/lib/thing.mjs', 'export {};');
    put(root, 'tests/thing.test.ts', "import '../scripts/lib/thing.mjs';\n");
    put(root, 'tests/other.test.ts', 'export {};');
    git(root, 'add', '.');
    git(root, 'commit', '-q', '-m', 'base2');
    git(root, 'switch', '-q', '-c', 'src-only');
    put(root, 'scripts/lib/thing.mjs', 'export const x = 1;');
    commit(root);
    const ran: string[][] = [];
    const r = runChecks(
      opts(root, { base: 'feature', scope: ['scripts/**'] }),
      deps({ tmpRoot: () => root, runTests: (_r: string, f: string[]) => (ran.push(f), 0) }),
    );
    expect(ran).toEqual([['tests/thing.test.ts']]);
    expect(r.warnings.join()).not.toContain('NOT exercised');

    git(root, 'switch', '-q', '-c', 'no-cover');
    put(root, 'scripts/lib/lonely.mjs', 'export {};');
    commit(root);
    const none = runChecks(
      opts(root, { base: 'src-only', scope: ['scripts/**'] }),
      deps({ tmpRoot: () => root, runTests: () => 1 }),
    );
    expect(none.warnings.join()).toContain('leak scan NOT exercised');
    expect(none.failures).toEqual([]);
  });

  it('finds covering tests by import path, with or without extension, and not by prefix', () => {
    const root = fixture();
    put(root, 'tests/a.test.ts', "import x from '../scripts/lib/a.mjs';");
    put(root, 'tests/b.test.ts', "import x from '../scripts/lib/a';");
    put(root, 'tests/c.test.ts', "import x from '../scripts/lib/a-longer.mjs';");
    expect(
      testsCovering(
        root,
        ['scripts/lib/a.mjs'],
        ['tests/a.test.ts', 'tests/b.test.ts', 'tests/c.test.ts'],
      ),
    ).toEqual(['tests/a.test.ts', 'tests/b.test.ts']);
  });
});

describe('gate inputs that are not allowlists (every security/ file must map to a gate)', () => {
  const IN = 'security/x-exceptions.json';
  const READS = "const j = JSON.parse(readFileSync('security/x-exceptions.json', 'utf8'));";
  const CI_ALL = 'jobs:\n  t:\n    steps:\n      - run: node scripts/bun-test.mjs --coverage\n';

  it('readsByPath: the file must be opened by its path, as a whole string, near a read or import', () => {
    expect(readsByPath(READS, IN)).toBe(true);
    expect(readsByPath("read('../security/x-exceptions.json')", IN)).toBe(true);
    expect(readsByPath("const p = join(root, 'security', 'x-exceptions.json');\nread(p)", IN)).toBe(
      true,
    );
    expect(readsByPath('import j from "../security/x-exceptions.json"', IN)).toBe(true);
    // a bare basename, a longer name, a prose mention, a comment, or a path with no read: no
    expect(readsByPath("expect(text).toContain('x-exceptions.json')", IN)).toBe(false);
    expect(readsByPath("read('security/my-x-exceptions.json')", IN)).toBe(false);
    expect(readsByPath("read('security/x-exceptions.json.bak')", IN)).toBe(false);
    expect(readsByPath("// read('security/x-exceptions.json')", IN)).toBe(false);
    expect(readsByPath("const note = 'security/x-exceptions.json';\n\n\n\n\nfoo();", IN)).toBe(
      false,
    );
    expect(readsByPath("read('docs/x-exceptions.json')", IN)).toBe(false);
  });

  it('ciRunsTest: a workflow runs the whole suite or names the file; partitioned tests need a name', () => {
    const root = fixture();
    put(root, '.github/workflows/ci.yml', CI_ALL);
    expect(ciRunsTest(root, 'tests/a.test.ts')).toBe(true);
    expect(ciRunsTest(root, 'tests/a.docker-e2e.test.ts')).toBe(false);
    put(
      root,
      '.github/workflows/e2e.yml',
      'steps:\n  - run: node scripts/bun-test.mjs --no-skip tests/a.docker-e2e.test.ts\n',
    );
    expect(ciRunsTest(root, 'tests/a.docker-e2e.test.ts')).toBe(true);
    // a run of some OTHER file is not the whole suite
    const only = fixture();
    put(
      only,
      '.github/workflows/ci.yml',
      'steps:\n  - run: node scripts/bun-test.mjs tests/z.test.ts\n',
    );
    expect(ciRunsTest(only, 'tests/a.test.ts')).toBe(false);
    // no workflow, or only a comment: no
    const none = fixture();
    put(none, '.github/workflows/ci.yml', '# run: node scripts/bun-test.mjs\nsteps: []\n');
    expect(ciRunsTest(none, 'tests/a.test.ts')).toBe(false);
    expect(ciRunsTest(fixture(), 'tests/a.test.ts')).toBe(false);
  });

  it('scanTestReaders needs path-read AND a CI run; not comments, this guard, or other tests', () => {
    const root = fixture();
    put(root, '.github/workflows/ci.yml', CI_ALL);
    put(root, 'tests/named.test.ts', READS);
    put(root, 'tests/sub/deep.test.ts', READS);
    put(root, 'tests/mention.test.ts', "expect(t).toContain('x-exceptions.json')");
    put(root, 'tests/commented.test.ts', `// ${READS}`);
    put(root, 'tests/other.test.ts', "read('security/y.json')");
    put(root, 'tests/prepush-check.test.ts', READS);
    put(root, 'tests/helper.ts', READS);
    put(root, 'tests/slow.docker-e2e.test.ts', READS);
    expect(scanTestReaders(root, IN)).toEqual(['tests/named.test.ts', 'tests/sub/deep.test.ts']);
    // and with no workflow running tests, none qualifies
    const bare = fixture();
    put(bare, 'tests/named.test.ts', READS);
    expect(scanTestReaders(bare, IN)).toEqual([]);
  });

  const table = { 'scripts/g.mjs': { needs: [], runs: [[]] } };

  it('flags an input nothing gates as unmapped: no registry entry, or no gate and no qualifying test', () => {
    const root = fixture();
    expect(planGateRuns(root, [IN], table, {}).unmapped).toEqual([IN]);
    const empty = planGateRuns(root, [IN], table, { [IN]: { gates: [], other: {} } });
    expect(empty.unmapped).toEqual([IN]);
    // a test that only mentions the name does not map it
    put(root, '.github/workflows/ci.yml', CI_ALL);
    put(root, 'tests/m.test.ts', "expect(t).toContain('x-exceptions.json')");
    expect(planGateRuns(root, [IN], table, { [IN]: { gates: [], other: {} } }).unmapped).toEqual([
      IN,
    ]);
  });

  it('maps an input by a script gate, a qualifying test (and runs it), or a documented exemption', () => {
    const root = fixture();
    put(root, 'scripts/g.mjs', 'x-exceptions.json');
    const viaScript = planGateRuns(root, [IN], table, {
      [IN]: { gates: ['scripts/g.mjs'], other: {} },
    });
    expect(viaScript.unmapped).toEqual([]);
    expect(viaScript.runs.map((r) => r.script)).toEqual(['scripts/g.mjs']);

    const root2 = fixture();
    put(root2, '.github/workflows/ci.yml', CI_ALL);
    put(root2, 'tests/x.test.ts', READS);
    const viaTest = planGateRuns(root2, [IN], table, { [IN]: { gates: [], other: {} } });
    expect(viaTest.unmapped).toEqual([]);
    expect(viaTest.tests).toEqual(['tests/x.test.ts']);
    // a naming test alone is not enough: the input must be registered, so its readers are explained
    expect(planGateRuns(root2, [IN], table, {}).unmapped).toEqual([IN]);

    const exempt = planGateRuns(fixture(), [IN], table, {
      [IN]: { gates: [], other: {}, exempt: 'only a workflow step reads it' },
    });
    expect(exempt.unmapped).toEqual([]);
    expect(exempt.exempt).toEqual([{ input: IN, reason: 'only a workflow step reads it' }]);
  });

  it('an exemption that a real gate has since replaced is not reported', () => {
    const root = fixture();
    put(root, '.github/workflows/ci.yml', CI_ALL);
    put(root, 'tests/x.test.ts', READS);
    const r = planGateRuns(root, [IN], table, { [IN]: { gates: [], other: {}, exempt: 'stale' } });
    expect(r.exempt).toEqual([]);
    expect(r.tests).toEqual(['tests/x.test.ts']);
  });

  it('every input in the real repo is mapped; each exemption names a reason and no gate replaced it', () => {
    const root = join(import.meta.dir, '..');
    const inputs = Object.keys(GATE_INPUT_REGISTRY);
    const plan = planGateRuns(root, inputs);
    expect(plan.unmapped).toEqual([]);
    expect(plan.unknown).toEqual([]);
    for (const [input, reg] of Object.entries(GATE_INPUT_REGISTRY) as [string, any][]) {
      if (!reg.exempt) continue;
      expect(String(reg.exempt).length, `${input} needs a real reason`).toBeGreaterThan(40);
      expect(reg.gates, `${input} is exempt, so it has no script gate`).toEqual([]);
      expect(
        scanTestReaders(root, input),
        `${input} now has a test gate; drop the exemption`,
      ).toEqual([]);
    }
  });
});

describe('braces and the drift guard', () => {
  it('bracedScopes flags any glob carrying brace alternation, however the comma split cut it', () => {
    expect(bracedScopes(parseScopeLines('Scope: src/{a,b}/**, docs/**'))).toEqual([
      'src/{a',
      'b}/**',
    ]);
    expect(bracedScopes(['a/**', 'b/*.ts'])).toEqual([]);
  });

  const lib = (block: string) =>
    `a\n// BEGIN branch-specific (x)\n${block}\n// END branch-specific\nb\n`;

  it('stripBranchSpecific removes the block and demands exactly one ordered marker pair', () => {
    expect(stripBranchSpecific(lib('X\nY'))).toBe('a\nb\n');
    expect(() => stripBranchSpecific('a\nb')).toThrow(/exactly one/);
    expect(() => stripBranchSpecific(`${lib('X')}${lib('Y')}`)).toThrow(/exactly one/);
    expect(() => stripBranchSpecific('// END branch-specific\n// BEGIN branch-specific\n')).toThrow(
      /before BEGIN/,
    );
    // a string constant that names the marker is not a marker
    const named = `const M = '// BEGIN branch-specific';\n${lib('X')}`;
    expect(stripBranchSpecific(named)).toBe("const M = '// BEGIN branch-specific';\na\nb\n");
  });

  it('driftBetween: equal outside the block (block contents ignored), reports the first drift', () => {
    expect(driftBetween(lib('one'), lib('two\nlines')).same).toBe(true);
    const d = driftBetween(lib('x'), lib('x').replace('\nb\n', '\nB\n'));
    expect(d).toEqual({ same: false, line: 2, a: 'b', b: 'B' });
    expect(driftBetween(lib('x'), `${lib('x')}extra\n`).same).toBe(false);
  });

  it('the real lib carries exactly one marker pair, so the drift guard can compare it', () => {
    const text = readFileSync(join(import.meta.dir, '..', 'scripts/lib/prepush-check.mjs'), 'utf8');
    expect(stripBranchSpecific(text)).not.toContain('export const GATE_TABLE');
    expect(stripBranchSpecific(text)).toContain('export function planGateRuns');
  });
});

describe('scope enforcement (CI reads the PR body only)', () => {
  it('parses a CRLF PR body, which is what the GitHub UI produces', () => {
    expect(parseScopeLines('## x\r\n\r\nScope: a/**, b.md\r\nmore\r\n')).toEqual(['a/**', 'b.md']);
    expect(parseScopeLines('Scope: a/**\r\nScope: c/**')).toEqual(['a/**', 'c/**']);
  });

  // a repo-shaped file list: top-level directories plus root files, 4 files in each
  const tree = (areas: string[], per = 4) => [
    'README.md',
    'package.json',
    ...Array.from({ length: 20 }, (_, i) => `root${i}.txt`),
    ...areas.flatMap((a) =>
      Array.from({ length: per }, (_, i) => `${a}/f${i}.${['ts', 'md', 'mjs', 'yml'][i % 4]}`),
    ),
  ];
  const AREAS = ['.github', 'apps', 'docs', 'packages', 'scripts', 'tests'];
  const dirs = (as: string[]) => as.map((a) => `${a}/**`);

  it('broadScopes: a wildcard over directories is broad by what it matches, in any repo', () => {
    for (const g of ['**', '**/*', './**', '*/**', '**/**', '**/']) {
      expect(broadScopes([g]), g).toEqual([g]);
      expect(broadScopes([g], tree(AREAS)), g).toEqual([g]);
    }
    expect(broadScopes(['scripts/**', '**'], tree(AREAS))).toEqual(['**']);
    expect(broadScopes(['scripts/**', 'tests/**', 'docs/**'], tree(AREAS))).toEqual([]);
    expect(broadScopes(['*.md'], tree(AREAS))).toEqual([]);
  });

  it("broadScopes: spanning the repo is broad, from the repo's ACTUAL tracked areas", () => {
    const files = tree(AREAS);
    // the extension bypass: no glob is a wildcard, together they touch every directory
    expect(broadScopes(['**/*.ts', '**/*.md', '**/*.mjs', '**/*.yml'], files)).toHaveLength(4);
    // 5 of 6 areas = 83% >= 75%; 4 of 6 = 67% is not
    expect(broadScopes(dirs(AREAS.slice(0, 5)), files)).toHaveLength(5);
    expect(broadScopes(dirs(AREAS.slice(0, 4)), files)).toEqual([]);
    // more areas appearing in the repo make the same 5-glob scope narrower than 75%
    expect(broadScopes(dirs(AREAS.slice(0, 5)), tree([...AREAS, 'infra', 'deploy', 'x']))).toEqual(
      [],
    );
    // one big area is a legitimate claim, even above half the files
    const lopsided = [
      ...tree(AREAS, 2),
      ...Array.from({ length: 30 }, (_, i) => `packages/p/${i}.ts`),
    ];
    expect(broadScopes(['packages/**'], lopsided)).toEqual([]);
  });

  it('broadScopes: more than 60% of tracked files is broad even when few directories are touched', () => {
    const files = [
      ...tree(AREAS, 1),
      ...Array.from({ length: 40 }, (_, i) => `packages/p/${i}.ts`),
      ...Array.from({ length: 40 }, (_, i) => `apps/a/${i}.ts`),
    ];
    // packages + apps hold ~87% of files but are 2 of 6 directories; alone each is under 60%
    expect(broadScopes(['packages/**', 'apps/**'], files)).toHaveLength(2);
    expect(broadScopes(['packages/**'], files)).toEqual([]);
  });

  it('broadScopes: ratios are not judged in a repo too small for them to mean anything', () => {
    expect(broadScopes(['docs/**', 'scripts/**'], ['docs/a', 'scripts/b'])).toEqual([]);
    expect(broadScopes(['**'], ['docs/a', 'scripts/b'])).toEqual(['**']);
  });

  let quiet: ReturnType<typeof spyOn>;
  beforeAll(() => {
    quiet = spyOn(console, 'log').mockImplementation(() => {});
  });
  afterAll(() => quiet.mockRestore());

  function repo(): string {
    const root = fixture();
    git(root, 'init', '-q', '-b', 'main');
    put(root, 'README.md', 'base');
    git(root, 'add', '.');
    git(root, 'commit', '-q', '-m', 'base');
    git(root, 'switch', '-q', '-c', 'feature');
    put(root, 'docs/a.md', 'x');
    git(root, 'add', '.');
    git(root, 'commit', '-q', '-m', 'change\n\nScope: docs/**');
    return root;
  }
  const deps = {
    onPath: () => true,
    which: () => '/bin/x',
    runGate: () => 0,
    runTests: () => 0,
    tmpRoot: () => '',
  };
  const ci = (root: string, over: Record<string, unknown> = {}) =>
    runChecks(
      { root, base: 'main', requireScope: true, skipGates: true, skipTests: true, ...over },
      { ...deps, tmpRoot: () => root },
    );

  it('FAILS a missing Scope line in CI, even when a commit trailer declares one', () => {
    const root = repo();
    const r = ci(root, { prBody: 'no scope line here' });
    expect(r.exit).toBe(1);
    expect(r.failures.join()).toContain('no `Scope:');
  });

  it('ignores --scope and the commit trailer in CI (they can be rewritten); reads the PR body', () => {
    const root = repo();
    expect(ci(root, { prBody: '', scope: ['docs/**'] }).exit).toBe(1);
    expect(ci(root, { prBody: 'Scope: docs/**' }).failures).toEqual([]);
  });

  it('FAILS a match-everything scope in CI, and only warns locally', () => {
    const root = repo();
    const r = ci(root, { prBody: 'Scope: **' });
    expect(r.exit).toBe(1);
    expect(r.failures.join()).toContain('scope is too broad');
    const local = runChecks(
      { root, base: 'main', prBody: 'Scope: **', scope: ['**'], skipGates: true, skipTests: true },
      { ...deps, tmpRoot: () => root },
    );
    expect(local.failures).toEqual([]);
    expect(local.warnings.join()).toContain('scope is too broad');
  });

  it('still fails an out-of-scope file in CI', () => {
    const root = repo();
    const r = ci(root, { prBody: 'Scope: scripts/**' });
    expect(r.failures).toEqual(['out of scope: docs/a.md']);
  });

  it('without --require-scope a missing scope still only warns', () => {
    const root = repo();
    const r = runChecks(
      { root, base: 'main', prBody: '', skipGates: true, skipTests: true, scope: [] },
      { ...deps, tmpRoot: () => root },
    );
    // the commit trailer declares docs/**, so even locally it is found
    expect(r.failures).toEqual([]);
  });
});

describe('security/ inputs through runChecks', () => {
  let quiet: ReturnType<typeof spyOn>;
  beforeAll(() => {
    quiet = spyOn(console, 'log').mockImplementation(() => {});
  });
  afterAll(() => quiet.mockRestore());

  function repo(): string {
    const root = fixture();
    git(root, 'init', '-q', '-b', 'main');
    put(root, 'security/x-exceptions.json', '[]');
    put(root, 'tests/x.test.ts', "read('security/x-exceptions.json')");
    put(root, '.github/workflows/ci.yml', 'steps:\n  - run: node scripts/bun-test.mjs\n');
    put(root, 'README.md', 'base');
    git(root, 'add', '.');
    git(root, 'commit', '-q', '-m', 'base');
    git(root, 'switch', '-q', '-c', 'feature');
    put(root, 'security/x-exceptions.json', '["new"]');
    git(root, 'add', '.');
    git(root, 'commit', '-q', '-m', 'change');
    return root;
  }
  const deps = (over: Record<string, unknown> = {}) => ({
    onPath: () => true,
    which: () => '/bin/x',
    runGate: () => 0,
    runTests: () => 0,
    tmpRoot: () => '',
    ...over,
  });
  const o = (root: string, over: Record<string, unknown> = {}) => ({
    root,
    base: 'main',
    scope: ['security/**', 'tests/**'],
    skipTests: true,
    gateTable: {},
    registry: { 'security/x-exceptions.json': { gates: [], other: {} } },
    ...over,
  });

  it('runs the test that names a changed non-allowlist input, and fails when it fails', () => {
    const root = repo();
    const ran: string[][] = [];
    const ok = runChecks(
      o(root),
      deps({ tmpRoot: () => root, runTests: (_r: string, f: string[]) => (ran.push(f), 0) }),
    );
    expect(ran).toEqual([['tests/x.test.ts']]);
    expect(ok.failures).toEqual([]);
    const bad = runChecks(o(root), deps({ tmpRoot: () => root, runTests: () => 1 }));
    expect(bad.failures.join()).toContain('gate tests tests/x.test.ts: exit 1');
  });

  it('treats bun missing as UNVERIFIED for the naming tests', () => {
    const root = repo();
    const d = deps({ tmpRoot: () => root, onPath: () => false });
    expect(runChecks(o(root), d).failures.join()).toContain('UNVERIFIED, bun not on PATH');
    expect(runChecks(o(root, { allowMissingTools: true }), d).failures).toEqual([]);
  });

  it('FAILS an unmapped input, including under --skip-gates', () => {
    const root = repo();
    for (const skipGates of [false, true]) {
      const r = runChecks(o(root, { registry: {}, skipGates }), deps({ tmpRoot: () => root }));
      expect(r.failures.join(), `skipGates=${skipGates}`).toContain(
        'security/x-exceptions.json is a security/ gate input that no gate is mapped to',
      );
    }
  });

  it('with --skip-gates runs nothing but still says so', () => {
    const root = repo();
    let ran = 0;
    const r = runChecks(
      o(root, { skipGates: true }),
      deps({ tmpRoot: () => root, runTests: () => (ran++, 1), runGate: () => (ran++, 1) }),
    );
    expect(ran).toBe(0);
    expect(r.warnings.join()).toContain('gates NOT executed');
  });
});

describe('default base follows the branch fork point', () => {
  it('prefers the nearer of main and integration/v2, either way round', () => {
    const dist: Record<string, [number, number] | null> = {
      'personal/integration/v2': [40, 0],
      'origin/integration/v2': null,
      'personal/main': [3, 0],
      'origin/main': [3, 0],
    };
    const refs = [
      'personal/integration/v2',
      'origin/integration/v2',
      'personal/main',
      'origin/main',
    ];
    expect(pickBase(refs, (r) => dist[r])).toBe('personal/main');
    expect(pickBase(refs, (r) => ({ ...dist, 'personal/integration/v2': [1, 0] })[r])).toBe(
      'personal/integration/v2',
    );
    // same fork commit: the ref with fewer commits of its own past it wins, then the earlier one
    expect(pickBase(['v2', 'main'], (r) => (r === 'v2' ? [1, 30] : [1, 0]))).toBe('main');
    expect(pickBase(['a', 'b'], () => [2, 2])).toBe('a');
    expect(pickBase(['a'], () => null)).toBeUndefined();
  });

  it('runChecks on a branch cut from main picks main even though integration/v2 exists', () => {
    const logs: string[] = [];
    const spy = spyOn(console, 'log').mockImplementation((m: unknown) => void logs.push(String(m)));
    try {
      const root = fixture();
      git(root, 'init', '-q', '-b', 'main');
      put(root, 'README.md', 'base');
      git(root, 'add', '.');
      git(root, 'commit', '-q', '-m', 'base');
      git(root, 'branch', 'personal/main');
      git(root, 'switch', '-q', '-c', 'personal/integration/v2');
      for (const n of ['1', '2', '3']) {
        put(root, `v2-${n}.txt`, n);
        git(root, 'add', '.');
        git(root, 'commit', '-q', '-m', `v2 ${n}`);
      }
      git(root, 'switch', '-q', 'main');
      git(root, 'switch', '-q', '-c', 'feature');
      put(root, 'docs/a.md', 'x');
      git(root, 'add', '.');
      git(root, 'commit', '-q', '-m', 'change');
      runChecks(
        { root, scope: ['docs/**'], skipGates: true, skipTests: true },
        {
          onPath: () => true,
          which: () => '',
          runGate: () => 0,
          runTests: () => 0,
          tmpRoot: () => root,
        },
      );
      expect(logs.find((l) => l.startsWith('prepush-check: base'))).toContain(
        'base personal/main,',
      );
    } finally {
      spy.mockRestore();
    }
  });
});

describe('the CI job that makes the check non-advisory', () => {
  const wf = readFileSync(
    join(import.meta.dir, '..', '.github/workflows/prepush-check.yml'),
    'utf8',
  );
  const code = wf
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');

  it('runs on pull_request, re-runs when the body is edited, and is not gated on anything', () => {
    expect(code).toMatch(/pull_request:/);
    expect(code).toMatch(/types:\s*\[[^\]]*\bedited\b[^\]]*\]/);
    expect(code).not.toMatch(/continue-on-error/);
    expect(code).not.toMatch(/\bif:/);
  });

  it('requires the scope, reads the base from the event, and diffs full history', () => {
    expect(code).toContain('--require-scope');
    expect(code).toContain('github.base_ref');
    expect(code).toMatch(/fetch-depth:\s*0/);
    expect(code).toContain('node scripts/prepush-check.mjs');
  });

  it('passes the PR body as env data and never interpolates it into the script', () => {
    expect(code).toMatch(/PR_BODY:\s*\$\{\{\s*github\.event\.pull_request\.body\s*\}\}/);
    const run = code.slice(code.indexOf('run: |'));
    expect(run).not.toContain('${{');
  });

  it('does not accept a commit trailer or --scope in CI', () => {
    expect(code).not.toMatch(/--scope\b/);
  });

  it('installs the locked dependencies (the check parses JS and YAML) before it runs', () => {
    expect(code.indexOf('bun install --frozen-lockfile')).toBeGreaterThan(0);
    expect(code.indexOf('bun install --frozen-lockfile')).toBeLessThan(
      code.indexOf('node scripts/prepush-check.mjs'),
    );
  });
});

describe('scope breadth, braces and exemptions through runChecks', () => {
  let quiet: ReturnType<typeof spyOn>;
  beforeAll(() => {
    quiet = spyOn(console, 'log').mockImplementation(() => {});
  });
  afterAll(() => quiet.mockRestore());

  const deps = (root: string) => ({
    onPath: () => true,
    which: () => '/bin/x',
    runGate: () => 0,
    runTests: () => 0,
    tmpRoot: () => root,
  });
  const run = (root: string, prBody: string, over: Record<string, unknown> = {}) =>
    runChecks(
      { root, base: 'main', requireScope: true, skipGates: true, skipTests: true, prBody, ...over },
      deps(root),
    );
  /** A repo shaped like a real one: enough tracked files across enough top-level directories. */
  function bigRepo(): string {
    const root = fixture();
    git(root, 'init', '-q', '-b', 'main');
    for (const a of ['docs', 'scripts', 'tests', 'apps', 'packages', 'infra']) {
      for (const [i, ext] of ['ts', 'md', 'mjs', 'yml'].entries())
        put(root, `${a}/f${i}.${ext}`, 'x');
    }
    for (let i = 0; i < 12; i++) put(root, `root${i}.txt`, 'x');
    git(root, 'add', '.');
    git(root, 'commit', '-q', '-m', 'base');
    git(root, 'switch', '-q', '-c', 'feature');
    put(root, 'docs/new.md', 'x');
    git(root, 'add', '.');
    git(root, 'commit', '-q', '-m', 'change');
    return root;
  }

  it('FAILS the extension bypass (`**/*.ts, **/*.md, ...`) in CI, and accepts a narrow scope', () => {
    const root = bigRepo();
    const bad = run(root, 'Scope: **/*.ts, **/*.md, **/*.mjs, **/*.yml');
    expect(bad.failures.join()).toContain('scope is too broad');
    expect(run(root, 'Scope: docs/**').failures).toEqual([]);
  });

  it('FAILS a brace glob with a message, in CI and locally, rather than misreading it', () => {
    const root = bigRepo();
    const ci = run(root, 'Scope: {docs,scripts}/**');
    expect(ci.failures.join()).toContain('brace alternation');
    expect(ci.failures.join()).not.toContain('out of scope');
    const local = run(root, 'Scope: {docs,scripts}/**', { requireScope: false });
    expect(local.failures.join()).toContain('brace alternation');
  });

  it('lists every documented exemption as a NOTICE on EVERY run, changed file or not', () => {
    const root = fixture();
    git(root, 'init', '-q', '-b', 'main');
    put(root, 'README.md', 'base');
    git(root, 'add', '.');
    git(root, 'commit', '-q', '-m', 'base');
    git(root, 'switch', '-q', '-c', 'feature');
    put(root, 'docs/a.md', 'x'); // no security/ file changes at all
    git(root, 'add', '.');
    git(root, 'commit', '-q', '-m', 'change');
    const registry = {
      'security/x.yaml': { gates: [], other: {}, exempt: 'only a workflow step reads it' },
      'security/y.json': { gates: ['s.mjs'], other: {} },
    };
    const lines: string[] = [];
    const spy = spyOn(console, 'log').mockImplementation(
      (m: unknown) => void lines.push(String(m)),
    );
    const r = runChecks(
      {
        root,
        base: 'main',
        scope: ['docs/**'],
        skipTests: true,
        skipGates: true,
        gateTable: {},
        registry,
      },
      deps(root),
    );
    spy.mockRestore();
    expect(lines.filter((l) => l.startsWith('NOTICE  security/x.yaml'))).toHaveLength(1);
    expect(r.failures).toEqual([]);
    expect(r.notices).toEqual([
      'security/x.yaml has no local gate (documented exemption): only a workflow step reads it',
    ]);
    const none = runChecks(
      {
        root,
        base: 'main',
        scope: ['docs/**'],
        skipTests: true,
        skipGates: true,
        gateTable: {},
        registry: {},
      },
      deps(root),
    );
    expect(none.notices).toEqual([]);
  });
});

describe('ciRunsTest: whole-suite flags and job guards', () => {
  const wf = (root: string, name: string, body: string) =>
    put(root, `.github/workflows/${name}`, body);
  const job = (extra: string, stepExtra = '') =>
    `jobs:\n  t:\n${extra}    runs-on: x\n    steps:\n      - name: s\n${stepExtra}        run: node scripts/bun-test.mjs --shard 1/4 --coverage\n`;

  it('runsWholeSuite accepts flags that take values and rejects a named test path', () => {
    expect(runsWholeSuite('node scripts/bun-test.mjs')).toBe(true);
    expect(runsWholeSuite('run: node scripts/bun-test.mjs --shard 1/4 --coverage')).toBe(true);
    expect(runsWholeSuite('node scripts/bun-test.mjs --timeout=30000 --no-skip')).toBe(true);
    expect(runsWholeSuite('node scripts/bun-test.mjs --coverage | tee out.txt')).toBe(true);
    expect(
      runsWholeSuite('node scripts/bun-test.mjs --coverage && node scripts/check-coverage.mjs'),
    ).toBe(true);
    expect(runsWholeSuite('node scripts/bun-test.mjs --shard 1/4 tests/a.test.ts')).toBe(false);
    expect(runsWholeSuite('node scripts/bun-test.mjs apps/x/y.test.ts')).toBe(false);
    expect(runsWholeSuite('bun test tests/a.test.ts')).toBe(false);
    // a directory argument narrows the run as much as a file does
    expect(runsWholeSuite('node scripts/bun-test.mjs tests/')).toBe(false);
    expect(runsWholeSuite('node scripts/bun-test.mjs --coverage tests')).toBe(true); // bare word: a flag value, not a path
    expect(runsWholeSuite('node scripts/bun-test.mjs packages/kn-next/src')).toBe(false);
    expect(runsWholeSuite('node scripts/bun-test.mjs --shard 1/4')).toBe(true);
  });

  it('counts a whole-suite step with value-taking flags', () => {
    const root = fixture();
    wf(root, 'ci.yml', job(''));
    expect(ciRunsTest(root, 'tests/a.test.ts')).toBe(true);
  });

  it('refuses a job whose if: is not always true on a pull request', () => {
    for (const cond of [
      "github.event_name == 'push'",
      "github.ref == 'refs/heads/main'",
      'matrix.x',
    ]) {
      const root = fixture();
      wf(root, 'ci.yml', job(`    if: ${cond}\n`));
      expect(ciRunsTest(root, 'tests/a.test.ts'), cond).toBe(false);
    }
    for (const cond of [
      'true',
      'always()',
      "github.event_name == 'pull_request'",
      '${{ always() }}',
    ]) {
      const root = fixture();
      wf(root, 'ci.yml', job(`    if: ${cond}\n`));
      expect(ciRunsTest(root, 'tests/a.test.ts'), cond).toBe(true);
    }
  });

  it('refuses a step whose if: is not always true, and ignores another job or step guard', () => {
    const root = fixture();
    wf(root, 'ci.yml', job('', "        if: github.event_name == 'push'\n"));
    expect(ciRunsTest(root, 'tests/a.test.ts')).toBe(false);
    // a guard on a DIFFERENT job does not refuse this one
    const other = fixture();
    wf(
      other,
      'ci.yml',
      `jobs:\n  a:\n    if: github.ref == 'x'\n    steps:\n      - run: echo hi\n  t:\n    steps:\n      - run: node scripts/bun-test.mjs\n`,
    );
    expect(ciRunsTest(other, 'tests/a.test.ts')).toBe(true);
    // a guard on a LATER job does not bleed back into this one
    const later = fixture();
    wf(
      later,
      'ci.yml',
      `jobs:\n  t:\n    steps:\n      - run: node scripts/bun-test.mjs\n  b:\n    if: github.ref == 'x'\n    steps:\n      - run: echo hi\n`,
    );
    expect(ciRunsTest(later, 'tests/a.test.ts')).toBe(true);
    // a guard on a DIFFERENT step does not refuse this one
    const sibling = fixture();
    wf(
      sibling,
      'ci.yml',
      `jobs:\n  t:\n    steps:\n      - name: a\n        if: matrix.x\n        run: echo hi\n      - name: b\n        run: node scripts/bun-test.mjs\n`,
    );
    expect(ciRunsTest(sibling, 'tests/a.test.ts')).toBe(true);
  });

  it('reads the step guard after a blank line, and treats a trailing comment on an if: as a comment', () => {
    const root = fixture();
    wf(
      root,
      'ci.yml',
      `jobs:\n  t:\n    runs-on: x\n    steps:\n      - name: s\n        run: node scripts/bun-test.mjs\n\n        if: github.ref == 'x'\n`,
    );
    expect(ciRunsTest(root, 'tests/a.test.ts')).toBe(false);
    const blankJob = fixture();
    wf(
      blankJob,
      'ci.yml',
      `jobs:\n  t:\n    runs-on: x\n\n    if: github.ref == 'x'\n    steps:\n      - run: node scripts/bun-test.mjs\n`,
    );
    expect(ciRunsTest(blankJob, 'tests/a.test.ts')).toBe(false);
    const commented = fixture();
    wf(commented, 'ci.yml', job('    if: always() # run on every pull request\n'));
    expect(ciRunsTest(commented, 'tests/a.test.ts')).toBe(true);
    const commentedFalse = fixture();
    wf(commentedFalse, 'ci.yml', job("    if: github.ref == 'x' # always() here\n"));
    expect(ciRunsTest(commentedFalse, 'tests/a.test.ts')).toBe(false);
    // flow-style and quoted forms are the same YAML
    const flow = fixture();
    wf(
      flow,
      'ci.yml',
      `jobs:\n  t: {runs-on: x, if: "github.ref == 'x'", steps: [{run: node scripts/bun-test.mjs}]}\n`,
    );
    expect(ciRunsTest(flow, 'tests/a.test.ts')).toBe(false);
  });

  it('refuses a workflow that is not valid YAML rather than guessing', () => {
    const root = fixture();
    wf(
      root,
      'ci.yml',
      `jobs:\n  t:\n    steps:\n      - run: node scripts/bun-test.mjs\n   bad: [unclosed\n`,
    );
    expect(ciRunsTest(root, 'tests/a.test.ts')).toBe(false);
  });
});

describe('the branch-specific block is data, and the drift guard compares both branches', () => {
  const block = (body: string) =>
    `head\n// BEGIN branch-specific (x)\n${body}\n// END branch-specific\ntail\n`;
  const REG =
    "export const GATE_TABLE = {};\nexport const GATE_INPUT_REGISTRY = { 'security/a.json': { gates: [], other: {} } };";

  it('branchBlockProblems accepts pure literal trees: objects, arrays, strings, numbers, regex, plain templates', () => {
    expect(branchBlockProblems(block(REG))).toEqual([]);
    expect(
      branchBlockProblems(
        block(
          "const R = 'a (b)';\n// note (x) => y\n/* function f() {} */\nexport const T = { k: 'v', 'q-r': [1, -2, true, null, /a\\/\\/b['\"]/g, `plain`] };",
        ),
      ),
    ).toEqual([]);
    // no trailing semicolon, but each statement on its own line is a complete const declaration
    expect(branchBlockProblems(block('const A = {}\nconst B = []'))).toEqual([]);
  });

  it('branchBlockProblems rejects anything that is not a pure literal tree', () => {
    for (const bad of [
      "const A = runners(['x']);",
      'const A = (() => 1)();',
      'const A = () => 1;',
      'const A = x => 1;',
      'const A = new Z;',
      'const A = { k: typeof Z };',
      'function f() {}',
      'const A = `t${1}`;',
      'const A = tag`t`;',
      'const A = new Map();',
      'let A = 1;',
      'doThing;',
      'const A = { k: 1 }; if (A) {}',
      'import x from "y";',
      'const A = { ...O };',
      'const A = [...O];',
      'const A = { k: B };',
      'const A = B;',
      'const A = { [k]: 1 };',
      'const A = { k };',
      'const A = { m() {} };',
      'const A = { get k() { return 1; } };',
      'const A = { k: 1 };;',
      'const A = {',
      'declare const A = 1;',
    ]) {
      expect(branchBlockProblems(block(bad)).length, bad).toBeGreaterThan(0);
    }
  });

  it('branchBlockProblems refuses text with no markers', () => {
    expect(branchBlockProblems('const A = {};').length).toBeGreaterThan(0);
    expect(
      branchBlockProblems('// END branch-specific\n// BEGIN branch-specific\n').length,
    ).toBeGreaterThan(0);
  });

  it('branchBlockProblems is not fooled by regex literals, a missing semicolon, or a spread of an unknown name', () => {
    // a regex holding `//` is not a comment: the code after it is real
    expect(
      branchBlockProblems(block('const A = /x\\/\\//; process.exitCode = 1;')).length,
    ).toBeGreaterThan(0);
    expect(
      branchBlockProblems(block('const A = /a\\/\\/b/;\nprocess.exitCode = 1;')).length,
    ).toBeGreaterThan(0);
    // a regex holding a quote does not open a string that swallows the statement after it
    expect(
      branchBlockProblems(block("const A = /'/; process.exitCode = 1; const B = /'/;")).length,
    ).toBeGreaterThan(0);
    // no semicolon: the next line is a statement of its own
    expect(branchBlockProblems(block('const A = {}\nprocess.exitCode = 1')).length).toBeGreaterThan(
      0,
    );
    // a spread of a name nothing defines is a reference, not data
    expect(branchBlockProblems(block('const A = { ...UNKNOWN };')).length).toBeGreaterThan(0);
  });

  it('the real lib block is data, and evalBranchBlock reads its registry', () => {
    const text = readFileSync(join(import.meta.dir, '..', 'scripts/lib/prepush-check.mjs'), 'utf8');
    expect(branchBlockProblems(text)).toEqual([]);
    const { GATE_INPUT_REGISTRY: reg } = evalBranchBlock(text);
    expect(Object.keys(reg)).toEqual(Object.keys(GATE_INPUT_REGISTRY));
    expect(exemptInputs(reg)).toEqual(exemptInputs(GATE_INPUT_REGISTRY));
    expect(() => evalBranchBlock(block('const A = f();'))).toThrow(/not data/);
  });

  it('exemptInputs lists exactly the entries with an exempt reason, sorted', () => {
    expect(
      exemptInputs({
        'security/b': { gates: [], other: {}, exempt: 'r' },
        'security/a': { gates: [], other: {}, exempt: 'r' },
        'security/c': { gates: [], other: {} },
      }),
    ).toEqual(['security/a', 'security/b']);
  });

  // ---- the drift CLI against a fixture repo with two branches
  const LIB = 'scripts/lib/prepush-check.mjs';
  const FILES = [
    'scripts/prepush-check.mjs',
    'scripts/prepush-lib-drift.mjs',
    'scripts/mutation-prove-prepush-check.mjs',
    'tests/prepush-check.test.ts',
    '.github/workflows/prepush-check.yml',
    '.github/workflows/prepush-lib-drift.yml',
  ];
  function pair(
    over: { here?: Record<string, string>; there?: Record<string, string>; hereRm?: string[] } = {},
  ) {
    const root = fixture();
    git(root, 'init', '-q', '-b', 'trunk');
    const base: Record<string, string> = { [LIB]: block(REG) };
    for (const f of FILES) base[f] = `content of ${f}\n`;
    for (const [f, t] of Object.entries({ ...base, ...(over.there ?? {}) })) put(root, f, t);
    git(root, 'add', '.');
    git(root, 'commit', '-q', '-m', 'other');
    git(root, 'branch', 'other');
    for (const f of over.hereRm ?? []) rmSync(join(root, f));
    for (const [f, t] of Object.entries(over.here ?? {})) put(root, f, t);
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '--allow-empty', '-m', 'here');
    return root;
  }
  const drift = (root: string) => {
    const spy = spyOn(console, 'log').mockImplementation(() => {});
    try {
      return driftMain(['--other', 'other'], root);
    } finally {
      spy.mockRestore();
    }
  };

  it('exits 0 for identical copies, and ignores differences INSIDE the branch-specific block', () => {
    expect(drift(pair())).toBe(0);
    const other = block(
      "export const GATE_TABLE = {};\nexport const GATE_INPUT_REGISTRY = { 'security/zzz.json': { gates: [], other: {} } };",
    );
    expect(drift(pair({ there: { [LIB]: other } }))).toBe(0);
  });

  it('exits 1 on drift in the lib outside the block, and on drift in each whole-compared file', () => {
    expect(drift(pair({ here: { [LIB]: `${block(REG)}extra\n` } }))).toBe(1);
    for (const f of FILES) {
      expect(drift(pair({ here: { [f]: 'changed\n' } })), f).toBe(1);
    }
  });

  it('exits 1 when the other branch has no copy, from EITHER direction', () => {
    const root = fixture();
    git(root, 'init', '-q', '-b', 'trunk');
    put(root, 'README.md', 'x');
    git(root, 'add', '.');
    git(root, 'commit', '-q', '-m', 'bare');
    git(root, 'branch', 'other');
    for (const [f, t] of Object.entries({
      [LIB]: block(REG),
      ...Object.fromEntries(FILES.map((f) => [f, 'x\n'])),
    }))
      put(root, f, t);
    git(root, 'add', '.');
    git(root, 'commit', '-q', '-m', 'here');
    expect(drift(root)).toBe(1);
  });

  it('exits 1 when a block is not data, in either copy', () => {
    const logic = block('export const GATE_TABLE = {};\nexport const GATE_INPUT_REGISTRY = mk();');
    expect(drift(pair({ here: { [LIB]: logic } }))).toBe(1);
    expect(drift(pair({ there: { [LIB]: logic } }))).toBe(1);
  });

  it('exits 1 when an input present on BOTH branches is exempt on only one', () => {
    const reg = (exempt: boolean) =>
      block(
        `export const GATE_TABLE = {};\nexport const GATE_INPUT_REGISTRY = { 'security/a.json': { gates: [], other: {}${exempt ? ", exempt: 'r'" : ''} } };`,
      );
    const both = { 'security/a.json': '{}' };
    const mk = (here: boolean, there: boolean, files: Record<string, string>) => {
      const root = pair({
        there: { [LIB]: reg(there), ...files },
        here: { [LIB]: reg(here), ...files },
      });
      return drift(root);
    };
    expect(mk(true, false, both)).toBe(1);
    expect(mk(false, true, both)).toBe(1);
    expect(mk(true, true, both)).toBe(0);
    // the file exists on neither branch (or one): the registries may differ
    expect(mk(true, false, {})).toBe(0);
    // present on one branch only: nothing to compare against
    const onlyThere = pair({
      there: { [LIB]: reg(false), 'security/a.json': '{}' },
      here: { [LIB]: reg(true) },
      hereRm: ['security/a.json'],
    });
    expect(drift(onlyThere)).toBe(0);
    const onlyHere = pair({
      there: { [LIB]: reg(false) },
      here: { [LIB]: reg(true), 'security/a.json': '{}' },
    });
    expect(drift(onlyHere)).toBe(0);
  });
});

describe('the prover and the drift CLI', () => {
  it('every mutation id in the prover is unique', () => {
    const src = readFileSync(
      join(import.meta.dir, '..', 'scripts/mutation-prove-prepush-check.mjs'),
      'utf8',
    );
    const ids = [...src.matchAll(/^\s+id: '([A-Za-z0-9]+)'/gm)].map((m) => m[1]);
    expect(ids.length).toBeGreaterThan(40);
    expect(ids.filter((id, i) => ids.indexOf(id) !== i)).toEqual([]);
  });

  it('the drift CLI exits 2 without --other and 1 when the other ref has no copy', () => {
    const cli = join(import.meta.dir, '..', 'scripts/prepush-lib-drift.mjs');
    const run = (...a: string[]) => spawnSync('node', [cli, ...a], { encoding: 'utf8' });
    expect(run().status).toBe(2);
    const r = run('--other', 'refs/heads/no-such-branch-for-the-test');
    expect(r.status).toBe(1);
    expect(r.stdout).toContain('not present on');
  });
});

describe('the symmetric drift workflow', () => {
  const wf = readFileSync(
    join(import.meta.dir, '..', '.github/workflows/prepush-lib-drift.yml'),
    'utf8',
  );
  const code = wf
    .split('\n')
    .filter((l) => !/^\s*#/.test(l))
    .join('\n');
  const run = code.slice(code.indexOf('run: |'));

  it('fires on pull requests AND pushes to BOTH branches, so either side reds on its own PR', () => {
    expect(code).toMatch(/pull_request:\s*\n\s*branches:\s*\[main, integration\/v2\]/);
    expect(code).toMatch(/push:\s*\n\s*branches:\s*\[main, integration\/v2\]/);
    expect(code).toContain('workflow_dispatch');
    // and compares against the OTHER branch in each direction
    expect(run).toMatch(/main\)\s*other=integration\/v2/);
    expect(run).toMatch(/integration\/v2\)\s*other=main/);
    expect(run).toContain('prepush-lib-drift.mjs --other');
  });

  it('passes the token to the fetch explicitly, through env, with read-only contents', () => {
    expect(code).toMatch(/persist-credentials:\s*false/);
    expect(code).toMatch(/GH_TOKEN:\s*\$\{\{\s*github\.token\s*\}\}/);
    expect(run).toContain('http.extraheader=AUTHORIZATION');
    expect(run).not.toContain('${{');
    expect(code).toMatch(/permissions:\s*\n\s*contents:\s*read\s*\n/);
    expect(code).not.toMatch(/contents:\s*write/);
    expect(code).not.toMatch(/continue-on-error/);
  });

  it('masks the derived basic-auth value before it is used, and installs the locked dependencies', () => {
    expect(run).toContain('echo "::add-mask::${auth}"');
    expect(run.indexOf('::add-mask::')).toBeLessThan(run.indexOf('http.extraheader'));
    expect(run.indexOf('::add-mask::')).toBeGreaterThan(run.indexOf('auth="$('));
    expect(code.indexOf('bun install --frozen-lockfile')).toBeGreaterThan(0);
    expect(code.indexOf('bun install --frozen-lockfile')).toBeLessThan(code.indexOf('run: |'));
  });

  it('runs nightly (a cron fires only from the default branch, so main checks v2) and says what its paths: filter misses', () => {
    expect(code).toMatch(/schedule:\s*\n\s*- cron: '/);
    expect(wf.replace(/\s*\n#\s*/g, ' ')).toMatch(
      /not re-checked here until this side next touches/,
    );
  });
});
