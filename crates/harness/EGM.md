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
  - Imports `runGenerate` (`packages/ffi/src/generate`), `CRATE_GIT`, `recordedCrateRev`, `runInit` (`packages/ffi/src/init`), `scanManifest` (`packages/ffi/src/manifest`), `libNameOf`, `renderModule` (`packages/ffi/src/render`) and `integerMatrix` (`packages/ffi/src/__tests__/integer-matrix`).
  - `wrapper`: scans and renders the module, stages the library under `native/ffi/<triple>/` with a sha256 `.integrity.json`, and calls through the generated module in a child Bun process (`inBun`, `--conditions=react-server`, `NODE_ENV=production`), including the `integerMatrix` integer-argument cases.
  - `init`: runs `runInit`, then `runGenerate` (with and without `check`, including a deliberately drifted wrapper), then calls `greet` through the generated module.

## Invariants
- `ffi-harness.ts:load` computes every buffer argument's pointer only after all arguments are encoded into the growable scratch buffer, so growing the buffer cannot invalidate an earlier pointer. An empty buffer is passed as `(null, 0)`.
- `ffi-harness.ts:load` (`take`) frees each non-empty returned buffer exactly once with `knext_ffi_v1_free`, unless `--no-free` is set. It maps status 1 to `RustError`, 2 to `RustPanicError` and 3 to `RustError("invalid input: ...")`.
- `ffi-harness.ts:modeLeakPhase` fails a phase (exit 1) when RSS grows by more than `LEAK_BOUND_MB` (48) over `LEAK_CALLS` (1e6) calls, after 10 000 warm-up calls. The `leak` exit code is the number of phases over the bound, so `--no-free` must exit 3. A phase exiting with anything other than 0 or 1 is a harness failure.
- `ffi-generated.ts:wrapper` requires the scanned functions to equal the fixture source's `#[export]` functions exactly (more than 30), the records `['Child', 'Point', 'Reading']` and the enum `['Color']`.
- `ffi-generated.ts:init` requires `recordedCrateRev()` to be a 40-hex revision, and the written `rust/Cargo.toml` to contain `knext-ffi = { git = "<CRATE_GIT>", rev = "<rev>" }`.

## Side Effects
- Loads native code with `dlopen` and spawns child processes (`Bun.spawnSync` in `ffi-harness.ts`, `spawnSync` in `ffi-generated.ts`).
- `ffi-generated.ts` writes temporary directories under `tmpdir()` (prefix `knext-ffi-gen-`) and removes them in `cleanup`.
- `ffi-generated.ts:init` runs cargo through `runGenerate`, which fetches `knext-ffi` from GitHub at the recorded revision.

## Verification
- Run: `bun crates/harness/ffi-harness.ts <manifest|roundtrip|panic|leak> <path-to-fixture-lib>` and `bun crates/harness/ffi-generated.ts wrapper <path-to-fixture-lib>` (or `init`), after building the fixture in `crates/` (`cargo build --release -p knext-ffi-fixture`).
