import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { anchorProblems } from '../scripts/lib/mutation-harness.mjs';
import {
  auditAnchorLiveness,
  auditSelfAsserting,
  discoverProvers,
  PROVER_AUDIT_EXEMPTIONS,
  SELF_ASSERTING_PROVERS,
} from '../scripts/lib/prover-lane.mjs';

/**
 * GUARDS for the per-prover anchor audit's SHAPE coverage.
 *
 * Eight provers were exempted from the PR-time anchor audit because its extractor
 * resolved zero anchors for them: they keep their mutations in a table of
 * `{ file, anchor }` objects, in positional `[file, label, anchor, …]` arrays,
 * behind a `prove(label, file, anchor, …)` wrapper, in a table imported from a
 * shared lib, or build the anchors at run time. Each exemption was DATED and each
 * was renewed because nothing about the prover would ever change by the date — a
 * clock that renews forever is not a clock.
 *
 * So the shapes are READ now (the extractor), and the two provers whose anchors
 * are computed at run time ASSERT THEIR OWN resolution at run time and are
 * classified as self-asserting — a permanent, reasoned classification the audit
 * checks, so a self-asserting prover that stops asserting reds.
 *
 * Both halves everywhere: a stale anchor in a fixture of each shape is a finding,
 * and a live one is not.
 */

const REPO_ROOT = resolve(import.meta.dirname, '..');

