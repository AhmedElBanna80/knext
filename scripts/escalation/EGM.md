# escalation

## Overview

The modules behind `../check-escalation-triggers.mjs`, the PR check that the
escalation triggers in `.claude/rules/workflow.md` were acknowledged. Each module
owns one concern; the CLI composes them.

| Module | Concern |
|---|---|
| `paths.mjs` | Triggers decided by the changed path alone |
| `public-surface.mjs` | The published surface of a package manifest |
| `credential-workflows.mjs` | Credential-bearing workflows and the files they name |
| `acknowledgement.mjs` | How a PR records that a trigger was noted |
| `git.mjs` | `git diff --name-status` parsing and a two-ref file reader |
| `report.mjs` | Merging findings, the text report and the job summary |

## Interface

- `paths.mjs`: `TRIGGERS` (ids `adr`, `crd`, `config-schema`, `cli-surface`, `crates`, `supply-chain`), `classifyPaths(changes)`, `isStaticSupplyChainPath(p)`, `isTestPath(p)`, `SUPPLY_CHAIN_WHY`.
- `public-surface.mjs`: `PUBLIC_MANIFEST_KEYS` (`exports`, `bin`, `files`, `main`, `types`, `typesVersions`), `publicSurfaceChanged(before, after)`, `publicSurfaceFindings(changes, repo)` (id `public-api`).
- `credential-workflows.mjs`: `WORKFLOW`, `LOW_PRIVILEGE_SECRETS` (`GITHUB_TOKEN`, `CODECOV_TOKEN`), `workflowHoldsCredential(text)`, `referencedPaths(text)`, `namedFiles(text, read, listUnder)`, `credentialWorkflowFindings(changes, repo, why)` (id `supply-chain`).
- `acknowledgement.mjs`: `ACK_LABEL` (`trigger:acknowledged`), `LEGACY_ACK_LABEL` (`design-gate:cleared`), `ACK_BODY_PATTERN` (`/Escalation trigger acknowledged:/i`), `isAcknowledged(labels, body)`.
- `git.mjs`: `git(args)`, `parseNameStatus(text)`, `gitReader(baseRef, headRef)` (`show(side, path)`, `listHead(prefix)`).
- `report.mjs`: `mergeFired(a, b)`, `writeJobSummary(fired, acked)`, `printReport(fired, acked)` (returns the exit code).

A `repo` is `{ show(side, path), listHead(prefix) }`: `show` returns a blob's text or null, `side` is `base` or `head`.

## Invariants

- `adr` fires on a modified or deleted file under `docs/adr/`, not an added one, and never under `docs/adr/gates/` [`paths.mjs:TRIGGERS`].
- `crd` fires on any `*_types.go` under an `api/` directory; `cli-surface` on `packages/<pkg>/src/cli.ts` or `src/cli/**`, tests excluded; `crates` on anything under `crates/` [`paths.mjs`].
- The static supply-chain paths are `security/**`, `scripts/audit-published.mjs` and any non-test `packages/<pkg>/src/**/supply-chain.{js,ts,…}` [`paths.mjs:isStaticSupplyChainPath`].
- `public-api` compares only `PUBLIC_MANIFEST_KEYS` of `packages/<pkg>/package.json`; a manifest that does not parse on either side fires, with the reason saying so [`public-surface.mjs:publicSurfaceFindings`].
- A workflow holds a credential when its text has `id-token: write`, `permissions: write-all`, a `packages`/`contents`/`attestations: write` grant, `toJSON(secrets)`, a `secrets[…]` index, or any `secrets.<NAME>` outside `LOW_PRIVILEGE_SECRETS` [`credential-workflows.mjs:workflowHoldsCredential`].
- A changed workflow fires `supply-chain` when it holds a credential on the base or the head side [`credential-workflows.mjs:credentialWorkflowFindings`].
- A changed file fires `supply-chain` when a credential-bearing head workflow names it directly (`namedFiles`), after YAML/shell comments are removed:
  - a `scripts/` or `.github/actions/` path, whether or not it exists;
  - any other `dir/file` path token that exists;
  - the Makefile of a `make` command (`-C dir`, `--directory=dir`, else the repo root, every `working-directory:` and every literal `cd` target in the file), when it exists;
  - every file under a named local action directory (also a file added there), and what its `action.yml` names, read once.
- Only one level is followed: a file that a named script imports or runs does not fire [`credential-workflows.mjs`].
- `parseNameStatus` throws on an unknown status letter or a record with no path, and a rename or copy yields both paths, destination first [`git.mjs`].
- `gitReader.show` treats a tree as absent (`cat-file -t` must be `blob`); any other git failure throws [`git.mjs`].
- `mergeFired` keeps one entry per id and every path once [`report.mjs`].
- `isAcknowledged` accepts either label, trimmed and case-folded, or a body line matching `ACK_BODY_PATTERN` [`acknowledgement.mjs`].

## Side Effects

- `git.mjs` runs `git` (`show`, `cat-file`, `ls-tree`) through `execFileSync`.
- `report.mjs` writes to stdout/stderr and appends to `$GITHUB_STEP_SUMMARY` when set; a failed append is ignored.
- `paths.mjs`, `public-surface.mjs`, `credential-workflows.mjs` and `acknowledgement.mjs` are pure.

## Verification

- `bun test tests/escalation-triggers.test.ts`
- `node scripts/mutation-prove-2388-escalation-trigger-scope.mjs`
