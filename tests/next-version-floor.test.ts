import { describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { posix, resolve } from 'node:path';
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
 * one - is expanded to every literal it can spell. The unit is the whole version
 * TOKEN the reference sits in (`next@16.$MINOR.$PATCH`, `next@"$MAJOR.$MINOR"`,
 * `next@v${{ inputs.fw }}`): its pieces are joined and the result is judged, so a
 * version only spells itself across several references.
 *
 *   - `${{ inputs.X }}` / `${{ github.event.inputs.X }}` to that input's `default:`
 *     (and, for a composite action, to every value a workflow passes through `with:`);
 *     an input with no default and no caller value is unresolvable;
 *   - `${{ env.X }}`, `$X`, `${X}`, `${X#v}` to `X` set by an `env:` key (workflow,
 *     job or step level), a shell assignment, or a JS `const`, anywhere in the same
 *     file (the tables for these are file-wide, not per job or step); chains are
 *     followed (`A: ${{ env.B }}`), as are the literals inside an expression
 *     (`inputs.X || '16.3.8'`);
 *   - `${{ matrix.X }}` to the static matrix values OF THE JOB THAT READS IT, or, for
 *     a `fromJSON(...)` matrix, to what the source script PRINTS (MATRIX_EMITTERS
 *     runs it) - but only when the `needs:` job that produces the matrix runs that
 *     script. A job without a matrix, and a matrix from any other source, is
 *     unresolvable: a static matrix in another job never stands in for it;
 *   - a `with:` value a workflow passes into a composite action is resolved against
 *     the CALLER's tables (its env, its inputs, the matrix of the calling job), never
 *     the action's own. Block mappings (plain or quoted keys), inline flow mappings
 *     `with: { k: v }`, `with:` written before `uses:` and flow-style steps are read;
 *     any other `with:` shape (alias, merge key, explicit key, block-scalar or
 *     next-line value, an expression for the whole map, a multi-line flow mapping) or
 *     a `uses:` line that is not the plain spelling is UNPARSEABLE, which makes every
 *     input of that action unresolvable;
 *   - a command substitution, `$(...)` or backticks, anywhere in a version token
 *     (`next@$(cat .nextver)`, `next@16.$(cat minor).0`) or in a value such a token
 *     reads, is unresolvable: the value is computed at run time. (Backticks are a
 *     command substitution in shell and YAML, a template literal in JS.)
 *   - in a JS script, `'...next@' + v` / `'...dependencies.next=' + a + '.' + b`: a
 *     string that ends where a version goes, followed by `+` operands - or a variable
 *     that holds such a string (`const p = 'next@'; ... p + v`). The statement may span
 *     lines (`'next@'\n  + '15.0.0'`, a trailing `+`). An operand must be a string /
 *     number literal or a plain identifier a JS assignment sets in the file; a member
 *     access, call or index is unresolvable;
 *   - a JS name's value is the union of EVERY assignment to it in the file, `v = '...'`
 *     without a keyword included. An assignment whose value is not one string literal
 *     (`v = pick()`, `v += '.0'`, `v = '15.0.' + patch`, a value on the next line, a
 *     ternary) leaves the name unresolvable. Only in a JS script: JS embedded in a
 *     workflow (`node -e`, github-script) is read for `const` / `let` / `var` only;
 *   - a YAML alias (`*v`), anchor (`&v ...`) or tag (`!!str ...`) as the value of an env
 *     key, an input default, a matrix key or a `with:` value is unresolvable when it is
 *     read in a version position, and a next-named binding to an alias
 *     (`NEXT_VERSION: *v`, also inside `{ ... }`) is unresolvable where it is written;
 *   - a PACKAGE NAME behind a reference: `${{ env.P }}@X`, `${{ inputs.p }}@X`, `$P@X`,
 *     `${P}@X`. When the reference spells `next` or `create-next-app`, `X` is judged as
 *     `next@X`; one that cannot be resolved, before a version-looking tail, is a failure;
 *   - a pin read through an indirection is attributed to the line that WROTE it, so
 *     an exclusion on that line (not on every line that reads it) excuses it.
 *
 * What it scans: every workflow, every composite action under `.github/actions/**`
 * (action.yml / action.yaml) and every one a `uses: ./<path>` line names wherever it
 * lives (`packages/kn-next-action`; found through other actions too), and every
 * tracked script a workflow or action names
 * (shell, mjs, cjs, js, ts; test files and package/app `src/` are not CI scripts).
 * A script is judged only where a version GOES - `next@X`, `dependencies.next=X`,
 * an assignment to a name that holds a next version - never the prose around it:
 * scripts compare against and log versions (`Next >= 16.4.0`), and "every token on a
 * line that mentions next" would flag the guards themselves.
 *
 * Fail-closed: a reference in a version position that cannot be resolved (a
 * `secrets.*` / `vars.*` / `needs.*` / `steps.*` / `github.*` value, an input with no
 * default and no caller value, a variable nothing in the file assigns, a value
 * computed by `$(...)` or backticks, a reference cycle, a matrix whose source is not
 * registered or is not the job it `needs`, a `with:` shape it cannot parse, a JS
 * concatenation operand it cannot resolve, an alias / anchor / tag, a JS assignment
 * that is not one string literal) is a FAILURE, never a pass. So is a local
 * `uses: ./<path>` with no tracked `action.yml` to scan (the repo root, `..`, a
 * missing directory): the real-tree test requires none. A path spelled some other
 * way (`./a/../b`) is normalised first, so the action it names is still scanned.
 *
 * STILL NOT SEEN, so nobody assumes more: indirection ACROSS files other than the
 * `with:` of a composite action (a reusable workflow's `with:` into another
 * workflow's `inputs:` - such an input is judged at its default, or is unresolvable
 * without one; a script argument whose value a workflow computes), a script that reads
 * its version from a file at run time (`readFileSync`), a version a JS object literal
 * carries (`{ next: '16.3.8' }`), JS strings built any way but `+` (`.concat()`,
 * `.join()`, `.replace()`, `util.format`, `path.join`; a prefix variable joined through
 * a template literal, `${p}${v}` or `${p}` + v - the variable has to be directly against
 * the `+`; a `//` note after a continued `+` is only dropped when it holds no quote),
 * a package name on a different line from its `@version`, a reference that follows a
 * SPACE inside one quoted range (`"next@>=16.4.1 <$V"`), expression functions
 * (`format()`, `join()`, ...; their literal text is judged, they are not evaluated),
 * an env or shell variable reassigned between two jobs or steps of the same file
 * (the union of every assignment in the file is judged), and a dynamic matrix whose
 * producer job runs a registered script indirectly, a package name and its `@`
 * split across `+` operands (`'npm i next' + '@15.0.0'`), JSON text or a bracket
 * assignment inside a script (`'{"next":"15.0.0"}'`, `deps['next'] = '15.0.0'`), a
 * JS block comment between a head and its `+`, and a Dockerfile behind a local
 * `runs: using: docker` action (Dockerfiles are not scanned). Scripts a script calls
 * are reached only when a workflow also names them.
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
  inputWith?: Record<string, (Source & { value: string; ctx?: Ctx })[]>;
  /** Versions any dynamic matrix (`fromJSON(...)`) of this file is taken to emit (fixtures). */
  matrixVersions?: string[];
  /**
   * Registered matrix sources: script path -> the versions it prints. A dynamic
   * matrix reads them only through the `needs.<job>` that RUNS the script.
   */
  matrixEmitters?: Record<string, string[]>;
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
/**
 * Any assignment to a bare name in JS, a keyword or a compound operator included
 * (`v = x`, `v += x`, `let v = x`). `==`, `===`, `!=`, `<=`, `=>` and `obj.v = x` are not.
 */
const JS_ANY_ASSIGN =
  /(?<![\w$.])(?:(?:const|let|var)\s+)?([A-Za-z_$][\w$]*)\s*(\+|-|\*\*|\*|\/|%|\|\||&&|\?\?)?=(?![=>])/g;
/** What must follow `=` for the value to be ONE string literal: the literal, then the end of the statement. */
const JS_STRING_RHS =
  /^\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|`([^`]*)`)\s*(?=[;,)}\]]|\/\/|$)/;
/**
 * A JS script as statements: a line that ends in `+`, or is followed by a line that
 * starts with `+`, is one statement with that line (`'next@'\n  + '15.0.0'`). Comment
 * lines are dropped; the statement text is the lines joined by a single space.
 */
function jsStatements(text: string): { no: number; raw: string; text: string }[] {
  const lines = text.split('\n');
  const comment = commentLine(true);
  const significant = (i: number) => !comment.test(lines[i]) && lines[i].trim() !== '';
  const out: { no: number; raw: string; text: string }[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!significant(i)) continue;
    const start = i;
    let cur = lines[i];
    for (let joined = 0; joined < 40; joined++) {
      let j = i + 1;
      while (j < lines.length && !significant(j)) j++;
      if (j >= lines.length) break;
      // a trailing `// note` after the operator is not part of the code
      const code = cur.replace(/\s\/\/[^'"`]*$/, '').trimEnd();
      if (!/(?<!\+)\+$/.test(code) && !/^\+(?!\+)/.test(lines[j].trimStart())) break;
      cur = `${code} ${lines[j].trim()}`;
      i = j;
    }
    out.push({ no: start + 1, raw: lines[start], text: cur });
  }
  return out;
}
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

/**
 * The top-level comma-separated pieces of a flow-collection body. A comma inside a
 * quote, a `${{ }}` expression or a nested `[ ]` / `{ }` does not split. `undefined`
 * when the body is not closed on this line, which the callers treat as unparseable.
 */
function splitFlow(body: string): string[] | undefined {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (c === '"' || c === "'") {
      const end = body.indexOf(c, i + 1);
      if (end < 0) return undefined;
      cur += body.slice(i, end + 1);
      i = end;
      continue;
    }
    if (body.startsWith('${{', i)) {
      const end = body.indexOf('}}', i);
      if (end < 0) return undefined;
      cur += body.slice(i, end + 2);
      i = end + 1;
      continue;
    }
    if (c === '[' || c === '{') depth++;
    if (c === ']' || c === '}') depth--;
    if (depth < 0) return undefined;
    if (c === ',' && depth === 0) {
      out.push(cur);
      cur = '';
      continue;
    }
    cur += c;
  }
  if (depth !== 0) return undefined;
  out.push(cur);
  return out.map((p) => p.trim()).filter(Boolean);
}

/** The `key: value` entries of a one-line flow mapping `{ ... }`, or `undefined` when unparseable. */
function flowEntries(s: string): { key: string; value: string }[] | undefined {
  const t = stripYamlComment(s);
  if (!t.startsWith('{') || !t.endsWith('}')) return undefined;
  const parts = splitFlow(t.slice(1, -1));
  if (!parts) return undefined;
  const out: { key: string; value: string }[] = [];
  for (const p of parts) {
    const m = /^(?:"([^"]+)"|'([^']+)'|([\w-]+))\s*:\s*([\s\S]*)$/.exec(p);
    if (!m) return undefined;
    out.push({ key: m[1] ?? m[2] ?? m[3], value: m[4].trim() });
  }
  return out;
}