describe('the extractor reads the table / wrapper / import shapes', () => {
  describe('object table: { file, anchor } rows', () => {
    const SRC = [
      "const WORKFLOW = '.github/workflows/x.yml';",
      "const SHARED = 'the shared anchor';",
      'const MUTATIONS = [',
      '  {',
      "    label: 'a',",
      '    file: WORKFLOW,',
      "    anchor: 'live text',",
      "    replacement: 'x',",
      '  },',
      '  {',
      "    label: 'b',",
      "    file: resolve(REPO_ROOT, 'src/y.ts'),",
      '    // a comment inside the row must not hide it',
      '    anchor: SHARED,',
      "    replacement: 'y',",
      '    also: [',
      "      { anchor: 'a nested edit with no file', replacement: 'z' },",
      '    ],',
      '  },',
      '];',
    ].join('\n');

    it('LIVE anchors resolve and are not findings', () => {
      const { resolved, findings, unresolved } = auditAnchorLiveness(SRC, (f) =>
        f === '.github/workflows/x.yml'
          ? 'one live text here\n'
          : f === 'src/y.ts'
            ? 'the shared anchor once\n'
            : undefined,
      );
      expect(findings).toEqual([]);
      expect(unresolved).toEqual([]);
      expect(resolved.map((r) => [r.file, r.anchor, r.count])).toEqual([
        ['.github/workflows/x.yml', 'live text', 1],
        ['src/y.ts', 'the shared anchor', 1],
      ]);
    });

    it('a STALE anchor (moved out of its subject) IS a finding', () => {
      const { findings } = auditAnchorLiveness(SRC, (f) =>
        f === 'src/y.ts' ? 'the shared anchor once\n' : 'the text moved away\n',
      );
      expect(findings.join(' ')).toMatch(/0 time\(s\) in \.github\/workflows\/x\.yml/);
    });

    it('a DELETED subject IS a finding', () => {
      const { findings } = auditAnchorLiveness(SRC, () => undefined);
      expect(findings.join(' ')).toMatch(/does not exist/);
    });

    it('a symbolic `file` KEY (not a path) is not graded as a deleted subject', () => {
      // mutation-prove-retracted-figures.mjs's PLAN: `file: 'ledger'` names a
      // snapshot looked up elsewhere. Grading it as a path reported a phantom
      // finding on a healthy prover.
      const src = "const PLAN = [{ id: 'M1', file: 'ledger', anchor: 'x', replacement: 'y' }];";
      const { findings, resolved } = auditAnchorLiveness(src, () => undefined);
      expect(findings).toEqual([]);
      expect(resolved).toEqual([]);
    });

    it("an anchor spelling an apostrophe as \\' still resolves", () => {
      const src = [
        "const F = '.github/workflows/x.yml';",
        "const M = [{ file: F, anchor: 'it\\'s live', replacement: 'x' }];",
      ].join('\n');
      const { resolved, findings } = auditAnchorLiveness(src, () => "it's live\n");
      expect(findings).toEqual([]);
      expect(resolved).toHaveLength(1);
    });

    it('a row whose anchor cannot be read is REPORTED, never dropped', () => {
      const src = [
        "const F = '.github/workflows/x.yml';",
        'const M = [{ file: F, anchor: compute(), replacement: "x" }];',
      ].join('\n');
      const { resolved, unresolved } = auditAnchorLiveness(src, () => 'x\n');
      expect(resolved).toEqual([]);
      expect(unresolved.length).toBeGreaterThan(0);
    });
  });

  describe('positional table: for (const [file, label, anchor, …] of TABLE)', () => {
    const SRC = [
      "const SCRIPT = resolve(REPO_ROOT, 'scripts/a.mjs');",
      "const DOC = resolve(REPO_ROOT, 'docs/b.md');",
      'const MUTATIONS = [',
      "  [SCRIPT, 'first', '  if (live) {', '  if (false) {'],",
      '  [',
      '    DOC,',
      "    'second',",
      "    'a long anchor ' + 'joined',",
      "    'x',",
      '  ],',
      '];',
      'for (const [file, label, anchor, replacement] of MUTATIONS) {',
      '  mutate(snapshot(file), anchor, replacement);',
      '}',
      'for (const [file, label, anchor] of MUTATIONS) {',
      '  countOccurrences(file, anchor);',
      '}',
    ].join('\n');
    const READ = (f: string) =>
      f === 'scripts/a.mjs'
        ? 'x\n  if (live) {\ny\n'
        : f === 'docs/b.md'
          ? 'a long anchor joined\n'
          : undefined;

    it('LIVE rows resolve (once per table, not once per loop)', () => {
      const { resolved, findings } = auditAnchorLiveness(SRC, READ);
      expect(findings).toEqual([]);
      expect(resolved.map((r) => r.file)).toEqual(['scripts/a.mjs', 'docs/b.md']);
    });

    it('a STALE anchor in a row IS a finding', () => {
      const { findings } = auditAnchorLiveness(SRC, (f) =>
        f === 'scripts/a.mjs' ? 'the line was reworded\n' : READ(f),
      );
      expect(findings.join(' ')).toMatch(/0 time\(s\) in scripts\/a\.mjs/);
    });

    it('a table that no loop destructures is not guessed at', () => {
      // No `for (const [file, …, anchor] of T)` -> the array is just data.
      const { resolved } = auditAnchorLiveness(
        "const T = [['a.txt', 'label', 'anchor', 'x']];",
        () => 'anchor\n',
      );
      expect(resolved).toEqual([]);
    });
  });

  describe('wrapper function: prove(label, file, anchor, …) call sites', () => {
    const SRC = [
      "const CI = resolve(REPO_ROOT, '.github/workflows/ci.yml');",
      'function prove(label, file, anchor, replacement) {',
      '  const snap = snapshot(file);',
      '  mutate(snap, anchor, replacement);',
      '}',
      "prove('one', CI, '  compat-smoke:\\n', 'x');",
      "prove('two', resolve(REPO_ROOT, 'src/z.ts'), 'live z', 'y');",
    ].join('\n');
    const READ = (f: string) =>
      f === '.github/workflows/ci.yml' ? 'jobs:\n  compat-smoke:\n    x\n' : 'a live z here\n';

    it('LIVE call sites resolve, and the wrapper body is not double-reported', () => {
      const { resolved, findings, unresolved } = auditAnchorLiveness(SRC, READ);
      expect(findings).toEqual([]);
      expect(unresolved).toEqual([]);
      expect(resolved.map((r) => r.file)).toEqual(['.github/workflows/ci.yml', 'src/z.ts']);
    });

    it('a STALE call-site anchor IS a finding', () => {
      const { findings } = auditAnchorLiveness(SRC, (f) =>
        f === 'src/z.ts' ? 'the construct was deleted\n' : READ(f),
      );
      expect(findings.join(' ')).toMatch(/0 time\(s\) in src\/z\.ts/);
    });

    it('an async wrapper is read too', () => {
      const src = SRC.replace('function prove', 'async function prove').replace(
        /^prove\(/gm,
        'await prove(',
      );
      const { resolved } = auditAnchorLiveness(src, READ);
      expect(resolved).toHaveLength(2);
    });

    it('a wrapper with NO call sites is reported, not silently clean', () => {
      const src = SRC.split('\n').slice(0, 5).join('\n');
      const { unresolved } = auditAnchorLiveness(src, READ);
      expect(unresolved.join(' ')).toMatch(/no call sites/);
    });

    it('a call site whose anchor is computed is REPORTED', () => {
      const { resolved, unresolved } = auditAnchorLiveness(
        [
          SRC.split('\n').slice(0, 5).join('\n'),
          "prove('c', resolve(REPO_ROOT, 'a.ts'), build(), 'y');",
        ].join('\n'),
        READ,
      );
      expect(resolved).toEqual([]);
      expect(unresolved.length).toBeGreaterThan(0);
    });
  });

  describe('table imported from a shared lib module', () => {
    const PROVER = [
      "import { MUTATIONS } from './lib/thing-proof.mjs';",
      'for (const m of MUTATIONS) prove(m);',
    ].join('\n');
    const LIB = [
      "const MARKERS = 'tests/helpers/m.ts';",
      'export const MUTATIONS = [',
      "  { label: 'one', file: MARKERS, anchor: 'live marker', replacement: 'x' },",
      '];',
    ].join('\n');
    const reader = (libSource: string | undefined, target: string | undefined) => (f: string) =>
      f === 'scripts/lib/thing-proof.mjs'
        ? libSource
        : f === 'tests/helpers/m.ts'
          ? target
          : undefined;

    it('a LIVE anchor in the delegated module resolves', () => {
      const { resolved, findings } = auditAnchorLiveness(
        PROVER,
        reader(LIB, 'one live marker line\n'),
      );
      expect(findings).toEqual([]);
      expect(resolved.map((r) => [r.file, r.anchor])).toEqual([
        ['tests/helpers/m.ts', 'live marker'],
      ]);
    });

    it('a STALE anchor in the delegated module IS a finding on the PROVER', () => {
      const { findings } = auditAnchorLiveness(PROVER, reader(LIB, 'the marker was renamed\n'));
      expect(findings.join(' ')).toMatch(/0 time\(s\) in tests\/helpers\/m\.ts/);
    });

    it('an import of a module that does not exist IS a finding', () => {
      const { findings } = auditAnchorLiveness(PROVER, reader(undefined, 'x\n'));
      expect(findings.join(' ')).toMatch(/imports .*thing-proof\.mjs.*does not exist/);
    });

    it('an import named only in a COMMENT is not followed', () => {
      const { findings } = auditAnchorLiveness(
        "// import { M } from './lib/thing-proof.mjs';\n",
        reader(undefined, undefined),
      );
      expect(findings).toEqual([]);
    });
  });
});

describe('self-asserting provers: anchors built at run time assert themselves', () => {
  describe('anchorProblems (the run-time check)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'anchor-problems-'));
    const file = join(dir, 'subject.txt');
    writeFileSync(file, 'alpha\nbeta\nbeta\n');

    it('a LIVE anchor (exactly one occurrence) has no problem', () => {
      expect(anchorProblems([{ label: 'live', file, anchor: 'alpha' }])).toEqual([]);
    });

    it('a STALE anchor (zero occurrences) is a problem', () => {
      expect(anchorProblems([{ label: 'gone', file, anchor: 'gamma' }]).join(' ')).toMatch(
        /gone.*0 times/,
      );
    });

    it('an AMBIGUOUS anchor (two occurrences) is a problem', () => {
      expect(anchorProblems([{ label: 'dup', file, anchor: 'beta' }]).join(' ')).toMatch(
        /dup.*2 times/,
      );
    });

    it('a MISSING subject file is a problem', () => {
      expect(
        anchorProblems([{ label: 'nofile', file: join(dir, 'nope.txt'), anchor: 'a' }]).join(' '),
      ).toMatch(/nofile.*cannot read/);
    });

    it('an EMPTY row list is a problem (vacuous assertion)', () => {
      expect(anchorProblems([]).join(' ')).toMatch(/no anchors/);
    });

    it('assertAnchorsResolved exits NON-ZERO on a stale anchor and zero on a live one', () => {
      const harness = resolve(REPO_ROOT, 'scripts/lib/mutation-harness.mjs');
      const run = (anchor: string) =>
        spawnSync(
          process.execPath,
          [
            '-e',
            `import(${JSON.stringify(harness)}).then((m) => m.assertAnchorsResolved([{ label: 'row', file: ${JSON.stringify(file)}, anchor: ${JSON.stringify(anchor)} }]))`,
          ],
          { encoding: 'utf8' },
        );
      expect(run('alpha').status).toBe(0);
      const stale = run('gamma');
      expect(stale.status).not.toBe(0);
      expect(`${stale.stdout}${stale.stderr}`).toMatch(/row.*0 times/);
      rmSync(dir, { recursive: true, force: true });
    });
  });

  describe('auditSelfAsserting (the static half the audit applies)', () => {
    const GOOD = [
      "import { assertAnchorsResolved, mutate } from './lib/mutation-harness.mjs';",
      'const rows = buildRows();',
      'assertAnchorsResolved(rows);',
      'for (const r of rows) mutate(r);',
    ].join('\n');

    it('a prover that imports and calls the assertion passes', () => {
      expect(auditSelfAsserting(GOOD)).toEqual([]);
    });

    it('the call REMOVED -> red (a self-asserting prover that stopped asserting)', () => {
      const dropped = GOOD.replace('assertAnchorsResolved(rows);\n', '');
      expect(auditSelfAsserting(dropped).join(' ')).toMatch(/never calls assertAnchorsResolved/);
    });

    it('the call COMMENTED OUT -> red', () => {
      const commented = GOOD.replace(
        'assertAnchorsResolved(rows);',
        '// assertAnchorsResolved(rows);',
      );
      expect(auditSelfAsserting(commented).length).toBeGreaterThan(0);
    });

    it('the call inside a STRING -> red', () => {
      const quoted = GOOD.replace(
        'assertAnchorsResolved(rows);',
        "console.log('assertAnchorsResolved(rows);');",
      );
      expect(auditSelfAsserting(quoted).length).toBeGreaterThan(0);
    });

    it('the call only inside a function that is never invoked -> red', () => {
      // A call nested in a function body is not top-level; defining the check is
      // not running it.
      const nested = GOOD.replace(
        'assertAnchorsResolved(rows);',
        'function never() {\n  assertAnchorsResolved(rows);\n}',
      );
      expect(auditSelfAsserting(nested).length).toBeGreaterThan(0);
    });

    it('the IMPORT removed (a local stub of the same name) -> red', () => {
      const stub = GOOD.replace(
        "import { assertAnchorsResolved, mutate } from './lib/mutation-harness.mjs';",
        "import { mutate } from './lib/mutation-harness.mjs';\nconst assertAnchorsResolved = () => {};",
      );
      expect(auditSelfAsserting(stub).join(' ')).toMatch(/does not import/);
    });
  });
});

