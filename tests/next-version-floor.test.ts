import { describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  minorWithoutFixedRelease,
  NEXT_ADVISORIES,
  nextAdvisoriesFor,
} from '../packages/kn-next/src/next-advisories';
import { NEXT_MATRIX_VERSIONS } from '../packages/kn-next/src/next-compat';
import { workspaceGlobs } from '../scripts/lib/workspace-globs.mjs';
import { buildMatrix } from '../scripts/next-minor-matrix.mjs';
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
 * fails CLOSED within its reach: on EVERY non-comment line that mentions `next`
 * (case-insensitive, `NEXTJS_REF` and `NEXT_PIN` included) — and on every line
 * directly under a key that mentions `next` and has no inline value (a block
 * sequence `next:\n  - 16.3.8`, a block mapping, a `>-` / `|` scalar, an open
 * flow sequence) — EVERY `X.Y` / `X.Y.Z` token is a pin and is judged by
 * `next-advisories.ts`, the table doctor fails on:
 *
 *   - `X.Y.Z` is advisory-checked at that exact version;
 *   - `X.Y` is red when the whole line has no fixed release
 *     (`minorWithoutFixedRelease`);
 *   - a token it cannot compare (`16.x`, `16.*`, `^16`) is red, never green;
 *   - `^ ~ >= >` and a `v` prefix are decoration around an anchor and are judged
 *     at it; an UPPER bound (`<X`, `<=X`) is not decoration, it admits every
 *     version below it, so it is red unless a lower bound on the same line puts
 *     the whole admitted interval clear of every affected range;
 *   - `create-next-app@X` scaffolds `next@X` (it defaults the template's next to
 *     its own version), so it is judged as `next@X`.
 *
 * REACH (#2630), stated so it is not mistaken for more. Per file, line-local
 * detection above PLUS indirection resolved WITHIN that file, then judged exactly
 * like a literal. A reference sitting in a next version position - after `next@`,
 * after `dependencies.next=`, bound to a name that holds a next version
 * (`NEXT_VERSION: ...`, `NEXTJS_REF=...`, `matrix.next`), or the `ref:` that reads
 * one - is expanded to every literal it can spell:
 *
 *   - `${{ inputs.X }}` / `${{ github.event.inputs.X }}` to that input's `default:`
 *     (and, for a composite action, to every value a workflow passes through `with:`);
 *   - `${{ env.X }}`, `$X`, `${X}`, `${X#v}` to `X` set by an `env:` key (workflow,
 *     job or step level), a shell assignment, or a JS `const`; chains are followed
 *     (`A: ${{ env.B }}`), as are the literals inside an expression
 *     (`inputs.X || '16.3.8'`);
 *   - `${{ matrix.X }}` to the static matrix values, or, for a `fromJSON(...)`
 *     matrix, to what the source script PRINTS (MATRIX_EMITTERS runs it; a source
 *     that is not registered there is unresolvable);
 *   - a pin read through an indirection is attributed to the line that WROTE it, so
 *     an exclusion on that line (not on every line that reads it) excuses it.
 *
 * What it scans: every workflow, every composite action under `.github/actions/**`
 * (action.yml / action.yaml), and every tracked script a workflow or action names
 * (shell, mjs, cjs, js, ts; test files and package/app `src/` are not CI scripts).
 * A script is judged only where a version GOES - `next@X`, `dependencies.next=X`,
 * an assignment to a name that holds a next version - never the prose around it:
 * scripts compare against and log versions (`Next >= 16.4.0`), and "every token on a
 * line that mentions next" would flag the guards themselves.
 *
 * Fail-closed: a reference in a version position that cannot be resolved (a
 * `secrets.*` / `vars.*` / `needs.*` / `steps.*` value, an input nobody defines, a
 * variable nothing assigns, a value computed by `$(...)`, a reference cycle, an
 * unregistered matrix source) is a FAILURE, never a pass.
 *
 * STILL NOT SEEN, so nobody assumes more: indirection ACROSS files other than the
 * `with:` of a composite action (a reusable workflow's `with:` into another
 * workflow's `inputs:`; a script argument whose value a workflow computes), a spec
 * a shell assembles from parts (`next@"$MAJOR.$MINOR"` with the pieces set apart),
 * a script that reads its version from a file at run time, and a version a JS
 * object literal carries (`{ next: '16.3.8' }`). Scripts a script calls are reached
 * only when a workflow also names them.
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
  {
    file: '.github/workflows/compat-credential-v1.3.yml',
    text: "default: 'v16.3.8'",
    version: '16.3.8',
    reason:
      'The `nextjsRef` workflow_dispatch input default: the vercel/next.js git tag the compat suite is checked out at, the same compat-harness ref as the NEXTJS_REF line it feeds, not a dependency of knext or of anything it deploys. The generated v1.3 credential lane is deliberately pinned here; moving it is a credential decision, tracked separately from this scan.',
  },
  {
    file: '.github/workflows/compat-vinext.yml',
    text: "default: 'v16.2.0'",
    version: '16.2.0',
    reason:
      'The `nextjsRef` workflow_dispatch input default: the vercel/next.js git tag the compat suite is checked out at, the same compat-harness ref as the NEXTJS_REF line it feeds, not a dependency of knext or of anything it deploys. The vinext lane stays on the v16.2.0 credential tag; moving it is a credential decision, tracked separately from this scan.',
  },
  {
    file: '.github/workflows/test-e2e-deploy.yml',
    text: "default: 'v16.4.0'",
    version: '16.4.0',
    reason:
      'The `nextjsRef` workflow_dispatch input default: the vercel/next.js git tag the compat suite is checked out at, the same compat-harness ref as the NEXTJS_REF line it feeds, not a dependency of knext or of anything it deploys. Inside the compat-window frozen set; moving it is a lead decision about what green means, tracked separately from this scan.',
  },
];

type WorkflowPin = {
  file: string;
  line: number;
  /** The token as comparable text: `16.3.8`, `16.3`, or the raw text when unparseable. */
  version: string;
  parseable: boolean;
  text: string;
  /** Set for `<X` / `<=X`: the operator and the lower-bound tokens on the same line. */
  upper?: { op: '<' | '<='; lowers: string[] };
  /** An indirection the scan could not resolve; `version` then holds the reference text. */
  unresolved?: boolean;
  /** For a pin reached through a reference: the `file:line` that reads it. */
  via?: string;
};

/** Spans that belong to a different package than `next`: `kn-next@0.4.3`, `@next/env@16.0.0`. */
const OTHER_PACKAGE_SPEC = /(?:@next\/[\w.-]+|[\w.-]*[\w]-next|next-[\w.-]*[a-z])@\S*/gi;
/** `create-next-app@X` scaffolds next@X, so it is next's version, not another package's. */
const CREATE_NEXT_APP = /(?<![\w.@/-])create-next-app@/gi;
// `NextApp` is knext's CR kind, never the npm package, so it is not a mention on its own.
const NEXT_MENTION = /(?<![a-z])next(?!app)/i;
/** `16.3.8`, `v16.3`, `^16.x`, `16.*` — the operator and a `v` are not part of the token. */
const VERSION_TOKEN = /(?<![\w.])v?(\d+)\.(\d+|[xX*])(?:\.(\d+|[xX*]))?(?![\w.]*\d)/g;
/** `next@^16` / `next=~16`: a bare major, which no X.Y token catches. */
const BARE_MAJOR = /(?<![\w@/-])next[@=][~^<>=v ]*(\d+)(?![\d.\w])/gi;
/**
 * A mapping key with no inline value (or a block-scalar / unclosed-flow opener):
 * its value lives on the following, more-indented lines. Group 1 is everything
 * before the key (indent and `- ` markers), group 2 the key itself.
 */
const BLOCK_KEY = /^(\s*(?:-\s+)*)([^\s#:][^:#]*?)\s*:\s*(?:[|>][+-]?\d*|[[{][^\]}]*)?\s*(?:#.*)?$/;

function lineTokens(file: string, lineNo: number, raw: string): WorkflowPin[] {
  const scanned = raw.replace(CREATE_NEXT_APP, 'next@').replace(OTHER_PACKAGE_SPEC, ' ');
  const found = new Map<string, WorkflowPin>();
  const lowers: string[] = [];
  const add = (key: string, version: string, parseable: boolean, upper?: WorkflowPin['upper']) =>
    found.set(key, { file, line: lineNo, version, parseable, text: raw.trim(), upper });
  for (const m of scanned.matchAll(VERSION_TOKEN)) {
    const [, major, minor, patch] = m;
    const parseable = /^\d+$/.test(minor) && (patch === undefined || /^\d+$/.test(patch));
    const version = parseable ? `${major}.${minor}${patch === undefined ? '' : `.${patch}`}` : m[0];
    const op = /(<=|>=|<|>|\^|~)\s*$/.exec(scanned.slice(0, m.index))?.[1] ?? '';
    if (parseable && (op === '<' || op === '<=')) {
      add(`${op}${version}`, version, true, { op, lowers });
    } else {
      add(version, version, parseable);
      if (parseable) lowers.push(version);
    }
  }
  for (const m of scanned.matchAll(BARE_MAJOR)) add(m[0], m[0], false);
  return [...found.values()];
}

/** Where a literal that ends up in a version position was written. */
type Source = { file: string; line: number; text: string };
type Part = Source & { s: string };
/** One way a value can expand: the literal parts that, joined, spell it. */
type Alt = Part[];
/** A piece of text attributed to where it was written (never spread a Part: its own `s` would win). */
const piece = (s: string, o: Source): Part => ({ s, file: o.file, line: o.line, text: o.text });

type ScanOpts = {
  /** Values callers pass to a composite action's inputs through `with:`, by input name. */
  inputWith?: Record<string, (Source & { value: string })[]>;
  /** Versions the dynamic-matrix source (`fromJSON(...)`) of this file is known to emit. */
  matrixVersions?: string[];
};

const isScriptFile = (file: string): boolean => /\.(?:sh|bash|mjs|cjs|js|ts)$/.test(file);
const commentLine = (script: boolean): RegExp => (script ? /^\s*(?:#|\/\/|\*|\/\*)/ : /^\s*#/);
const preprocess = (raw: string): string =>
  raw.replace(CREATE_NEXT_APP, 'next@').replace(OTHER_PACKAGE_SPEC, ' ');

type NextLine = { no: number; raw: string; blockChild: boolean };

/**
 * The lines the scan looks at: every non-comment line that mentions `next`, and
 * every direct child line of a key that mentions `next` and has no inline value.
 * Only those direct children are pins: a job called `build-next` has a whole body
 * of steps under it, and `pnpm`'s `version: 10.4.1` in there is not next's version.
 */
function nextLineEntries(text: string, script: boolean): NextLine[] {
  const out: NextLine[] = [];
  const comment = commentLine(script);
  let block: { col: number; child?: number } | undefined;
  text.split('\n').forEach((raw, i) => {
    if (comment.test(raw) || raw.trim() === '') return;
    const indent = raw.length - raw.trimStart().length;
    if (block) {
      const seqAtKey = indent === block.col && /^-(\s|$)/.test(raw.trimStart());
      if (indent > block.col || seqAtKey) {
        block.child ??= indent;
        if (indent === block.child) out.push({ no: i + 1, raw, blockChild: true });
        return;
      }
      block = undefined;
    }
    if (!NEXT_MENTION.test(preprocess(raw))) return;
    out.push({ no: i + 1, raw, blockChild: false });
    const key = script ? null : BLOCK_KEY.exec(raw);
    if (key && NEXT_MENTION.test(key[2])) block = { col: key[1].length };
  });
  return out;
}

/** Direct (line-local) pins only: the version tokens written ON a line that mentions next. */
function workflowNextPins(file: string, text: string): WorkflowPin[] {
  if (isScriptFile(file)) return scriptLiteralPins(file, text);
  return nextLineEntries(text, false).flatMap((l) => lineTokens(file, l.no, l.raw));
}

// ---------------------------------------------------------------------------------
// #2630 — indirection. A version can reach `next` without being written on a line that
// mentions it: `next@${{ inputs.fw }}`, `next@$FW`, `NEXT_VERSION: ${{ env.FW }}`,
// `next@${{ matrix.next }}`. The scan below resolves such a reference to the literal
// text(s) it can expand to, WITHIN the file, and judges those tokens like any other.
// A reference it cannot resolve is a failure, never a pass.
// ---------------------------------------------------------------------------------

/** `${{ expr }}`, `${NAME…}` and `$NAME`, left to right. */
const REF_SPAN = /\$\{\{[\s\S]*?\}\}|\$\{[A-Za-z_]\w*[^}]*\}|\$[A-Za-z_]\w*/g;
/** A context reference inside a `${{ }}` expression. */
const EXPR_OPERAND =
  /\b(?:github\.event\.inputs|inputs|env|matrix|secrets|vars|needs|steps|github|runner|job|strategy|jobs)(?:\.[\w-]+|\[(?:'[^']*'|"[^"]*")\])+/g;
const PREFIX_BINDING = /([\w.-]*)\s*([:=@])\s*["'`~^<>=v ]*$/;
const YAML_KEY_PREFIX = /^\s*(?:-\s+)*[\w.-]+\s*:\s*["'`~^<>=v ]*$/;
/** The last word of a name says it holds a version: `NEXT_VERSION`, `NEXTJS_REF`, `nextPin`, `matrix.next`. */
const VERSION_WORDS = new Set(['version', 'ver', 'ref', 'pin', 'spec', 'tag', 'range', 'release']);

/**
 * Does this name hold a next version? It must mention next AND end in `next` /
 * `nextjs` or a version word. `NEXT_TEST_NATIVE_DIR`, `NEXT_DEPLOYMENT_ID` and
 * `needs.build-next.result` mention next and hold something else.
 */
function holdsNextVersion(name: string): boolean {
  if (!NEXT_MENTION.test(name)) return false;
  const words = name
    .split(/[_.-]|(?<=[a-z])(?=[A-Z])/)
    .filter(Boolean)
    .map((w) => w.toLowerCase());
  const last = words[words.length - 1];
  return last === 'next' || last === 'nextjs' || VERSION_WORDS.has(last);
}

/**
 * Text that sits where a next version goes: the package spec `next@X` (also what
 * `create-next-app@X` is normalised to), `dependencies.next=X`, and a binding to a
 * name that holds a next version (`NEXT_PIN: X`, `NEXT_VERSION=X`). A `key:` only
 * binds at the start of a YAML line, so prose such as `echo "next: ${x}"` is not one.
 */
function versionPositionPrefix(prefix: string, script: boolean): boolean {
  const m = PREFIX_BINDING.exec(prefix);
  if (!m) return false;
  const [, ident, connector] = m;
  if (connector === '@') return /^next$/i.test(ident);
  if (connector === ':' && (script || !YAML_KEY_PREFIX.test(prefix))) return false;
  if (connector === '=' && script) {
    // In a script `name=${x}` is as often a log line as a binding, so only an npm
    // path (`dependencies.next=`) or an assignment that starts the line counts.
    return holdsNextVersion(ident) && (/\w\.[\w.-]+$/.test(ident) || SCRIPT_BINDING.test(prefix));
  }
  return holdsNextVersion(ident);
}
const SCRIPT_BINDING =
  /^\s*(?:export\s+|readonly\s+|local\s+)?(?:(?:const|let|var)\s+)?[\w.-]+\s*=\s*["'`~^<>=v ]*$/;

/**
 * A script's own literals: the version written where a version goes, never the
 * prose around it. Scripts compare against versions (`Next >= 16.4.0`) and log them,
 * so "every token on a line that mentions next" would flag the guards themselves.
 */
function scriptLiteralPins(file: string, text: string): WorkflowPin[] {
  const out: WorkflowPin[] = [];
  for (const { no, raw } of nextLineEntries(text, true)) {
    const scanned = preprocess(raw);
    for (const m of scanned.matchAll(/[:=@]\s*["'`~^<>=v ]*/g)) {
      const end = (m.index as number) + m[0].length;
      if (!versionPositionPrefix(scanned.slice(0, end), true)) continue;
      const tail = scanned.slice(end).split(/["'`),;|&]/)[0];
      out.push(
        ...lineTokens(file, no, mask(scanned.slice(0, end)) + tail).map((p) => ({
          ...p,
          text: raw.trim(),
        })),
      );
    }
  }
  return out;
}
const SHELL_ASSIGN = /(?<![\w.$@/-])([A-Za-z_]\w*)=(?:"([^"]*)"|'([^']*)'|([^\s"'`;)&|]+))/g;
const JS_ASSIGN = /\b(?:const|let|var)\s+([A-Za-z_]\w*)\s*=\s*(?:"([^"]*)"|'([^']*)'|`([^`]*)`)/g;
const MAX_ALTS = 64;
const MAX_DEPTH = 8;

const unquote = (v: string): string => v.replace(/^(["'])(.*)\1$/, '$2');

/** The scalar item(s) a YAML value holds: a plain/quoted scalar, or the items of a flow sequence. */
function scalarItems(v: string): string[] {
  let t = v.trim();
  if (/^["']/.test(t)) {
    const end = t.indexOf(t[0], 1);
    return [end > 0 ? t.slice(1, end) : t.slice(1)];
  }
  t = t.replace(/\s+#.*$/, '');
  if (t.startsWith('[')) {
    return t
      .replace(/^\[|\]\s*$/g, '')
      .split(',')
      .map((x) => unquote(x.trim()));
  }
  return [t];
}

type Tables = {
  /** `KEY: v`, `KEY=v`, `const KEY = 'v'` anywhere in the file, by key name. */
  keyVals: Map<string, Part[]>;
  inputDefaults: Map<string, Part[]>;
  definedInputs: Set<string>;
};

function buildTables(file: string, text: string, script: boolean): Tables {
  const keyVals = new Map<string, Part[]>();
  const inputDefaults = new Map<string, Part[]>();
  const definedInputs = new Set<string>();
  const add = (m: Map<string, Part[]>, k: string, s: string, no: number, raw: string) => {
    const part: Part = { s, file, line: no, text: raw.trim() };
    m.set(k, [...(m.get(k) ?? []), part]);
  };
  const comment = commentLine(script);
  const lines = text.split('\n');
  let pending: { name: string; indent: number } | undefined;
  lines.forEach((raw, i) => {
    if (comment.test(raw) || raw.trim() === '') return;
    const no = i + 1;
    const indent = raw.length - raw.trimStart().length;
    for (const m of raw.matchAll(SHELL_ASSIGN)) {
      add(keyVals, m[1], m[2] ?? m[3] ?? m[4] ?? '', no, raw);
    }
    for (const m of raw.matchAll(JS_ASSIGN)) {
      add(keyVals, m[1], m[2] ?? m[3] ?? m[4] ?? '', no, raw);
    }
    if (script) return;
    const seq = /^(\s*)-\s+(.+)$/.exec(raw);
    if (pending && seq && indent >= pending.indent && !/^[\w.-]+\s*:(\s|$)/.test(seq[2])) {
      for (const s of scalarItems(seq[2])) add(keyVals, pending.name, s, no, raw);
      return;
    }
    if (pending && indent <= pending.indent) pending = undefined;
    const kv = /^\s*(?:-\s+)*([A-Za-z_][\w.-]*)\s*:\s*(.*?)\s*$/.exec(raw);
    if (!kv) return;
    const [, name, value] = kv;
    if (value === '' || /^[|>][+-]?\d*$/.test(value)) {
      pending = value === '' ? { name, indent } : undefined;
      return;
    }
    for (const s of scalarItems(value)) add(keyVals, name, s, no, raw);
  });
  // `inputs:` → each direct child is an input; its `default:` is the in-tree value.
  lines.forEach((raw, i) => {
    const head = /^(\s*)inputs:\s*$/.exec(raw);
    if (!head) return;
    const base = head[1].length;
    let child: number | undefined;
    let grand: number | undefined;
    let cur: string | undefined;
    for (let j = i + 1; j < lines.length; j++) {
      const l = lines[j];
      if (comment.test(l) || l.trim() === '') continue;
      const ind = l.length - l.trimStart().length;
      if (ind <= base) break;
      child ??= ind;
      if (ind === child) {
        const m = /^([\w-]+)\s*:/.exec(l.trimStart());
        cur = m?.[1];
        grand = undefined;
        if (cur) definedInputs.add(cur);
      } else if (cur) {
        grand ??= ind;
        const d = /^default\s*:\s*(.*?)\s*$/.exec(l.trimStart());
        if (d && ind === grand) {
          for (const s of scalarItems(d[1])) add(inputDefaults, cur, s, j + 1, l);
        }
      }
    }
  });
  return { keyVals, inputDefaults, definedInputs };
}

type Resolution = { alts: Alt[]; unresolved: string[] };

function cartesian(options: Alt[][]): Alt[] {
  let acc: Alt[] = [[]];
  for (const opt of options) {
    acc = acc.flatMap((a) => opt.map((o) => [...a, ...o])).slice(0, MAX_ALTS);
  }
  return acc;
}

/** Expand the refs inside one literal piece of text written at `origin`. */
function expandText(
  s: string,
  origin: Source,
  t: Tables,
  opts: ScanOpts,
  seen: string[],
): Resolution {
  const spans = [...s.matchAll(REF_SPAN)];
  if (spans.length === 0) return { alts: [[piece(s, origin)]], unresolved: [] };
  const unresolved: string[] = [];
  const options: Alt[][] = [];
  let at = 0;
  for (const m of spans) {
    const idx = m.index as number;
    options.push([[piece(s.slice(at, idx), origin)]]);
    const r = resolveSpan(m[0], origin, t, opts, seen);
    unresolved.push(...r.unresolved);
    options.push(r.alts.length ? r.alts : [[]]);
    at = idx + m[0].length;
  }
  options.push([[piece(s.slice(at), origin)]]);
  return { alts: cartesian(options), unresolved };
}

function resolveName(
  kind: 'inputs' | 'env' | 'matrix',
  name: string,
  t: Tables,
  opts: ScanOpts,
  seen: string[],
): Resolution {
  const key = `${kind}.${name}`;
  if (seen.includes(key) || seen.length >= MAX_DEPTH) {
    return { alts: [], unresolved: [`${key} (reference cycle or too deep)`] };
  }
  const trail = [...seen, key];
  const sources: Part[] = [];
  let known = false;
  if (kind === 'inputs') {
    sources.push(...(t.inputDefaults.get(name) ?? []));
    for (const w of opts.inputWith?.[name] ?? []) {
      sources.push({ s: w.value, file: w.file, line: w.line, text: w.text });
    }
    known = t.definedInputs.has(name) || sources.length > 0;
  } else {
    sources.push(...(t.keyVals.get(name) ?? []));
    if (kind === 'matrix') {
      for (const v of opts.matrixVersions ?? []) {
        sources.push({ s: v, file: '(dynamic matrix)', line: 0, text: `matrix emits ${v}` });
      }
    }
    known = sources.length > 0;
  }
  if (!known) return { alts: [], unresolved: [key] };
  const out: Resolution = { alts: [], unresolved: [] };
  for (const src of sources) {
    // A command substitution computes its value at run time; there is no literal to judge.
    if (/^\s*(?:\$\(|`)/.test(src.s)) {
      out.unresolved.push(`${key} (computed by a command)`);
      continue;
    }
    const r = expandText(src.s, src, t, opts, trail);
    out.alts.push(...r.alts);
    out.unresolved.push(...r.unresolved);
  }
  return out;
}

/** Every literal text one `${{ }}` / `${X}` / `$X` reference can expand to. */
function resolveSpan(
  span: string,
  origin: Source,
  t: Tables,
  opts: ScanOpts,
  seen: string[],
): Resolution {
  if (span.startsWith('${{')) {
    const inner = span.slice(3, -2);
    const operands = [...inner.matchAll(EXPR_OPERAND)].map((m) => m[0]);
    // The expression's own literals (`inputs.fw || '16.3.8'`) are version text too.
    const out: Resolution = {
      alts: [[piece(inner.replace(EXPR_OPERAND, ''), origin)]],
      unresolved: [],
    };
    for (const op of operands) {
      const m = /^(github\.event\.inputs|inputs|env|matrix)\.([\w-]+)$/.exec(op);
      if (!m) {
        out.unresolved.push(op);
        continue;
      }
      const kind = m[1] === 'env' || m[1] === 'matrix' ? m[1] : 'inputs';
      const r = resolveName(kind, m[2], t, opts, seen);
      out.alts.push(...r.alts);
      out.unresolved.push(...r.unresolved);
    }
    return out;
  }
  const name = /^\$\{?([A-Za-z_]\w*)/.exec(span)?.[1] as string;
  return resolveName('env', name, t, opts, seen);
}

const mask = (s: string): string => s.replace(/\d/g, '#');

/** Pins reached through a reference that sits in a next version position. */
function indirectPins(file: string, text: string, opts: ScanOpts): WorkflowPin[] {
  const script = isScriptFile(file);
  const entries = nextLineEntries(text, script);
  if (entries.length === 0) return [];
  const tables = buildTables(file, text, script);
  const pins: WorkflowPin[] = [];
  for (const { no, raw, blockChild } of entries) {
    const scanned = preprocess(raw);
    for (const m of scanned.matchAll(REF_SPAN)) {
      const start = m.index as number;
      const prefix = scanned.slice(0, start);
      const names = m[0].startsWith('${{')
        ? [...m[0].matchAll(EXPR_OPERAND)].map((o) => o[0])
        : [/^\$\{?([A-Za-z_]\w*)/.exec(m[0])?.[1] ?? m[0]];
      // By name too, in YAML: `ref: ${{ env.NEXTJS_REF }}`. Not in a script, where a
      // JS variable called `next` is an iterator and `nextjsRef=${nextjsRef}` a log line.
      const inPosition =
        blockChild ||
        versionPositionPrefix(prefix, script) ||
        (!script && names.some(holdsNextVersion));
      if (!inPosition) continue;
      const origin: Source = { file, line: no, text: raw.trim() };
      const r = resolveSpan(m[0], origin, tables, opts, []);
      for (const u of r.unresolved) {
        pins.push({
          file,
          line: no,
          version: u,
          parseable: false,
          unresolved: true,
          text: raw.trim(),
        });
      }
      const suffix = scanned.slice(start + m[0].length);
      for (const alt of r.alts) {
        const value = alt.map((p) => p.s).join('');
        for (const p of lineTokens(file, no, mask(prefix) + value + mask(suffix))) {
          // Attribute the token to the line that WROTE it, so an exclusion on that
          // line (not on every line that merely reads it) is what excuses it.
          const src = alt.find((part) => part.s.includes(p.version)) ?? alt[0];
          pins.push({
            ...p,
            file: src.file,
            line: src.line,
            text: src.text,
            via: `${file}:${no}`,
          });
        }
      }
    }
  }
  return pins;
}

/** Direct plus indirect pins of one file. */
function allPins(file: string, text: string, opts: ScanOpts = {}): WorkflowPin[] {
  return [...workflowNextPins(file, text), ...indirectPins(file, text, opts)];
}

/** Affected versions inside [lo, hi) / [lo, hi] — what an upper-bounded range really admits. */
function admittedAdvisories(lo: string, hi: string, op: '<' | '<='): string[] {
  const t = (v: string, fill: number): [number, number, number] => {
    const [a, b, c] = v.split('.').map(Number);
    return [a, b, c ?? fill];
  };
  const cmp = (a: number[], b: number[]) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
  // `<16.4` stops before 16.4.0; `<=16.4` admits every 16.4.x.
  const top = t(hi, op === '<' ? 0 : Number.MAX_SAFE_INTEGER);
  const bottom = t(lo, 0);
  return NEXT_ADVISORIES.filter((a) =>
    a.ranges.some((r) => {
      const intro = t(r.introduced, 0);
      const start = cmp(bottom, intro) > 0 ? bottom : intro;
      return (
        cmp(start, t(r.lastAffected, 0)) <= 0 &&
        (op === '<' ? cmp(start, top) < 0 : cmp(start, top) <= 0)
      );
    }),
  ).map((a) => a.id);
}

/** What is wrong with one pin, or `undefined` when it is clear. */
function judgePin(p: WorkflowPin): string | undefined {
  if (p.unresolved) {
    return `unresolvable indirection into a next version position (${p.version}) — the scan cannot judge it`;
  }
  if (!p.parseable) return `unparseable next version ${p.version}`;
  if (p.upper) {
    const { op, lowers } = p.upper;
    if (lowers.length === 0) {
      return `next ${op}${p.version}: an upper-bound-only range admits every version below it, affected ones included`;
    }
    const ids = [...new Set(lowers.flatMap((lo) => admittedAdvisories(lo, p.version, op)))];
    return ids.length
      ? `next ${op}${p.version} admits affected versions (${ids.join(', ')})`
      : undefined;
  }
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
function workflowFlags(
  file: string,
  text: string,
  exclusions: HarnessPin[],
  opts: ScanOpts = {},
): string[] {
  const flags = allPins(file, text, opts).flatMap((p) => {
    const why = judgePin(p);
    if (why === undefined || exclusions.some((ex) => excuses(ex, p))) return [];
    return [`${p.file}:${p.line}: ${why}${p.via ? ` (read at ${p.via})` : ''} — ${p.text}`];
  });
  return [...new Set(flags)];
}

/** Exclusions that excuse no flagged pin: the line moved, changed, was fixed, or is gone. */
function staleExclusions(exclusions: HarnessPin[], pins: WorkflowPin[]): HarnessPin[] {
  return exclusions.filter((ex) => !pins.some((p) => judgePin(p) !== undefined && excuses(ex, p)));
}

/**
 * Dynamic-matrix SOURCES: a script a workflow runs to produce its `fromJSON(...)`
 * matrix, mapped to the versions it really prints. Run, not parsed — the script is
 * asked what it emits. A workflow whose `matrix.next` comes from a script not listed
 * here is unresolvable, so a new matrix source reds until it is registered.
 */
const MATRIX_EMITTERS: Record<string, () => string[]> = {
  'scripts/next-minor-matrix.mjs': () =>
    (buildMatrix() as { include: { next: string }[] }).include.map((e) => e.next),
};

type ScanTarget = { file: string; text: string; opts: ScanOpts };

const SCRIPT_TOKEN = /[\w@+./-]+\.(?:mjs|cjs|js|ts|sh|bash)\b/g;
/** Specs are test fixtures; package/app `src/` is product code, not a script CI runs to install things. */
const NOT_A_CI_SCRIPT = /\.(?:test|spec)\.|__tests__\/|^(?:packages|apps)\/[^/]+\/src\//;

/** Tracked, non-test scripts named on a non-comment line of a workflow or composite action. */
function referencedScripts(yamls: { text: string }[], tracked: Set<string>): string[] {
  const found = new Set<string>();
  for (const { text } of yamls) {
    for (const raw of text.split('\n')) {
      if (/^\s*#/.test(raw)) continue;
      for (const m of raw.matchAll(SCRIPT_TOKEN)) {
        // `knext/scripts/x.sh` is a checkout-relative spelling of `scripts/x.sh`.
        const segs = m[0].replace(/^\.\//, '').split('/');
        for (let k = 0; k < segs.length; k++) {
          const candidate = segs.slice(k).join('/');
          if (tracked.has(candidate)) {
            if (!NOT_A_CI_SCRIPT.test(candidate)) found.add(candidate);
            break;
          }
        }
      }
    }
  }
  return [...found].sort();
}

/** What every `uses: ./.github/actions/<dir>` step passes through `with:`, by input name. */
function actionCallerInputs(
  dir: string,
  yamls: { file: string; text: string }[],
): NonNullable<ScanOpts['inputWith']> {
  const out: NonNullable<ScanOpts['inputWith']> = {};
  const uses = new RegExp(`\\buses:\\s*["']?\\./${dir.replaceAll('.', '\\.')}/?["']?\\s*(?:#.*)?$`);
  for (const { file, text } of yamls) {
    const lines = text.split('\n');
    lines.forEach((raw, i) => {
      if (!uses.test(raw)) return;
      const col = raw.indexOf('uses:');
      let withCol = -1;
      let child: number | undefined;
      for (let j = i + 1; j < lines.length; j++) {
        const l = lines[j];
        if (l.trim() === '' || /^\s*#/.test(l)) continue;
        const ind = l.length - l.trimStart().length;
        if (withCol < 0) {
          if (ind < col) break;
          if (ind === col && /^with:\s*$/.test(l.trimStart())) withCol = ind;
          continue;
        }
        if (ind <= withCol) break;
        child ??= ind;
        const kv = ind === child ? /^([\w-]+)\s*:\s*(.*?)\s*$/.exec(l.trimStart()) : null;
        if (!kv) continue;
        for (const value of scalarItems(kv[2])) {
          out[kv[1]] = [...(out[kv[1]] ?? []), { value, file, line: j + 1, text: l.trim() }];
        }
      }
    });
  }
  return out;
}

/**
 * Everything the indirection scan covers, DISCOVERED (never enumerated): every
 * workflow, every composite action under `.github/actions/**` (with the `with:`
 * values its callers pass), and every script those name.
 */
function scanTargets(): ScanTarget[] {
  const tracked = trackedFiles();
  const trackedSet = new Set(tracked);
  const read = (f: string) => readFileSync(resolve(REPO_ROOT, f), 'utf8');
  const workflows = tracked.filter((f) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(f));
  const actions = tracked.filter((f) => /^\.github\/actions\/.+\/action\.ya?ml$/.test(f));
  const yamls = [...workflows, ...actions].map((file) => ({ file, text: read(file) }));
  const targets: ScanTarget[] = yamls.map(({ file, text }) => {
    const opts: ScanOpts = {};
    if (/\bfromJSON\(/.test(text)) {
      opts.matrixVersions = Object.entries(MATRIX_EMITTERS).flatMap(([script, emit]) =>
        text.includes(script) ? emit() : [],
      );
    }
    if (actions.includes(file)) {
      opts.inputWith = actionCallerInputs(file.replace(/\/action\.ya?ml$/, ''), yamls);
    }
    return { file, text, opts };
  });
  for (const file of referencedScripts(yamls, trackedSet)) {
    targets.push({ file, text: read(file), opts: {} });
  }
  return targets;
}

describe('#2594 — no workflow pins, sets or asserts a next with a known advisory', () => {
  const workflows = trackedFiles().filter((f) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(f));
  const targets = scanTargets();
  const pins = targets.flatMap((t) => allPins(t.file, t.text, t.opts));

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

  // #2606 review F2: an upper bound admits every version BELOW it, so `<16.4.1`
  // admits 16.4.0 even though 16.4.1 itself is clear.
  const UPPER_BOUNDS: [string, string][] = [
    ['an upper-bound-only range', '          npm i "next@<16.4.1"'],
    ['an inclusive upper-bound-only range', '          npm i "next@<=16.4.0"'],
    ['an upper bound over a stale lower bound', '          npm i "next@>=16.3.0 <16.4.1"'],
    [
      'an upper bound over a lower bound that admits affected versions',
      '          npm i "next@>=1.0.0 <16.4.1"',
    ],
    ['an upper bound in an env pin', '  NEXT_PIN: "<16.4.1"'],
    // inclusive upper bound sitting exactly on the first affected release (10.0.0)
    [
      'an inclusive upper bound on the first affected release',
      '          npm i "next@>=1.0.0 <=10.0.0"',
    ],
  ];
  for (const [name, line] of UPPER_BOUNDS) {
    it(`flags ${name}`, () => {
      expect(workflowFlags('x.yml', line, []).length, line).toBeGreaterThan(0);
    });
  }

  it('does not flag a range whose every admitted version is clear', () => {
    for (const line of [
      '          npm i "next@>=16.4.1 <16.5.0"',
      '          npm i "next@>16.4.1 <=16.4.9"',
      '          npm i "next@^16.4.1"',
      '          npm i "next@~16.4.1"',
      // exclusive upper bound sitting exactly on the first affected release (10.0.0)
      '          npm i "next@>=1.0.0 <10.0.0"',
    ]) {
      expect(workflowFlags('x.yml', line, []), line).toEqual([]);
    }
  });

  // #2606 review F3: `create-next-app@X` scaffolds next@X (it defaults the
  // template's next to its own version), so it is a next pin, not another package.
  it('judges create-next-app@X as next@X', () => {
    for (const line of [
      '          npx create-next-app@16.3.8 my-app',
      '          npx --yes create-next-app@16.4.0 my-app --ts',
      '          bunx create-next-app@^16.3.0 my-app',
    ]) {
      expect(workflowFlags('x.yml', line, []).length, line).toBe(1);
    }
    for (const line of [
      '          npx create-next-app@16.4.1 my-app',
      '          npx create-next-app@latest my-app',
    ]) {
      expect(workflowFlags('x.yml', line, []), line).toEqual([]);
    }
  });

  // #2606 review F1: the version sits on a LATER line than the key that names next.
  it('flags a block-style sequence or mapping under a key that mentions next', () => {
    for (const text of [
      '    next:\n      - 16.3.8',
      '    next:\n    - 16.3.8',
      '    next:\n      - "16.3.8"\n      - 16.4.1',
      '    - next:\n        - 16.3.8',
      '  NEXT_PIN:\n    - 16.3.8',
      '    next:\n      version: 16.3.8',
      '    nextVersion: >-\n      16.3.8',
      '    next:\n\n      # the stale pin\n      - 16.3.8',
    ]) {
      expect(workflowFlags('x.yml', text, []).length, text).toBeGreaterThan(0);
    }
  });

  it('a block sequence ends at the next key and is judged like any other pin', () => {
    expect(workflowFlags('x.yml', '    next:\n      - 16.4.1', [])).toEqual([]);
    expect(
      workflowFlags('x.yml', '    next:\n      - 16.4.1\n    other:\n      - 16.3.8', []),
    ).toEqual([]);
    expect(workflowFlags('x.yml', '    node:\n      - 22.4\n      - 20.1', [])).toEqual([]);
    // only the key's DIRECT children are pins: a job named `build-next` has a body of
    // steps under it, and pnpm's `version: 10.4.1` in there is not next's version
    expect(
      workflowFlags(
        'x.yml',
        '  build-next:\n    runs-on: x\n    steps:\n      - uses: pnpm/action-setup@v6\n        with:\n          version: 10.4.1',
        [],
      ),
    ).toEqual([]);
    // an excused block pin matches on its own line, file and version
    const ex = { file: 'x.yml', text: '- 16.3.8', version: '16.3.8', reason: 'r'.repeat(30) };
    expect(workflowFlags('x.yml', '    next:\n      - 16.3.8', [ex])).toEqual([]);
  });

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

  it('an exclusion on a pin that is already clear is stale too (the pin was fixed)', () => {
    const fixed = '  NEXTJS_REF: v16.4.1';
    const ex = { file: 'x.yml', text: fixed.trim(), version: '16.4.1', reason: 'r'.repeat(30) };
    expect(staleExclusions([ex], workflowNextPins('x.yml', fixed)).length).toBe(1);
  });

  it('the scan reaches the kind e2e jobs that stage and deploy a fixture', () => {
    expect(workflows).toContain('.github/workflows/standalone-deploy-kind-e2e.yml');
    expect(workflows).toContain('.github/workflows/supply-chain.yml');
    expect(pins.length).toBeGreaterThan(0);
  });

  // #2630: an over-narrowed discovery would pass vacuously. Pin the floor of what the
  // indirection scan must see on the real tree.
  it('the indirection scan reaches composite actions and the scripts workflows call', () => {
    const files = targets.map((t) => t.file);
    expect(files).toContain('.github/actions/docker-hub-mirror/action.yml');
    expect(files).toContain('scripts/next-minor-matrix.mjs');
    expect(files).toContain('scripts/e2e-deploy.sh');
    expect(files.filter((f) => f.startsWith('scripts/')).length).toBeGreaterThan(20);
    // test files and product source are not CI scripts
    expect(files.filter((f) => /\.test\.|^packages\/[^/]+\/src\//.test(f))).toEqual([]);
  });

  it('resolves the real indirections: NEXTJS_REF consumers and the dynamic matrix', () => {
    const via = (file: string) => pins.filter((p) => p.via?.startsWith(`${file}:`));
    // NEXT_NPM_VERSION="${NEXTJS_REF#v}" / next@${NEXT_NPM_VERSION}: read at one line, written at another
    const e2e = via('.github/workflows/test-e2e-deploy.yml');
    expect(e2e.length).toBeGreaterThan(0);
    expect(e2e.some((p) => p.version === '16.4.0' && p.text.startsWith('NEXTJS_REF:'))).toBe(true);
    // next@${MATRIX_NEXT} <- matrix.next <- scripts/next-minor-matrix.mjs, via the emitter
    const emitted = via('.github/workflows/next-minor-matrix.yml').filter(
      (p) => p.file === '(dynamic matrix)',
    );
    expect(new Set(emitted.map((p) => p.version))).toEqual(new Set(NEXT_MATRIX_VERSIONS));
  });

  it('the dynamic-matrix source reads its versions from the one source of truth', () => {
    const script = readFileSync(resolve(REPO_ROOT, 'scripts/next-minor-matrix.mjs'), 'utf8');
    expect(script).toMatch(/import \{[^}]*NEXT_MATRIX_VERSIONS[^}]*\} from '[^']*next-compat/);
    // no version literal of its own: what the emitter prints is exactly next-compat.ts
    expect(script.match(/\b\d+\.\d+\.\d+\b/g) ?? []).toEqual([]);
    expect((buildMatrix() as { include: { next: string }[] }).include.map((e) => e.next)).toEqual([
      ...NEXT_MATRIX_VERSIONS,
    ]);
    for (const v of NEXT_MATRIX_VERSIONS) expect(nextAdvisoriesFor(v), v).toEqual([]);
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
    const bad = targets.flatMap((t) =>
      workflowFlags(t.file, t.text, WORKFLOW_HARNESS_PINS, t.opts),
    );
    expect(bad).toEqual([]);
  });
});
/**
 * #2630: a version that reaches `next` through INDIRECTION. Fixture text is written
 * with `@{` standing for `${` so the literals are not template-string lookalikes.
 */
const fx = (s: string): string => s.replaceAll('@{', '$' + '{');

describe('#2630 — a next version reached through indirection is judged, not skipped', () => {
  const flagged = (file: string, text: string, opts: ScanOpts = {}) =>
    workflowFlags(file, fx(text), [], opts);

  describe('dispatch / call input defaults', () => {
    const wf = (def: string, use: string) =>
      [
        'on:',
        '  workflow_dispatch:',
        '    inputs:',
        '      fw:',
        '        description: the framework',
        `        default: ${def}`,
        'jobs:',
        '  b:',
        '    steps:',
        `      - run: ${use}`,
      ].join('\n');

    for (const [name, use] of [
      ['inputs.X in an install spec', 'bun add "next@@{{ inputs.fw }}"'],
      ['github.event.inputs.X in an install spec', 'bun add "next@@{{ github.event.inputs.fw }}"'],
      ['inputs.X in an npm pkg set', 'npm pkg set "dependencies.next=@{{ inputs.fw }}"'],
      ['inputs.X with a fallback literal', 'bun add "next@@{{ inputs.fw || \'16.4.3\' }}"'],
    ] as const) {
      it(`flags ${name} when the default is vulnerable`, () => {
        const out = flagged('x.yml', wf("'16.3.8'", use));
        expect(out.length, name).toBeGreaterThan(0);
        expect(out.join('\n')).toContain('16.3.8');
      });
      it(`passes ${name} when the default is clear`, () => {
        expect(flagged('x.yml', wf("'16.4.3'", use)), name).toEqual([]);
      });
    }

    it('flags an input default that feeds a next-named env key', () => {
      const text = [
        'on:',
        '  workflow_call:',
        '    inputs:',
        '      fw:',
        '        default: 16.3.8',
        'env:',
        '  NEXT_PIN: @{{ inputs.fw }}',
      ].join('\n');
      expect(flagged('x.yml', text).length).toBeGreaterThan(0);
    });

    it('does not judge an input default that never reaches a next position', () => {
      const text = wf("'16.3.8'", 'echo "built with @{{ inputs.fw }}"');
      expect(flagged('x.yml', text)).toEqual([]);
    });

    it('turns an input it cannot resolve into a failure, not a pass', () => {
      const text = 'jobs:\n  b:\n    steps:\n      - run: bun add "next@@{{ inputs.nope }}"';
      const out = flagged('x.yml', text);
      expect(out.length).toBeGreaterThan(0);
      expect(out.join('\n')).toContain('unresolvable');
    });

    it('turns a secret / step output / vars feeding next into a failure', () => {
      for (const ref of [
        'secrets.NEXT_V',
        'steps.pick.outputs.v',
        'vars.NEXT_V',
        'needs.a.outputs.v',
      ]) {
        const text = `jobs:\n  b:\n    steps:\n      - run: bun add "next@@{{ ${ref} }}"`;
        expect(flagged('x.yml', text).join('\n'), ref).toContain('unresolvable');
      }
    });
  });

  describe('env indirection', () => {
    const USES = [
      'bun add next@$FW',
      'bun add next@@{FW}',
      'bun add "next@@{{ env.FW }}"',
      'npm pkg set "dependencies.next=@{FW}"',
      'bun add "next@@{FW#v}"',
    ];
    const LEVELS: [string, (v: string, use: string) => string][] = [
      ['workflow', (v, use) => `env:\n  FW: ${v}\njobs:\n  b:\n    steps:\n      - run: ${use}`],
      ['job', (v, use) => `jobs:\n  b:\n    env:\n      FW: ${v}\n    steps:\n      - run: ${use}`],
      [
        'step',
        (v, use) =>
          `jobs:\n  b:\n    steps:\n      - name: s\n        env:\n          FW: ${v}\n        run: ${use}`,
      ],
    ];

    for (const [level, build] of LEVELS) {
      for (const use of USES) {
        it(`flags a ${level}-level env read as ${use}`, () => {
          expect(flagged('x.yml', build('16.3.8', use)).length, use).toBeGreaterThan(0);
          expect(flagged('x.yml', build('16.4.3', use)), use).toEqual([]);
        });
      }
    }

    it('follows a chain across env keys and a shell derivation', () => {
      const text = [
        'env:',
        '  A: @{{ env.B }}',
        '  B: v16.3.8',
        'jobs:',
        '  b:',
        '    steps:',
        '      - run: |',
        '          NEXT_NPM_VERSION="@{A#v}"',
        '          npm pack "next@@{NEXT_NPM_VERSION}"',
      ].join('\n');
      const out = flagged('x.yml', text);
      expect(out.length).toBeGreaterThan(0);
      expect(out.join('\n')).toContain('16.3.8');
    });

    it('follows a shell-local assignment', () => {
      const text = [
        'jobs:',
        '  b:',
        '    steps:',
        '      - run: |',
        '          FW=16.3.8',
        '          bun add next@$FW',
      ].join('\n');
      expect(flagged('x.yml', text).length).toBeGreaterThan(0);
    });

    it('flags a vulnerable fallback literal inside a value that feeds next', () => {
      const text = [
        'on:',
        '  workflow_call:',
        '    inputs:',
        '      fw:',
        '        default: 16.4.3',
        'env:',
        "  FW: @{{ inputs.fw || '16.3.8' }}",
        'jobs:',
        '  b:',
        '    steps:',
        '      - run: bun add next@$FW',
      ].join('\n');
      expect(flagged('x.yml', text).length).toBeGreaterThan(0);
    });

    it('turns an env var it cannot resolve into a failure', () => {
      const text = 'jobs:\n  b:\n    steps:\n      - run: bun add next@$UNKNOWN_V';
      expect(flagged('x.yml', text).join('\n')).toContain('unresolvable');
    });

    it('does not judge an env var that never reaches a next position', () => {
      const text = [
        'env:',
        '  PNPM_VERSION: 10.4.1',
        '  HOME_V: 16.3.8',
        'jobs:',
        '  b:',
        '    steps:',
        '      - run: echo $HOME_V && pnpm@@{PNPM_VERSION}',
      ].join('\n');
      expect(flagged('x.yml', text)).toEqual([]);
    });

    it('an exclusion on the SOURCE line excuses the pin it feeds, and only that', () => {
      const text = fx(
        [
          'env:',
          '  FW: 16.3.8',
          'jobs:',
          '  b:',
          '    steps:',
          '      - run: bun add next@@{FW}',
        ].join('\n'),
      );
      const ex = { file: 'x.yml', text: 'FW: 16.3.8', version: '16.3.8', reason: 'r'.repeat(30) };
      expect(workflowFlags('x.yml', text, [ex])).toEqual([]);
      expect(
        workflowFlags('x.yml', text.replace('FW: 16.3.8', 'FW: 16.3.8 # edited'), [ex]).length,
      ).toBeGreaterThan(0);
      expect(workflowFlags('y.yml', text, [ex]).length).toBeGreaterThan(0);
    });
  });

  describe('positions and fail-closed edges', () => {
    it('fails a value computed by a command, which has no literal to judge', () => {
      const text =
        'env:\n  FW: $(node -p "1+1")\njobs:\n  b:\n    steps:\n      - run: bun add next@$FW';
      expect(flagged('x.yml', text).join('\n')).toContain('computed by a command');
    });

    it('fails a reference cycle instead of looping', () => {
      const text =
        'env:\n  A: @{B}\n  B: @{A}\njobs:\n  b:\n    steps:\n      - run: bun add next@$A';
      expect(flagged('x.yml', text).join('\n')).toContain('cycle');
    });

    it('joins literal pieces around a reference into the version they spell', () => {
      const text = (minor: string) =>
        [
          'on:',
          '  workflow_call:',
          '    inputs:',
          '      minor:',
          `        default: ${minor}`,
          'env:',
          '  FW: 16.@{{ inputs.minor }}.8',
          'jobs:',
          '  b:',
          '    steps:',
          '      - run: bun add next@$FW',
        ].join('\n');
      expect(flagged('x.yml', text('3')).join('\n')).toContain('next 16.3.8');
      expect(flagged('x.yml', text('4').replace('.8', '.4'))).toEqual([]);
    });

    it('judges a reference sitting under a key that mentions next', () => {
      const text = 'env:\n  FW: 16.3.8\nmatrix:\n  next:\n    - @{{ env.FW }}';
      expect(flagged('x.yml', text).length).toBeGreaterThan(0);
    });

    it('does not take prose, or a next-named value that is not a version, for a position', () => {
      for (const text of [
        'env:\n  FW: 16.3.8\njobs:\n  b:\n    steps:\n      - run: echo "next: @{FW}"',
        'env:\n  NEXT_TEST_NATIVE_DIR: @{{ steps.swc.outputs.dir }}',
        'env:\n  BUILD_RESULT: @{{ needs.build-next.result }}',
        '      - run: docker run kn-next-operator:v@{VERSION}',
      ]) {
        expect(flagged('x.yml', text), text).toEqual([]);
      }
    });

    it('attributes a literal on the reading line to that line, not to the source it also reads', () => {
      const text =
        'env:\n  FW: 16.4.3\njobs:\n  b:\n    steps:\n      - run: echo next@16.3.8 && bun add next@$FW';
      const out = flagged('x.yml', text);
      expect(out.length).toBeGreaterThan(0);
      for (const line of out) expect(line, line).not.toContain('FW: 16.4.3');
    });
  });

  describe('matrix', () => {
    it('flags a static matrix key read through matrix.X', () => {
      const text = [
        'strategy:',
        '  matrix:',
        '    ver: [16.3.8, 16.4.3]',
        'steps:',
        '  - run: bun add "next@@{{ matrix.ver }}"',
      ].join('\n');
      expect(flagged('x.yml', text).length).toBeGreaterThan(0);
    });
    const dynamic = [
      'strategy:',
      '  matrix: @{{ fromJSON(needs.plan.outputs.matrix) }}',
      'steps:',
      '  - run: bun add "next@@{{ matrix.next }}"',
    ].join('\n');
    it('judges the versions a dynamic-matrix script is known to emit', () => {
      expect(flagged('x.yml', dynamic, { matrixVersions: ['16.3.8'] }).length).toBeGreaterThan(0);
      expect(flagged('x.yml', dynamic, { matrixVersions: ['16.4.3'] })).toEqual([]);
    });
    it('fails a dynamic matrix whose source it cannot resolve', () => {
      expect(flagged('x.yml', dynamic).join('\n')).toContain('unresolvable');
    });
  });

  describe('composite actions', () => {
    const action = (def: string) =>
      [
        'name: a',
        'inputs:',
        '  fw:',
        '    description: d',
        `    default: ${def}`,
        'runs:',
        '  using: composite',
        '  steps:',
        '    - shell: bash',
        '      run: bun add "next@@{{ inputs.fw }}"',
      ].join('\n');
    it('resolves inputs.X to the action input default', () => {
      expect(flagged('.github/actions/a/action.yml', action('16.3.8')).length).toBeGreaterThan(0);
      expect(flagged('.github/actions/a/action.yml', action('16.4.3'))).toEqual([]);
    });
    it('resolves inputs.X to the value a caller passes through with:', () => {
      const withs = {
        fw: [{ value: '16.3.8', file: '.github/workflows/c.yml', line: 9, text: 'fw: 16.3.8' }],
      };
      expect(
        flagged('.github/actions/a/action.yml', action('16.4.3'), { inputWith: withs }).length,
      ).toBeGreaterThan(0);
    });
  });

  describe('scripts the workflows call', () => {
    it('flags a literal next version a shell script installs', () => {
      expect(flagged('scripts/x.sh', 'set -e\nbun add next@16.3.8').length).toBeGreaterThan(0);
      expect(flagged('scripts/x.sh', 'set -e\nbun add next@16.4.3')).toEqual([]);
    });
    it('flags a literal in a script and resolves its own variables', () => {
      expect(flagged('scripts/x.sh', 'FW=16.3.8\nbun add next@@{FW}').length).toBeGreaterThan(0);
      expect(
        flagged('scripts/x.mjs', "const fw = '16.3.8';\nrun(`bun add next@@{fw}`);").length,
      ).toBeGreaterThan(0);
      expect(flagged('scripts/x.mjs', "const fw = '16.4.3';\nrun(`bun add next@@{fw}`);")).toEqual(
        [],
      );
    });
    it('does not flag comments in a script', () => {
      for (const c of [
        '// bun add next@16.3.8',
        ' * bun add next@16.3.8',
        '/* next@16.3.8 */',
        '# next@16.3.8',
      ]) {
        expect(flagged('scripts/x.mjs', c), c).toEqual([]);
      }
    });
    it('fails a script that builds its next spec from something it cannot resolve', () => {
      expect(flagged('scripts/x.mjs', 'run(`bun add next@@{opts.version}`);').join('\n')).toContain(
        'unresolvable',
      );
    });
  });
});
