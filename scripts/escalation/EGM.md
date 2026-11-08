# escalation

## Overview

The modules behind `../check-escalation-triggers.mjs`, the PR check that the
escalation triggers in `.claude/rules/workflow.md` were acknowledged. Each module
owns one concern; every trigger's wording comes from `catalogue.mjs`. Dependencies
run one way: the CLI uses `classify.mjs`, `git.mjs`, `report.mjs` and
`acknowledgement.mjs`, and re-exports names from the detector modules for existing
importers; `classify.mjs` uses the detectors (`paths.mjs`,
`public-surface.mjs`, `credential-workflows.mjs`) and `report.mjs`; the detectors
use `catalogue.mjs`; `report.mjs` uses `acknowledgement.mjs`.

| Module | Concern |
|---|---|
| `catalogue.mjs` | Every trigger's id, label and reason, and `finding()` |
| `classify.mjs` | Every finding for a diff (`classifyAll`) |
| `paths.mjs` | Triggers decided by the changed path alone |
| `public-surface.mjs` | The published surface of a package manifest |
| `credential-workflows.mjs` | Credential-bearing workflows and the files they name |
| `acknowledgement.mjs` | How a PR records that a trigger was noted |
| `git.mjs` | `git diff --name-status` parsing and a two-ref file reader |
| `report.mjs` | Merging findings, the text report and the job summary |

## Interface

- `catalogue.mjs`: `CATALOGUE` (ids `adr`, `crd`, `config-schema`, `cli-surface`, `crates`, `supply-chain`, `public-api`, each with `label` and `why`), `finding(id, paths, note = '')` (throws on an id not in the catalogue).
- `classify.mjs`: `classify(changes)` (path triggers), `classifyContent(changes, repo)`, `classifyAll(changes, repo)` (both, merged).
- `paths.mjs`: `TRIGGERS` (`{ id, match(path, status) }` for `adr`, `crd`, `config-schema`, `cli-surface`, `crates`, `supply-chain`), `classifyPaths(changes)`, `isStaticSupplyChainPath(p)`, `isTestPath(p)`.
- `public-surface.mjs`: `PUBLIC_MANIFEST_KEYS` (`exports`, `bin`, `files`, `main`, `types`, `typesVersions`), `publicSurfaceChanged(before, after)`, `publicSurfaceFindings(changes, repo)` (id `public-api`).
- `credential-workflows.mjs`: `WORKFLOW`, `LOW_PRIVILEGE_SECRETS` (`GITHUB_TOKEN`, `CODECOV_TOKEN`), `workflowHoldsCredential(text)`, `referencedPaths(text)`, `prepare(text, { comments, actionDir })`, `namedFiles(text, read, listUnder)`, `INSTALL_INPUTS` (per manager: bun `bun.lock`, `bun.lockb`, `bunfig.toml`, `.npmrc`; npm `package-lock.json`, `npm-shrinkwrap.json`, `.npmrc`; pnpm `pnpm-lock.yaml`, `pnpm-workspace.yaml`, `.npmrc`; yarn `yarn.lock`, `.yarnrc.yml`, `.yarnrc`), `installManagers(text)`, `installDirs(text)`, `DEPENDENCY_KEYS`, `dependenciesChanged(before, after)`, `credentialWorkflowFindings(changes, repo)` (id `supply-chain`).
- `acknowledgement.mjs`: `ACK_LABEL` (`trigger:acknowledged`), `LEGACY_ACK_LABEL` (`design-gate:cleared`), `ACK_BODY_PATTERN` (`/Escalation trigger acknowledged:/i`), `ACK_BODY_EXAMPLE`, `isAcknowledged(labels, body)`.
- `git.mjs`: `git(args)`, `parseNameStatus(text)`, `gitReader(baseRef, headRef)` (`show(side, path)`, `listHead(prefix)`).
- `report.mjs`: `mergeFired(a, b)`, `writeJobSummary(fired, acked)`, `printReport(fired, acked)` (returns the exit code).

A `repo` is `{ show(side, path), listHead(prefix) }`: `show` returns a blob's text or null, `side` is `base` or `head`.

## Invariants

