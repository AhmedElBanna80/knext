# harness

## Overview
Bun test tooling for the knext-ffi crates. It loads the real fixture library built from `knext-ffi-fixture` and checks what only a real load can show. These scripts are not the generator; the generator lives in `@getknext/ffi` (`ffi-harness.ts` header). Both scripts exit 0 on a pass and 10 (`HARNESS_ERROR`) when the harness could not run. `ffi-harness.ts` also exits 10 on any failed check (`fail`), except in `leak` mode (see Invariants); `ffi-generated.ts` exits 1 when any check failed (`finish`).

## Interface
- `ffi-harness.ts`, run as `bun crates/harness/ffi-harness.ts <mode> <lib> [--no-free]`:
  - `scan(bytes)`: exported. Extracts every `KNEXTFFI1` + JSON + NUL record from the library bytes.
  - `schemaString(f, types)`: exported. Rebuilds the schema string for a fn record (its `sig` followed by the canonical form of every reachable record or enum, sorted by name byte-wise).
  - `RustError`, `RustPanicError`: exported error classes.
  - `load` (private): binds `knext_ffi_v1_free` plus every fn symbol and its `_schema` companion with `dlopen`, from the embedded manifest.
  - Modes:
    - `manifest` (`modeManifest`): record counts, the rebuilt sig, the symbol `knext_ffi_v1_<fn>_<fnv32(sig)>`, `<symbol>_schema()` == `fnv64(schemaString)`, and the doc comment `Says hello.` on `greet`
    - `roundtrip` (`modeRoundtrip`): unicode, NUL, empty and 1 MiB strings, an empty `Uint8Array` passed as NULL, 64-bit integers beyond 2^53, records, `Err`, and two large string arguments
    - `panic` (`modePanic`): 1000 panics in a row via `boom`, then `boom_any`, then a correct call
    - `leak` (`modeLeak`): spawns one `leak-phase` child process per entry in `LEAK_PHASES` (`String`, `Vec<u8>`, `record`)
    - `leak-phase` (`modeLeakPhase`, internal): one phase, calling `echo_string`, `echo_bytes` or `echo_point`
- `ffi-generated.ts`, run as `bun crates/harness/ffi-generated.ts wrapper <lib> | init`:
  - Imports `runGenerate` (`packages/ffi/src/generate`), `CRATE_GIT`, `recordedCrateRev`, `runInit` (`packages/ffi/src/init`), `scanManifest` (`packages/ffi/src/manifest`), `libNameOf`, `renderModule` (`packages/ffi/src/render`), `integerMatrix` (`packages/ffi/src/__tests__/integer-matrix`), and `assertRevOnBase` and `localCrateSourceEnv` from `./local-crates-source`.
  - `wrapper`: scans and renders the module, stages the library under `native/ffi/<triple>/` with a sha256 `.integrity.json`, makes the library and its directories read-only (the loader refuses a tree anyone but root could write), and calls through the generated module in a child Bun process (`inBun`, `--conditions=react-server`, `NODE_ENV=production`), including the `integerMatrix` integer-argument cases.
  - `init`: runs `runInit`, then (when `KNEXT_FFI_LOCAL_REPO` is set, CI only) calls `assertRevOnBase(KNEXT_FFI_LOCAL_REPO, recordedCrateRev(), KNEXT_FFI_LOCAL_BASE_REF)`, which fails closed unless the recorded rev is a 40-hex SHA and an ancestor of `KNEXT_FFI_LOCAL_BASE_REF` (a ref or SHA, unset means failure). The CI step sets it to the PR base SHA (`pull_request.base.sha`), the merge-queue base (`merge_group.base_sha`), or `github.sha` on push (`.github/workflows/rust-crates.yml:190`). Only after that check does it point git's `url.insteadOf` for `CRATE_GIT` at that checkout via `localCrateSourceEnv` (`local-crates-source.ts`), so cargo fetches the recorded rev from the local clone with no network access to the remote; then `runGenerate` (with and without `check`, including a deliberately drifted wrapper), then calls `greet` through the generated module.
- `local-crates-source.ts`, CI only, imported by `ffi-generated.ts` and `ffi-egress-offline.ts`:
  - `localCrateSourceEnv(repoDir, gitUrl)`: returns the env that makes git rewrite `gitUrl` to `file://<repoDir>` (`url.insteadOf`) and sets `CARGO_NET_GIT_FETCH_WITH_CLI`.
  - `assertRevOnBase(repoDir, rev, baseRef)`: throws unless `rev` is a 40-hex SHA, `baseRef` resolves in the clone, and `rev` is an ancestor of `baseRef`.
  - Egress proof (S9-4): `DENIED_PROXY` (`http://127.0.0.1:9`), `githubDenialGitConfig()` (a git config file that routes `https://github.com/` through `DENIED_PROXY`), `cargoDbHoldsRev(cargoHome, rev)` (true when cargo's git db under `CARGO_HOME/git/db` holds `rev` as a commit; it reads the db, never cargo's output), `egressVerdict(positive, positiveHoldsRev, control)` (pure: `[]` when the positive fetch succeeded, its db holds the rev, and the control was refused at the denied route), and `cargoEgressProbe({ repoDir, gitUrl, rev, spawn? })` (writes a consumer crate that depends on `knext-ffi` at `rev`, checks that the denial is in the written git config before cargo runs, fetches twice with fresh `CARGO_HOME`s, returns the verdict).
