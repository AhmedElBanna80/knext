/**
 * The upstream-runtime-defect ledger (ADR-0007 amendment 2026-11-05).
 *
 * Two halves, both asserted:
 *   - PR time: every entry in `$knextUpstreamRuntimeDefects` passes the validator in
 *     scripts/lib/upstream-runtime-defects.mjs, and each rule rejects its own violation.
 *   - Run time: scripts/compat-manifest-for-ref.mjs adds an entry's cases to the scoped copy's
 *     `suites[file].failed` ONLY on the entry's lane, at its ref, and (on Bun) at its Bun; on any
 *     other cell, ref or Bun the cases run. It fails closed on an unknown lane or an unreadable Bun.
 *
 * Mutation proofs: scripts/mutation-prove-upstream-runtime-defects.mjs.
 */

import { afterAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  caseName,
  HARNESS_LANE_WORKFLOWS,
  laneDefaultRef,
} from '../scripts/lib/ref-pinned-cases.mjs';
import {
  applyUpstreamRuntimeDefects,
  entryProblems,
  laneBunPin,
  ledgerProblems,
  parseUpstreamRuntimeDefects,
  UPSTREAM_RUNTIME_DEFECT_CAP,
  UPSTREAM_RUNTIME_DEFECT_KEY,
  UPSTREAM_RUNTIME_DEFECT_SCOPE_KEY,
} from '../scripts/lib/upstream-runtime-defects.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');
const MANIFEST_PATH = 'test/deploy-tests-manifest.knext.json';
const SCRIPT = resolve(ROOT, 'scripts/compat-manifest-for-ref.mjs');

type Case = { path: string[]; title: string };
type Entry = {
  test: string;
  lane: string;
  nextjsRef: string;
  bunVersion?: string;
  cases: Case[];
  mechanism: string;
  runs: { run: string; cell: string; ref: string }[];
  upstream: { issue: string; fix: string };
  knextRefusal: string;
  removeWhen: string;
  provenance: string;
  [k: string]: unknown;
};
type Manifest = {
  suites: Record<string, { failed?: string[]; flakey?: string[] }>;
  rules: { include: string[]; exclude: string[] };
  [k: string]: unknown;
};

const manifestText = read(MANIFEST_PATH);
const manifest = JSON.parse(manifestText) as Manifest;
const ledger = (manifest[UPSTREAM_RUNTIME_DEFECT_KEY] ?? []) as Entry[];
const snapshot = JSON.parse(read('test/compat-ref-pinned-cases.upstream.json'));
const laneRefs = HARNESS_LANE_WORKFLOWS.map((w) => laneDefaultRef(read(w), w));
const shippedRef = `v${JSON.parse(read('.github/compat-credentialed-next-version.json')).shippedNextPin}`;
const laneBun = laneBunPin(read('.github/workflows/test-e2e-deploy.yml'), 'test-e2e-deploy.yml');
const ctx = {
  exists: (p: string) => existsSync(resolve(ROOT, p)),
  read: (p: string) => (existsSync(resolve(ROOT, p)) ? read(p) : undefined),
};
const deps = { ctx, laneRefs, shippedRef, laneBun, snapshot };

const tmpDirs: string[] = [];
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'knext-urd-'));
  tmpDirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

const TREESHAKE = 'test/e2e/app-dir/treeshake-mw/mw.test.ts';
const CHUNKGROUP =
  'test/e2e/app-dir/turbopack-tree-shaking-chunkgroup/turbopack-tree-shaking-chunkgroup.test.ts';

// ── PR time: the real ledger ──────────────────────────────────────────────────────────────────

