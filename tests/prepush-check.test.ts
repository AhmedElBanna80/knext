import { afterAll, beforeAll, describe, expect, it, spyOn } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  bareInvocations,
  broadScopes,
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
  scanReaders,
  scanTestReaders,
  staticTempDirFindings,
  testsCovering,
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
  it('matches every data file directly under security/, not only allowlists, and no other path', () => {
    expect(
      changedGateInputs([
        'security/osv-allowlist.json',
        'security/gitleaks-allowlist.json',
        'security/bun-install-scripts.json',
        'security/govulncheck-exceptions.json',
        'security/docs-closure-trivyignore.yaml',
        'security/README.md',
        'docs/osv-allowlist.json',
        'security/sub/osv-allowlist.json',
      ]),
    ).toEqual([
      'security/osv-allowlist.json',
      'security/gitleaks-allowlist.json',
      'security/bun-install-scripts.json',
      'security/govulncheck-exceptions.json',
      'security/docs-closure-trivyignore.yaml',
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
    const onDisk = readdirSync(join(root, 'security')).filter((f) => /\.(?:json|ya?ml)$/.test(f));

    it('registers every security/ data file on disk, and nothing else', () => {
      expect(Object.keys(GATE_INPUT_REGISTRY).sort()).toEqual(
        onDisk.map((f) => `security/${f}`).sort(),
      );
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
          reg.gates.length + scanTestReaders(root, input).length,
          `${input} has no gate: no registered script and no test naming it`,
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
      deps({ tmpRoot: () => root + '/.', runGate: (_r: string, s: string) => (ran.push(s), 1) }),
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
  it('scanTestReaders finds tests that name the file, not comments, not this guard, not others', () => {
    const root = fixture();
    put(root, 'tests/named.test.ts', "read('security/x-exceptions.json')");
    put(root, 'tests/sub/deep.test.ts', "read('x-exceptions.json')");
    put(root, 'tests/commented.test.ts', '// x-exceptions.json\n/* x-exceptions.json */');
    put(root, 'tests/other.test.ts', "read('security/y.json')");
    put(root, 'tests/prepush-check.test.ts', "'x-exceptions.json'");
    put(root, 'tests/helper.ts', "'x-exceptions.json'");
    expect(scanTestReaders(root, 'security/x-exceptions.json')).toEqual([
      'tests/named.test.ts',
      'tests/sub/deep.test.ts',
    ]);
  });

  const table = { 'scripts/g.mjs': { needs: [], runs: [[]] } };
  const IN = 'security/x-exceptions.json';

  it('flags an input nothing gates as unmapped: no registry entry, or no gate and no naming test', () => {
    const root = fixture();
    const none = planGateRuns(root, [IN], table, {});
    expect(none.unmapped).toEqual([IN]);
    const empty = planGateRuns(root, [IN], table, { [IN]: { gates: [], other: {} } });
    expect(empty.unmapped).toEqual([IN]);
  });

  it('maps an input by a script gate, or by a test that names it, and runs those tests', () => {
    const root = fixture();
    put(root, 'scripts/g.mjs', 'x-exceptions.json');
    const viaScript = planGateRuns(root, [IN], table, {
      [IN]: { gates: ['scripts/g.mjs'], other: {} },
    });
    expect(viaScript.unmapped).toEqual([]);
    expect(viaScript.runs.map((r) => r.script)).toEqual(['scripts/g.mjs']);

    const root2 = fixture();
    put(root2, 'tests/x.test.ts', "'x-exceptions.json'");
    const viaTest = planGateRuns(root2, [IN], table, { [IN]: { gates: [], other: {} } });
    expect(viaTest.unmapped).toEqual([]);
    expect(viaTest.tests).toEqual(['tests/x.test.ts']);
    // a naming test alone is not enough: the input must be registered, so its readers are explained
    expect(planGateRuns(root2, [IN], table, {}).unmapped).toEqual([IN]);
  });

  it('every non-allowlist input in the real repo is mapped', () => {
    const root = join(import.meta.dir, '..');
    const inputs = [
      'security/govulncheck-exceptions.json',
      'security/govulncheck-modules.json',
      'security/release-age-exceptions.json',
      'security/dockerfile-base-exclusions.json',
      'security/bun-install-scripts.json',
      'security/docs-closure-trivyignore.yaml',
    ];
    const plan = planGateRuns(root, inputs);
    expect(plan.unmapped).toEqual([]);
    expect(plan.unknown).toEqual([]);
  });
});

describe('scope enforcement (CI reads the PR body only)', () => {
  it('parses a CRLF PR body, which is what the GitHub UI produces', () => {
    expect(parseScopeLines('## x\r\n\r\nScope: a/**, b.md\r\nmore\r\n')).toEqual(['a/**', 'b.md']);
    expect(parseScopeLines('Scope: a/**\r\nScope: c/**')).toEqual(['a/**', 'c/**']);
  });

  it('broadScopes flags a scope that matches everything by what it matches, not its spelling', () => {
    for (const g of ['**', '**/*', './**', '*/**', '**/**', '**/']) {
      expect(broadScopes([g]), g).toEqual([g]);
    }
    expect(broadScopes(['scripts/**', '**'])).toEqual(['**']);
    expect(broadScopes(['scripts/**', 'tests/**', 'docs/**'])).toEqual([]);
    expect(broadScopes(['scripts/**', 'security/**'])).toEqual([]);
    expect(broadScopes(['*.md'])).toEqual([]);
    // every directory but .github is still a narrower claim than "everything"
    expect(
      broadScopes(['apps/**', 'docs/**', 'packages/**', 'scripts/**', 'security/**', 'tests/**']),
    ).toEqual([]);
    // together they cover every area, though none does alone
    expect(
      broadScopes([
        '.github/**',
        'apps/**',
        'docs/**',
        'packages/**',
        'scripts/**',
        'security/**',
        'tests/**',
      ]),
    ).toHaveLength(7);
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
    expect(r.failures.join()).toContain('scope matches everything');
    const local = runChecks(
      { root, base: 'main', prBody: 'Scope: **', scope: ['**'], skipGates: true, skipTests: true },
      { ...deps, tmpRoot: () => root },
    );
    expect(local.failures).toEqual([]);
    expect(local.warnings.join()).toContain('scope matches everything');
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
});
