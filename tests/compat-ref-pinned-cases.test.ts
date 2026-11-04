/**
 * The ref-pinned per-case ledger (ADR-0007 amendment 2026-11-04).
 *
 * ADR-0007 section (h) kept deterministic failures at FILE level because a per-case list can
 * quietly hide a failing assertion. The amendment admits a per-case entry only under five bars,
 * and this file is where each bar is a guard rather than a sentence:
 *
 *   1. ref pin   2. exact names that must still exist upstream   3. upstream line citation
 *   4. run IDs and measured cells (no unmeasured cell claim)      5. a counted cap
 *
 * Part A drives the validator with fixtures, one rule at a time, so each bar is shown to be able
 * to go red. Part B holds the REAL manifest to the validator. Part C pins the ADR text.
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildSnapshot,
  diffSnapshots,
  fetchFromGitHub,
} from '../scripts/compat-ref-pinned-cases-snapshot.mjs';
import {
  CELLS,
  caseName,
  extractLines,
  extractTitleLiterals,
  literalProduces,
  MECHANISM_CATEGORIES,
  passingCasesLostPerCell,
  REF_PINNED_CASE_CAP,
  REF_PINNED_FILE_CAP,
  refPinAdmissible,
  validateRefPinnedCases,
} from '../scripts/lib/ref-pinned-cases.mjs';
import { UPSTREAM_MIRROR_SUITES } from './compat-quarantine-bounds';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(resolve(ROOT, p), 'utf8');

type Case = { path: string[]; title: string; cells: string[] };
type Entry = Record<string, unknown> & { test: string; cases: Case[] };

const FILE = 'test/e2e/app-dir/example/example.test.ts';
const REF = 'v16.4.3';

function entry(over: Partial<Entry> = {}): Entry {
  return {
    test: FILE,
    nextjsRef: REF,
    mechanismCategory: 'vercel-cdn-header',
    mechanism:
      'The failing assertion sits in the isNextDeploy branch and expects the Vercel CDN header x-vercel-cache.',
    upstream: [{ line: 7, anchor: "get('x-vercel-cache')" }],
    cases: [
      { path: ['example'], title: 'serves a shell', cells: ['node-turbopack', 'bun-webpack'] },
      { path: ['example'], title: 'keeps it dynamic', cells: ['node-turbopack'] },
    ],
    runs: [
      { run: '41754152861', cell: 'node-turbopack', ref: REF },
      { run: '41770412157', cell: 'bun-webpack', ref: REF },
    ],
    measured: { 'node-turbopack': { failed: 2 }, 'bun-webpack': { failed: 1 } },
    provenance: 'https://github.com/getknext-dev/knext/issues/2128',
    retire: 'Retire when upstream stops asserting the CDN header for non-Vercel adapters.',
    ...over,
  } as Entry;
}

function ctx(ledger: Entry[] = [entry()], over: Record<string, unknown> = {}) {
  const suites: Record<string, { failed?: string[] }> = {};
  for (const e of ledger) suites[e.test] = { failed: e.cases.map(caseName) };
  return {
    ledger,
    suites,
    rulesExclude: [] as string[],
    snapshot: {
      ref: REF,
      files: Object.fromEntries(
        ledger.map((e) => [
          e.test,
          {
            literals: ['example', 'serves a shell', 'keeps it dynamic'],
            lines: { '7': "  expect(h.get('x-vercel-cache')).toBe('HIT')" },
          },
        ]),
      ),
    },
    defaultRef: 'v16.3.8',
    shippedRef: REF,
    upstreamMirror: new Set<string>(),
    ...over,
  };
}

const errs = (c: ReturnType<typeof ctx>) => validateRefPinnedCases(c as never);

describe('ref-pinned per-case ledger — Part A: every bar can go red', () => {
  it('the fixture ledger is admissible (so each red below is caused by its own mutation)', () => {
    expect(errs(ctx())).toEqual([]);
  });

  describe('bar 1: the ref pin', () => {
    it('refPinAdmissible: default, or the shipped pin while ahead of the default, and nothing else', () => {
      expect(refPinAdmissible('v16.3.8', 'v16.3.8', 'v16.4.3')).toBe(true);
      expect(refPinAdmissible('v16.4.3', 'v16.3.8', 'v16.4.3')).toBe(true);
      expect(refPinAdmissible('v16.4.0', 'v16.3.8', 'v16.4.3')).toBe(false);
      // The default moved past the shipped pin: the shipped-pin allowance is gone.
      expect(refPinAdmissible('v16.4.3', 'v16.5.0', 'v16.4.3')).toBe(false);
    });
    it('reds when the pin is neither the workflow default nor the shipped pin', () => {
      const c = ctx([entry({ nextjsRef: 'v16.4.0' })]);
      expect(errs(c).join('\n')).toMatch(/pinned at v16\.4\.0/);
    });
    it('reds on a bump: the entry is still pinned at the old ref after the default moved', () => {
      const c = ctx([entry()], { defaultRef: 'v16.5.0', shippedRef: 'v16.5.0' });
      expect(errs(c).join('\n')).toMatch(/stops being admissible at any other ref/);
    });
    it('has no "reaudited" escape', () => {
      const c = ctx([entry({ reaudited: 'v16.5.0' })]);
      expect(errs(c).join('\n')).toMatch(/cannot be "reaudited"/);
    });
    it('reds when a cited run measured a different ref than the pin', () => {
      const e = entry({ runs: [{ run: '41754152861', cell: 'node-turbopack', ref: 'v16.3.8' }] });
      expect(errs(ctx([e])).join('\n')).toMatch(/measured v16\.3\.8, not the pinned v16\.4\.3/);
    });
    it('reds when the snapshot was taken at another ref', () => {
      const c = ctx();
      c.snapshot.ref = 'v16.3.8';
      expect(errs(c).join('\n')).toMatch(/snapshot is for v16\.3\.8/);
    });
  });

  describe('bar 2: exact names that still exist upstream', () => {
    it('reds on a case title that no longer exists in the file at the ref', () => {
      const e = entry();
      e.cases[0].title = 'a title upstream renamed';
      expect(errs(ctx([e])).join('\n')).toMatch(
        /no longer exists upstream at v16\.4\.3 \(title not found\)/,
      );
    });
    it('reds on a describe element that no longer exists', () => {
      const e = entry();
      e.cases[0].path = ['a renamed describe'];
      expect(errs(ctx([e])).join('\n')).toMatch(/describe "a renamed describe" not found/);
    });
    it('a jest %s placeholder in the source describe matches its substituted value', () => {
      expect(literalProduces('app-dir (flag: %s)', 'app-dir (flag: true)')).toBe(true);
      expect(literalProduces('app-dir (flag: %s)', 'app-dir (other: true)')).toBe(false);
    });
    it('reds when suites.failed is missing a ledgered name, or carries one the ledger does not', () => {
      const missing = ctx();
      missing.suites[FILE].failed = [caseName(entry().cases[0])];
      expect(errs(missing).join('\n')).toMatch(/is in the ledger but not in suites\.failed/);
      const extra = ctx();
      extra.suites[FILE].failed?.push('example something else');
      expect(errs(extra).join('\n')).toMatch(/suites\.failed has "example something else"/);
    });
    it('reds on a suites.failed list outside the upstream mirror that has no ledger record', () => {
      const c = ctx();
      c.suites['test/e2e/other/other.test.ts'] = { failed: ['other x'] };
      expect(errs(c).join('\n')).toMatch(/unledgered per-case list is forbidden/);
      c.upstreamMirror.add('test/e2e/other/other.test.ts');
      expect(errs(c)).toEqual([]);
    });
    it('reds when the file is also excluded at file level', () => {
      const c = ctx();
      c.rulesExclude.push(FILE);
      expect(errs(c).join('\n')).toMatch(/must not also be file-level excluded/);
    });
    it('reds on two entries for one file', () => {
      expect(errs(ctx([entry(), entry()])).join('\n')).toMatch(/two ledger entries for one file/);
    });
  });

  describe('bar 3: citation and mechanism', () => {
    it('reds on a missing citation', () => {
      expect(errs(ctx([entry({ upstream: [] })])).join('\n')).toMatch(/no upstream citation/);
    });
    it('reds when the cited line does not contain the anchor at the ref', () => {
      const e = entry({ upstream: [{ line: 7, anchor: 'a string that is not on that line' }] });
      expect(errs(ctx([e])).join('\n')).toMatch(/line 7 at v16\.4\.3 does not contain/);
    });
    it('reds when the cited line is not in the snapshot', () => {
      const e = entry({ upstream: [{ line: 99, anchor: 'x' }] });
      expect(errs(ctx([e])).join('\n')).toMatch(/cited line 99 is not in the upstream snapshot/);
    });
    it('reds on a mechanism category outside the closed set', () => {
      expect(errs(ctx([entry({ mechanismCategory: 'flakey' })])).join('\n')).toMatch(
        /not in the closed set/,
      );
      expect(MECHANISM_CATEGORIES).not.toContain('flakey');
    });
    it('reds on a missing or short reason, provenance, or retirement condition', () => {
      expect(errs(ctx([entry({ mechanism: 'short' })])).join('\n')).toMatch(/written reason/);
      expect(errs(ctx([entry({ provenance: 'see the thread' })])).join('\n')).toMatch(/provenance/);
      expect(errs(ctx([entry({ retire: '' })])).join('\n')).toMatch(/retire must state/);
    });
  });

  describe('bar 4: run IDs and measured cells', () => {
    it('reds when no run is cited', () => {
      const e = entry({ runs: [], measured: {} });
      expect(errs(ctx([e])).join('\n')).toMatch(/no runs cited/);
    });
    it('reds on a case that claims a cell nobody measured', () => {
      const e = entry();
      e.cases[0].cells = ['node-turbopack', 'node-webpack'];
      expect(errs(ctx([e])).join('\n')).toMatch(
        /claims cell node-webpack, which has no measured run/,
      );
    });
    it('reds when the failures measured on a cell do not equal the cases claiming it', () => {
      const e = entry({
        measured: { 'node-turbopack': { failed: 5 }, 'bun-webpack': { failed: 1 } },
      });
      expect(errs(ctx([e])).join('\n')).toMatch(/measured 5 failure\(s\) but 2 case\(s\) claim it/);
    });
    it('reds on an unknown cell or a malformed run id', () => {
      const e = entry({ runs: [{ run: 'abc', cell: 'deno-vite', ref: REF }] });
      expect(errs(ctx([e])).join('\n')).toMatch(/not a run id/);
      expect(errs(ctx([e])).join('\n')).toMatch(/unknown cell "deno-vite"/);
    });
    it('reds on measured counts for a cell that has no run', () => {
      const e = entry({
        measured: {
          'node-turbopack': { failed: 2 },
          'bun-webpack': { failed: 1 },
          'node-webpack': { failed: 0 },
        },
      });
      expect(errs(ctx([e])).join('\n')).toMatch(/measured counts for node-webpack have no run/);
    });
    it('counts the passing cases a cell loses', () => {
      const lost = passingCasesLostPerCell(ctx().ledger as never);
      // bun-webpack measured 1 failure; the second case is deselected there but passes there.
      expect(lost['bun-webpack']).toBe(1);
      expect(lost['node-turbopack']).toBe(0);
      expect(lost['node-webpack']).toBe(0);
    });
  });

  describe('bar 5: the cap counts files AND cases', () => {
    const many = (files: number, perFile: number) =>
      Array.from({ length: files }, (_, i) => {
        const e = entry({ test: `test/e2e/app-dir/gen-${i}/gen-${i}.test.ts` });
        e.cases = Array.from({ length: perFile }, (_, j) => ({
          path: ['example'],
          title: `case ${j}`,
          cells: ['node-turbopack'],
        }));
        e.measured = { 'node-turbopack': { failed: perFile } };
        e.runs = [{ run: '41754152861', cell: 'node-turbopack', ref: REF }];
        return e;
      });
    const capCtx = (ledger: Entry[]) => {
      const c = ctx(ledger);
      for (const e of ledger) {
        c.snapshot.files[e.test] = {
          literals: ['example', ...e.cases.map((k) => k.title)],
          lines: { '7': "  expect(h.get('x-vercel-cache')).toBe('HIT')" },
        };
      }
      return c;
    };
    it('exactly the cap is fine', () => {
      expect(errs(capCtx(many(REF_PINNED_FILE_CAP, 1)))).toEqual([]);
      expect(errs(capCtx(many(1, REF_PINNED_CASE_CAP)))).toEqual([]);
    });
    it('one more FILE reds', () => {
      expect(errs(capCtx(many(REF_PINNED_FILE_CAP + 1, 1))).join('\n')).toMatch(
        /files exceed the cap/,
      );
    });
    it('one more CASE reds', () => {
      expect(errs(capCtx(many(1, REF_PINNED_CASE_CAP + 1))).join('\n')).toMatch(
        /cases exceed the cap/,
      );
    });
    it('the caps are the reviewed numbers (10 files, 20 cases)', () => {
      expect(REF_PINNED_FILE_CAP).toBe(10);
      expect(REF_PINNED_CASE_CAP).toBe(20);
    });
  });
});

describe('ref-pinned per-case ledger — upstream snapshot tooling', () => {
  const SRC = [
    "describe('outer', () => {",
    "  describe.each([false, true])('variant (flag: %s)', (f) => {",
    "    it('does a thing', async () => {})",
    "    it.failing('is expected to fail', async () => {})",
    '  })',
    '  // @gate !deploy',
    '  if (isNextDeploy) {',
    '})',
  ].join('\n');

  it('extracts describe/it/test title literals, including describe.each and it.failing', () => {
    expect(extractTitleLiterals(SRC)).toEqual([
      'does a thing',
      'is expected to fail',
      'outer',
      'variant (flag: %s)',
    ]);
  });
  it('extracts cited lines by 1-indexed number', () => {
    expect(extractLines(SRC, [6, 7])).toEqual({
      '6': '  // @gate !deploy',
      '7': '  if (isNextDeploy) {',
    });
  });
  it('builds a snapshot through an injected fetcher and detects drift against it', async () => {
    const ledger = [
      { test: FILE, nextjsRef: REF, upstream: [{ line: 7, anchor: 'isNextDeploy' }] },
    ];
    const fetchFile = async () => ({ sha: 'abc123', source: SRC });
    const built = await buildSnapshot(ledger as never, fetchFile);
    expect(built.ref).toBe(REF);
    expect((built.files as Record<string, { blob: string }>)[FILE].blob).toBe('abc123');
    expect(diffSnapshots(built, built)).toEqual([]);
    const drifted = await buildSnapshot(ledger as never, async () => ({
      sha: 'def456',
      source: SRC.replace('does a thing', 'renamed'),
    }));
    expect(diffSnapshots(built, drifted).join('\n')).toMatch(/differs from upstream/);
  });
  it('an upstream that cannot be reached is a FAILURE, never a pass', async () => {
    const ledger = [{ test: FILE, nextjsRef: REF, upstream: [{ line: 1, anchor: 'x' }] }];
    await expect(
      buildSnapshot(ledger as never, async () => {
        throw new Error('GET answered 503');
      }),
    ).rejects.toThrow(/503/);
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => new Response('', { status: 503 })) as never;
    try {
      await expect(fetchFromGitHub(FILE, REF, 'token')).rejects.toThrow(/503/);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
  it('refuses a ledger that pins more than one ref', async () => {
    const ledger = [
      { test: FILE, nextjsRef: 'v16.4.3', upstream: [] },
      { test: 'test/e2e/b/b.test.ts', nextjsRef: 'v16.3.8', upstream: [] },
    ];
    await expect(
      buildSnapshot(ledger as never, async () => ({ sha: 'x', source: '' })),
    ).rejects.toThrow(/ONE ref/);
  });
});

describe('ref-pinned per-case ledger — Part B: the real manifest', () => {
  const manifest = JSON.parse(read('test/deploy-tests-manifest.knext.json'));
  const snapshot = JSON.parse(read('test/compat-ref-pinned-cases.upstream.json'));
  const ledger: Entry[] = manifest.$knextRefPinnedCases ?? [];

  const defaultRef = read('.github/workflows/test-e2e-deploy.yml').match(
    /NEXTJS_REF:\s*\$\{\{\s*github\.event\.inputs\.nextjsRef\s*\|\|\s*'([^']+)'\s*\}\}/,
  )?.[1] as string;
  const shippedRef = `v${JSON.parse(read('.github/compat-credentialed-next-version.json')).shippedNextPin}`;

  // The verbatim upstream mirror: these `failed` lists are upstream's own, not knext's.
  const upstreamMirror = new Set<string>(UPSTREAM_MIRROR_SUITES);

  it('has entries (the amendment is exercised by real data)', () => {
    expect(ledger.length).toBeGreaterThan(0);
  });

  it('is admissible under every bar', () => {
    const found = validateRefPinnedCases({
      ledger,
      suites: manifest.suites,
      rulesExclude: manifest.rules.exclude,
      snapshot,
      defaultRef,
      shippedRef,
      upstreamMirror,
    } as never);
    expect(found).toEqual([]);
  });

  it('every ledgered file runs: it is in no file-level exclusion and not a $knextQuarantines file entry', () => {
    const quarantined = new Set(
      (manifest.$knextQuarantines ?? []).map((q: { test: string }) => q.test),
    );
    for (const e of ledger) {
      expect(manifest.rules.exclude).not.toContain(e.test);
      expect(quarantined.has(e.test), `${e.test} is also a flakey/file quarantine`).toBe(false);
      expect(manifest.$knextExclusions.some((x: { test: string }) => x.test === e.test)).toBe(
        false,
      );
    }
  });

  it('only measured cells are claimed: a webpack-only failure is not claimed on a turbopack-only record', () => {
    for (const e of ledger) {
      const cells = new Set((e.runs as { cell: string }[]).map((r) => r.cell));
      for (const c of e.cases) for (const cell of c.cells) expect(cells.has(cell)).toBe(true);
    }
  });

  it('every claimed cell is a real credential cell', () => {
    for (const e of ledger)
      for (const c of e.cases) for (const cell of c.cells) expect(CELLS).toContain(cell);
  });

  it('prerender-native-module is claimed for the bun cell only, and its gap is stated loudly', () => {
    const e = ledger.find((x) => x.test === 'test/e2e/prerender-native-module.test.ts');
    expect(e).toBeTruthy();
    for (const c of e?.cases ?? []) expect(c.cells).toEqual(['bun-webpack']);
    expect(String(e?.mechanism)).toMatch(/V8/);
    expect(String(e?.mechanism)).toMatch(/NODE_MODULE_VERSION/);
    expect(String(e?.mechanism)).toMatch(/Node cells/i);
    expect(String(e?.provenance)).toMatch(/issues\/2713$/);
  });

  it('swc-plugins-env is NOT excluded (it is fixed elsewhere)', () => {
    expect(JSON.stringify(manifest.rules.exclude)).not.toMatch(/swc-plugins-env/);
    expect(JSON.stringify(manifest.suites)).not.toMatch(/swc-plugins-env/);
  });

  it('records the passing cases lost per measured cell, and it is small and stated', () => {
    const lost = passingCasesLostPerCell(ledger as never);
    expect(lost['node-turbopack']).toBe(4);
    expect(lost['bun-webpack']).toBe(0);
    // Cells with no measurement make no claim at all.
    expect(lost['node-webpack']).toBe(0);
    expect(lost['bun-turbopack']).toBe(0);
  });
});

describe('ref-pinned per-case ledger — Part C: the ADR amendment states the bars', () => {
  const adr = read('docs/adr/0007-compat-suite.md');
  const amendment = adr.slice(adr.indexOf('## Amendment (2026-11-04)'));

  it('is an accepted amendment with Context, Decision, Options, Consequences', () => {
    expect(adr).toContain('## Amendment (2026-11-04)');
    expect(amendment).toMatch(/Status: Accepted/);
    for (const h of ['### Context', '### Decision', '### Options considered', '### Consequences']) {
      expect(amendment).toContain(h);
    }
  });
  it('states every bar and the real caps', () => {
    for (const re of [
      /ref pin/i,
      /exact names?/i,
      /citation/i,
      /measured cell/i,
      /cap/i,
      /reaudited/i,
    ]) {
      expect(amendment).toMatch(re);
    }
    expect(amendment).toContain(`${REF_PINNED_FILE_CAP} files`);
    expect(amendment).toContain(`${REF_PINNED_CASE_CAP} cases`);
  });
  it('says exactly what the runner does with a listed case that starts passing', () => {
    expect(amendment).toMatch(/excludedCases/);
    expect(amendment).toMatch(/--testNamePattern/);
    expect(amendment).toMatch(/does not run/i);
    expect(amendment).toMatch(/silent/i);
  });
  it('keeps the flakey rules untouched and the options table has a trade-off column', () => {
    expect(amendment).toMatch(/`flakey` handling is unchanged/);
    expect(amendment).toMatch(/\| Option \|/);
  });
});