describe('upstream-runtime-defect ledger — the real manifest', () => {
  it('holds exactly the two Bun-parser entries, on bun/turbopack, at v16.4.3, on Bun 1.4.2', () => {
    expect(ledger.map((e) => e.test).sort()).toEqual([TREESHAKE, CHUNKGROUP].sort());
    for (const e of ledger) {
      expect(e.lane).toBe('bun/turbopack');
      expect(e.nextjsRef).toBe('v16.4.3');
      expect(e.bunVersion).toBe('1.4.2');
      expect(e.upstream).toEqual({ issue: 'oven-sh/bun#45007', fix: 'oven-sh/bun#45010' });
    }
  });

  it('records the exact jest names upstream runs at v16.4.3', () => {
    const names = Object.fromEntries(ledger.map((e) => [e.test, e.cases.map(caseName)]));
    expect(names[TREESHAKE]).toEqual([
      'treeshake-mw builds and runs Node.js middleware importing via a star re-export',
    ]);
    expect(names[CHUNKGROUP]).toEqual([
      'turbopack-tree-shaking-chunkgroup builds an app-router app with tree-shaking enabled and renders',
    ]);
  });

  it('every entry is admissible and the ledger has no boundary problem', () => {
    expect(ledgerProblems(manifest, deps)).toEqual([]);
  });

  it('is within its own cap', () => {
    expect(UPSTREAM_RUNTIME_DEFECT_CAP).toBe(5);
    expect(ledger.length).toBeLessThanOrEqual(UPSTREAM_RUNTIME_DEFECT_CAP);
  });

  it('the committed manifest deselects nothing of this kind: the files keep running on every cell', () => {
    for (const e of ledger) {
      expect(manifest.suites[e.test]?.failed ?? []).toEqual([]);
      expect(manifest.rules.exclude).not.toContain(e.test);
    }
  });

  it('the smoke manifest carries the ledger verbatim', () => {
    const smoke = JSON.parse(read('test/deploy-tests-manifest.smoke.knext.json'));
    expect(smoke[UPSTREAM_RUNTIME_DEFECT_KEY]).toEqual(ledger);
  });

  it('the refusal it cites is the shipped build-time guard', () => {
    for (const e of ledger) {
      expect(e.knextRefusal).toContain(
        'packages/kn-next/src/cli/turbopack-fragments-guard.ts#assertNoBunTurbopackFragments',
      );
    }
    expect(read('packages/kn-next/src/cli/turbopack-fragments-guard.ts')).toContain(
      'export function assertNoBunTurbopackFragments',
    );
  });
});

describe('upstream-runtime-defect ledger — parse fails closed', () => {
  it('invalid JSON throws', () => {
    expect(() => parseUpstreamRuntimeDefects('{ nope')).toThrow(/not readable JSON/);
  });
  it('a missing key throws (never reads as an empty ledger)', () => {
    expect(() => parseUpstreamRuntimeDefects('{}')).toThrow(
      /no \$knextUpstreamRuntimeDefects array/,
    );
  });
  it('a non-array value throws', () => {
    expect(() => parseUpstreamRuntimeDefects('{"$knextUpstreamRuntimeDefects":{}}')).toThrow(
      /array/,
    );
  });
  it('the real manifest parses to the ledger', () => {
    expect(parseUpstreamRuntimeDefects(manifestText)).toEqual(ledger);
  });
});

// ── PR time: each rule rejects its own violation ──────────────────────────────────────────────

