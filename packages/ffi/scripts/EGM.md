# scripts (FFI e2e and CI harness)

## Overview
Standalone CI and e2e drivers for the in-process Rust feature. None of them is a package export:
`../tsup.config.ts` bundles only `src/`. They stage the fixture zone and the musl load matrix,
install the pinned Rust/zig toolchain on a runner, drive the zone's Rust-backed Server Actions
over HTTP, and run the unchanged compat-smoke runner (`apps/file-manager/scripts/compat-smoke.mjs`)
against a host-arch twin or against the shipped image.

## Interface
- `ffi-action-e2e.mjs`: `node ffi-action-e2e.mjs --url <base> --manifest <server-reference-manifest.json> [--host <h>] [--page <p>] [--metrics <url>]` (`--page` defaults to `/rust-ffi`).
  - It POSTs to the page with a `Next-Action` header, using the action ids from the manifest
    (`actionIds`), and parses the RSC result (`actionResult`).
  - It asserts the results of `greetAction`, `checkedGreetAction` (`RustError`) and
    `explodeAction` (`RustPanicError`), then that `greetAction` still answers after the panic.
    With `--metrics`, it asserts that two `pauseAction` calls add exactly 2 to
    `knext_ffi_slow_calls_total{fn="pause"}`, a fast `greetAction` adds 0 to `fn="greet"`, and
    there is one `knext_ffi_load_seconds` sample above 0 (`parseFfiMetrics`, `scrapeMetrics`).
  - It prints `KNEXT_FFI_ACTIONS {json}`. Usage errors exit 2 and assertion failures exit 1.
- `ffi-musl-driver.ts` is copied in as `driver.ts` and imports `./src/generated/ffi/index.ts`.
  - Every run starts with `checkEnvironment` (musl, `NODE_ENV=production`, a read-only root and
    TMPDIR). It then makes a first `m.noop()` call, which loads the library.
  - `driver all` runs `checkEveryExport` (the `CASES` keys must equal the module's function
    exports, the three error classes aside),
    `checkPanics` (`PANICS = 1000`) and `timings`.
  - `driver leak <phase>` runs `leakCheck` (`LEAK_CALLS = 1_000_000`, `LEAK_BOUND_MB = 48`) and
    exits with its code, which is 3 when the bound is exceeded.
  - Any other mode fails with a usage error. Both modes print `KNEXT_FFI_SUMMARY {json}`.
- `stage-musl-load.ts`: `bun stage-musl-load.ts --lib <lib.so> --triple <triple> --out <dir> [--stage-triple <triple>]`.
  - Missing `--lib`, `--triple` or `--out` exits 2.
  - It runs `src/elf.ts:assertMuslLibrary`, then renders the wrapper with
    `src/generate.ts:generateFiles`.
  - It writes `<dir>/app` (the wrapper, `driver.ts` and a stub `server-only` package under
    `node_modules/`), `<dir>/app-leak` (a wrapper with its `knext_ffi_v1_free` calls removed; staging exits 1 unless
    there are exactly 2 to remove),
    `<dir>/native` (with the integrity manifest from
    `packages/kn-next/src/cli/native-integrity.ts:writeNativeIntegrityManifest`) and `<dir>/needed`.
- `stage-ffi-zone.sh <repo-root> <dest>` uses `git archive` to copy the tracked
  `apps/file-manager` into `<dest>` and lays the `fixtures/ffi-zone` opt-in over it.
  `FFI_E2E_OVERLAY=none` skips the overlay. `FFI_E2E_MUTATION` accepts `none`, `wrong-triple`,
  `leak` and `compat-check`; only `compat-check` changes the stage (it deletes
  `src/app/knext-smoke/stream`).
