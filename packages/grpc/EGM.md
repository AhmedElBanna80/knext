# @getknext/grpc

## Overview

`@getknext/grpc` is the opt-in zone-functions module of knext (Beta). A zone (a
`NextApp`) can call Go or Rust functions over Connect. Their protobuf contracts
are the source of truth. The package is `private: true` in `package.json` and
has an optional peer dependency on `@getknext/core` (`>=2.0.0-0 <3.0.0`).

- Core owns the `knext` bin and lazily loads `./cli` for the `generate`, `add`
  and `deploy` verbs (`src/cli.ts` header, `DISPATCH_PROTOCOL`, `CORE_PEER_RANGE`).
- Generated zone code imports `./runtime`: the policy-enforcing client, the
  Next.js glue helpers, and the zone identity-token signer.
- `./skew` exports the contract skew rule.

## Interface

- `package.json` `exports`: `./cli` → `dist/cli.js`, `./runtime` →
  `dist/runtime.js`, `./skew` → `dist/skew.js`, `./package.json`. The tarball
  `files` are `dist`, `proto` and `templates`.
- `tsup.config.ts`: the ESM build. `entry` is `cli` ← `src/cli.ts`, `runtime` ←
  `src/runtime.ts`, `skew` ← `src/skew.ts`; it also emits `dts`, with
  `target: 'node22'`. The package `build` script is `tsup && node
  scripts/copy-templates.mjs`.
- `buf.yaml`: the buf v2 module `proto`, with `lint: STANDARD` and
  `breaking: FILE`.
- Runtime dependencies are pinned exactly: `@bufbuild/buf` 1.73.0,
  `@bufbuild/protobuf`, `@bufbuild/protoc-gen-es` and `@bufbuild/protoplugin`
  2.16.0, and `@connectrpc/connect` and `@connectrpc/connect-node` 2.2.0.
- Subdirectories:
  - src: [./src/EGM.md](./src/EGM.md) - CLI verbs (generate, add function,
    deploy function), the codegen plugins, and the runtime (client, glue,
    signer, skew).
  - proto: [./proto/EGM.md](./proto/EGM.md) - the shipped `knext.v1` options
    contract (function name, contract version, per-RPC `Auth`).
  - scripts: [./scripts/EGM.md](./scripts/EGM.md) - template copy at build time,
    runners for the verbs and the verified buf from source, and the token-vector
    generator.
  - e2e/z7-identity-kind (no EGM.md): the Z7 zone-identity-token lane on kind.
    `run.sh` is its entry point (run by `.github/workflows/z7-identity-kind-e2e.yml`),
    sources the shared `e2e/lib/kind-lane.sh`, and its header describes the
    phases, including the squatted-JWKS-ConfigMap phase. `mutation-rows.mjs` holds the mutation rows (the operator rows, plus M7 for
    `run.sh` itself), which
    `mutation-prove-operator.sh` runs by hand. The lane's workflow, script and lib
    are guarded from the repo root, and its probe and needle helpers under
    `packages/grpc/src/__tests__`: see the header of its
    prover, `scripts/mutation-prove-2461-z7-kind-e2e.mjs`, for the test files it
    covers, including `tests/z7-identity-kind-e2e-lane.test.ts`.
  - e2e/z10-zone-functions-kind (no EGM.md): the Z10 zone-functions lane on kind
    (cold path, trailers, rollout, sovereignty, wake-ahead). The same workflow
    runs its `run.sh` after Z7, on the same cluster. Its `wake` phase uses a
    second zone image, `zone-caller-wake`, built by `../z7-identity-kind/zone-caller/build.ts --wake`,
    which starts the stand-in zone with knext's wake-ahead preload. Guard:
    `tests/z10-zone-functions-kind-lane.test.ts`.
  - e2e/lib/kind-lane.sh: helpers sourced (never run) by the Z7, Z10 and Z11
    scripts.
  - e2e/z11-activator-drill (no EGM.md): a manual drill on kind with Calico,
    phases `up deploy token direct noauth`; it proves which control holds on the
    activator path (the function's token, and the NetworkPolicy on a direct
    dial). No workflow runs it; `RECORDED-RUN.md` holds the last run. Guard:
    `tests/z11-activator-drill.test.ts`.

## Invariants

- `cli.js` reads `../package.json` and `../proto/` at run time, so both must sit
  beside `dist/` in the tarball (`tsup.config.ts` comment;
  `src/cli.ts:manifest`, `src/add-function.ts:packagedOptionsProto`).
- Dependencies (buf, protobuf-es, Connect) stay external to the bundle and
  resolve from the package's own `dependencies` (`tsup.config.ts` comment).
- `BUF_VERSION` and the four `BUF_SHA256` digests in `src/buf.ts` must change in
  the same edit as the `@bufbuild/buf` dependency (`src/buf.ts` header).
- This package never imports core, and it reaches the cluster only through the
  `DeployHost` seam that core supplies (`src/deploy-function.ts` header).
- When run from source, the scaffolder uses the repository's `templates/<lang>`.
  When run from `dist/`, it uses the copy packed beside `dist/`
  (`src/scaffold-template.ts:resolveLangTemplateDir`).

## Side Effects

- `build` regenerates `dist/` (`clean: true`) and replaces
  `packages/grpc/templates/{go,rust}` (`scripts/copy-templates.mjs`).
- The verbs' file, process and cluster effects are listed in
  [./src/EGM.md](./src/EGM.md).

## Verification

- Run: `node scripts/bun-test.mjs packages/grpc` (from the repository root).
- The e2e guards live at the repo root and run by name:
  `node scripts/bun-test.mjs tests/z7-identity-kind-e2e-lane.test.ts tests/z10-zone-functions-kind-lane.test.ts tests/z11-activator-drill.test.ts`.
