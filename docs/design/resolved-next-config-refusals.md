# Resolved next.config refusals (design note, #2250)

Status: proposed, revised after design review (r1: approve-with-changes). Scope: `packages/kn-next` CLI build guards + the official adapter.

## Problem

Four build decisions read `next.config.*` as **text**:

| # | Decision | Path | When | Today |
|---|---|---|---|---|
| 1 | refuse a custom `distDir` | Next | before `next build` | `assertDefaultDistDir` — string/comment-aware scan |
| 2 | find `distDir` to look for `export-detail.json` | Next | after `next build` | `configuredDistDir` — scan |
| 3 | refuse `turbopackModuleFragments` on Bun + Turbopack | Next | before build | `enablesTurbopackModuleFragments` — regex |
| 4 | refuse `output: 'export'` | vinext | before `vite build` | `classifyStaticExport` — hand-written tokenizer |

A text scan is a second, unofficial model of Next's config resolution: it misses wrappers, curried plugins,
`export { x as default }`, reassigned bindings, env-computed values, and it false-refuses on shapes it
mis-tokenizes. #2235 took four review rounds and still lists ~10 known limitations.

## Requirements

- R1 No refusal depends on a text scan. A scan may survive only as an advisory warning.
- R2 The decision is made on the **same resolved config the build uses** (no second resolver).
- R3 Fail closed: a config that cannot be loaded/resolved refuses (or the build itself fails) — never a silent pass.
- R4 Refuse before compilation work where today's guard does (1, 3, 4).
- R5 The user still gets knext's actionable message, not a bare stack.

## Decision (recommended)

### Next path (decisions 1–3): decide inside the adapter's `modifyConfig`

`modifyConfig(config, { phase })` is the **official** Deployment Adapter hook and receives the resolved
`NextConfigComplete` (defaults applied, all wrappers/plugins already evaluated) at the very start of
`next build`, before any compilation. On `phase-production-build` only:

- `config.distDir !== '.next'` → refuse (1).
- `KNEXT_RUNTIME === 'bun'` and `KNEXT_BUILDER === 'turbopack'` and
  `config.experimental.turbopackModuleFragments === true` → refuse (3). `modifyConfig` is not told the
  bundler (measured on next 16.4.3: ctx is `{ phase, nextVersion, projectDir }`), so the CLI exports
  `KNEXT_BUILDER` beside the `KNEXT_RUNTIME` it already sets.
- Always write the resolved facts `{ distDir, output, turbopackModuleFragments }` to
  `<projectDir>/.knext/resolved-next-config.json` (a fixed path, so it does not depend on `distDir`),
  before any refusal.

A refusal throws an `Error` whose message starts with a stable marker `[knext-refuse:<code>]` followed by
the user-facing message. Next prints it and `next build` exits non-zero.

CLI side (`runProjectBuild`):