- `install-ffi-toolchain.sh <crate-dir> [--supply-chain] [<rust-target>...]` installs rustup
  1.28.2 (only when no `rustup` is on PATH), the crate's pinned toolchain with the requested
  targets, zig 0.17.0 and cargo-zigbuild 0.23.4 (release binary). With `--supply-chain` it also
  installs cargo-deny 0.20.2 (release binary) and, through `cargo install --locked --version`,
  cargo-auditable 0.7.7 and cargo-cyclonedx 0.5.9. It supports x86_64 and aarch64 Linux only.
- `compile-smoke-twin.ts`: `bun compile-smoke-twin.ts <app-dir> <out-file>`. It calls
  `buildStandaloneExecutable` (`packages/kn-next/src/cli/standalone-exec-build.ts`) with
  `hostSmokeArch()` (`packages/kn-next/src/cli/vinext-build.ts`). Missing arguments exit 2.
- `run-compat-smoke.sh <repo-root> <app-dir> <scratch-dir>` copies the standalone tree to the
  scratch directory, compiles the twin, flushes Redis and runs the compat-smoke runner with
  `RUNTIME=bun`.
- `run-compat-smoke-image.sh <repo-root> <image-ref>` does the same against the shipped image. It
  goes through `shipped-image-exec.sh`, and reads the executable path from the image's
  `STANDALONE_SERVER_EXEC`.
- `shipped-image-exec.sh` is the `SERVER_CMD` that boots the image with its own ENTRYPOINT. When
  `BUN_BE_BUN=1`, it runs the compiled executable as the bun CLI instead. It reads
  `KNEXT_SMOKE_IMAGE`, `KNEXT_SMOKE_IMAGE_EXEC` and `KNEXT_SMOKE_CONTAINER`.
- `redis-flush.mjs`: `REDIS_URL=… node redis-flush.mjs` sends raw-RESP `FLUSHALL`, then requires
  `DBSIZE` to answer `:0`.

## Invariants
- `run-compat-smoke-image.sh` and `shipped-image-exec.sh` refuse an image ref without `@sha256:`.
  `shipped-image-exec.sh` also refuses any server arguments, exiting 2.
- `stage-ffi-zone.sh`, `run-compat-smoke.sh` and `stage-musl-load.ts` work on copies.
  - `stage-ffi-zone.sh` and `run-compat-smoke.sh` fail if their destination or scratch directory
    already exists.
  - `stage-ffi-zone.sh` never modifies `apps/file-manager` (from its header comment).
  - `run-compat-smoke.sh` never touches the build's own `.next/standalone`.
- `redis-flush.mjs` exits 1 in four cases: `REDIS_URL` is unset or not a URL, the server is
  unreachable, `FLUSHALL` does not answer `+OK`, or `DBSIZE` is not `:0`.
- `install-ffi-toolchain.sh` must carry the same pins as `src/supply-chain.ts:CARGO_TOOL_PINS` and
  `ZIG_PIN`. Its header says to keep the two equal. A sha256 mismatch on any download fails the
  install.

## Side Effects
- **Docker.** `docker pull`, `docker image inspect`, `docker run --network host` and
  `docker rm -f` (the image scripts).
- **Network**
  - TCP to Redis (`redis-flush.mjs`), which empties every Redis database.
  - HTTP to the app and its metrics port (`ffi-action-e2e.mjs`).
  - Toolchain downloads (`install-ffi-toolchain.sh`).
- **Disk.** The staging scripts write their output trees. In its copy, `stage-ffi-zone.sh`
  deletes test and tooling files, rewrites the crate's `knext-ffi` path dependency to
  `<repo-root>/crates/knext-ffi`, drops the workspace dependencies from `package.json` (whose
  scripts become `{build: "next build"}`), and removes the two tracing-root pins from
  `next.config.ts`. The path and `next.config.ts` rewrites fail unless their anchor occurs
  exactly once, and the `package.json` rewrite fails if any `workspace:` range remains. `install-ffi-toolchain.sh` appends to
  `$GITHUB_PATH` when it is set.
- **Builds.** `compile-smoke-twin.ts` compiles a Bun single executable.

## Verification
- Run: the repo root `test` script, scoped to `packages/ffi`