describe('the real tree: no dated exemption remains for these provers', () => {
  const RESOLVED = [
    'scripts/mutation-prove-skew-id-chain.mjs',
    'scripts/mutation-prove-anonymous-install.mjs',
    'scripts/mutation-prove-ci-blocking-gates.mjs',
    'scripts/mutation-prove-compat-fail-on-red-teeth.mjs',
    'scripts/mutation-prove-compat-lane-pointer.mjs',
    'scripts/mutation-prove-entry-copy-parity.mjs',
    'scripts/mutation-prove-ledger-completeness.mjs',
    'scripts/mutation-prove-publish-markers.mjs',
  ];
  const provers = discoverProvers(REPO_ROOT);
  const readTarget = (rel: string) => {
    const p = resolve(REPO_ROOT, rel);
    return existsSync(p) ? readFileSync(p, 'utf8') : undefined;
  };

  it('PROVER_AUDIT_EXEMPTIONS no longer names any of them', () => {
    const named = PROVER_AUDIT_EXEMPTIONS.map((e: { prover: string }) => e.prover);
    expect(named.filter((p: string) => RESOLVED.includes(p))).toEqual([]);
  });

  it('every one is either anchor-audited (>=1 resolved, 0 findings) or self-asserting', () => {
    const selfAsserting = new Set(SELF_ASSERTING_PROVERS.map((s: { prover: string }) => s.prover));
    const bad: string[] = [];
    for (const rel of RESOLVED) {
      const src = readFileSync(resolve(REPO_ROOT, rel), 'utf8');
      if (selfAsserting.has(rel)) {
        const f = auditSelfAsserting(src);
        if (f.length) bad.push(`${rel}: ${f.join('; ')}`);
        continue;
      }
      const { resolved, findings } = auditAnchorLiveness(src, readTarget);
      if (resolved.length === 0) bad.push(`${rel}: resolves 0 anchors and is not self-asserting`);
      if (findings.length) bad.push(`${rel}: ${findings.join('; ')}`);
    }
    expect(bad).toEqual([]);
  });

  it('every self-asserting classification is permanent, reasoned, and names a real prover', () => {
    const known = new Set(provers.map((p) => p.relPath));
    expect(SELF_ASSERTING_PROVERS.length).toBeGreaterThan(0);
    for (const s of SELF_ASSERTING_PROVERS as ReadonlyArray<Record<string, unknown>>) {
      expect(known.has(s.prover as string), `${s.prover} does not exist`).toBe(true);
      expect(String(s.reason ?? '').length, `${s.prover} needs a reason`).toBeGreaterThan(40);
      // PERMANENT: a dated entry would be the renewing clock this replaces.
      expect('expires' in s || 'added' in s).toBe(false);
    }
  });

  it('every self-asserting prover really asserts (red if one stops)', () => {
    for (const s of SELF_ASSERTING_PROVERS as ReadonlyArray<{ prover: string }>) {
      const src = readFileSync(resolve(REPO_ROOT, s.prover), 'utf8');
      expect(auditSelfAsserting(src), s.prover).toEqual([]);
    }
  });
});