- `adr` fires on a file under `docs/adr/` with any status except added (a rename into it fires), never under `docs/adr/gates/` [`paths.mjs:TRIGGERS`].
- `crd` fires on any `*_types.go` under an `api/` directory; `cli-surface` on `packages/<pkg>/src/cli.ts` or `src/cli/**`, tests excluded; `crates` on anything under `crates/` [`paths.mjs`].
- The static supply-chain paths are `security/**`, `scripts/audit-published.mjs` and any non-test `packages/<pkg>/src/**/supply-chain.{js,ts,…}` [`paths.mjs:isStaticSupplyChainPath`].
- `public-api` compares only `PUBLIC_MANIFEST_KEYS` of `packages/<pkg>/package.json`; a manifest that does not parse on either side fires, with the reason saying so [`public-surface.mjs:publicSurfaceFindings`].
- A workflow holds a credential when its text has `id-token: write`, `permissions: write-all`, a `packages`/`contents`/`attestations: write` grant, `toJSON(secrets)`, a `secrets[…]` index, or any `secrets.<NAME>` outside `LOW_PRIVILEGE_SECRETS` [`credential-workflows.mjs:workflowHoldsCredential`].
- A changed workflow fires `supply-chain` when it holds a credential on the base or the head side [`credential-workflows.mjs:credentialWorkflowFindings`].
- A changed file fires `supply-chain` when a credential-bearing head workflow names it directly (`namedFiles`). The text is read through `prepare`: `${{ github.workspace }}/`, `$GITHUB_WORKSPACE/` and `${GITHUB_WORKSPACE}/` are stripped; `${{ github.action_path }}/`, `$GITHUB_ACTION_PATH/` and `${GITHUB_ACTION_PATH}/` become the action's directory inside its `action.yml` and are stripped elsewhere; full-line comments are dropped except for `scripts/` and `.github/actions/` mentions:
  - a `scripts/` or `.github/actions/` path, whether or not it exists; when it is a directory, every file under it and any file added there;
  - any other path token, a `dir/file` (a dot-directory such as `.github/scripts/x.sh` included) or a bare script name (`*.sh`, `*.bash`, `*.mjs`, `*.cjs`, `*.js`, `*.ts`, `*.py`), resolved against the root, every `working-directory:` and every literal `cd` target, when it exists on the head or the base side (so a file the PR deletes still counts; a directory such as an app build context does not cover its files);
  - the `GNUmakefile`, `makefile` or `Makefile` a `make` command runs (`-C dir`, `--directory=dir`, else every base), when it exists;
  - for a local action (a `.github/actions/<name>` mention, or any directory a `uses: ./dir` step names that holds an `action.yml` / `action.yaml`), every file under it and what its `action.yml` names, read once;
  - for each package install the workflow or a local action it uses runs (`bun|npm|pnpm|yarn`, then `-flag` options, then `install`, `i`, `ci` or `add`, on one line), that manager's `INSTALL_INPUTS` and, when its `DEPENDENCY_KEYS` change (an unparseable side counts as a change), the `package.json`, at the root and in every `working-directory:` / `cd` target (`installDirs`).
- Only one level is followed: a file that a named script imports or runs does not fire [`credential-workflows.mjs`].
- `parseNameStatus` throws on an unknown status letter or a record with no path, and a rename or copy yields both paths, destination first [`git.mjs`].
- `gitReader.show` returns null when `cat-file -t` fails or the object is not a blob, so a tree reads as absent; `git show` of a found blob, and `listHead`, throw on failure [`git.mjs`].
- `mergeFired` keeps one entry per id and every path once [`report.mjs`].
- `isAcknowledged` accepts either label, trimmed and case-folded, or a body line matching `ACK_BODY_PATTERN` [`acknowledgement.mjs`].

## Side Effects

- `git.mjs` runs `git` (`show`, `cat-file`, `ls-tree`) through `execFileSync`.
- `report.mjs` writes to stdout/stderr and, when a trigger fired and `$GITHUB_STEP_SUMMARY` is set, appends to it; a failed append is ignored.
- `catalogue.mjs`, `classify.mjs`, `paths.mjs` and `acknowledgement.mjs` are pure (`classify.mjs` reads through the `repo` it is given). `public-surface.mjs` and `credential-workflows.mjs` read files only through the `repo` they are given.

## Verification

- `bun test tests/escalation-triggers.test.ts`
- `node scripts/mutation-prove-2388-escalation-trigger-scope.mjs`