/** A matrix as one job sees it: its static keys, and whether it is built by `fromJSON(...)`. */
type MatrixScope = {
  keys: Map<string, Part[]>;
  /** Set when the matrix (or part of it) is computed: the `needs.<job>` it reads, possibly none. */
  dynamic?: string[];
};
type JobScope = { id: string; from: number; to: number; text: string; matrix: MatrixScope };

type Tables = {
  /** Identifies the file, so `inputs.fw` of two files is not mistaken for a cycle. */
  id: string;
  /** `KEY: v`, `KEY=v`, `const KEY = 'v'` anywhere in the file, by key name. */
  keyVals: Map<string, Part[]>;
  /** JS names assigned a value that is not one string literal: they have no literal to judge. */
  opaque: Map<string, Source>;
  inputDefaults: Map<string, Part[]>;
  /** In a shell / YAML file a backtick pair is a command substitution; in JS it is a template. */
  ticks: boolean;
  /** The matrix of the job being read (or of the whole file when it has no `jobs:`). */
  matrix: MatrixScope;
  jobs: JobScope[];
};

/** `key: value` / `- key: value` / `- scalar` lines of YAML, feeding `add` (lines `from` ..< `to`, 0-based). */
function collectYamlKeyVals(
  lines: string[],
  from: number,
  to: number,
  comment: RegExp,
  add: (name: string, s: string, no: number, raw: string) => void,
): void {
  let pending: { name: string; indent: number } | undefined;
  for (let i = from; i < to; i++) {
    const raw = lines[i];
    if (comment.test(raw) || raw.trim() === '') continue;
    const no = i + 1;
    const indent = raw.length - raw.trimStart().length;
    const seq = /^(\s*)-\s+(.+)$/.exec(raw);
    if (pending && seq && indent >= pending.indent && !/^[\w.-]+\s*:(\s|$)/.test(seq[2])) {
      for (const s of scalarItems(seq[2])) add(pending.name, s, no, raw);
      continue;
    }
    if (pending && indent <= pending.indent) pending = undefined;
    const kv = /^\s*(?:-\s+)*([A-Za-z_][\w.-]*)\s*:\s*(.*?)\s*$/.exec(raw);
    if (!kv) continue;
    const [, name, value] = kv;
    if (value === '' || /^[|>][+-]?\d*$/.test(value)) {
      pending = value === '' ? { name, indent } : undefined;
      continue;
    }
    for (const s of scalarItems(value)) add(name, s, no, raw);
  }
}

