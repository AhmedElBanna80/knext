# Contributing to knext

## Where things go (triage path)

- **Bug?** Open an issue with the [bug report template](.github/ISSUE_TEMPLATE/bug_report.yml) —
  it asks for the version and cluster environment up front, which is most of what triage needs.
- **Feature idea?** Open an issue with the [feature request template](.github/ISSUE_TEMPLATE/feature_request.yml).
- **"How do I...?" / general question?** Use [Discussions](https://github.com/getknext-dev/knext/discussions),
  not the issue tracker — issues are for actionable work items.
- **Security vulnerability?** Do **not** open a public issue. See [SECURITY.md](SECURITY.md) for
  private reporting via GitHub Security Advisories.

## Before you push: `bun run prepush`

PRs kept going red on the same three local checks. One command runs exactly what CI's
Lint & Test runs first, in order, without short-circuiting, and exits non-zero if any fail:

```bash
bun run prepush   # biome check --diagnostic-level=error, the D9 temp-dir guard, typecheck
```

Run it before every push (agents included). After a merge, `.github/workflows/merged-sha-check.yml`
fails if the commit that landed on `main` or `integration/**` does not contain the PR's final head
(`scripts/merged-sha-check.mjs`: ancestry, or for squash merges, per-file blob equality).

## Before you push, part two: `node scripts/prepush-check.mjs`

`bun run prepush` checks lint and types. This one checks the diff you are about to push, against
the merge base, for three defects that reached CI or merged: a changed `security/` data file
that its gate rejects, tests that leak temp directories, and a change that touches files outside
its task.

```bash
node scripts/prepush-check.mjs --scope 'scripts/**,tests/**'
```

Every check looks at the same set of files: the merge-base diff plus your uncommitted and
untracked changes, which are listed as such. It runs the real gate for every changed file under
`security/` (any depth, any extension except `.md`): readers are found by scanning `scripts/`, the
workflows and `package.json` scripts, and one that is not in the registry in
`scripts/lib/prepush-check.mjs` fails. A file with no gate fails too. A gate is a registered
script, a test that reads the file by its path and that a workflow runs, or a documented
exemption (printed as a `NOTICE` on every run, whether or not that file changed). It also runs the changed tests while snapshotting `tmpdir()`
and the repo root for new leftovers (with no changed tests it runs the tests that import the
changed source, and warns that the leak scan was not exercised if there are none), scans
`tests/**` for a `mkdtemp` that is never removed, and prints `git diff --stat` grouped by
top-level area. A file outside the declared scope fails. The scope is `--scope`, or a line of the
form `Scope: glob, glob` in a commit or PR body; any other phrasing is ignored. List each glob
separately: a brace glob such as `{a,b}/**` fails, because the line is split on commas. A gate
whose tool is not installed is reported as unverified and fails unless you pass
`--allow-missing-tools`. It is not a git hook and nothing installs it.

### In CI

`.github/workflows/prepush-check.yml` runs it on every pull request, and again when the PR body is
edited. There the `Scope:` line must be in the **PR body** (a commit message can be rebased wider),
and the job fails when it is missing, when it is a wildcard over directories (`**`, `**/*`,
`*/**`), or when the globs together touch 75% of the tracked top-level directories or match more
than 60% of tracked files (so `**/*.ts, **/*.md` fails). Locally a missing scope only warns.

What the CI job does **not** catch:

- It does not run any gate or test; each already runs in its own workflow. It proves a scope was
  declared and that each changed `security/` file has a gate.
- The scope is self-declared. A revert inside the declared scope passes, and so does a wide but
  honest-looking scope below the thresholds above.
- A `Scope:` line is not checked against what the PR says it does.
- A test counts as a gate if it reads the file by path and a workflow runs it. A step or job whose
  `if:` is not always true on a pull request is refused, but workflow trigger filters (`paths:`,
  `branches:`) and `needs:` are not evaluated, and a test that reads the file but asserts little
  still counts.
- A path built at run time cannot be seen by the reader scan; keep paths literal.

The copy on `main` and the copy on `integration/v2` differ only in the block between
`// BEGIN branch-specific` and `// END branch-specific` (which gates and `security/` files each
registers); that block holds data literals only, no calls or functions.
`.github/workflows/prepush-lib-drift.yml` exists on both branches and runs
`scripts/prepush-lib-drift.mjs` on every pull request and push to either, against the other
branch, so drift introduced from either side fails on that side's own PR. It fails on any
difference outside the block, in the CLI, the tests, the prover or the two workflows, on a block
that is not plain data, and on an input that exists on both branches but is exempt on only one.

## Mutation-proving a guard

Every new guard is mutation-proved (delete the behaviour it protects, watch it go RED, restore).
**Restore from a byte snapshot and run the residue scan** — `git status --porcelain` cannot see
residue in a file your PR legitimately modifies, which is how two near-misses happened in one
session:

```bash
bun run lint:mutation-residue     # red-on-fail in CI; run it before you commit
```

Read [`docs/guides/mutation-testing.md`](docs/guides/mutation-testing.md) before writing a harness;
it ships one (`scripts/lib/mutation-harness.mjs`) so you do not hand-roll the restore.

## Docs live with the code (`apps/docs/`)

The user-facing docs site (knext-platform.dev) lives in this monorepo at **`apps/docs/`** and consumes
`@getknext/core` via `workspace:*` (see `docs/adr/0024-docs-site-in-monorepo.md`).

- **If your PR changes documented behavior — public surface** (`@getknext/core` exports, the
  `KnativeNextConfig` / `NextApp` schema, CLI flags, or generated code) — **update
  `apps/docs/content/**` in the same PR**, or say why the change is invisible to users.
  This is judgment-based, not a hard gate: a soft CI reminder (`docs-drift-reminder`) will post a
  non-blocking warning when public surface changes without a `content/**` change, but it never
  fails the build.

- **`apps/docs/content/**` is USER-FACING.** Even though it now lives beside internal ADRs and
  issue history, it must contain **no ADR numbers, no issue/PR numbers (`#NN`), and no internal
  strategy jargon** (e.g. `vinext`, `Nitro`). Write for adopters, not maintainers. A soft CI
  reminder greps added `content/**` lines for these and warns — treat it as a nudge, not a gate.
  (The docs app's `next.config.ts` / `next-adapter.ts` / `knext.config.ts` legitimately reference
  internals; the guard is scoped to `content/**` only.)

## How the lead merges a PR (`scripts/merge-train.mjs`)

Once a PR has code review + spec review + CI green, the lead enqueues it with
`scripts/merge-train.mjs` rather than `gh pr merge` directly — three incidents (a base-branch
deletion auto-closing a stacked child PR, twice; a PR dequeued on a guard failure only visible on
the combined tree) motivated promoting this out of an ad-hoc scratch script into a tested tool.

```bash
# Enqueue the EXACT reviewed head (full 40-hex SHA only — a short SHA or a
# branch name is refused before anything is queued). Re-checks the PR's
# head on every poll tick and aborts with "HEAD MOVED" if a push landed
# after review. Before enqueueing, it merges current main into a scratch
# worktree of the PR head and runs the PR's changed test files against the
# COMBINED tree, refusing to enqueue (and printing the failing test) if that
# is red — skip only with --skip-preflight.
node scripts/merge-train.mjs enqueue <PR> <FULL_HEAD_SHA> [--timeout 8h] [--skip-preflight]

# If a merge-train run reports "DEQUEUED", or after the fact: find and print
# the merge-group run's failing job/step without digging through the UI.
node scripts/merge-train.mjs investigate <PR>

# Before deleting a merged base branch (the stacked-PR case): refuses and
# lists any open PRs still based on it, unless --retarget is passed, in
# which case it retargets them to main first.
node scripts/merge-train.mjs delete-base <branch> [--retarget]
```

Exit/status lines are deliberately terse and machine-greppable: `MERGED <sha> head-in-main`,
`HEAD MOVED: <old> != <new>`, `DEQUEUED: <reason>`, `TIMEOUT`. Every guard is mutation-proved
(`scripts/mutation-prove-merge-train.mjs`) against fake-`gh` unit tests
(`tests/merge-train.test.ts`, `tests/merge-train-cli.test.ts`) — no live GitHub call is made by
the test suite.

## Building the docs locally

From the repo root (workspace-aware install/build):

```bash
bun install
bun run --filter @getknext/lib build && bun run --filter @getknext/db build && bun run --filter @getknext/core build
bun run --filter knext-docs build            # vanilla (managed-host / Vercel) build
KNEXT_ADAPTER=1 bun run --filter knext-docs build   # self-host / adapter dogfood build
```
