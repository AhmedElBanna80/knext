import { describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  minorWithoutFixedRelease,
  nextAdvisoriesFor,
} from '../packages/kn-next/src/next-advisories';
import { workspaceGlobs } from '../scripts/lib/workspace-globs.mjs';
import { REPO_ROOT, WORKSPACE_DIRS, workspaceManifests } from './helpers/workspace-manifests';

/**
 * The `next` version FLOOR across the workspace (#579).
 *
 * `next@16.2.10` shipped with 4 HIGH advisories — CVE-2026-64641 (GHSA-m99w-x7hq-7vfj),
 * CVE-2026-64642 (GHSA-6gpp-xcg3-4w24), CVE-2026-64645 (GHSA-p9j2-gv94-2wf4) and
 * CVE-2026-64649 (GHSA-89xv-2m56-2m9x) — plus 5 MODERATE, all fixed in 16.2.11.
 * Remediation discipline for this repo is BUMP, never suppress (#155/#199/#319/#320/#465).
 *
 * #2594 raised the floor to 16.4.1: GHSA-2464-fhr4-w9xw (critical, RCE in the
 * Image Optimization API with SVG), GHSA-673q-mjm6-r5xr (critical, RCE in
 * `'use cache'` functions returning typed arrays) and GHSA-p3m5-59mp-jv5r (high,
 * Server Actions DoS) affect every 16.x through 16.4.0; no 16.3.x patch exists.
 * The same PR added the REPO-WIDE scan at the bottom of this file: the workspace
 * scan above never saw the scaffold templates, the standalone e2e fixtures with
 * their own `bun.lock`, or the demo apps outside the workspace globs, and those
 * are exactly what users get and what knext deploys.
 *
 * This guard locks the floor so a later `pnpm update`, a new app, or a copy-pasted
 * pin cannot silently walk the tree back under a fixed version. It SCANS the
 * workspace globs rather than enumerating packages — an enumerated list is how the
 * second manifest gets missed, and this repo has hit that twice.
 *
 * Two deliberate exclusions, stated rather than left to be rediscovered:
 *
 *   - `peerDependencies`. `@getknext/core` declares `next: ">=16.0.0 <16.5.0"` on purpose:
 *     it is a compatibility statement about what the adapter supports, not a
 *     statement about what we install. Raising it would drop support for every
 *     16.0/16.1 consumer over a CVE in *their* tree, which they fix by upgrading
 *     `next`, not by upgrading knext.
 *   - `NEXTJS_REF` in `.github/workflows/test-e2e-deploy.yml`. That is a different
 *     knob — it is the vercel/next.js git TAG the compat suite is checked out at
 *     (and, via `NEXT_NPM_VERSION="${NEXTJS_REF#v}"`, the prebuilt `next` the
 *     fixtures install). It is inside the compat-window frozen set (ADR-0039), so
 *     moving it is a lead decision about what "green" means, not a security bump.
 */

/**
 * The lowest `next` version any workspace manifest may admit.
 *
 * A FLOOR, deliberately — this asserts `>=`, not equality, because its subject
 * is a CVE, not a pin. `template-next-pin.test.ts` (#643) is the one that
 * asserts equality, and it derives its expectation from the workspace rather
 * than from this constant for exactly that reason: a tree sitting at the floor
 * while the workspace has moved on satisfies this and is still drift.
 */
const FLOOR: [number, number, number] = [16, 4, 1];

type Version = [number, number, number];