- `ffi-egress-offline.ts`, CI only, run as `bun harness/ffi-egress-offline.ts` from `crates/` (`rust-crates.yml`, the `Generator — egress denied` step, after the init step): checks `KNEXT_FFI_LOCAL_REPO` and the recorded rev (`assertRevOnBase`), runs `cargoEgressProbe`, exits 1 on any problem and 2 when the checkout is not set.

## Invariants
- `ffi-harness.ts:load` computes every buffer argument's pointer only after all arguments are encoded into the growable scratch buffer, so growing the buffer cannot invalidate an earlier pointer. An empty buffer is passed as `(null, 0)`.
- `ffi-harness.ts:load` (`take`) frees each non-empty returned buffer exactly once with `knext_ffi_v1_free`, unless `--no-free` is set. It maps status 1 to `RustError`, 2 to `RustPanicError` and 3 to `RustError("invalid input: ...")`.
- `ffi-harness.ts:modeLeakPhase` fails a phase (exit 1) when RSS grows by more than `LEAK_BOUND_MB` (48) over `LEAK_CALLS` (1e6) calls, after 10 000 warm-up calls. The `leak` exit code is the number of phases over the bound, so `--no-free` must exit 3. A phase exiting with anything other than 0 or 1 is a harness failure.
- `ffi-generated.ts:wrapper` requires the scanned functions to equal the fixture source's `#[export]` functions exactly (more than 30), the records `['Child', 'Point', 'Reading']` and the enum `['Color']`.
- `ffi-generated.ts:init` requires `recordedCrateRev()` to be a 40-hex revision, and the written `rust/Cargo.toml` to contain `knext-ffi = { git = "<CRATE_GIT>", rev = "<rev>" }`.
- Egress proof (`ffi-egress-offline.ts`, S9-4): the CI job proves that the knext crates are reachable through the local rewrite alone. The positive cargo fetch must succeed, and cargo's git db under its own `CARGO_HOME` must hold the recorded rev as a commit. Cargo's output is not used: a `-q` fetch, or a ref already up to date, prints no `From` line, so the db is the evidence. The control, the same fetch with the rewrite removed, must fail with a connect error to `127.0.0.1 port 9`. A control that succeeds, or fails for any other reason (DNS, timeout), is a failure. The denial is scoped to github.com, not `HTTPS_PROXY`, because the crate pulls `serde` and `serde_json` from crates.io; `CARGO_NET_OFFLINE` is not used, because offline cargo cannot fetch a git revision it has never seen.

## NOT VERIFIED (founder decision)
- The recorded revision (`packages/ffi` `knextFfi.crateRev`) is **not** verified to be published on `CRATE_GIT` (`https://github.com/getknext-dev/knext`), where users fetch it. `assertRevOnBase` checks only that the revision is an ancestor of the PR base in the local clone, which is the personal fork's history. The egress proof shows that `CRATE_GIT` is served from the checkout with github.com closed; it does not show that `CRATE_GIT` holds the revision.
- This stays unverified while getknext-dev is restricted. Which source users fetch from is the founder's decision. Neither `CRATE_GIT` nor the supply-chain policy changes in this package.

## Side Effects
- With `KNEXT_FFI_LOCAL_REPO`, `ffi-generated.ts:init` sets `GIT_CONFIG_*` and `CARGO_NET_GIT_FETCH_WITH_CLI` in its own process env only; no git config file is written. The checkout must hold the recorded revision (full history).
- Loads native code with `dlopen` and spawns child processes (`Bun.spawnSync` in `ffi-harness.ts`, `spawnSync` in `ffi-generated.ts`).
- `ffi-generated.ts` writes temporary directories under `tmpdir()` (prefix `knext-ffi-gen-`) and removes them in `cleanup`.
- `ffi-generated.ts:init` runs cargo through `runGenerate`, which fetches `knext-ffi` at the recorded revision from GitHub, or from the local clone when `KNEXT_FFI_LOCAL_REPO` is set (`ffi-generated.ts:380-386`).

## Verification
- Run: `bun crates/harness/ffi-harness.ts <manifest|roundtrip|panic|leak> <path-to-fixture-lib>` and `bun crates/harness/ffi-generated.ts wrapper <path-to-fixture-lib>` (or `init`), after building the fixture in `crates/` (`cargo build --release -p knext-ffi-fixture`).
- Unit: `bun test tests/ffi-ci-local-crates.test.ts` asserts that the `rust-crates.yml` generator step serves the knext crates from the checkout, while the user-facing `Cargo.toml` keeps its git + rev dependency. It also runs the git half of the egress proof with real git against a local bare-repo fixture (the rewrite half, the denial half, and a quiet `-q` fetch), checks the verdict and the cargo wiring with a fake spawn that fills a real db, and guards the `Generator — egress denied` step's shape (present, after init, unmasked, exact run).
- Egress (CI, cargo half): `cd crates && KNEXT_FFI_LOCAL_REPO=<checkout> KNEXT_FFI_LOCAL_BASE_REF=HEAD bun harness/ffi-egress-offline.ts`. It needs the Rust toolchain and registry access (for serde); it is not part of the unit suite.
- Mutation proof: `node scripts/mutation-prove-s9-4-ffi-offline.mjs` (the rewrite, the denial, the verdict, the step's mask and the script's exit).