describe('upstream-runtime-defect ledger — each rule rejects its violation', () => {
  const base = () => JSON.parse(JSON.stringify(ledger[0])) as Entry;
  const problems = (mut: (e: Entry) => void) => {
    const e = base();
    mut(e);
    return entryProblems(e, deps).join('\n');
  };

  it('CONTROL: the unmutated entry is admissible', () => {
    expect(entryProblems(base(), deps)).toEqual([]);
  });
  it.each([
    [
      'a glob test path',
      (e: Entry) => (e.test = 'test/e2e/app-dir/**/*.test.ts'),
      /concrete corpus/,
    ],
    ['a dot segment', (e: Entry) => (e.test = 'test/e2e/../x.test.ts'), /concrete corpus/],
    ['a runtime-wide lane', (e: Entry) => (e.lane = 'bun'), /lane must be/],
    ['a vinext lane', (e: Entry) => (e.lane = 'bun/vinext'), /lane must be/],
    ['a ref no lane runs', (e: Entry) => (e.nextjsRef = 'v16.4.0'), /not the default NEXTJS_REF/],
    ['an unparseable ref', (e: Entry) => (e.nextjsRef = '16.4.3'), /vX\.Y\.Z/],
    ['a reaudited escape', (e: Entry) => (e.reaudited = 'v16.4.3'), /no reaudited escape/],
    ['a missing bunVersion', (e: Entry) => delete e.bunVersion, /bunVersion it was measured on/],
    [
      'a Bun the lane no longer pins',
      (e: Entry) => (e.bunVersion = '1.4.3'),
      /not the lane's pinned Bun/,
    ],
    [
      'an in-house upstream issue',
      (e: Entry) => (e.upstream.issue = 'getknext-dev/knext#1'),
      /upstream\.issue/,
    ],
    ['a free-text upstream fix', (e: Entry) => (e.upstream.fix = 'soon'), /upstream\.fix/],
    [
      'an empty removal condition',
      (e: Entry) => (e.removeWhen = ' '),
      /removeWhen must be a non-empty/,
    ],
    [
      'a removal condition without the fix',
      (e: Entry) => (e.removeWhen = 'TBD'),
      /own upstream fix/,
    ],
    ['no refusal', (e: Entry) => (e.knextRefusal = ''), /knextRefusal must cite/],
    [
      'a refusal naming no real file',
      (e: Entry) => (e.knextRefusal = 'src/nope.ts#x'),
      /real guard/,
    ],
    [
      'a refusal naming a symbol the file lacks',
      (e: Entry) =>
        (e.knextRefusal = 'packages/kn-next/src/cli/turbopack-fragments-guard.ts#notThere'),
      /real guard/,
    ],
    ['a short mechanism', (e: Entry) => (e.mechanism = 'bun bug'), /mechanism must be/],
    ['no provenance URL', (e: Entry) => (e.provenance = 'see chat'), /provenance/],
    ['no cases', (e: Entry) => (e.cases = []), /cases must be/],
    [
      'a case title upstream does not have',
      (e: Entry) => (e.cases[0].title = 'a forged case'),
      /not a describe\/it title/,
    ],
    [
      'a describe upstream does not have',
      (e: Entry) => (e.cases[0].path = ['forged']),
      /not a describe\/it title/,
    ],
    ['a duplicate case', (e: Entry) => e.cases.push({ ...e.cases[0] }), /duplicate case/],
    ['no runs', (e: Entry) => (e.runs = []), /at least one CI run/],
    ['a run at another ref', (e: Entry) => (e.runs[0].ref = 'v16.4.0'), /measured v16\.4\.0/],
    ['a run id that is not one', (e: Entry) => (e.runs[0].run = 'yesterday'), /not a CI run id/],
    ['a run on an unknown cell', (e: Entry) => (e.runs[1].cell = 'mars'), /names no known cell/],
    [
      'no run on the entry cell',
      (e: Entry) => (e.runs[0].cell = 'node-webpack'),
      /entry's own cell/,
    ],
  ])('%s', (_label, mut, re) => {
    expect(problems(mut)).toMatch(re);
  });

  it('a snapshot taken at another ref is rejected', () => {
    expect(
      entryProblems(base(), { ...deps, snapshot: { ...snapshot, ref: 'v16.3.8' } }).join('\n'),
    ).toMatch(/snapshot is for v16\.3\.8, entry is pinned at v16\.4\.3/);
  });

  it('a file with no upstream snapshot is rejected', () => {
    const e = base();
    expect(
      entryProblems(e, { ...deps, snapshot: { ref: 'v16.4.3', files: {} } }).join('\n'),
    ).toMatch(/no upstream snapshot/);
  });

  it('refuses to verify a refusal with no repository context', () => {
    expect(entryProblems(base(), { ...deps, ctx: undefined }).join('\n')).toMatch(
      /without a repository context/,
    );
  });
});

describe('upstream-runtime-defect ledger — ledger-level rules', () => {
  const clone = () => JSON.parse(JSON.stringify(manifest)) as Manifest;
  const entries = (m: Manifest) => m[UPSTREAM_RUNTIME_DEFECT_KEY] as Entry[];

  it('over the cap is a red', () => {
    const m = clone();
    const e = entries(m)[0];
    const list = Array.from({ length: UPSTREAM_RUNTIME_DEFECT_CAP + 1 }, (_, i) => ({
      ...JSON.parse(JSON.stringify(e)),
      test: e.test.replace('.test.ts', `${i}.test.ts`),
    }));
    m[UPSTREAM_RUNTIME_DEFECT_KEY] = list;
    expect(ledgerProblems(m, deps).join('\n')).toMatch(/over its own cap of 5/);
  });
  it('a duplicate test@lane is a red', () => {
    const m = clone();
    entries(m).push(JSON.parse(JSON.stringify(entries(m)[0])));
    expect(ledgerProblems(m, deps).join('\n')).toMatch(/duplicate entry/);
  });
  it('a file excluded at file level is a red (it would stop running where it passes)', () => {
    const m = clone();
    m.rules.exclude.push(entries(m)[0].test);
    expect(ledgerProblems(m, deps).join('\n')).toMatch(/excluded at file level/);
  });
  it('a file also in the section (h) quarantine ledger is a red', () => {
    const m = clone();
    (m.$knextQuarantines as { test: string }[]).push({ test: entries(m)[0].test });
    expect(ledgerProblems(m, deps).join('\n')).toMatch(/also in \$knextQuarantines/);
  });
  it('a file also in the ref-pinned ledger is a red', () => {
    const m = clone();
    (m.$knextRefPinnedCases as { test: string }[]).push({ test: entries(m)[0].test });
    expect(ledgerProblems(m, deps).join('\n')).toMatch(/also in \$knextRefPinnedCases/);
  });
  it('a case already in the committed failed list is a red (that would deselect on every cell)', () => {
    const m = clone();
    const e = entries(m)[0];
    m.suites[e.test] = { failed: [caseName(e.cases[0])] };
    expect(ledgerProblems(m, deps).join('\n')).toMatch(/deselects it on EVERY cell/);
  });
  it('a manifest with no ledger array is a red, not an empty pass', () => {
    const m = clone();
    delete m[UPSTREAM_RUNTIME_DEFECT_KEY];
    expect(ledgerProblems(m, deps)).toEqual(['manifest has no $knextUpstreamRuntimeDefects array']);
  });
});