/** Lowest version a `1.2.3`, `^1.2.3` or `>=1.2.3` style range admits. */
function floorOf(range: string): Version {
  const m = range.match(/(\d+)\.(\d+)\.(\d+)/);
  if (!m) throw new Error(`next range "${range}" has no X.Y.Z floor to check`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

function gte(a: Version, b: Version): boolean {
  for (let i = 0; i < 3; i++) {
    if (a[i] !== b[i]) return a[i] > b[i];
  }
  return true;
}

describe('#579/#2594 — the workspace `next` floor is 16.4.1', () => {
  it('scans the same workspace globs the repo declares', () => {
    // Read through the shared helper, not by re-parsing the declaration here.
    // Three guards make this same "hardcoded list still matches the workspace"
    // check, and each parsed `pnpm-workspace.yaml` its own way — so removing
    // pnpm broke all three separately, and nothing stopped them disagreeing
    // about what the workspace IS.
    expect(workspaceGlobs().sort()).toEqual(WORKSPACE_DIRS.map((d) => `${d}/*`).sort());
  });

  it('finds at least one workspace member depending on next', () => {
    const withNext = workspaceManifests().filter(
      ({ pkg }) =>
        (pkg.dependencies as Record<string, string> | undefined)?.next ??
        (pkg.devDependencies as Record<string, string> | undefined)?.next,
    );
    // A guard that matches nothing is a guard over nothing.
    expect(withNext.length).toBeGreaterThan(0);
  });

  it.each(
    workspaceManifests().flatMap(({ path, pkg }) =>
      (['dependencies', 'devDependencies'] as const).flatMap((field) => {
        const range = (pkg[field] as Record<string, string> | undefined)?.next;
        return range ? [{ path, field, range }] : [];
      }),
    ),
  )('$path ($field) pins next >= 16.4.1 — got $range', ({ range }) => {
    expect(gte(floorOf(range), FLOOR)).toBe(true);
  });

  it('resolves no next below 16.4.1 anywhere in the root lockfile', () => {
    // `bun.lock` since the repo left pnpm. The scan is unchanged because both
    // formats spell a resolved dependency the same way — `name@x.y.z` — so this
    // guard's subject (no `next` below the floor resolves ANYWHERE) survives the
    // format change intact.
    const lock = readFileSync(resolve(REPO_ROOT, 'bun.lock'), 'utf8');
    const resolved = [...new Set([...lock.matchAll(/\bnext@(\d+\.\d+\.\d+)\b/g)].map((m) => m[1]))];
    expect(resolved.length).toBeGreaterThan(0);
    expect(resolved.filter((v) => !gte(floorOf(v), FLOOR))).toEqual([]);
  });
});

/**
 * Every tracked manifest and lockfile outside the workspace globs, too (#2594).
 *
 * DISCOVERED from `git ls-files`, never enumerated: the scaffold templates
 * (`package.json.hbs`, `package.json.vinext.hbs`), the e2e fixtures that carry
 * their own `bun.lock`, the examples and the demo apps. The verdict comes from
 * `next-advisories.ts` — the same table `knext doctor` FAILs on — so a 15.x
 * demo pinned to the 15.x backport passes and a 16.3.x pin does not.
 *
 * HARNESS_PINS is the only way out, and each entry says why. These are
 * test-harness pins that reproduce a bug or freeze evidence at one exact
 * version; they are never built into anything a user runs or knext deploys.
 */
const HARNESS_PINS: Record<string, string> = {
  'test/bun-sandbox-fetch-ab/fixture/package.json':
    'A/B reproduction of a Bun sandbox-fetch bug, pinned to the exact Next.js it was measured on; run only by its own manual workflow, never deployed.',
  'docs/wayfinder/spike-vinext-image-intercept/fixture-app/package.json':
    'Frozen evidence for a finished spike under docs/; never installed or deployed by any workflow.',
};

function trackedFiles(): string[] {
  return execFileSync('git', ['ls-files'], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
    .split('\n')
    .filter(Boolean);
}

/** Exact `next` pins in a manifest: every dependency field, `X.Y.Z`-anchored. */
function manifestNextPins(text: string): string[] {
  const pkg = JSON.parse(text) as Record<string, Record<string, string> | undefined>;
  return (['dependencies', 'devDependencies', 'optionalDependencies'] as const)
    .map((field) => pkg[field]?.next)
    .filter((r): r is string => typeof r === 'string' && /\d+\.\d+\.\d+/.test(r))
    .map((r) => (r.match(/(\d+\.\d+\.\d+)/) as RegExpMatchArray)[1]);
}

describe('#2594 — no tracked manifest or lockfile pins a next with a known advisory', () => {
  const files = trackedFiles();
  const manifests = files.filter((f) => /(^|\/)package\.json(\.[a-z]+)*(\.hbs)?$/.test(f));
  const lockfiles = files.filter((f) => /(^|\/)bun\.lock$/.test(f));

  it('the harness exclusions still exist and each carries a reason', () => {
    for (const [path, reason] of Object.entries(HARNESS_PINS)) {
      expect(files, `${path} is no longer tracked; drop it from HARNESS_PINS`).toContain(path);
      expect(reason.length).toBeGreaterThan(20);
    }
  });

  it('the scan reaches the scaffold templates and the fixture lockfiles', () => {
    // An over-narrowed filter would pass vacuously; pin the floor of what it must see.
    for (const known of [
      'packages/kn-next/templates/app/package.json.hbs',
      'packages/kn-next/templates/app/package.json.vinext.hbs',
      'turbo/generators/templates/zone/package.json.hbs',
      'apps/file-manager/package.json',
    ]) {
      expect(manifests).toContain(known);
    }
    expect(lockfiles).toContain('bun.lock');
    expect(lockfiles.length).toBeGreaterThan(1);
  });

  it('every pinned manifest is clear of the advisories knext doctor fails on', () => {
    const bad: string[] = [];
    let checked = 0;
    for (const path of manifests) {
      if (path in HARNESS_PINS) continue;
      for (const v of manifestNextPins(readFileSync(resolve(REPO_ROOT, path), 'utf8'))) {
        checked++;
        const hits = nextAdvisoriesFor(v).map((h) => h.id);
        if (hits.length) bad.push(`${path}: next ${v} (${hits.join(', ')})`);
      }
    }
    expect(checked).toBeGreaterThan(5);
    expect(bad).toEqual([]);
  });

  it('every tracked bun.lock resolves only advisory-free next versions', () => {
    const bad: string[] = [];
    let resolvedAny = 0;
    for (const path of lockfiles) {
      const lock = readFileSync(resolve(REPO_ROOT, path), 'utf8');
      for (const v of new Set([...lock.matchAll(/"next@(\d+\.\d+\.\d+)"/g)].map((m) => m[1]))) {
        resolvedAny++;
        const hits = nextAdvisoriesFor(v).map((h) => h.id);
        if (hits.length) bad.push(`${path}: next@${v} (${hits.join(', ')})`);
      }
    }
    expect(resolvedAny).toBeGreaterThan(1);
    expect(bad).toEqual([]);
  });
});

/**
 * Workflows install, `npm pkg set` and assert `next` versions too (#2594 round 2).
 *
 * The kind e2e jobs stage a fixture, force its `next` with
 * `npm pkg set "dependencies.next=${NEXT_VERSION}"` and deploy it; the JS-closure
 * Trivy job pins `dependencies.next=X` before scanning.
 *
 * #2606: the first version of this scan recognised four spellings and let every
 * other one through (`next@^16.3.8`, `next@v16.3.8`, `next@16.3`, `NEXT_PIN: X`,
 * `next: [X]`, `echo NEXT_VERSION=X >> $GITHUB_ENV`), so a workflow edit written
 * one of those ways could reinstall a vulnerable `next` with CI green. It now
 * fails CLOSED: on EVERY non-comment line that mentions `next` (case-insensitive,
 * `NEXTJS_REF` and `NEXT_PIN` included), EVERY `X.Y` / `X.Y.Z` token is a pin —
 * ranges (`^ ~ >= <`) and a `v` prefix are just decoration around it — and is
 * judged by `next-advisories.ts`, the table doctor fails on:
 *
 *   - `X.Y.Z` is advisory-checked at that exact version;
 *   - `X.Y` is red when the whole line has no fixed release
 *     (`minorWithoutFixedRelease`);
 *   - a token it cannot compare (`16.x`, `16.*`, `^16`) is red, never green.
 *
 * Tokens that belong to another package on the same line (`kn-next@0.4.3`,
 * `@next/env@16.0.0`) are not next's version and are stripped first. Comment
 * lines are history, not pins.
 *
 * WORKFLOW_HARNESS_PINS excuses a hit only by exact file AND exact (trimmed)
 * line content AND exact version, with a reason. It is not a blanket pass: an
 * edit to the excused line un-excuses it, and an exclusion that no longer excuses
 * a flagged pin (the line moved, was fixed, or was deleted) is itself red.
 */
type HarnessPin = { file: string; text: string; version: string; reason: string };

const WORKFLOW_HARNESS_PINS: HarnessPin[] = [
  {
    file: '.github/workflows/compat-credential-v1.3.yml',
    text: "description: 'vercel/next.js git ref to test against (pinned tag ≥ v16.2.0; do NOT use canary)'",
    version: '16.2.0',
    reason:
      'Prose in a workflow-input description or issue body that names the compat-suite tag floor for a human reader; it installs nothing and pins nothing.',
  },
  {
    file: '.github/workflows/compat-credential-v1.3.yml',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal workflow-expression text being matched
    text: "NEXTJS_REF: ${{ github.event.inputs.nextjsRef || 'v16.3.8' }}",
    version: '16.3.8',
    reason:
      'The vercel/next.js git tag the compat suite is checked out at (and the prebuilt next its fixtures install): a compat-harness ref, not a dependency of knext or of anything it deploys. The generated v1.3 credential lane is deliberately pinned at v16.3.8; moving it is a credential decision, tracked separately from this scan.',
  },
  {
    file: '.github/workflows/compat-shipped-pin-early-warning.yml',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal workflow-expression text being matched
    text: 'body="At least one leg (node/bun x turbopack/webpack) went red on the shipped-pin early-warning lane (#1376 option b). This is NON-credentialing — it tests the SCAFFOLD\'s shipped Next.js pin, not the v16.2.0 credential, and cannot affect any v1.0 credential streak. Open the run to see which leg(s) failed: ${RUN_URL}"',
    version: '16.2.0',
    reason:
      'Prose in a workflow-input description or issue body that names the compat-suite tag floor for a human reader; it installs nothing and pins nothing.',
  },
  {
    file: '.github/workflows/compat-vinext.yml',
    text: "description: 'vercel/next.js git ref to test against (pinned tag >= v16.2.0; do NOT use canary)'",
    version: '16.2.0',
    reason:
      'Prose in a workflow-input description or issue body that names the compat-suite tag floor for a human reader; it installs nothing and pins nothing.',
  },
  {
    file: '.github/workflows/compat-vinext.yml',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal workflow-expression text being matched
    text: "NEXTJS_REF: ${{ github.event.inputs.nextjsRef || 'v16.2.0' }}",
    version: '16.2.0',
    reason:
      'The vercel/next.js git tag the compat suite is checked out at (and the prebuilt next its fixtures install): a compat-harness ref, not a dependency of knext or of anything it deploys. The vinext lane stays on the v16.2.0 credential tag; moving it is a credential decision, tracked separately from this scan.',
  },
  {
    file: '.github/workflows/test-e2e-deploy.yml',
    text: "description: 'vercel/next.js git ref to test against (pinned tag ≥ v16.2.0; do NOT use canary)'",
    version: '16.2.0',
    reason:
      'Prose in a workflow-input description or issue body that names the compat-suite tag floor for a human reader; it installs nothing and pins nothing.',
  },
  {
    file: '.github/workflows/test-e2e-deploy.yml',
    // biome-ignore lint/suspicious/noTemplateCurlyInString: the literal workflow-expression text being matched
    text: "NEXTJS_REF: ${{ github.event.inputs.nextjsRef || 'v16.4.0' }}",
    version: '16.4.0',
    reason:
      'The vercel/next.js git tag the compat suite is checked out at (and the prebuilt next its fixtures install): a compat-harness ref, not a dependency of knext or of anything it deploys. Inside the compat-window frozen set; moving it is a lead decision about what green means, tracked separately from this scan.',
  },
];

type WorkflowPin = {
  file: string;
  line: number;
  /** The token as comparable text: `16.3.8`, `16.3`, or the raw text when unparseable. */
  version: string;
  parseable: boolean;
  text: string;
};

/** Spans that belong to a different package than `next`: `kn-next@0.4.3`, `@next/env@16.0.0`. */
const OTHER_PACKAGE_SPEC = /(?:@next\/[\w.-]+|[\w.-]*[\w]-next|next-[\w.-]*[a-z])@\S*/gi;
// `NextApp` is knext's CR kind, never the npm package, so it is not a mention on its own.
const NEXT_MENTION = /(?<![a-z])next(?!app)/i;
/** `16.3.8`, `v16.3`, `^16.x`, `16.*` — the operator and a `v` are not part of the token. */
const VERSION_TOKEN = /(?<![\w.])v?(\d+)\.(\d+|[xX*])(?:\.(\d+|[xX*]))?(?![\w.]*\d)/g;
/** `next@^16` / `next=~16`: a bare major, which no X.Y token catches. */
const BARE_MAJOR = /(?<![\w@/-])next[@=][~^<>=v ]*(\d+)(?![\d.\w])/gi;

function workflowNextPins(file: string, text: string): WorkflowPin[] {
  const pins: WorkflowPin[] = [];
  text.split('\n').forEach((raw, i) => {
    if (/^\s*#/.test(raw)) return;
    const scanned = raw.replace(OTHER_PACKAGE_SPEC, ' ');
    if (!NEXT_MENTION.test(scanned)) return;
    const found = new Map<string, boolean>();
    for (const m of scanned.matchAll(VERSION_TOKEN)) {
      const [, major, minor, patch] = m;
      const parseable = /^\d+$/.test(minor) && (patch === undefined || /^\d+$/.test(patch));
      found.set(
        parseable ? `${major}.${minor}${patch === undefined ? '' : `.${patch}`}` : m[0],
        parseable,
      );
    }
    for (const m of scanned.matchAll(BARE_MAJOR)) found.set(m[0], false);
    for (const [version, parseable] of found) {
      pins.push({ file, line: i + 1, version, parseable, text: raw.trim() });
    }
  });
  return pins;
}

/** What is wrong with one pin, or `undefined` when it is clear. */
function judgePin(p: WorkflowPin): string | undefined {
  if (!p.parseable) return `unparseable next version ${p.version}`;
  const hits = (
    /^\d+\.\d+$/.test(p.version)
      ? minorWithoutFixedRelease(p.version)
      : nextAdvisoriesFor(p.version).map((h) => h.id)
  ).join(', ');
  return hits ? `next ${p.version} (${hits})` : undefined;
}

const excuses = (ex: HarnessPin, p: WorkflowPin): boolean =>
  ex.file === p.file && ex.text === p.text && ex.version === p.version;

/** Every un-excused problem in one workflow file's text. */
function workflowFlags(file: string, text: string, exclusions: HarnessPin[]): string[] {
  return workflowNextPins(file, text).flatMap((p) => {
    const why = judgePin(p);
    if (why === undefined || exclusions.some((ex) => excuses(ex, p))) return [];
    return [`${p.file}:${p.line}: ${why} — ${p.text}`];
  });
}

/** Exclusions that excuse no flagged pin: the line moved, changed, was fixed, or is gone. */
function staleExclusions(exclusions: HarnessPin[], pins: WorkflowPin[]): HarnessPin[] {
  return exclusions.filter((ex) => !pins.some((p) => judgePin(p) !== undefined && excuses(ex, p)));
}

describe('#2594 — no workflow pins, sets or asserts a next with a known advisory', () => {
  const workflows = trackedFiles().filter((f) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(f));
  const pins = workflows.flatMap((f) =>
    workflowNextPins(f, readFileSync(resolve(REPO_ROOT, f), 'utf8')),
  );

  it('recognises every shape it claims to (self-test)', () => {
    const sample = [
      '      NEXT_VERSION: 16.4.0',
      '          npm pkg set "dependencies.next=16.3.8"',
      '          bun add next@16.2.10',
      "          node -e \"const v=require('./node_modules/next/package.json').version; if (v !== '16.4.0') {}\"",
      '          # previously pinned to next@16.0.3',
      '          npx kn-next@0.4.3 deploy',
      '          bun add @next/env@16.0.0',
      "          VINEXT_VERSION: '1.0.1'",
    ].join('\n');
    expect(workflowNextPins('x.yml', sample).map((p) => `${p.line}:${p.version}`)).toEqual([
      '1:16.4.0',
      '2:16.3.8',
      '3:16.2.10',
      '4:16.4.0',
    ]);
  });

  // #2606: every spelling below used to pass unflagged. Each is its own case so a
  // mutation that drops one detector reds exactly that case.
  const SPELLINGS: [string, string][] = [
    ['range operator in an install spec', '          bun add next@^16.3.8'],
    ['tilde in an npm pkg set', '          npm pkg set dependencies.next=~16.3.0'],
    ['x.y install spec', '          bun add next@16.3'],
    ['v-prefixed install spec', '          bun add next@v16.3.8'],
    ['an env-style pin', '  NEXT_PIN: 16.3.8'],
    ['a yaml flow sequence', '        next: [16.3.8]'],
    ['an echo into GITHUB_ENV', '          echo NEXT_VERSION=16.3.8 >> $GITHUB_ENV'],
    ['a ref with a v prefix', '  NEXTJS_REF: v16.3.8'],
  ];
  for (const [name, line] of SPELLINGS) {
    it(`flags ${name}`, () => {
      expect(workflowNextPins('x.yml', line).length).toBeGreaterThan(0);
      expect(workflowFlags('x.yml', line, []).length).toBeGreaterThan(0);
    });
  }

  it('does not flag a comment, another package, or a line that does not mention next', () => {
    for (const line of [
      '          # bun add next@16.3.8',
      '          npx kn-next@0.4.3 deploy',
      '          bun add @next/env@16.0.0',
      "  VINEXT_VERSION: '1.0.1'",
      '  node-version: 22.4',
    ]) {
      expect(workflowNextPins('x.yml', line), line).toEqual([]);
    }
  });

  it('judges an X.Y token by whether the whole line has a fixed release', () => {
    expect(workflowFlags('x.yml', 'bun add next@16.3', []).length).toBe(1);
    expect(workflowFlags('x.yml', 'bun add next@16.4', [])).toEqual([]);
    expect(workflowFlags('x.yml', 'bun add next@16.4.1', [])).toEqual([]);
    expect(workflowFlags('x.yml', 'bun add next@^16.4.1', [])).toEqual([]);
  });

  it('turns a next version it cannot parse into a failure, not a pass', () => {
    for (const line of ['bun add next@16.x', 'bun add next@16.*', 'bun add next@^16']) {
      const flags = workflowFlags('x.yml', line, []);
      expect(flags.length, line).toBe(1);
      expect(flags[0], line).toContain('unparseable');
    }
  });

  it('an exclusion matches exact file AND exact line AND version, and never anything wider', () => {
    const line = '  NEXTJS_REF: v16.3.8';
    const ex = { file: 'x.yml', text: line.trim(), version: '16.3.8', reason: 'r'.repeat(30) };
    expect(workflowFlags('x.yml', line, [ex])).toEqual([]);
    // same version, different line content
    expect(workflowFlags('x.yml', '  NEXTJS_REF: v16.3.8 # edited', [ex]).length).toBe(1);
    // same line content, different file
    expect(workflowFlags('y.yml', line, [ex]).length).toBe(1);
    // same line, a second version appears alongside the excused one
    expect(
      workflowFlags('x.yml', '  NEXTJS_REF: v16.3.8 next@16.3.0', [
        { ...ex, text: '  NEXTJS_REF: v16.3.8 next@16.3.0'.trim() },
      ]).length,
    ).toBe(1);
  });

  it('a stale exclusion that matches no line reds', () => {
    const ex = { file: 'x.yml', text: 'gone', version: '16.3.8', reason: 'r'.repeat(30) };
    expect(staleExclusions([ex], workflowNextPins('x.yml', '  NEXTJS_REF: v16.3.8')).length).toBe(
      1,
    );
    expect(
      staleExclusions(
        [{ ...ex, text: 'NEXTJS_REF: v16.3.8' }],
        workflowNextPins('x.yml', '  NEXTJS_REF: v16.3.8'),
      ),
    ).toEqual([]);
  });

  it('the scan reaches the kind e2e jobs that stage and deploy a fixture', () => {
    expect(workflows).toContain('.github/workflows/standalone-deploy-kind-e2e.yml');
    expect(workflows).toContain('.github/workflows/supply-chain.yml');
    expect(pins.length).toBeGreaterThan(0);
  });

  it('every harness exclusion has a reason and still excuses a flagged pin', () => {
    for (const ex of WORKFLOW_HARNESS_PINS) expect(ex.reason.length).toBeGreaterThan(20);
    const stale = staleExclusions(WORKFLOW_HARNESS_PINS, pins);
    expect(
      stale.map((ex) => `${ex.file}: ${ex.version} — ${ex.text}`),
      'these exclusions match no flagged pin (line edited, moved, fixed or deleted); drop or re-point them',
    ).toEqual([]);
  });

  it('every non-excluded workflow pin is clear of the advisories knext doctor fails on', () => {
    const bad = workflows.flatMap((f) =>
      workflowFlags(f, readFileSync(resolve(REPO_ROOT, f), 'utf8'), WORKFLOW_HARNESS_PINS),
    );
    expect(bad).toEqual([]);
  });
});