/** The job ranges (1-based, inclusive) under a top-level `jobs:` key; none when the file has no such key. */
function parseJobs(lines: string[], comment: RegExp): { id: string; from: number; to: number }[] {
  const head = lines.findIndex((l) => /^jobs\s*:\s*(?:#.*)?$/.test(l));
  if (head < 0) return [];
  const heads: { id: string; from: number; indent: number }[] = [];
  let child: number | undefined;
  let last = lines.length;
  for (let i = head + 1; i < lines.length; i++) {
    const l = lines[i];
    if (comment.test(l) || l.trim() === '') continue;
    const ind = l.length - l.trimStart().length;
    if (ind === 0) {
      last = i;
      break;
    }
    child ??= ind;
    const m = ind === child ? /^(?:"([^"]+)"|'([^']+)'|([\w.-]+))\s*:/.exec(l.trimStart()) : null;
    if (m) heads.push({ id: m[1] ?? m[2] ?? m[3], from: i + 1, indent: ind });
  }
  return heads.map((h, k) => ({
    id: h.id,
    from: h.from,
    to: k + 1 < heads.length ? heads[k + 1].from - 1 : last,
  }));
}

/** The matrix declared in lines `from` ..< `to` (0-based): static keys, or the fact that it is computed. */
function matrixOf(
  file: string,
  lines: string[],
  from: number,
  to: number,
  comment: RegExp,
): MatrixScope {
  const keys = new Map<string, Part[]>();
  let dynamic: string[] | undefined;
  const markDynamic = (s: string) => {
    dynamic = [...(dynamic ?? []), ...[...s.matchAll(/needs\.([\w-]+)/g)].map((m) => m[1])];
  };
  const add = (name: string, s: string, no: number, raw: string) => {
    keys.set(name, [...(keys.get(name) ?? []), { s, file, line: no, text: raw.trim() }]);
  };
  const indentOf = (l: string) => l.length - l.trimStart().length;
  for (let i = from; i < to; i++) {
    const raw = lines[i];
    if (comment.test(raw) || raw.trim() === '') continue;
    const m = /^(\s*)matrix\s*:\s*(.*?)\s*$/.exec(raw);
    if (!m) continue;
    const base = m[1].length;
    // Only `strategy.matrix` (or a bare top-level `matrix:`) is a matrix: `outputs: matrix:` is not.
    let parent: string | undefined;
    for (let j = i - 1; j >= from && base > 0; j--) {
      if (comment.test(lines[j]) || lines[j].trim() === '') continue;
      if (indentOf(lines[j]) < base) {
        parent = /^\s*(?:-\s+)*["']?([\w-]+)/.exec(lines[j])?.[1];
        break;
      }
    }
    if (parent !== undefined && parent !== 'strategy') continue;
    const inline = stripYamlComment(m[2]);
    if (inline !== '') {
      const entries = inline.startsWith('{') ? flowEntries(inline) : undefined;
      if (!entries) markDynamic(inline);
      for (const e of entries ?? [])
        for (const s of scalarItems(e.value)) add(e.key, s, i + 1, raw);
      continue;
    }
    let end = i + 1;
    while (
      end < to &&
      (comment.test(lines[end]) || lines[end].trim() === '' || indentOf(lines[end]) > base)
    ) {
      end++;
    }
    collectYamlKeyVals(lines, i + 1, end, comment, add);
    for (let j = i + 1; j < end; j++) {
      if (!comment.test(lines[j]) && /fromJSON\s*\(/i.test(lines[j])) markDynamic(lines[j]);
    }
  }
  return { keys, dynamic };
}

function buildTables(file: string, text: string, script: boolean): Tables {
  const keyVals = new Map<string, Part[]>();
  const opaque = new Map<string, Source>();
  const inputDefaults = new Map<string, Part[]>();
  const add = (m: Map<string, Part[]>, k: string, s: string, no: number, raw: string) => {
    const part: Part = { s, file, line: no, text: raw.trim() };
    m.set(k, [...(m.get(k) ?? []), part]);
  };
  const comment = commentLine(script);
  const lines = text.split('\n');
  const js = /\.(?:mjs|cjs|js|ts)$/.test(file);
  lines.forEach((raw, i) => {
    if (comment.test(raw) || raw.trim() === '') return;
    const no = i + 1;
    for (const m of raw.matchAll(SHELL_ASSIGN)) {
      add(keyVals, m[1], m[2] ?? m[3] ?? m[4] ?? '', no, raw);
    }
    if (js) return;
    for (const m of raw.matchAll(JS_ASSIGN)) {
      add(keyVals, m[1], m[2] ?? m[3] ?? m[4] ?? '', no, raw);
    }
  });
  if (js) {
    // Every assignment to a name, keyword or not: the union is judged. One that is not a
    // single string literal (a call, `+=`, `'15.0.' + patch`, a value on the next line)
    // leaves the name with no literal to judge, which is a failure when it is read.
    for (const st of jsStatements(text)) {
      for (const m of st.text.matchAll(JS_ANY_ASSIGN)) {
        const rhs = JS_STRING_RHS.exec(st.text.slice((m.index as number) + m[0].length));
        if (m[2] === undefined && rhs) {
          add(keyVals, m[1], rhs[1] ?? rhs[2] ?? rhs[3] ?? '', st.no, st.raw);
        } else if (!opaque.has(m[1])) {
          opaque.set(m[1], { file, line: st.no, text: st.raw.trim() });
        }
      }
    }
  }
  if (!script) {
    collectYamlKeyVals(lines, 0, lines.length, comment, (name, s, no, raw) =>
      add(keyVals, name, s, no, raw),
    );
  }
  // `inputs:` → each direct child is an input; its `default:` is the in-tree value.
  lines.forEach((raw, i) => {
    if (script) return;
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
        cur = /^([\w-]+)\s*:/.exec(l.trimStart())?.[1];
        grand = undefined;
      } else if (cur) {
        grand ??= ind;
        const d = /^default\s*:\s*(.*?)\s*$/.exec(l.trimStart());
        if (d && ind === grand) {
          for (const s of scalarItems(d[1])) add(inputDefaults, cur, s, j + 1, l);
        }
      }
    }
  });
  const heads = script ? [] : parseJobs(lines, comment);
  const jobs: JobScope[] = heads.map((h) => ({
    ...h,
    text: lines
      .slice(h.from - 1, h.to)
      .filter((l) => !comment.test(l))
      .join('\n'),
    matrix: matrixOf(file, lines, h.from - 1, h.to, comment),
  }));
  const matrix =
    heads.length > 0 || script
      ? { keys: new Map<string, Part[]>() }
      : matrixOf(file, lines, 0, lines.length, comment);
  return {
    id: file,
    keyVals,
    opaque,
    inputDefaults,
    ticks: !/\.(?:mjs|cjs|js|ts)$/.test(file),
    matrix,
    jobs,
  };
}

/** The tables as the job containing 1-based line `no` sees them (its own matrix). */
function tablesAt(t: Tables, no: number): Tables {
  const job = t.jobs.find((j) => j.from <= no && no <= j.to);
  return job ? { ...t, matrix: job.matrix } : t;
}

/** A caller's tables and options: where a `with:` value written in the caller is resolved. */
type Ctx = { tables: Tables; opts: ScanOpts };

/** Keyed under this name in `inputWith`: a `with:` the scan could not read. */
const UNPARSED_WITH = '\u0000unparsed-with';

type Resolution = { alts: Alt[]; unresolved: string[] };

function cartesian(options: Alt[][]): Alt[] {
  let acc: Alt[] = [[]];
  for (const opt of options) {
    acc = acc.flatMap((a) => opt.map((o) => [...a, ...o])).slice(0, MAX_ALTS);
  }
  return acc;
}

/** A reference or command substitution inside a text, with where it sits. */
type Span = { text: string; index: number };
/** A command substitution computes its value at run time: there is no literal to judge. */
const isCommand = (sp: Span): boolean => sp.text.startsWith('$(') || sp.text.startsWith('`');
// Balanced to three levels; a lone `$(` is still a command substitution (it never reads as a variable).
const CMD_SUB = String.raw`\$\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*\)|\$\(`;
const SPAN_RE = new RegExp(`${REF_SPAN.source}|${CMD_SUB}`, 'g');
const SPAN_TICKS_RE = new RegExp(`${REF_SPAN.source}|${CMD_SUB}|\`[^\`]*\``, 'g');

function spansOf(s: string, ticks: boolean): Span[] {
  return [...s.matchAll(ticks ? SPAN_TICKS_RE : SPAN_RE)].map((m) => ({
    text: m[0],
    index: m.index as number,
  }));
}

/** Expand the refs inside one literal piece of text written at `origin`. */
function expandText(
  s: string,
  origin: Source,
  t: Tables,
  opts: ScanOpts,
  seen: string[],
): Resolution {
  const spans = spansOf(s, t.ticks);
  if (spans.length === 0) return { alts: [[piece(s, origin)]], unresolved: [] };
  const unresolved: string[] = [];
  const options: Alt[][] = [];
  let at = 0;
  for (const sp of spans) {
    options.push([[piece(s.slice(at, sp.index), origin)]]);
    const r = resolveSpan(sp.text, origin, t, opts, seen);
    unresolved.push(...r.unresolved);
    options.push(r.alts.length ? r.alts : [[]]);
    at = sp.index + sp.text.length;
  }
  options.push([[piece(s.slice(at), origin)]]);
  return { alts: cartesian(options), unresolved };
}

/** The versions the dynamic matrix of this scope is known to emit: only from a job that runs a registered emitter. */
function emittedFor(t: Tables, opts: ScanOpts): string[] {
  if (!t.matrix.dynamic) return [];
  const out = [...(opts.matrixVersions ?? [])];
  for (const id of t.matrix.dynamic) {
    const job = t.jobs.find((j) => j.id === id);
    for (const [script, versions] of Object.entries(opts.matrixEmitters ?? {})) {
      if (job?.text.includes(script)) out.push(...versions);
    }
  }
  return out;
}

function resolveName(
  kind: 'inputs' | 'env' | 'matrix',
  name: string,
  t: Tables,
  opts: ScanOpts,
  seen: string[],
): Resolution {
  const key = `${kind}.${name}`;
  const scoped = `${t.id}:${key}`;
  if (seen.includes(scoped) || seen.length >= MAX_DEPTH) {
    return { alts: [], unresolved: [`${key} (reference cycle or too deep)`] };
  }
  const trail = [...seen, scoped];
  const out: Resolution = { alts: [], unresolved: [] };
  const sources: { part: Part; ctx?: Ctx }[] = [];
  const computed = kind === 'env' ? t.opaque.get(name) : undefined;
  if (computed) {
    out.unresolved.push(
      `${key} (assigned a value that is not one string literal at ${computed.file}:${computed.line})`,
    );
  }
  if (kind === 'inputs') {
    for (const part of t.inputDefaults.get(name) ?? []) sources.push({ part });
    for (const w of opts.inputWith?.[name] ?? []) {
      sources.push({ part: { s: w.value, file: w.file, line: w.line, text: w.text }, ctx: w.ctx });
    }
    for (const u of opts.inputWith?.[UNPARSED_WITH] ?? []) {
      out.unresolved.push(`${key} (the with: at ${u.file}:${u.line} is not parseable)`);
    }
  } else if (kind === 'matrix') {
    for (const part of t.matrix.keys.get(name) ?? []) sources.push({ part });
    for (const v of emittedFor(t, opts)) {
      sources.push({
        part: { s: v, file: '(dynamic matrix)', line: 0, text: `matrix emits ${v}` },
      });
    }
  } else {
    for (const part of t.keyVals.get(name) ?? []) sources.push({ part });
  }
  if (sources.length === 0) {
    if (!computed) {
      out.unresolved.push(
        kind === 'inputs' ? `${key} (no default, and no caller value is visible)` : key,
      );
    }
    return out;
  }
  for (const { part, ctx } of sources) {
    if (OPAQUE_YAML_VALUE.test(part.s.trim())) {
      // An alias, anchor or tag names a value written elsewhere: there is no literal here to judge.
      out.unresolved.push(`${key} (an alias, anchor or tag at ${part.file}:${part.line})`);
      continue;
    }
    const r = expandText(part.s, part, ctx?.tables ?? t, ctx?.opts ?? opts, trail);
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
  if (span.startsWith('$(') || span.startsWith('`')) {
    return { alts: [], unresolved: [`${span} (computed by a command)`] };
  }
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

/** Characters that continue a version token (a reference inside it is part of the same spec). */
const TOKEN_CHAR = /[\w.\-+*#%]/;

/**
 * The extent of the version token a span sits in: back over the literal text and
 * spans written directly against it, and forward the same way. `next@16.$MINOR.$PATCH`
 * is one token with two spans, and the pieces only spell a version together.
 */
function tokenBounds(s: string, spans: Span[], k: number): [number, number] {
  let a = spans[k].index;
  let b = a + spans[k].text.length;
  for (;;) {
    const prev = spans.find((sp) => sp.index + sp.text.length === a);
    if (prev) a = prev.index;
    else if (a > 0 && TOKEN_CHAR.test(s[a - 1])) a--;
    else break;
  }
  for (;;) {
    const next = spans.find((sp) => sp.index === b);
    if (next) b = next.index + next.text.length;
    else if (b < s.length && TOKEN_CHAR.test(s[b])) b++;
    else break;
  }
  return [a, b];
}

/** The names a span reads: `inputs.fw`, `NEXTJS_REF`. A command substitution reads none. */
function spanNames(sp: Span): string[] {
  if (isCommand(sp)) return [];
  return sp.text.startsWith('${{')
    ? [...sp.text.matchAll(EXPR_OPERAND)].map((o) => o[0])
    : [/^\$\{?([A-Za-z_]\w*)/.exec(sp.text)?.[1] ?? sp.text];
}

/** A string literal followed by `+`: the head of a JS concatenation. */
const CONCAT_HEAD = /(["'`])((?:(?!\1)[^\\\n])*?)\1\s*\+\s*/g;
/** One operand of a concatenation: a string, a number, or an identifier with optional member / call / index tails. */
const CONCAT_OPERAND =
  /\s*(?:"((?:[^"\\]|\\.)*)"|'((?:[^'\\]|\\.)*)'|`([^`]*)`|(\d+(?:\.\d+)*)|([A-Za-z_$][\w$]*(?:\s*(?:\.[A-Za-z_$][\w$]*|\[[^\]]*\]|\([^)]*\)))*))/y;

/** `NEXT_VERSION: *v`, also inside `{ ..., NEXT_VERSION: *v }`: an alias, which names a value written elsewhere. */
const ALIAS_BINDING = /(?:^\s*(?:-\s+)*|[{,]\s*)["']?([\w.-]+)["']?\s*:\s*(\*[^\s,}\]]*)/g;
/** The packages whose `@X` is next's version: the one named `next`, and its scaffolder. */
const NEXT_PACKAGE_NAME = /^(?:next|create-next-app)$/i;

/** Pins reached through a reference that sits in a next version position. */
function indirectPins(file: string, text: string, opts: ScanOpts): WorkflowPin[] {
  const script = isScriptFile(file);
  const js = script && !/\.(?:sh|bash)$/.test(file);
  const entries = nextLineEntries(text, script);
  const fileTables = buildTables(file, text, script);
  const pins: WorkflowPin[] = [];
  const unresolvedPin = (no: number, raw: string, what: string) =>
    pins.push({
      file,
      line: no,
      version: what,
      parseable: false,
      unresolved: true,
      text: raw.trim(),
    });
  /** Judge what one resolved token spells, between the text before it and after it. */
  const judgeAt =
    (no: number, raw: string) =>
    (r: Resolution, lead: string, rest: string): void => {
      for (const u of r.unresolved) unresolvedPin(no, raw, u);
      const origin: Source = { file, line: no, text: raw.trim() };
      for (const alt of r.alts) {
        const value = alt.map((p) => p.s).join('');
        for (const p of lineTokens(file, no, mask(lead) + value + mask(rest))) {
          // Attribute the token to the line that WROTE it, so an exclusion on that
          // line (not on every line that merely reads it) is what excuses it.
          const src = alt.find((part) => part.s.includes(p.version)) ?? alt[0] ?? origin;
          pins.push({ ...p, file: src.file, line: src.line, text: src.text, via: `${file}:${no}` });
        }
      }
    };
  for (const { no, raw, blockChild } of entries) {
    const tables = tablesAt(fileTables, no);
    const scanned = preprocess(raw);
    const origin: Source = { file, line: no, text: raw.trim() };
    const judge = judgeAt(no, raw);
    if (!script) {
      for (const b of scanned.matchAll(ALIAS_BINDING)) {
        if (holdsNextVersion(b[1])) {
          unresolvedPin(no, raw, `${b[1]}: ${b[2]} (an alias names a value written elsewhere)`);
        }
      }
    }
    const spans = spansOf(scanned, fileTables.ticks);
    const seenSpans = new Set<number>();
    spans.forEach((_sp, k) => {
      if (seenSpans.has(k)) return;
      const [a, b] = tokenBounds(scanned, spans, k);
      const inToken = spans.filter((s2) => s2.index >= a && s2.index + s2.text.length <= b);
      for (const s2 of inToken) seenSpans.add(spans.indexOf(s2));
      const lead = scanned.slice(0, a);
      // By name too, in YAML: `ref: ${{ env.NEXTJS_REF }}`. Not in a script, where a
      // JS variable called `next` is an iterator and `nextjsRef=${nextjsRef}` a log line.
      const inPosition =
        blockChild ||
        versionPositionPrefix(lead, script) ||
        (!script && inToken.some((s2) => spanNames(s2).some(holdsNextVersion)));
      if (!inPosition) return;
      judge(expandText(scanned.slice(a, b), origin, tables, opts, []), lead, scanned.slice(b));
    });
  }
  if (js) concatPins(file, text, fileTables, opts, judgeAt);
  packageNamePins(file, text, fileTables, opts, script, judgeAt);
  return pins;
}

type JudgeAt = (no: number, raw: string) => (r: Resolution, lead: string, rest: string) => void;

/**
 * `run('npm i next@' + v)`: a string that ends where the version goes, and the `+`
 * operands that follow spell it. The statement may span lines, and the head may be a
 * variable that holds such a string (`const p = 'next@'; ... p + v`).
 */
function concatPins(
  file: string,
  text: string,
  fileTables: Tables,
  opts: ScanOpts,
  judgeAt: JudgeAt,
): void {
  const prefixVars = new Map<string, string[]>();
  for (const [name, parts] of fileTables.keyVals) {
    const prefixes = parts.map((p) => p.s).filter((s) => versionPositionPrefix(s, true));
    if (prefixes.length) prefixVars.set(name, prefixes);
  }
  const prefixHead = prefixVars.size
    ? new RegExp(
        String.raw`(?<![\w$.])(${[...prefixVars.keys()].map((n) => n.replace(/\$/g, '\\$')).join('|')})(?![\w$])\s*\+\s*`,
        'g',
      )
    : undefined;
  for (const st of jsStatements(text)) {
    const tables = tablesAt(fileTables, st.no);
    const scanned = preprocess(st.text);
    const origin: Source = { file, line: st.no, text: st.raw.trim() };
    const heads: { lead: string; end: number }[] = [];
    for (const h of scanned.matchAll(CONCAT_HEAD)) {
      if (versionPositionPrefix(h[2], true)) {
        heads.push({ lead: h[2], end: (h.index as number) + h[0].length });
      }
    }
    for (const h of prefixHead ? scanned.matchAll(prefixHead) : []) {
      for (const lead of prefixVars.get(h[1]) ?? []) {
        heads.push({ lead, end: (h.index as number) + h[0].length });
      }
    }
    for (const head of heads) {
      const options: Alt[][] = [];
      const unresolved: string[] = [];
      let at = head.end;
      for (;;) {
        CONCAT_OPERAND.lastIndex = at;
        const op = CONCAT_OPERAND.exec(scanned);
        if (!op) {
          unresolved.push(`${scanned.slice(at).trim() || '(nothing)'} (a concatenated operand)`);
          break;
        }
        const literal = op[1] ?? op[2] ?? op[3] ?? op[4];
        if (literal !== undefined) {
          const r = expandText(literal, origin, tables, opts, []);
          unresolved.push(...r.unresolved);
          options.push(r.alts);
        } else if (/^[A-Za-z_$][\w$]*$/.test(op[5])) {
          const r = resolveName('env', op[5], tables, opts, []);
          unresolved.push(...r.unresolved);
          options.push(r.alts.length ? r.alts : [[]]);
        } else {
          unresolved.push(`${op[5]} (a concatenated operand)`);
        }
        at = (op.index as number) + op[0].length;
        const more = /^\s*\+\s*/.exec(scanned.slice(at));
        if (!more) break;
        at += more[0].length;
      }
      judgeAt(st.no, st.raw)({ alts: cartesian(options), unresolved }, head.lead, '');
    }
  }
}

/**
 * `${{ env.P }}@15.0.0`, `$P@15.0.0`: the PACKAGE NAME is a reference, and the version
 * after the `@` is next's when that reference spells `next`. Every reference that is
 * written directly against an `@` followed by a version is read, on any line - a name
 * that cannot be resolved is a failure, since it may well be `next`.
 */
function packageNamePins(
  file: string,
  text: string,
  fileTables: Tables,
  opts: ScanOpts,
  script: boolean,
  judgeAt: JudgeAt,
): void {
  const comment = commentLine(script);
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (comment.test(raw) || raw.trim() === '') continue;
    const no = i + 1;
    const scanned = preprocess(raw);
    const spans = spansOf(scanned, fileTables.ticks);
    if (spans.length === 0) continue;
    const tables = tablesAt(fileTables, no);
    const origin: Source = { file, line: no, text: raw.trim() };
    const judge = judgeAt(no, raw);
    const seen = new Set<number>();
    spans.forEach((_sp, k) => {
      const [a, b] = tokenBounds(scanned, spans, k);
      if (scanned[b] !== '@' || seen.has(a)) return;
      seen.add(a);
      const deco = /^[~^<>=v]*/.exec(scanned.slice(b + 1))?.[0] ?? '';
      const from = b + 1 + deco.length;
      let to = from;
      for (;;) {
        const nx = spans.find((sp) => sp.index === to);
        if (nx) to = nx.index + nx.text.length;
        else if (to < scanned.length && TOKEN_CHAR.test(scanned[to])) to++;
        else break;
      }
      const tail = scanned.slice(from, to);
      if (tail === '') return;
      const name = expandText(scanned.slice(a, b), origin, tables, opts, []);
      const digitTail = /^\d/.test(tail);
      // `user@${{ env.HOST }}` is an address, not a spec: only a version-looking tail
      // makes an UNRESOLVED name a failure.
      if (name.unresolved.length && digitTail)
        judge({ alts: [], unresolved: name.unresolved }, '', '');
      const isNext = name.alts.some((alt) =>
        NEXT_PACKAGE_NAME.test(
          alt
            .map((p) => p.s)
            .join('')
            .trim(),
        ),
      );
      if (isNext)
        judge(expandText(tail, origin, tables, opts, []), `next@${deco}`, scanned.slice(to));
    });
  }
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

/** What every registered matrix source prints, run once. */
let emittedCache: Record<string, string[]> | undefined;
const MATRIX_EMITTED = (): Record<string, string[]> =>
  (emittedCache ??= Object.fromEntries(
    Object.entries(MATRIX_EMITTERS).map(([script, emit]) => [script, emit()]),
  ));

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

/** The text of a YAML scalar line minus a trailing ` # comment` (quotes are not parsed: values here are versions). */
const stripYamlComment = (v: string): string => v.replace(/\s+#.*$/, '').trim();

/** Does `value` start with an alias, anchor or tag? None of them can be followed to a literal here. */
const OPAQUE_YAML_VALUE = /^[*&!]/;

/**
 * What every `uses: ./.github/actions/<dir>` step passes through `with:`, by input
 * name, with the CALLER's own tables so a value such as `${{ env.FW }}` or
 * `${{ matrix.next }}` is resolved where it was written, not in the callee.
 *
 * Every shape of `with:` is either parsed or recorded under UNPARSED_WITH, which
 * makes every input of the action unresolvable: a caller this cannot read is a
 * caller it cannot judge, never a caller that passed nothing. Parsed: a block
 * mapping (plain, `"quoted"` or `'quoted'` keys), an inline flow mapping
 * `{ k: v, ... }`, `with:` written before `uses:`, and a flow-style step
 * `- { uses: ..., with: { ... } }`. Everything else (an alias, a merge key, an
 * explicit `? key`, a block-scalar or next-line value, an expression for the
 * whole map, a flow mapping that spans lines) is unparsed.
 */
function actionCallerInputs(
  dir: string,
  yamls: YamlFile[],
  optsOf: (file: string) => ScanOpts,
): NonNullable<ScanOpts['inputWith']> {
  const out: NonNullable<ScanOpts['inputWith']> = {};
  const path = `./${dir}`;
  const esc = path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const strict = new RegExp(`\\buses:\\s*["']?${esc}/?["']?\\s*(?:#.*)?$`);
  // The action's path as a whole word, in any position of a line that says `uses`.
  const mentions = new RegExp(`${esc}/?(?=["'\\s,}#]|$)`);
  for (const { file, text } of yamls) {
    const lines = text.split('\n');
    const base = buildTables(file, text, false);
    const caller = (no: number): Ctx => ({ tables: tablesAt(base, no), opts: optsOf(file) });
    const give = (key: string, value: string, no: number, shown: string) => {
      for (const v of scalarItems(value)) {
        out[key] = [
          ...(out[key] ?? []),
          { value: v, file, line: no, text: shown.trim(), ctx: caller(no) },
        ];
      }
    };
    const unparsed = (no: number, shown: string) => {
      out[UNPARSED_WITH] = [
        ...(out[UNPARSED_WITH] ?? []),
        { value: '', file, line: no, text: shown.trim() },
      ];
    };
    const giveEntries = (value: string, no: number, shown: string) => {
      const entries = flowEntries(value);
      if (!entries || entries.some((e) => OPAQUE_YAML_VALUE.test(e.value))) {
        unparsed(no, shown);
        return;
      }
      for (const e of entries) give(e.key, e.value, no, shown);
    };
    lines.forEach((raw, i) => {
      if (/^\s*#/.test(raw) || !/\buses\b/.test(raw)) return;
      if (!mentions.test(raw)) {
        // The same action spelled some other way (`./a/../b`, `././b`): a caller this
        // cannot match to the action is a caller it cannot judge.
        if (localUses(raw).some((u) => u.dir === dir)) unparsed(i + 1, raw);
        return;
      }
      if (!strict.test(raw)) {
        // Not the plain `uses: ./dir` spelling: a flow-style step is parsed, anything else fails closed.
        const flow = /^\s*(?:-\s+)?(\{.*\})\s*(?:#.*)?$/.exec(raw);
        const entries = flow ? flowEntries(flow[1]) : undefined;
        const mine = entries?.find(
          (e) => e.key === 'uses' && unquote(e.value).replace(/\/$/, '') === path,
        );
        if (!entries || !mine) {
          unparsed(i + 1, raw);
          return;
        }
        const w = entries.find((e) => e.key === 'with');
        if (w) giveEntries(w.value, i + 1, raw);
        return;
      }
      const col = raw.indexOf('uses:');
      const indentOf = (l: string) => l.length - l.trimStart().length;
      const blank = (l: string) => l.trim() === '' || /^\s*#/.test(l);
      // The step: from its `- ` line (which may be this one) to the next line at a shallower indent.
      let start = i;
      if (!/^\s*-\s+uses:/.test(raw)) {
        for (let j = i - 1; j >= 0; j--) {
          if (blank(lines[j])) continue;
          if (indentOf(lines[j]) < col) {
            start = j;
            break;
          }
        }
      }
      let end = i + 1;
      while (end < lines.length && (blank(lines[end]) || indentOf(lines[end]) >= col)) end++;
      for (let k = start; k < end; k++) {
        // On the `- ` line the first key sits after the dash.
        const dash = /^(\s*-\s+)(.*)$/.exec(lines[k]);
        const keyCol = dash && k === start ? dash[1].length : indentOf(lines[k]);
        const body = dash && k === start ? dash[2] : lines[k].trimStart();
        const w = /^["']?with["']?\s*:\s*(.*?)\s*$/.exec(body);
        if (keyCol !== col || !w) continue;
        const inline = stripYamlComment(w[1]);
        if (inline.startsWith('{')) {
          giveEntries(inline, k + 1, lines[k]);
        } else if (inline !== '') {
          unparsed(k + 1, lines[k]);
        } else {
          let child: number | undefined;
          for (let j = k + 1; j < end; j++) {
            if (blank(lines[j])) continue;
            const ind = indentOf(lines[j]);
            if (ind <= col) break;
            child ??= ind;
            const kv =
              ind === child
                ? /^(?:"([^"]+)"|'([^']+)'|([\w-]+))\s*:\s*(.*?)\s*$/.exec(lines[j].trimStart())
                : null;
            const v = kv ? stripYamlComment(kv[4]) : '';
            // `key:` with nothing after it, a block scalar, an alias or a deeper line is a value
            // this cannot read as one scalar.
            if (!kv || v === '' || /^[|>][+-]?\d*$/.test(v) || OPAQUE_YAML_VALUE.test(v)) {
              unparsed(j + 1, lines[j]);
              continue;
            }
            give(kv[1] ?? kv[2] ?? kv[3], v, j + 1, lines[j]);
          }
        }
        break;
      }
    });
  }
  return out;
}

type YamlFile = { file: string; text: string };

/**
 * The scan targets of a set of workflow / composite-action files: each one's own
 * tables plus, for an action, what its callers pass through `with:`.
 */
function yamlTargets(yamls: YamlFile[], emitters = MATRIX_EMITTED()): ScanTarget[] {
  const targets: ScanTarget[] = yamls.map(({ file, text }) => ({
    file,
    text,
    opts: /\bfromJSON\s*\(/i.test(text) ? { matrixEmitters: emitters } : {},
  }));
  const optsOf = (file: string): ScanOpts => targets.find((t) => t.file === file)?.opts ?? {};
  for (const t of targets) {
    if (/^.+\/action\.ya?ml$/.test(t.file)) {
      t.opts.inputWith = actionCallerInputs(t.file.replace(/\/action\.ya?ml$/, ''), yamls, optsOf);
    }
  }
  return targets;
}
/**
 * Everything the indirection scan covers, DISCOVERED (never enumerated): every
 * workflow, every composite action under `.github/actions/**` (with the `with:`
 * values its callers pass), and every script those name.
 */
/** `uses: ./path` (the path may be quoted): a step or job that runs something from this checkout. */
const LOCAL_USES = /(?<![\w-])["']?uses["']?\s*:\s*["']?(\.(?:\/[^\s"'#,}]*)?)(?=["'\s,}#]|$)/g;
/** The local paths one line of YAML runs, as written and as a normalised checkout-relative dir (`.` = the root). */
function localUses(raw: string): { written: string; dir: string }[] {
  return [...raw.matchAll(LOCAL_USES)].map((m) => ({
    written: m[1],
    dir: posix.normalize(m[1]).replace(/(.)\/$/, '$1'),
  }));
}
/**
 * The workflows and composite actions to scan, DISCOVERED: every workflow, every
 * action under `.github/actions/**`, and every action a `uses: ./<path>` line names
 * wherever it lives (`packages/kn-next-action`). A local `uses:` path with no tracked
 * `action.yml` to read is reported in `unscanned`, never skipped.
 */
function gatherYamls(
  tracked: string[],
  read: (f: string) => string,
): { yamls: YamlFile[]; unscanned: string[] } {
  const trackedSet = new Set(tracked);
  const workflows = tracked.filter((f) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(f));
  const actions = tracked.filter((f) => /^\.github\/actions\/.+\/action\.ya?ml$/.test(f));
  const yamls = [...workflows, ...actions].map((file) => ({ file, text: read(file) }));
  const have = new Set(yamls.map((y) => y.file));
  const unscanned: string[] = [];
  // `yamls` grows as actions are found: an action reached only through another is read too.
  for (let n = 0; n < yamls.length; n++) {
    const { file, text } = yamls[n];
    text.split('\n').forEach((raw, i) => {
      if (/^\s*#/.test(raw)) return;
      for (const { written, dir } of localUses(raw)) {
        if (have.has(dir)) continue; // a reusable workflow, already scanned
        const root = dir === '.' || dir.startsWith('..');
        const found = root
          ? undefined
          : [`${dir}/action.yml`, `${dir}/action.yaml`].find((f) => trackedSet.has(f));
        if (found) {
          if (!have.has(found)) {
            have.add(found);
            yamls.push({ file: found, text: read(found) });
          }
          continue;
        }
        unscanned.push(
          `${file}:${i + 1}: uses: ${written} (a local path with no tracked action to scan)`,
        );
      }
    });
  }
  return { yamls, unscanned: [...new Set(unscanned)] };
}
function scanTargets(): ScanTarget[] {
  const tracked = trackedFiles();
  const trackedSet = new Set(tracked);
  const read = (f: string) => readFileSync(resolve(REPO_ROOT, f), 'utf8');
  const { yamls } = gatherYamls(tracked, read);
  const targets = yamlTargets(yamls);
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
    // The expected version is read from the workflow's own NEXTJS_REF fallback, not
    // hardcoded: the harness moves (#2626 moved it to 16.4.3), and a literal here
    // would turn every harness move into a red guard for the wrong reason.
    const nextjsRefFallback = readFileSync(
      resolve(REPO_ROOT, '.github/workflows/test-e2e-deploy.yml'),
      'utf8',
    ).match(/NEXTJS_REF: \$\{\{ github\.event\.inputs\.nextjsRef \|\| 'v(\d+\.\d+\.\d+)' \}\}/);
    expect(nextjsRefFallback, 'no NEXTJS_REF fallback to derive the version from').not.toBeNull();
    const harnessVersion = (nextjsRefFallback as RegExpMatchArray)[1];
    expect(e2e.some((p) => p.version === harnessVersion && p.text.startsWith('NEXTJS_REF:'))).toBe(
      true,
    );
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
/**
 * #2630 round 2: shapes of indirection that went through the first resolver
 * unjudged. Each case is its own `it` so a mutation that drops one detector reds
 * exactly that case.
 */
describe('#2630 — indirection the first resolver let through', () => {
  const flagged = (file: string, text: string, opts: ScanOpts = {}) =>
    workflowFlags(file, fx(text), [], opts);
  /** Run the whole-tree path (composite action callers included) over in-memory files. */
  const scanFiles = (files: Record<string, string>): string[] =>
    yamlTargets(Object.entries(files).map(([file, text]) => ({ file, text: fx(text) }))).flatMap(
      (t) => workflowFlags(t.file, t.text, [], t.opts),
    );
  const step = (run: string) => `jobs:\n  b:\n    steps:\n      - run: ${run}`;

  describe('1. a command substitution inside a version-position span', () => {
    for (const [name, use] of [
      ['$(...) straight after next@', 'npm install next@$(cat .nextver)'],
      ['$(...) in a quoted spec', 'npm install "next@$(cat .nextver)"'],
      ['$(...) after a v prefix', 'npm install "next@v$(cat .nextver)"'],
      ['$(...) after a range operator', 'npm install "next@^$(cat .nextver)"'],
      ['$(...) inside the version', 'npm install next@16.$(cat .minor).0'],
      ['$(...) in an npm pkg set', 'npm pkg set "dependencies.next=$(cat .nextver)"'],
      ['backticks straight after next@', 'npm install next@`cat .nextver`'],
      ['backticks inside the version', 'npm install next@16.`cat .minor`.0'],
      ['a nested $(...)', 'npm install next@$(echo $(cat .nextver))'],
    ] as const) {
      it(`fails ${name}`, () => {
        const out = flagged('x.yml', step(use));
        expect(out.length, use).toBeGreaterThan(0);
        expect(out.join('\n'), use).toContain('unresolvable');
      });
    }

    it('fails a command substitution assigned to a next-named env key or shell variable', () => {
      expect(flagged('x.yml', 'env:\n  NEXT_VERSION: $(cat .nextver)').join('\n')).toContain(
        'unresolvable',
      );
      expect(flagged('scripts/x.sh', 'NEXT_VER=$(cat .nextver)').join('\n')).toContain(
        'unresolvable',
      );
      expect(flagged('scripts/x.sh', 'bun add next@`cat f`').join('\n')).toContain('unresolvable');
    });

    it('fails a command substitution in a value that a version position reads', () => {
      const text =
        'env:\n  FW: 16.$(cat .minor).0\njobs:\n  b:\n    steps:\n      - run: bun add next@$FW';
      expect(flagged('x.yml', text).join('\n')).toContain('unresolvable');
    });

    it('does not take a command substitution outside a version position for a pin', () => {
      for (const use of [
        'echo "next is $(cat .nextver)"',
        'echo "run `bun add next@16.4.3` first"',
        'echo "kn-next@$(cat v) built"',
        'docker run kn-next-operator:v$(cat v)',
      ]) {
        expect(flagged('x.yml', step(use)), use).toEqual([]);
      }
    });

    it('does not treat a JS template literal as a command substitution', () => {
      expect(flagged('scripts/x.mjs', "const v = '16.4.3';\nrun(`bun add next@@{v}`);")).toEqual(
        [],
      );
    });
  });

  describe('2. an input with no default', () => {
    const wf = (decl: string) =>
      [
        'on:',
        '  workflow_dispatch:',
        '    inputs:',
        '      fw:',
        ...decl.split('\n').map((l) => `        ${l}`),
        'jobs:',
        '  b:',
        '    steps:',
        '      - run: bun add "next@@{{ inputs.fw }}"',
      ].join('\n');
    for (const [name, decl] of [
      ['description only', 'description: the framework'],
      ['required and typed', 'required: true\ntype: string'],
      ['a choice', 'type: choice\noptions:\n  - 16.3.8\n  - 16.4.3'],
    ] as const) {
      it(`fails an input with ${name} and no default`, () => {
        const out = flagged('x.yml', wf(decl));
        expect(out.length).toBeGreaterThan(0);
        expect(out.join('\n')).toContain('unresolvable');
        expect(out.join('\n')).toContain('inputs.fw');
      });
    }
    it('still resolves an input that has a default', () => {
      expect(flagged('x.yml', wf("description: d\ndefault: '16.4.3'"))).toEqual([]);
      expect(flagged('x.yml', wf("description: d\ndefault: '16.3.8'")).length).toBeGreaterThan(0);
    });
    it('still fails an input that is never declared', () => {
      expect(flagged('x.yml', step('bun add "next@@{{ inputs.fw }}"')).join('\n')).toContain(
        'unresolvable',
      );
    });
  });

  describe('3. a matrix belongs to its job', () => {
    const two = (aMatrix: string, bMatrix: string) =>
      [
        'jobs:',
        '  a:',
        '    strategy:',
        `      matrix: ${aMatrix}`,
        '    steps:',
        '      - run: bun add "next@@{{ matrix.fw }}"',
        '  b:',
        '    needs: g',
        '    strategy:',
        `      matrix: ${bMatrix}`,
        '    steps:',
        '      - run: bun add "next@@{{ matrix.fw }}"',
      ].join('\n');
    const dyn = '@{{ fromJSON(needs.g.outputs.m) }}';

    it("a static matrix in job A does not satisfy job B's unregistered fromJSON matrix", () => {
      const out = flagged('x.yml', two('\n        fw: [16.4.1]', dyn));
      expect(out.length).toBeGreaterThan(0);
      expect(out.join('\n')).toContain('unresolvable');
      expect(out.join('\n')).toContain('matrix.fw');
    });

    it("job A's vulnerable values are not read by job B, and vice versa", () => {
      const out = flagged('x.yml', two('\n        fw: [16.3.8]', '\n        fw: [16.4.3]'));
      expect(out.length).toBeGreaterThan(0);
      for (const line of out) expect(line, line).toContain('16.3.8');
      // only job A's read (line 7) is flagged; job B's read (line 14) sees only B's matrix
      expect(out.join('\n')).toContain('read at x.yml:7');
      expect(out.join('\n')).not.toContain('x.yml:14');
      expect(flagged('x.yml', two('\n        fw: [16.4.3]', '\n        fw: [16.4.3]'))).toEqual([]);
    });

    it("job B's own vulnerable values are judged at the read in job B", () => {
      const out = flagged('x.yml', two('\n        fw: [16.4.3]', '\n        fw: [16.3.8]'));
      expect(out.length).toBeGreaterThan(0);
    });

    it('a job without any matrix cannot read matrix.X', () => {
      const text = [
        'jobs:',
        '  a:',
        '    strategy:',
        '      matrix:',
        '        fw: [16.4.3]',
        '    steps:',
        '      - run: echo hi',
        '  b:',
        '    steps:',
        '      - run: bun add "next@@{{ matrix.fw }}"',
      ].join('\n');
      expect(flagged('x.yml', text).join('\n')).toContain('unresolvable');
    });

    it('a matrix key set in env does not stand in for a matrix key', () => {
      const text = [
        'env:',
        '  ver: 16.4.3',
        'jobs:',
        '  b:',
        '    steps:',
        '      - run: bun add "next@@{{ matrix.ver }}"',
      ].join('\n');
      expect(flagged('x.yml', text).join('\n')).toContain('unresolvable');
    });

    it('resolves a dynamic matrix only against the emitter its own needs job runs', () => {
      const text = (needs: string) =>
        [
          'jobs:',
          '  plan:',
          '    steps:',
          '      - run: bun scripts/emit.mjs',
          '  other:',
          '    steps:',
          '      - run: echo hi',
          '  m:',
          `    needs: ${needs}`,
          '    strategy:',
          `      matrix: @{{ fromJSON(needs.${needs}.outputs.m) }}`,
          '    steps:',
          '      - run: bun add "next@@{{ matrix.next }}"',
        ].join('\n');
      const opts = { matrixEmitters: { 'scripts/emit.mjs': ['16.3.8'] } };
      expect(flagged('x.yml', text('plan'), opts).join('\n')).toContain('16.3.8');
      expect(
        flagged('x.yml', text('plan'), { matrixEmitters: { 'scripts/emit.mjs': ['16.4.3'] } }),
      ).toEqual([]);
      expect(flagged('x.yml', text('other'), opts).join('\n')).toContain('unresolvable');
    });
  });

  describe('4. composite-action with: values resolve against the CALLER', () => {
    const ACTION = '.github/actions/a/action.yml';
    const action = [
      'name: a',
      'inputs:',
      '  fw:',
      '    default: 16.4.3',
      'env:',
      '  FW: 16.4.3',
      'runs:',
      '  using: composite',
      '  steps:',
      '    - shell: bash',
      '      run: bun add "next@@{{ inputs.fw }}"',
    ].join('\n');
    const caller = (head: string, withLine: string) =>
      [
        head,
        'jobs:',
        '  c:',
        '    strategy:',
        '      matrix:',
        '        mv: [16.3.8]',
        '    steps:',
        '      - uses: ./.github/actions/a',
        '        with:',
        `          fw: ${withLine}`,
      ].join('\n');

    it("resolves @{{ env.X }} against the caller's env, not the callee's", () => {
      const out = scanFiles({
        [ACTION]: action,
        '.github/workflows/c.yml': caller('env:\n  FW: 16.3.8', '@{{ env.FW }}'),
      });
      expect(out.length).toBeGreaterThan(0);
      expect(out.join('\n')).toContain('16.3.8');
    });

    it("an env value only the callee has does not satisfy the caller's reference", () => {
      const out = scanFiles({
        [ACTION]: action,
        '.github/workflows/c.yml': caller('on: push', '@{{ env.FW }}'),
      });
      expect(out.join('\n')).toContain('unresolvable');
    });

    it("resolves @{{ matrix.X }} against the calling job's matrix", () => {
      const out = scanFiles({
        [ACTION]: action,
        '.github/workflows/c.yml': caller('on: push', '@{{ matrix.mv }}'),
      });
      expect(out.join('\n')).toContain('16.3.8');
    });

    it("resolves @{{ inputs.X }} against the caller's input defaults", () => {
      const head = 'on:\n  workflow_dispatch:\n    inputs:\n      pin:\n        default: 16.3.8';
      const out = scanFiles({
        [ACTION]: action,
        '.github/workflows/c.yml': caller(head, '@{{ inputs.pin }}'),
      });
      expect(out.join('\n')).toContain('16.3.8');
    });

    it('fails a with: value it cannot resolve', () => {
      for (const ref of ['@{{ secrets.NEXT_V }}', '@{{ steps.p.outputs.v }}', '@{{ vars.V }}']) {
        const out = scanFiles({
          [ACTION]: action,
          '.github/workflows/c.yml': caller('on: push', ref),
        });
        expect(out.join('\n'), ref).toContain('unresolvable');
      }
    });

    it('passes when the caller hands over a clear literal or a clear reference', () => {
      expect(
        scanFiles({ [ACTION]: action, '.github/workflows/c.yml': caller('on: push', '16.4.3') }),
      ).toEqual([]);
      expect(
        scanFiles({
          [ACTION]: action,
          '.github/workflows/c.yml': caller('env:\n  FW: 16.4.3', '@{{ env.FW }}'),
        }),
      ).toEqual([]);
    });
  });

  describe('5. every with: shape is parsed or fails closed', () => {
    const ACTION = '.github/actions/a/action.yml';
    const action = [
      'name: a',
      'inputs:',
      '  fw:',
      '    default: 16.4.3',
      'runs:',
      '  using: composite',
      '  steps:',
      '    - shell: bash',
      '      run: bun add "next@@{{ inputs.fw }}"',
    ].join('\n');
    const wf = (stepBody: string) =>
      `jobs:\n  c:\n    steps:\n${stepBody
        .split('\n')
        .map((l) => `      ${l}`)
        .join('\n')}`;
    const scan = (stepBody: string) =>
      scanFiles({ [ACTION]: action, '.github/workflows/c.yml': wf(stepBody) });

    for (const [name, body] of [
      ['a plain key', '- uses: ./.github/actions/a\n  with:\n    fw: 16.3.8'],
      ['a double-quoted key', '- uses: ./.github/actions/a\n  with:\n    "fw": 16.3.8'],
      ['a single-quoted key', "- uses: ./.github/actions/a\n  with:\n    'fw': 16.3.8"],
      ['a quoted value', "- uses: ./.github/actions/a\n  with:\n    fw: '16.3.8'"],
      ['an inline flow mapping', '- uses: ./.github/actions/a\n  with: { fw: 16.3.8 }'],
      [
        'an inline flow mapping, quoted key',
        '- uses: ./.github/actions/a\n  with: { "fw": "16.3.8" }',
      ],
      [
        'an inline flow mapping among other keys',
        '- uses: ./.github/actions/a\n  with: { other: "a, b", fw: 16.3.8, last: x }',
      ],
      ['with: before uses:', '- with:\n    fw: 16.3.8\n  uses: ./.github/actions/a'],
      ['with: before uses: (flow)', '- with: { fw: 16.3.8 }\n  uses: ./.github/actions/a'],
      ['a name: before uses:', '- name: s\n  uses: ./.github/actions/a\n  with:\n    fw: 16.3.8'],
      ['a flow-style step', '- { uses: ./.github/actions/a, with: { fw: 16.3.8 } }'],
      ['a quoted uses', '- uses: "./.github/actions/a"\n  with:\n    fw: 16.3.8'],
    ] as const) {
      it(`reads the value passed through ${name}`, () => {
        const out = scan(body);
        expect(out.length, body).toBeGreaterThan(0);
        expect(out.join('\n'), body).toContain('16.3.8');
      });
    }

    for (const [name, body] of [
      ['an anchor / alias', '- uses: ./.github/actions/a\n  with: *shared'],
      ['a merge key', '- uses: ./.github/actions/a\n  with:\n    <<: *shared'],
      ['a block-scalar value', '- uses: ./.github/actions/a\n  with:\n    fw: |\n      16.3.8'],
      ['a value on the next line', '- uses: ./.github/actions/a\n  with:\n    fw:\n      16.3.8'],
      ['a multi-line flow mapping', '- uses: ./.github/actions/a\n  with: { fw:\n    16.3.8 }'],
      [
        'an expression for the whole map',
        '- uses: ./.github/actions/a\n  with: @{{ fromJSON(env.W) }}',
      ],
      ['a flow entry without a key', '- uses: ./.github/actions/a\n  with: { 16.3.8 }'],
      ['an explicit key', '- uses: ./.github/actions/a\n  with:\n    ? fw\n    : 16.3.8'],
      ['an unparseable flow-style step', '- { uses: ./.github/actions/a, with: *w }'],
    ] as const) {
      it(`fails closed on ${name}`, () => {
        const out = scan(body);
        expect(out.length, body).toBeGreaterThan(0);
        expect(out.join('\n'), body).toContain('unresolvable');
      });
    }

    it('passes a well-formed with: that hands over a clear value', () => {
      for (const body of [
        '- uses: ./.github/actions/a\n  with:\n    fw: 16.4.3',
        '- uses: ./.github/actions/a\n  with: { "fw": 16.4.3 }',
        '- uses: ./.github/actions/a',
        '- uses: ./.github/actions/a\n  with:\n    other: x',
      ]) {
        expect(scan(body), body).toEqual([]);
      }
    });

    it('does not take a path that merely mentions the action for a caller', () => {
      const w =
        "on:\n  push:\n    paths:\n      - '.github/actions/a/**'\njobs:\n  c:\n    steps:\n      - run: echo hi";
      expect(scanFiles({ [ACTION]: action, '.github/workflows/c.yml': w })).toEqual([]);
    });
  });

  describe('6. JS string concatenation in scripts', () => {
    for (const [name, text] of [
      ['a const joined with +', "const v = '15.0.0';\nrun('npm i next@' + v);"],
      ['double quotes', 'const v = "15.0.0";\nrun("npm i next@" + v);'],
      ['a ^ range', "const v = '15.0.0';\nrun('npm i next@^' + v);"],
      ['an npm pkg set', "const v = '15.0.0';\nrun('npm pkg set dependencies.next=' + v);"],
      ['a literal on the right', "run('npm i next@' + '15.0.0');"],
      ['a chain', "const a = '15';\nconst b = '0.0';\nrun('npm i next@' + a + '.' + b);"],
      ['a template literal operand', "const a = '15';\nrun('npm i next@' + `@{a}.0.0`);"],
      ['a template-literal head', "const v = '15.0.0';\nrun(`npm i next@` + v);"],
    ] as const) {
      it(`flags ${name}`, () => {
        const out = flagged('scripts/x.mjs', text);
        expect(out.length, text).toBeGreaterThan(0);
        expect(out.join('\n'), text).toContain('15.0.0');
      });
    }

    it('passes a concatenation of a clear version', () => {
      expect(flagged('scripts/x.mjs', "const v = '16.4.3';\nrun('npm i next@' + v);")).toEqual([]);
    });

    it('fails a concatenated operand it cannot resolve', () => {
      for (const operand of ['opts.version', 'getVersion()', 'argv[2]', 'unknownVar']) {
        const out = flagged('scripts/x.mjs', `run('npm i next@' + ${operand});`);
        expect(out.join('\n'), operand).toContain('unresolvable');
      }
    });

    it('does not take a concatenation outside a version position for a pin', () => {
      for (const t of [
        "const v = '15.0.0';\nconsole.log('Next >= ' + v);",
        "const v = '15.0.0';\nlog('next version: ' + v);",
        "const v = '15.0.0';\nrun('npm i react@' + v + ' next');",
      ]) {
        expect(flagged('scripts/x.mjs', t), t).toEqual([]);
      }
    });

    it('attributes the pin to the line that wrote the version', () => {
      const out = flagged('scripts/x.mjs', "const v = '15.0.0';\nrun('npm i next@' + v);");
      expect(out.join('\n')).toContain("const v = '15.0.0';");
    });
  });

  describe('7. a spec assembled from parts', () => {
    it('joins the pieces of next@"$MAJOR.$MINOR"', () => {
      const text = (minor: string) =>
        step(
          `|\n          MAJOR=16\n          MINOR=${minor}\n          bun add next@"$MAJOR.$MINOR"`,
        );
      expect(flagged('x.yml', text('3.8')).join('\n')).toContain('16.3.8');
      expect(flagged('x.yml', text('4.3'))).toEqual([]);
    });
    it('fails a piece nothing assigns', () => {
      expect(flagged('x.yml', step('bun add next@"16.$MINOR"')).join('\n')).toContain(
        'unresolvable',
      );
    });
  });
});
describe('#2630 — edges of the per-job matrix, caller context and with: parsing', () => {
  const flagged = (file: string, text: string, opts: ScanOpts = {}) =>
    workflowFlags(file, fx(text), [], opts);
  const scanFiles = (
    files: Record<string, string>,
    emitters: Record<string, string[]> = {},
  ): string[] =>
    yamlTargets(
      Object.entries(files).map(([file, text]) => ({ file, text: fx(text) })),
      emitters,
    ).flatMap((t) => workflowFlags(t.file, t.text, [], t.opts));
  const ACTION = '.github/actions/a/action.yml';
  const action = [
    'name: a',
    'inputs:',
    '  fw:',
    '    default: 16.4.3',
    'runs:',
    '  using: composite',
    '  steps:',
    '    - shell: bash',
    '      run: bun add "next@@{{ inputs.fw }}"',
  ].join('\n');

  it('an `outputs: matrix:` key is not a matrix', () => {
    const text = [
      'jobs:',
      '  b:',
      '    outputs:',
      '      matrix: @{{ steps.m.outputs.matrix }}',
      '    strategy:',
      '      matrix:',
      '        fw: [16.4.3]',
      '    steps:',
      '      - run: bun add "next@@{{ matrix.fw }}"',
    ].join('\n');
    // were `outputs.matrix` taken for a dynamic matrix, the override below would be emitted
    expect(flagged('x.yml', text, { matrixVersions: ['16.3.8'] })).toEqual([]);
  });

  it('a fromJSON nested inside a matrix block makes it dynamic', () => {
    const text = (src: string) =>
      [
        'jobs:',
        '  plan:',
        '    steps:',
        '      - run: bun scripts/emit.mjs',
        '  m:',
        '    needs: plan',
        '    strategy:',
        '      matrix:',
        '        fw: [16.4.3]',
        `        include: @{{ fromJSON(needs.${src}.outputs.m) }}`,
        '    steps:',
        '      - run: bun add "next@@{{ matrix.fw }}"',
      ].join('\n');
    const opts = { matrixEmitters: { 'scripts/emit.mjs': ['16.3.8'] } };
    expect(flagged('x.yml', text('plan'), opts).join('\n')).toContain('16.3.8');
    expect(flagged('x.yml', text('plan'))).toEqual([]);
  });

  it('an inline flow-mapping matrix is read, and an unparseable one is dynamic', () => {
    const text = (m: string) =>
      `jobs:\n  b:\n    strategy:\n      matrix: ${m}\n    steps:\n      - run: bun add "next@@{{ matrix.fw }}"`;
    expect(flagged('x.yml', text('{ fw: [16.3.8] }')).join('\n')).toContain('16.3.8');
    expect(flagged('x.yml', text('{ fw: [16.4.3] }'))).toEqual([]);
    expect(flagged('x.yml', text('*shared')).join('\n')).toContain('unresolvable');
  });

  it("a caller's dynamic matrix resolves through the caller's own emitters", () => {
    const caller = [
      'jobs:',
      '  plan:',
      '    steps:',
      '      - run: bun scripts/emit.mjs',
      '  c:',
      '    needs: plan',
      '    strategy:',
      '      matrix: @{{ fromJSON(needs.plan.outputs.m) }}',
      '    steps:',
      '      - uses: ./.github/actions/a',
      '        with:',
      '          fw: @{{ matrix.mv }}',
    ].join('\n');
    const files = { [ACTION]: action, '.github/workflows/c.yml': caller };
    expect(scanFiles(files, { 'scripts/emit.mjs': ['16.3.8'] }).join('\n')).toContain('16.3.8');
    expect(scanFiles(files, { 'scripts/emit.mjs': ['16.4.3'] })).toEqual([]);
    expect(scanFiles(files, {}).join('\n')).toContain('unresolvable');
  });

  it('follows with: through an action that calls another action with the same input name', () => {
    const outer = [
      'name: b',
      'inputs:',
      '  fw:',
      '    default: 16.4.3',
      'runs:',
      '  using: composite',
      '  steps:',
      '    - uses: ./.github/actions/a',
      '      with:',
      '        fw: @{{ inputs.fw }}',
    ].join('\n');
    const wf = `jobs:\n  c:\n    steps:\n      - uses: ./.github/actions/b\n        with:\n          fw: 16.3.8`;
    const out = scanFiles({
      [ACTION]: action,
      '.github/actions/b/action.yml': outer,
      '.github/workflows/c.yml': wf,
    });
    expect(out.join('\n')).toContain('16.3.8');
    expect(out.join('\n')).not.toContain('cycle');
  });

  it('fails closed on an alias value inside a parsed with: mapping', () => {
    for (const body of [
      '- uses: ./.github/actions/a\n  with: { fw: *v }',
      '- uses: ./.github/actions/a\n  with:\n    fw: *v',
      '- uses: ./.github/actions/a\n  with:\n    fw: !!str 16.3.8',
    ]) {
      const wf = `jobs:\n  c:\n    steps:\n${body
        .split('\n')
        .map((l) => `      ${l}`)
        .join('\n')}`;
      expect(
        scanFiles({ [ACTION]: action, '.github/workflows/c.yml': wf }).join('\n'),
        body,
      ).toContain('unresolvable');
    }
  });

  it('fails closed on a flow-style step that spans lines or names the action oddly', () => {
    for (const body of [
      '- { uses: ./.github/actions/a,\n    with: { fw: 16.3.8 } }',
      '- { name: "uses ./.github/actions/a" }',
    ]) {
      const wf = `jobs:\n  c:\n    steps:\n${body
        .split('\n')
        .map((l) => `      ${l}`)
        .join('\n')}`;
      expect(
        scanFiles({ [ACTION]: action, '.github/workflows/c.yml': wf }).join('\n'),
        body,
      ).toContain('unresolvable');
    }
  });

  it('does not take a different action sharing a path prefix for this one', () => {
    const wf =
      'jobs:\n  c:\n    steps:\n      - uses: ./.github/actions/a-other\n        with: *shared';
    expect(scanFiles({ [ACTION]: action, '.github/workflows/c.yml': wf })).toEqual([]);
  });

  it('judges a with: value passed to a quoted-path uses', () => {
    const wf =
      "jobs:\n  c:\n    steps:\n      - uses: './.github/actions/a/'\n        with:\n          fw: 16.3.8";
    expect(scanFiles({ [ACTION]: action, '.github/workflows/c.yml': wf }).join('\n')).toContain(
      '16.3.8',
    );
  });
});
describe('#2630 — the rest of a version token and unbalanced substitutions', () => {
  const flagged = (file: string, text: string, opts: ScanOpts = {}) =>
    workflowFlags(file, fx(text), [], opts);

  it('judges the literal text that follows a reference in the same token', () => {
    const text = (tail: string) =>
      `env:\n  MAJOR: 16\njobs:\n  b:\n    steps:\n      - run: bun add next@@{MAJOR}${tail}`;
    expect(flagged('x.yml', text('.3.8')).join('\n')).toContain('16.3.8');
    expect(flagged('x.yml', text('.4.1'))).toEqual([]);
  });

  it('fails a command substitution in a string a JS script hands to a shell', () => {
    for (const line of [
      "execSync('npm i next@$(cat .nextver)');",
      'execSync("npm i next@$(cat .nextver)");',
    ]) {
      expect(flagged('scripts/x.mjs', line).join('\n'), line).toContain('unresolvable');
    }
  });

  it('fails an unbalanced command substitution instead of dropping it', () => {
    for (const [file, text] of [
      ['x.yml', 'jobs:\n  b:\n    steps:\n      - run: bun add "next@$(cat f"'],
      ['scripts/x.sh', 'bun add next@$(cat f'],
      ['scripts/x.sh', 'NEXT_VERSION=$(cat f'],
    ] as const) {
      expect(flagged(file, text).join('\n'), text).toContain('unresolvable');
    }
  });
});
// Round 3 (#2630): the doc comment above states the scan's reach. Each shape in this
// block is one of those claims made exact - it is either RED here, or it is listed under
// STILL NOT SEEN there. Fixtures are written before the detector that turns them red.
describe('#2630 round 3 - the documented reach is the real reach', () => {
  const flagged = (file: string, text: string, opts: ScanOpts = {}) =>
    workflowFlags(file, fx(text), [], opts);
  const wf = (run: string) => `jobs:\n  b:\n    steps:\n      - run: ${run}`;
  /** The whole discovery + scan path over an in-memory tree. */
  const scanTree = (files: Record<string, string>) => {
    const g = gatherYamls(Object.keys(files), (f) => fx(files[f]));
    return {
      unscanned: g.unscanned,
      scanned: g.yamls.map((y) => y.file),
      flags: yamlTargets(g.yamls, {}).flatMap((t) => workflowFlags(t.file, t.text, [], t.opts)),
    };
  };

  describe('1. a JS concatenation that spans lines, or whose head is a variable', () => {
    for (const [name, text] of [
      ['a leading + on the next line', "const s = 'next@'\n  + '15.0.0';"],
      ['a trailing + at the end of the line', "run('npm i next@' +\n  '15.0.0');"],
      ['a variable operand on the next line', "const v = '15.0.0';\nrun('npm i next@'\n  + v);"],
      ['a chain across three lines', "run('npm i next@'\n  + '15'\n  + '.0.0');"],
      ['a prefix variable joined on the next line', "const p='next@'; const s = p\n + '15.0.0';"],
      [
        'a prefix variable on a line that does not mention next',
        "const p = 'next@';\nrun(p + '15.0.0');",
      ],
      ['an npm path held in a variable', "const p = 'dependencies.next=';\nrun(p + '15.0.0');"],
    ] as const) {
      it(`flags ${name}`, () => {
        const out = flagged('scripts/x.mjs', text);
        expect(out.length, text).toBeGreaterThan(0);
        expect(out.join('\n'), text).toContain('15.0.0');
      });
    }

    it('passes the clear versions of the same shapes', () => {
      for (const t of [
        "const s = 'next@'\n  + '16.4.3';",
        "run('npm i next@' +\n  '16.4.3');",
        "const p='next@'; const s = p\n + '16.4.3';",
        "const p = 'next@';\nconst v = '16.4.3';\nrun(p + v);",
      ]) {
        expect(flagged('scripts/x.mjs', t), t).toEqual([]);
      }
    });

    it('fails an operand it cannot resolve on the next line', () => {
      for (const t of [
        "run('npm i next@'\n  + opts.version);",
        "const p = 'next@';\nrun(p + getVersion());",
      ]) {
        expect(flagged('scripts/x.mjs', t).join('\n'), t).toContain('unresolvable');
      }
    });

    it('does not take a joined line outside a version position for a pin', () => {
      for (const t of [
        "log('Next >= '\n  + '15.0.0');",
        "const label = 'next version: ';\nlog(label + '15.0.0');",
        "const a = 'x'\n  + '15.0.0';",
      ]) {
        expect(flagged('scripts/x.mjs', t), t).toEqual([]);
      }
    });
  });

  describe('2. a YAML alias, anchor or tag in an env or input-default table', () => {
    const useIt = '      - run: npm i next@@{{ env.NEXT_VERSION }}';
    for (const [name, text] of [
      [
        'an alias bound to a next-named env key',
        `env:\n  X: &v 15.0.0\n  NEXT_VERSION: *v\njobs:\n  b:\n    steps:\n${useIt}`,
      ],
      [
        'an alias to a CLEAR anchor (it cannot be followed, so it is not green)',
        `env:\n  X: &v 16.4.3\n  NEXT_VERSION: *v\njobs:\n  b:\n    steps:\n${useIt}`,
      ],
      ['a tagged value', `env:\n  NEXT_VERSION: !!str 16.4.3\njobs:\n  b:\n    steps:\n${useIt}`],
      [
        'an alias read through a differently named env key',
        'env:\n  X: &v 15.0.0\n  FW: *v\njobs:\n  b:\n    steps:\n      - run: npm i next@@{{ env.FW }}',
      ],
      [
        'an alias as an input default',
        'on:\n  workflow_dispatch:\n    inputs:\n      fw:\n        default: *v\njobs:\n  b:\n    steps:\n      - run: npm i next@@{{ inputs.fw }}',
      ],
      [
        'an alias in an inline env flow mapping',
        'env: { X: &v 15.0.0, NEXT_VERSION: *v }\njobs:\n  b:\n    steps:\n      - run: npm i next@@{{ env.NEXT_VERSION }}',
      ],
      ['a next-named binding to an alias, never read', 'env:\n  X: &v 16.4.3\n  NEXT_VERSION: *v'],
      ['a next-named binding to an alias in a flow mapping', 'env: { NEXT_VERSION: *v }'],
    ] as const) {
      it(`fails closed on ${name}`, () => {
        const out = flagged('x.yml', text);
        expect(out.length, text).toBeGreaterThan(0);
        expect(out.join('\n'), text).toContain('unresolvable');
      });
    }

    it('does not judge an alias that never reaches a next position', () => {
      const text =
        'env:\n  X: &v 15.0.0\n  HOME_V: *v\njobs:\n  b:\n    steps:\n      - run: echo @{{ env.HOME_V }}';
      expect(flagged('x.yml', text)).toEqual([]);
    });
  });

  describe('3. a JS reassignment without a keyword', () => {
    it('judges the union of every assignment, a bare one included', () => {
      for (const t of [
        "let v='16.4.1'; v='15.0.0'; run('npm i next@'+v);",
        "let v = '16.4.1';\nif (x) {\n  v = '15.0.0';\n}\nrun('npm i next@' + v);",
        'let v = "16.4.1";\nv = "15.0.0";\nrun(`npm i next@@{v}`);',
      ]) {
        const out = flagged('scripts/x.mjs', t);
        expect(out.length, t).toBeGreaterThan(0);
        expect(out.join('\n'), t).toContain('15.0.0');
      }
    });

    it('fails closed on an assignment whose value is not one string literal', () => {
      for (const t of [
        "let v = '16.4.1';\nv = pick();\nrun('npm i next@' + v);",
        "let v = '16.4.1';\nv += '.0';\nrun('npm i next@' + v);",
        "const v = '15.0.' + patch;\nrun('npm i next@' + v);",
        "let v = '16.4.1';\nv =\n  '15.0.0';\nrun('npm i next@' + v);",
        "let v = '16.4.1';\nv = cond ? '15.0.0' : '16.4.1';\nrun('npm i next@' + v);",
      ]) {
        expect(flagged('scripts/x.mjs', t).join('\n'), t).toContain('unresolvable');
      }
    });

    it('passes clear reassignments, and is not fooled by a comparison, an arrow or a property', () => {
      for (const t of [
        "let v='16.4.1'; v='16.4.3'; run('npm i next@'+v);",
        "const v = '16.4.3';\nif (v == '15.0.0') run('npm i next@' + v);",
        "const v = '16.4.3';\nif (v === '15.0.0') run('npm i next@' + v);",
        "const v = '16.4.3';\nif (v !== '15.0.0' && v <= '15.0.0') run('npm i next@' + v);",
        "const v = '16.4.3';\nconst f = (w) => w;\nobj.v = '15.0.0';\nrun('npm i next@' + v);",
      ]) {
        expect(flagged('scripts/x.mjs', t), t).toEqual([]);
      }
    });
  });

  describe('4. the package name itself sits behind a reference', () => {
    const envP = (name: string) => `env:\n  P: ${name}\njobs:\n  b:\n    steps:\n`;
    const inP = (name: string) =>
      `on:\n  workflow_dispatch:\n    inputs:\n      p:\n        default: ${name}\njobs:\n  b:\n    steps:\n`;
    for (const [name, build] of [
      ['an env expression', (v: string) => `${envP('next')}      - run: npm i @{{ env.P }}@${v}`],
      [
        'an input expression',
        (v: string) => `${inP('next')}      - run: npm i @{{ inputs.p }}@${v}`,
      ],
      [
        'a quoted env expression',
        (v: string) => `${envP('next')}      - run: npm i "@{{ env.P }}@${v}"`,
      ],
      ['a shell variable', (v: string) => `${envP('next')}      - run: npm i $P@${v}`],
      ['a braced shell variable', (v: string) => `${envP('next')}      - run: npm i @{P}@${v}`],
      [
        'create-next-app',
        (v: string) => `${envP('create-next-app')}      - run: npx @{{ env.P }}@${v} app`,
      ],
    ] as const) {
      it(`flags ${name} holding next, and passes its clear version`, () => {
        const bad = flagged('x.yml', build('15.0.0'));
        expect(bad.length, name).toBeGreaterThan(0);
        expect(bad.join('\n'), name).toContain('15.0.0');
        expect(flagged('x.yml', build('16.4.3')), name).toEqual([]);
      });
    }

    it('follows the version half of the spec through its own reference too', () => {
      const text =
        'env:\n  P: next\n  V: 15.0.0\njobs:\n  b:\n    steps:\n      - run: npm i @{{ env.P }}@@{{ env.V }}';
      expect(flagged('x.yml', text).join('\n')).toContain('15.0.0');
    });

    it('does not judge a name that resolves to another package', () => {
      const text =
        'env:\n  P: react\njobs:\n  b:\n    steps:\n      - run: npm i @{{ env.P }}@15.0.0';
      expect(flagged('x.yml', text)).toEqual([]);
    });

    it('fails closed on a package name it cannot resolve, before a version', () => {
      for (const ref of ['secrets.PKG', 'env.NOPE', 'inputs.nope', 'steps.s.outputs.p']) {
        expect(flagged('x.yml', wf(`npm i @{{ ${ref} }}@15.0.0`)).join('\n'), ref).toContain(
          'unresolvable',
        );
      }
    });

    it('leaves a reference that is not followed by a version alone', () => {
      for (const t of [
        wf('git clone git@@{{ env.HOST }}:org/repo'),
        wf('echo @{{ secrets.USER }}@example.com'),
        wf('ssh deploy@@{{ env.HOST }}'),
      ]) {
        expect(flagged('x.yml', t), t).toEqual([]);
      }
    });
  });

  describe('5. a local composite action outside .github/actions', () => {
    const caller = (path: string, quote = '') =>
      `jobs:\n  c:\n    steps:\n      - uses: ${quote}${path}${quote}\n        with:\n          fw: 15.0.0`;
    const action = (def: string) =>
      [
        'name: a',
        'inputs:',
        '  fw:',
        `    default: ${def}`,
        'runs:',
        '  using: composite',
        '  steps:',
        '    - shell: bash',
        '      run: bun add "next@@{{ inputs.fw }}"',
      ].join('\n');

    it('discovers the action from the uses: line and judges what its callers pass', () => {
      for (const [path, q] of [
        ['./tools/act', ''],
        ['./tools/act/', ''],
        ['./tools/act', '"'],
        ['./tools/act', "'"],
      ] as const) {
        const r = scanTree({
          '.github/workflows/c.yml': caller(path, q),
          'tools/act/action.yml': action('16.4.3'),
        });
        expect(r.scanned, path).toContain('tools/act/action.yml');
        expect(r.unscanned, path).toEqual([]);
        expect(r.flags.join('\n'), path).toContain('15.0.0');
      }
    });

    it('fails closed on a caller that spells the action path some other way', () => {
      for (const path of ['./tools/act/../act', './././tools/act', './tools//act']) {
        const r = scanTree({
          '.github/workflows/c.yml': caller(path),
          'tools/act/action.yml': action('16.4.3'),
        });
        expect(r.flags.join('\n'), path).toContain('unresolvable');
      }
    });

    it('judges the action default when no caller passes the input', () => {
      const r = scanTree({
        '.github/workflows/c.yml': 'jobs:\n  c:\n    steps:\n      - uses: ./tools/act',
        'tools/act/action.yaml': action('15.0.0'),
      });
      expect(r.scanned).toContain('tools/act/action.yaml');
      expect(r.flags.join('\n')).toContain('15.0.0');
    });

    it('follows an action reached only through another action', () => {
      const outer = [
        'name: o',
        'runs:',
        '  using: composite',
        '  steps:',
        '    - uses: ./tools/inner',
      ].join('\n');
      const r = scanTree({
        '.github/workflows/c.yml': 'jobs:\n  c:\n    steps:\n      - uses: ./.github/actions/o',
        '.github/actions/o/action.yml': outer,
        'tools/inner/action.yml': action('15.0.0'),
      });
      expect(r.scanned).toContain('tools/inner/action.yml');
      expect(r.flags.join('\n')).toContain('15.0.0');
    });

    it('fails closed on a local uses: path that has no tracked action to scan', () => {
      for (const path of ['./tools/missing', './', '.', './tools/act/extra']) {
        const r = scanTree({
          '.github/workflows/c.yml': `jobs:\n  c:\n    steps:\n      - uses: ${path}`,
          'tools/act/action.yml': action('16.4.3'),
        });
        expect(r.unscanned.join('\n'), path).toContain(path);
      }
    });

    it('does not take a reusable workflow, a comment, a remote action or a clear action for unscanned', () => {
      const r = scanTree({
        '.github/workflows/c.yml': [
          '# uses: ./tools/commented',
          'jobs:',
          '  c:',
          '    uses: ./.github/workflows/d.yml',
          '  e:',
          '    steps:',
          '      - uses: actions/checkout@v4',
          '      - uses: docker://alpine:3',
          '      - uses: ./tools/act',
          '        with:',
          '          fw: 16.4.3',
        ].join('\n'),
        '.github/workflows/d.yml': 'on: workflow_call\njobs: {}',
        'tools/act/action.yml': action('16.4.3'),
      });
      expect(r.unscanned).toEqual([]);
      expect(r.flags).toEqual([]);
    });
  });

  it('the real tree has no local action the scan cannot see, and reaches the ones outside .github', () => {
    const g = gatherYamls(trackedFiles(), (f) => readFileSync(resolve(REPO_ROOT, f), 'utf8'));
    expect(g.unscanned).toEqual([]);
    expect(g.yamls.map((y) => y.file)).toContain('packages/kn-next-action/action.yml');
  });
});