describe('upstream-runtime-defect ledger — the lane Bun pin is read, never assumed', () => {
  it('reads the one pin from the real workflow', () => {
    expect(laneBun).toBe('1.4.2');
  });
  it('throws when there is no pin', () => {
    expect(() => laneBunPin('bun-version: 1.4.2', 'x.yml')).toThrow(/cannot read ONE/);
  });
  it('throws when two lane pins disagree', () => {
    const two =
      "bun-version: ${{ github.event.inputs.bun-version || '1.4.2' }}\n" +
      "bun-version: ${{ github.event.inputs.bun-version || '1.4.3' }}";
    expect(() => laneBunPin(two, 'x.yml')).toThrow(/cannot read ONE/);
  });
  it('a lane Bun bump turns every bun entry red until it is re-measured or removed', () => {
    const bumped = { ...deps, laneBun: '1.4.3' };
    for (const e of ledger) {
      expect(entryProblems(e, bumped).join('\n')).toMatch(/not the lane's pinned Bun \(1\.4\.3\)/);
    }
  });
});

// ── Run time: the scope, in-process and on the real script ────────────────────────────────────

describe('upstream-runtime-defect scope — in-process', () => {
  const names = (m: Manifest, f: string) => m.suites[f]?.failed ?? [];
  const scope = (lane: { ref: string; runtime?: string; builder?: string; bun?: string }) =>
    applyUpstreamRuntimeDefects(JSON.parse(JSON.stringify(manifest)), {
      ref: lane.ref,
      runtime: lane.runtime,
      builder: lane.builder,
      bunVersion: () => lane.bun ?? '',
    }) as Manifest;

  it('bun/turbopack at v16.4.3 on Bun 1.4.2: both cases deselected', () => {
    const m = scope({ ref: 'v16.4.3', runtime: 'bun', builder: 'turbopack', bun: '1.4.2' });
    for (const e of ledger) expect(names(m, e.test)).toEqual(e.cases.map(caseName));
    expect((m[UPSTREAM_RUNTIME_DEFECT_SCOPE_KEY] as { applied: string[] }).applied.sort()).toEqual(
      ledger.map((e) => e.test).sort(),
    );
  });
  it.each([
    ['node/turbopack at v16.4.3', { ref: 'v16.4.3', runtime: 'node', builder: 'turbopack' }],
    [
      'bun/webpack at v16.4.3',
      { ref: 'v16.4.3', runtime: 'bun', builder: 'webpack', bun: '1.4.2' },
    ],
    ['node/webpack at v16.4.3', { ref: 'v16.4.3', runtime: 'node', builder: 'webpack' }],
    [
      'bun/turbopack at v16.3.8',
      { ref: 'v16.3.8', runtime: 'bun', builder: 'turbopack', bun: '1.4.2' },
    ],
    [
      'bun/turbopack at v16.4.3 on a canary Bun',
      { ref: 'v16.4.3', runtime: 'bun', builder: 'turbopack', bun: '1.4.3' },
    ],
    ['bun/vinext at v16.4.3', { ref: 'v16.4.3', runtime: 'bun', builder: 'vinext', bun: '1.4.2' }],
  ])('%s: nothing deselected, the cases run', (_label, lane) => {
    const m = scope(lane);
    for (const e of ledger) expect(names(m, e.test)).toEqual([]);
    expect((m[UPSTREAM_RUNTIME_DEFECT_SCOPE_KEY] as { applied: string[] }).applied).toEqual([]);
  });
  it('the Bun is read only when an entry matches lane and ref (a node lane never needs bun)', () => {
    let calls = 0;
    applyUpstreamRuntimeDefects(JSON.parse(JSON.stringify(manifest)), {
      ref: 'v16.4.3',
      runtime: 'node',
      builder: 'turbopack',
      bunVersion: () => {
        calls += 1;
        return '1.4.2';
      },
    });
    expect(calls).toBe(0);
  });
  it('FAIL CLOSED: a matching Bun lane whose Bun cannot be read throws', () => {
    expect(() => scope({ ref: 'v16.4.3', runtime: 'bun', builder: 'turbopack', bun: '' })).toThrow(
      /could not be read/,
    );
  });
  it('FAIL CLOSED: a non-empty ledger with no runtime or builder throws', () => {
    expect(() => scope({ ref: 'v16.4.3', builder: 'turbopack' })).toThrow(/lane is unknown/);
    expect(() => scope({ ref: 'v16.4.3', runtime: 'bun' })).toThrow(/lane is unknown/);
  });
  it('FAIL CLOSED: an entry with no parseable lane, ref or cases throws', () => {
    for (const mut of [
      (e: Entry) => (e.lane = 'bun'),
      (e: Entry) => (e.nextjsRef = 'main'),
      (e: Entry) => (e.cases = []),
    ]) {
      const m = JSON.parse(JSON.stringify(manifest)) as Manifest;
      mut((m[UPSTREAM_RUNTIME_DEFECT_KEY] as Entry[])[0]);
      expect(() =>
        applyUpstreamRuntimeDefects(m, {
          ref: 'v16.4.3',
          runtime: 'node',
          builder: 'turbopack',
          bunVersion: () => '1.4.2',
        }),
      ).toThrow();
    }
  });
  it('a manifest without the ledger passes through with no scope record (old rc tags)', () => {
    const m = JSON.parse(JSON.stringify(manifest)) as Manifest;
    delete m[UPSTREAM_RUNTIME_DEFECT_KEY];
    const out = applyUpstreamRuntimeDefects(m, { ref: 'v16.4.3' }) as Manifest;
    expect(out[UPSTREAM_RUNTIME_DEFECT_SCOPE_KEY]).toBeUndefined();
  });
});

describe('upstream-runtime-defect scope — the REAL script, env-driven like the workflow step', () => {
  /** A PATH holding a fake `bun` that prints `version`, so the test does not depend on the host Bun. */
  function fakeBun(version: string | null): string {
    const dir = tmp();
    const bin = join(dir, 'bun');
    writeFileSync(bin, version === null ? '#!/bin/sh\nexit 1\n' : `#!/bin/sh\necho ${version}\n`);
    chmodSync(bin, 0o755);
    return dir;
  }
  function run(o: { ref: string; runtime?: string; builder?: string; bun?: string | null }) {
    const out = join(tmp(), 'scoped.json');
    const env: Record<string, string> = {
      PATH: `${fakeBun(o.bun === undefined ? '1.4.2' : o.bun)}:${dirname(process.execPath)}:/usr/bin:/bin`,
    };
    if (o.runtime !== undefined) env.KNEXT_RUNTIME = o.runtime;
    if (o.builder !== undefined) env.KNEXT_BUILDER = o.builder;
    const r = spawnSync(
      process.execPath,
      [SCRIPT, '--manifest', resolve(ROOT, MANIFEST_PATH), '--ref', o.ref, '--out', out],
      { encoding: 'utf8', env },
    );
    return {
      r,
      out,
      scoped: existsSync(out) ? (JSON.parse(readFileSync(out, 'utf8')) as Manifest) : null,
    };
  }

  it('bun/turbopack at v16.4.3, Bun 1.4.2: the copy the harness reads deselects both cases', () => {
    const { r, scoped } = run({ ref: 'v16.4.3', runtime: 'bun', builder: 'turbopack' });
    expect(r.status, r.stderr).toBe(0);
    for (const e of ledger) expect(scoped?.suites[e.test]?.failed).toEqual(e.cases.map(caseName));
    expect(r.stdout).toMatch(/upstream-runtime defects on bun\/turbopack at v16\.4\.3: 2 applied/);
    // The Bun it compared is the one `bun --version` printed on PATH, not an assumed constant.
    expect(
      (scoped?.[UPSTREAM_RUNTIME_DEFECT_SCOPE_KEY] as { bunVersion: string } | undefined)
        ?.bunVersion,
    ).toBe('1.4.2');
  });
  it.each([
    ['node/turbopack v16.4.3', { ref: 'v16.4.3', runtime: 'node', builder: 'turbopack' }],
    ['bun/webpack v16.4.3', { ref: 'v16.4.3', runtime: 'bun', builder: 'webpack' }],
    ['bun/turbopack v16.3.8', { ref: 'v16.3.8', runtime: 'bun', builder: 'turbopack' }],
    [
      'bun/turbopack v16.4.3 on a canary Bun',
      { ref: 'v16.4.3', runtime: 'bun', builder: 'turbopack', bun: '1.5.0' },
    ],
  ])('%s: the cases run', (_label, lane) => {
    const o = lane as { ref: string; runtime: string; builder: string; bun?: string };
    const { r, scoped } = run(o);
    expect(r.status, r.stderr).toBe(0);
    for (const e of ledger) expect(scoped?.suites[e.test]?.failed).toBeUndefined();
    if (o.bun) {
      expect(
        (scoped?.[UPSTREAM_RUNTIME_DEFECT_SCOPE_KEY] as { bunVersion: string } | undefined)
          ?.bunVersion,
      ).toBe(o.bun);
    }
  });
  it('flags override the env', () => {
    const out = join(tmp(), 'scoped.json');
    const r = spawnSync(
      process.execPath,
      [
        SCRIPT,
        '--manifest',
        resolve(ROOT, MANIFEST_PATH),
        '--ref',
        'v16.4.3',
        '--out',
        out,
        '--runtime',
        'bun',
        '--builder',
        'turbopack',
        '--bun-version',
        '1.4.2',
      ],
      {
        encoding: 'utf8',
        env: { PATH: '/usr/bin:/bin', KNEXT_RUNTIME: 'node', KNEXT_BUILDER: 'webpack' },
      },
    );
    expect(r.status, r.stderr).toBe(0);
    const scoped = JSON.parse(readFileSync(out, 'utf8')) as Manifest;
    for (const e of ledger) expect(scoped.suites[e.test]?.failed).toEqual(e.cases.map(caseName));
  });
  it('FAIL CLOSED: no KNEXT_RUNTIME/KNEXT_BUILDER exits non-zero and leaves no copy', () => {
    const { r, out } = run({ ref: 'v16.4.3' });
    expect(r.status).not.toBe(0);
    expect(existsSync(out)).toBe(false);
  });
  it('FAIL CLOSED: a bun/turbopack night whose bun --version fails exits non-zero and leaves no copy', () => {
    const { r, out } = run({ ref: 'v16.4.3', runtime: 'bun', builder: 'turbopack', bun: null });
    expect(r.status).not.toBe(0);
    expect(existsSync(out)).toBe(false);
  });
});

describe('upstream-runtime-defect scope — the workflows hand the lane to the scope step', () => {
  // The step takes the lane from the workflow-level env, which every step inherits. A step-level
  // override would hand the script the wrong lane, so it is a red.
  for (const lane of [
    '.github/workflows/test-e2e-deploy.yml',
    '.github/workflows/compat-vinext.yml',
  ]) {
    it(`${lane} defines KNEXT_RUNTIME and KNEXT_BUILDER at workflow level and the scope step does not override them`, () => {
      const wf = (Bun as unknown as { YAML: { parse: (s: string) => unknown } }).YAML.parse(
        read(lane),
      ) as {
        env: Record<string, string>;
        jobs: Record<string, { steps: { name?: string; env?: Record<string, string> }[] }>;
      };
      expect(wf.env.KNEXT_RUNTIME).toBeTruthy();
      expect(wf.env.KNEXT_BUILDER).toBeTruthy();
      const steps = Object.values(wf.jobs).flatMap((j) => j.steps ?? []);
      const scope = steps.filter(
        (s) => s.name === 'Scope ref-pinned per-case deselections to NEXTJS_REF',
      );
      expect(scope.length).toBe(1);
      expect(scope[0].env?.KNEXT_RUNTIME).toBeUndefined();
      expect(scope[0].env?.KNEXT_BUILDER).toBeUndefined();
    });
  }
});