- Delete the pre-build text guards for 1 and 3; set `KNEXT_BUILDER`; remove a stale facts file before the build.
- On build failure: if the facts file carries a `refused` code, throw the matching `UsageError` (R5);
  otherwise rethrow untouched (today's behaviour).
- On success: read `distDir` from the facts file for the `export-detail.json` check (2). A **missing**
  facts file after a successful `next build` means the adapter did not run (the app's build script is not
  `next build`, or `adapterPath` was removed) → refuse, fail closed (R3).

`output: 'export'` on the Next path keeps its existing `export-detail.json` signal (it is already
Next-written, not a scan); only its `distDir` lookup moves to the facts file.

### vinext path (decision 4): vinext's own loader

vinext resolves next.config itself (`loadNextConfig` + `resolveNextConfig` in
`vinext/internal/config/next-config`, used by vinext's build at `dist/index.js`). The CLI calls those
before `vite build` and refuses on `output === 'export'`. That is the resolver `vite build` will use (R2).
A load error refuses with the error text (R3). The subpath is `internal/`, so:

- it is pinned by the vinext version knext already pins, and
- a contract test imports it and asserts both functions exist with the used shape, so a vinext bump
  that moves it reds CI instead of silently disabling the guard.

### Text scans

`classifyStaticExport`, `configuredDistDir`, `distDirMentions`, `enablesTurbopackModuleFragments` stop
deciding. `knext doctor`'s turbopack check (advisory, no build) keeps its scan as a warning; the rest
are deleted with their fixtures moved to the resolved-config tests (the #2235 36-case set becomes a
fixture matrix of real config files fed through the real resolver).

## Options considered

| Option | R1 | R2 | Official API | Pre-build (R4) | Cost |
|---|---|---|---|---|---|
| **A. adapter `modifyConfig` (Next) + vinext loader (vinext)** — recommended | yes | yes | yes for Next; vinext-internal for vinext | yes (start of build) | M |
| B. CLI calls `next/dist/server/config` `loadConfig` pre-build | yes | ~ (same code, separate evaluation; double-evaluates user config) | no — Next internal, not adapter API | yes | M; unversioned internal |
| C. keep the tokenizer, add shapes | no | no | — | yes | grows forever (#2235 history) |
| D. post-build only (facts file, no refusal in `modifyConfig`) | yes | yes | yes | **no** — refuse only after a full build | S |

A over B: B reaches into an unversioned Next internal from the CLI and evaluates the user's config a second
time outside the build; A uses the hook the adapter API provides for exactly this. A over D: D gives up
R4 (a custom-distDir build would run to completion before refusing).

## Failure modes

- Adapter not wired (custom build script, `adapterPath` removed): no facts file → refuse after build (R3).
  Not pre-build, but today's text guard also cannot see a build script that bypasses Next.
- Stale facts file from a previous build: deleted before every build.
- `next build` run directly (not via knext): the adapter now refuses a custom `distDir` itself. That is
  correct — the adapter's artifact layout assumes `.next` — and is a behaviour change to note in the changeset.
- `--skip-next` / `deploy --skip-build` / `--image`: no build, no decision — unchanged.
- vinext internal moved: contract test reds.

## Surface changes

- New env `KNEXT_BUILDER` (adapter input, set by the CLI; internal, documented in the adapter EGM).
- New file `.knext/resolved-next-config.json` (build artefact; gitignore guidance).
- Error messages unchanged in wording; the custom-distDir and turbopack refusals now also fire on a plain
  `next build`.

Escalation trigger acknowledged: CLI surface + hard rule ("official adapter API") — this moves decisions
**onto** the official adapter API and off a heuristic, and uses a vinext-internal subpath only on the
opt-in vinext target, contract-tested.

## Revision 1 (design review findings, all adopted)

1. **Phase is not enough (blocker).** `phase-production-build` is also used by `next typegen`, `next upgrade`,
   `next test` and post-build. The adapter therefore **enforces only when the CLI sets `KNEXT_BUILD_NONCE`**
   (a fresh random value per `runProjectBuild`); without it, it does nothing (no refusal, no facts file).
   The facts file carries the nonce, and the CLI accepts it only if the nonce matches, which also removes
   the stale-file problem.
2. **Several writers.** `modifyConfig` runs in the main build process and again in the Turbopack/webpack
   workers. The facts file is written tmp-then-rename (last identical write wins), and a failed write
   throws a named message, not a bare `EACCES`.
3. **The bundler is not resolved config.** `finalizeConfig(..., bundler)` runs after `modifyConfig`, so
   `KNEXT_BUILDER` mirrors knext's own builder setting, not flags a custom build script passes
   (`next build --webpack`). This is the same blind spot the text guard had. Stated as a limitation, not
   claimed as R2. R2 is claimed for `distDir`, `output` and `turbopackModuleFragments` only.
4. **`output: 'export'` on the Next path.** The facts' `output` (recorded *after* the adapter's own
   standalone default, i.e. what Next actually builds) is the primary signal. `export-detail.json` stays
   as a corroborating check. `modifyConfig` still does **not** refuse an explicit export: Next runs its
   own export validation first. The CLI refuses after the build.
5. **`distDir` normalisation.** `./.next` and `.next/` are accepted, as the old guard did (path-normalised
   compare, not `!==`).
6. **Missing facts after a successful build.** Refuse, with the cause named: "knext's adapter did not run
   during this build (`adapterPath` missing, or the build script does not run `next build`)".
7. **`next dev` and other commands are unaffected** (no nonce). There is a test for it.
8. **Log noise.** The `modifyConfig fired` log is printed only once per nonce (the main process).
9. **vinext half (blockers adopted):**
   - pass `phase-production-build` (the loader defaults to the dev phase);
   - run the loader in a **child process** (it `chdir`s and evaluates user code);
   - resolve vinext from the **app's** `cwd`;
   - an inline `vinext({ nextConfig })` override in `vite.config` is not seen by an on-disk load, so it is a
     stated limitation and the CLI warns when `vite.config.*` passes `nextConfig`.
   The `internal/` subpath is a **hard-rule exception** (official API first). It goes to the sprint-close
   design review as an ADR-0036 amendment item, not decided here.
10. **Changeset** notes the behaviour change: a plain `next build` with knext's adapter now records facts but
    refuses nothing (enforcement only under the CLI nonce). So there is *no* plain-`next build` behaviour
    change after all, which replaces the "Failure modes" bullet above.

### Delivery

- **PR 1, Next path:** adapter facts + nonce + refusals for `distDir` and turbopack fragments. The CLI reads
  the facts for `distDir`/`output`, and the text guards for 1–3 are deleted. The doctor scan stays as a warning.
- **PR 2, vinext path:** the child-process loader, after the ADR-0036 amendment question is filed for sprint close.

## Revision 2 (discovered while implementing, jev 0.87)

**Discovered fact.** knext deploys apps that have **no** `adapterPath` (`apps/db-demo` builds with a plain
`next build --webpack` and `output: 'standalone'`). So "no facts after a successful build ⇒ refuse" would
break a supported setup. In Next 16.4 `adapterPath` defaults to `process.env.NEXT_ADAPTER_PATH`
(`config-shared.js`), and an app's own `adapterPath` overrides it.

**Changes to the decision:**

- A **facts-only adapter** (`@getknext/core/internal/next-config-facts`) records facts and refuses. It does
  nothing else: no output default, no cache-handler rewrite, no `onBuildComplete`. The CLI sets
  `NEXT_ADAPTER_PATH` to it (resolved from the app's `cwd`) unless the env already sets one. An app on
  knext's full adapter gets the same recording from that adapter, which calls the same function. An app's
  own non-knext adapter wins, and then facts are missing (below).
- **The nonce plus the fixed path become one env var.** `KNEXT_CONFIG_FACTS_OUT` is an absolute path to a
  fresh per-build temp file, created by the CLI. Adapters record and enforce only when it is set and the
  phase is `phase-production-build`. That rules out `next typegen` and `next dev`, and makes a plain
  `next build` a no-op. A unique path cannot be stale. It is written tmp-then-rename, because several
  processes write it.
- **Missing facts** (a foreign adapter, a script that does not run `next build`, `build --skip-next`): the CLI
  **falls back to the existing text checks for that build** and prints a warning that the resolved config could
  not be confirmed. This keeps today's guarantees on the uncommon paths, and the resolved config decides on
  every path where an adapter ran. This replaces Revision 1 item 6 and the `.knext/` path.

## Revision 3 (PR review, jev 0.68). Supersedes Revision 2's injection

**Discovered fact (design review, read in Next 16.4.3 source).** Setting *any* `adapterPath` changes Next's
build output, whether or not the adapter does anything:
- prerender artifact names (`getRouteCacheKey`, `build/index.js`);
- `useScopedBuildArtifacts` (`export/worker.js`);
- `fallback: false` misses render a 404 instead of throwing `NoFallbackError` (`pages-handler.js`);
- the build-cache hash.

`build-artifact.ts` already blanks `adapterPath` in the standalone config for this reason. A facts-only
adapter injected through `NEXT_ADAPTER_PATH` is therefore **not** behaviour-neutral for adapter-less apps.
It is removed, together with its export.

**Measured (Next 16.4.3; webpack, Turbopack and a static export).** Every `next build` writes the resolved
config to `<distDir>/required-server-files.json`, `config` included. That covers a non-standalone build
and a wrapper-set flag (`turbopackModuleFragments: true` read back). A build whose `distDir` resolves to
`build` writes it to `build/` and leaves `.next`'s copy untouched.

**Decision order after a Next build:**
1. **knext's adapter record.** The adapter refuses in `modifyConfig`, before compilation. The record
   carries `projectDir` (from `modifyConfig`'s ctx), and a record for another app's directory is ignored,
   which covers a script that builds several apps. A recorded refusal throws even if the build exited 0.
2. **Next's own `.next/required-server-files.json`**, for apps without knext's adapter. The CLI deletes it
   (and `.next/export-detail.json`) before the build, so a present file belongs to this build; there is no
   clock comparison. A file that does not parse refuses. These refusals come after the build.
3. **Neither** (the build script did not run `next build`, or a custom `distDir` on an adapter-less app):
   the earlier text checks, with a warning.

**Before the build,** the text checks also run, as warnings only, so a setting the text can see is
flagged before a slow build.

**R1, amended.** No refusal depends on a text scan **when Next resolved the config in this build**, which
is cases 1 and 2. Text scans still decide in case 3, on `build --skip-next` (no build, so no resolved
config), on the vinext target (PR 2), and in `knext doctor` (advisory).

**Not done (dropped):** Revision 1 item 8, logging once per build. The `modifyConfig fired` log predates
this change, and the nonce it was keyed on no longer exists.
