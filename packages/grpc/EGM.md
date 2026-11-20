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
    covers, including `tests/z7-identity-kind-e2e-lane.test.ts`. The real-time rotation's
    property (c) is decided by `rotation-verdict.ts` from probes `run.sh` records
    (unit-tested without a cluster in `src/__tests__/z7-rotation-verdict.test.ts`); the
    `rotation` phase (`z7-identity-kind/run.sh:952`, dispatch/weekly only) is decided by that verdict; the
    workflow runs that phase through the `rotation_realtime` input, by dispatch, or by the weekly caller `z7-rotation-weekly.yml`. That caller is not on this branch: it lives on the default branch `main` (merged in #162), because GitHub fires `schedule:` only from the default branch, and the cron therefore cannot live in this workflow. It `uses:` this workflow through `workflow_call`, pinned at `@integration/v2`.
  - e2e/z10-zone-functions-kind (no EGM.md): the Z10 zone-functions lane on kind
    (cold path, Connect error codes (`connecterr`), gRPC-protocol `grpc-status` trailers via `packages/grpc/e2e/z7-identity-kind/zone-caller/grpc-probe.ts` (tested cluster-free by `src/__tests__/z10-grpc-trailer-probe.test.ts`), zone and function both at zero, rollout with one zone
    revision per served-version bump, sovereignty, cross-zone refusal, wake-ahead, the `imagepin` phase (a zone that pins its function's image digest refuses a swapped image, with no Knative Service and no pod, then recovers when the pinned image returns) and the `http11` phase (a zone's `httpVersion: "1.1"` calls the function over HTTP/1.1 while the function's port stays `h2c`)). The same workflow
    runs its `run.sh` after Z7, on the same cluster, on push, PR and normal dispatch runs; it is
    skipped on the weekly called or `rotation_realtime` dispatch run
    (the step "Run the Z10 zone-functions cold-path e2e on the same cluster" in
    `.github/workflows/z7-identity-kind-e2e.yml`). Its `grpctrailers` phase
    (`phase_grpctrailers` in `z10-zone-functions-kind/run.sh`) proves the gRPC `grpc-status` trailer survives the
    activator, fail-closed. Its `wake` phase uses a
    second zone image, `zone-caller-wake`, built by `../z7-identity-kind/zone-caller/build.ts --wake`,
    which starts the stand-in zone with knext's wake-ahead preload. Guard:
    `tests/z10-zone-functions-kind-lane.test.ts`.
  - e2e/lib/kind-lane.sh: helpers sourced (never run) by the Z7, Z10, Z11 and Z12
    scripts.
  - e2e/z11-activator-drill (no EGM.md): a drill on kind with Calico, phases
    `up deploy token direct policyoff noauth rotcold held heldwarm`; it proves which control holds on the
    activator path (the function's token, and the NetworkPolicy on a direct
    dial), and that with the NetworkPolicy off a token-less call is still refused
    by the function itself (`policyoff`, for the Go function and, as its Rust leg
    `policyoff_rust`, for the Rust template function; each leg ends with a positive control: a VALID token sent the same direct way is accepted, 404 not_found, judged by `check_direct_accepted` in `answering-pod.sh`, so the refusals are the token check and not a path that refuses everything), while a function without its interceptor and
    without the policy answers it (`noauth`). `rotcold` rotates and retires the zone's
    signing key while the function is at zero: the cold pod that wakes refuses the
    retired key (401 unauthenticated) and, after another scale to zero, accepts the new
    one. `held` makes the activator hold a call past the token's life with a ResourceQuota in the
    function's namespace that admits no pod (no node is cordoned; `Z11_HELD_SECONDS`, default
    80 s; the quota is removed on exit): the call is refused as unauthenticated, then a fresh
    token is accepted and a garbage one is still refused. `heldwarm` is the warm-pod, held-call case: two warm pods each load the old key set with one call (the others detached, quota in place), the key is rotated and retired under them, a new-key call held 30 s and released to pod A only is accepted (the control), and the same held 80 s and released to pod B only, in the same state, is refused (401 unauthenticated "token rejected"). The pod uid set is checked unchanged; labels go back before the quota. The pod that answered each held call is observed, not assumed: `e2e/z11-activator-drill/answering-pod.sh` (sourced by `run.sh`) reads every pod's queue-proxy `revision_request_count` through the API server's pod proxy before and after the call, and the one pod whose total rose by exactly one is the answerer (any other result fails the run, and an unreadable, empty, series-less or non-numeric scrape fails closed naming the pod rather than counting as zero). The verdicts (404 not_found, or 401 unauthenticated "token rejected", from the expected pod) are the functions `check_accepted_by` and `check_refused_by` in the same file. After its refusal, pod B alone is given a fresh token and must accept it (404 not_found), which shows the refusal was the token's age. The verifier's order is JWKS re-read, kid lookup, signature, then expiry, and a refusal is not logged, so the drill proves the pair, not which check fired. `Z11_MUTANT=swap-pod` (local only: the drill refuses to start when `Z11_MUTANT` and `CI` are both set, `refuse_mutant_in_ci` in `e2e/z11-activator-drill/run.sh:789-794`) re-attaches the other pod, and `check_accepted_by` must then fail naming the pod that answered.
    Both sign through `../z7-identity-kind/probe.ts` (`--timeout-seconds` is its
    long-call option). `.github/workflows/z11-activator-drill-e2e.yml`
    runs every phase by default; `RECORDED-RUN.md` holds an earlier manual run.
    Guard: `tests/z11-activator-drill.test.ts`, mutation-proved by
    `scripts/mutation-prove-s8-1-z11-policyoff.mjs`,
    `scripts/mutation-prove-s9-1-z11-rotation-held.mjs` and
    `scripts/mutation-prove-s9-2-z11-rust-policyoff.mjs` (the Rust leg) and
    `scripts/mutation-prove-s10-4-z11-heldwarm.mjs` (`heldwarm` and the warm hold) and
    `scripts/mutation-prove-s11-1-z11-answering-pod.mjs` (which pod answered, the pod B fresh-token control and the policy-off valid-token control,
    run against `tests/z11-answering-pod.test.ts`, which executes the shell on fabricated counters).
  - e2e/z12-quickstart-kind (no EGM.md): the Z12 zone-functions quickstart on kind, run by
    hand, not by any workflow. `run.sh` builds `@getknext/{lib,db,core,grpc}` from this checkout
    and packs them, then runs the documented path on a real Next.js zone: `knext create --runtime
    node --cache-components`, `knext add function orders --lang go`, `knext generate`, `knext deploy
    function`, `knext deploy`. Phases `pack scaffold function zone calls wake` (`PHASES`). It proves
    the zone reaches Ready with its `BackendBindings` True, a Route Handler reaches a cold function
    through the generated Server Action, a read keeps `NotFound` through `"use cache"`, a refused
    caller gets the refusal message, and a warm wake loads the function from `KNEXT_WAKE_FUNCTIONS`.
    Prerequisite: a kind cluster from the Z7 `up` phase (`PHASES=up e2e/z7-identity-kind/run.sh`).
    No test or workflow names it. It was merged 2026-11-11 and has never run in CI; see
    the Sprint 14 debt in `.claude/plans/v2-sprint14.md`.

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
  `node scripts/bun-test.mjs tests/z7-identity-kind-e2e-lane.test.ts tests/z10-zone-functions-kind-lane.test.ts tests/z11-activator-drill.test.ts tests/z11-answering-pod.test.ts`.
