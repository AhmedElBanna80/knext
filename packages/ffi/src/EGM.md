# src (@getknext/ffi sources)

## Overview
This is the implementation of the `knext ffi` verbs: `init`, `generate`, `check` and `build`. Together
they provide in-process Rust for Bun zones (Beta). `generate` and `check` build the zone's crate for
the host, scan the library's embedded `KNEXTFFI1` manifest from its bytes (the library is never
loaded), and render a typed `server-only` TypeScript module. `build` cross-compiles the crate for
the musl image behind supply-chain gates, stages it under `native/ffi/<triple>/`, and fails if the
committed wrapper has drifted. The bundled entries are `cli`, `render` and `build`
(`../tsup.config.ts`).

## Interface
- `cli.ts` is the dispatch surface that `@getknext/core` loads lazily.
  - `cli.ts:run(verb, argv, io)` returns an exit code and never calls `process.exit`.
  - Exported values: `cli.ts:DISPATCH_PROTOCOL` (`1`), `cli.ts:FFI_VERSION`,
    `cli.ts:CORE_PEER_RANGE` (from `package.json` `peerDependencies['@getknext/core']`),
    `cli.ts:VERBS` (`['ffi']`), `cli.ts:SUBCOMMANDS`, `cli.ts:BETA_NOTICE` and
    `cli.ts:helpText(sub)`.
  - Exported types: `cli.ts:BuildModule` and `cli.ts:RunIo`.
- `config.ts` handles `knext.ffi.json`.
  - Exported values: `CONFIG_FILE`, `DEFAULT_CONFIG` (`{version:1, crate:'rust',
    out:'src/generated/ffi'}`), `FfiUsageError`, `parseConfig`, `loadConfig` and `serializeConfig`.
  - Exported type: `FfiConfig`.
- `init.ts` holds `runInit`, `recordedCrateRev`, `CRATE_GIT` (`https://github.com/getknext-dev/knext`),
  `TEMPLATE_DIR` and the `RunInitOptions` type.
- `generate.ts` holds `runGenerate({cwd, check, io, deps})` and
  `generateFiles(libraryPath, config)`. `generateFiles` returns a `Map` of `.knext-generated.json`
  and `index.ts`. The file also exports the `Io`, `GenerateDeps` and `RunGenerateOptions` types and
  re-exports `MANIFEST`.
- `cargo.ts` holds `hostBuild(crateDir, env)`, which runs
  `cargo build --release --message-format=json-render-diagnostics`, and
  `pickCdylib(stdout, cargoToml)`, which picks the last `.so`/`.dylib` cdylib artifact whose
  manifest path is the zone crate's own `Cargo.toml`.
- `manifest.ts` is the manifest scanner.
  - Constants and types: `MAGIC` (`'KNEXTFFI1'`), `MANIFEST_VERSION` (`1`), `SCALARS`, `RESERVED`,
    `RESERVED_TYPES`, `ManifestError`, and the types `Scalar`, `TypeDesc`, `Arg`, `FnRecord`,
    `RecordType`, `EnumType` and `Manifest`.
  - Functions: `scanManifest(bytes)`, `manifestDigest`, `typeToken`, `schemaString` and `fnv1a64`.
- `render.ts` is the module emitter. It exports `renderModule(manifest, {libName, crate})`,
  `libNameOf(fileName)`, `RenderOptions` and `BETA_LINE`, and re-exports `Manifest`,
  `ManifestError` and `scanManifest`. It is the `@getknext/ffi/render` entry.
  - The module it emits exports one typed function per manifest function, an `interface` per
    record, a string-union `type` per enum, and the error classes `RustError`, `RustPanicError`
    and `FfiLoadError` (`render.ts:ERROR_CLASSES`).
- `output.ts` writes the generated output.
  - Values: `MANIFEST` (`'.knext-generated.json'`), `previouslyWritten`, `diffOutput`,
    `writeFileAtomic` and `ConfinedWriter` (with `check(path)` and `write(path, content)`).
  - Type: `Drift` (`changed | missing | stale`).
- `elf.ts` is the musl check. It exports `readElf(bytes)`, `assertMuslLibrary(bytes, triple, label)`,
  `allowedNeeded(arch)`, `tripleArch` and `ElfError`, plus the type `ElfInfo`.
- `build.ts` implements `build`.
  - Functions: `runBuild({cwd, argv, io, deps})` and `knextFfiRev(cargoLock)`.
  - Constants: `SUPPORTED_TARGETS` (`x86_64-unknown-linux-musl`, `aarch64-unknown-linux-musl`),
    `PROVENANCE_FILE` (`'provenance.json'`) and `INSTALL_HINTS`.
  - Types: `Runner`, `RunResult`, `BuildDeps` and `RunBuildOptions`.
- `supply-chain.ts` holds the supply-chain gates.
  - Pins: `CARGO_TOOL_PINS` (cargo-zigbuild 0.23.4, cargo-deny 0.20.2, cargo-auditable 0.7.7,
    cargo-cyclonedx 0.5.9) and `ZIG_PIN` (zig 0.17.0, one sha256-pinned archive each for
    `linux-x86_64`, `linux-aarch64` and `macos-aarch64`).
  - Gate functions: `prepareSupplyChain`, `assertGitSources`, `runCargoDeny`,
    `loadAdvisoryAllowlist`, `judgeAdvisories`, `parseDenyJson`, `checkCargoTools`, `resolveZig`
    and `releaseZig`.
  - Tool and artifact helpers: `zigbuildEnv`, `zigCacheDir`, `zigHostKey`, `readAuditData`,
    `assertAuditable`, `buildSbom`, `assertCycloneDx`, `cargoInstallCommand`,
    `resolveCargoSubcommand`, `versionOf` and `todayUtc`.
  - Constants: `DENY_FILE`, `ADVISORY_ALLOWLIST_FILE`, `SBOM_FILE` (`'sbom.cdx.json'`),
    `AUDIT_SECTION` (`'.dep-v0'`), `ALLOWED_GIT_SOURCE` (`init.ts:CRATE_GIT`) and
    `ZIG_DOWNLOAD_TIMEOUT_MS` (10 min).
  - Types: `CargoToolPin`, `CargoTool`, `ZigAsset`, `ZigPin`, `HostPlatform`, `ZigDeps`,
    `ResolvedZig`, `AllowEntry`, `AdvisoryFinding`, `DenyReport`, `AdvisoryVerdict`,
    `DenyOptions`, `AuditPackage`, `SupplyChainOptions` and `SupplyChain`.
- Tests live in `__tests__/`, which this contract does not document.

## Invariants
- **CLI dispatch** (`cli.ts:run`)
  - `cli.ts:run` handles only the verb `ffi`; any other verb, a missing or unknown subcommand
    exits 1. It prints `BETA_NOTICE` to stderr once a known subcommand runs without `--help`/`-h`.
  - `init`, `generate` and `check` take no options (`parseArgs` strict); `build` gets the rest of
    `argv`.
  - `build` is loaded at run time from `./build.js` (`cli.ts:defaultLoadBuild`). A module-not-found
    error becomes exit 1. Any other error propagates to the outer catch, which also exits 1.
- **Config** (`config.ts`)
  - `config.ts:parseConfig` accepts only `version: 1` and no unknown keys.
  - `crate` and `out` must be relative subdirectories of the app (`config.ts:subdir`). They cannot
    be the app root, absolute, contain `..` or a backslash, or contain a `node_modules` segment in
    any letter case.
- **Init** (`init.ts:runInit`)
  - It refuses unless the recorded crate revision is a 40-hex commit.
  - It writes nothing if `knext.ffi.json` or any top-level template entry already exists.
- **Manifest scanning** (`manifest.ts`)
  - The wrapper is derived from the built library's bytes, never from the Rust source
    (`generate.ts:generateFiles` calls `manifest.ts:scanManifest`).
  - `scanManifest` throws `ManifestError` in each of these cases:
    - no functions, or a version other than `MANIFEST_VERSION`;
    - a truncated or non-JSON record;
    - a duplicate function or type name, or an unresolved or mismatched record or enum reference;
    - `unit` anywhere but a top-level return, or an unknown scalar;
    - a symbol that does not match `knext_ffi_v1_<name>_<8 hex>`;
    - a function, argument, record or enum name that is not an ASCII identifier or is in
      `RESERVED`, or a record or enum name in `RESERVED_TYPES`;
    - a field name that is not a Rust identifier, or is `__proto__`.
  - `manifestDigest` is the sha256 of the sorted manifest. `schemaString` concatenates the
    function's `sig` with every record or enum it reaches, transitively and sorted by name.
- **Rendering** (`render.ts:renderModule`)
  - It is pure. The same manifest gives byte-identical output, so `generate`, `check` and the image
    drift check all agree.
  - The emitted module imports `'server-only'` first and has no static `bun:ffi` import. It gets
    `bun:ffi` through `process.getBuiltinModule` on the first call.
  - Loading fails closed:
    - It refuses during `NEXT_PHASE === 'phase-production-build'` and on a non-Bun runtime.
    - A library staged in `native/ffi/<triple>/` (`native/` beside `process.execPath`) must be
      listed in `native/.integrity.json` (version 1) with a matching sha256. If `native/ffi/`
      holds only other triples, the load fails.
    - The bytes are hashed through an open descriptor. On Linux the library is then loaded
      through that same descriptor (`/proc/self/fd/<n>`, never closed), so a file renamed or
      symlinked over the path after the check is not the one loaded. On macOS it is loaded by
      path, because dyld opens `/dev/fd/<n>` as a second library instance; a swap between the
      check and the load is not caught there.
    - The crate's `<cwd>/<crate>/target/{release,debug}` development build (newest by mtime) is
      used only when `NODE_ENV !== 'production'`, and without an integrity check.
    - Every `<symbol>_schema` must equal the FNV-1a 64 hash computed at render time.
    - The first load failure is cached and rethrown as `FfiLoadError`.
- **Output writes** (`output.ts`)
  - A file is stale only if the previous `.knext-generated.json` lists it, the current run does not
    produce it, and it is a regular file (`output.ts:diffOutput`).
  - Manifest entries that escape the output directory are dropped (`output.ts:previouslyWritten`).
  - `ConfinedWriter` never writes through a symlink, and never writes outside the app or the output
    directory. `writeFileAtomic` replaces the target by rename from an `O_EXCL | O_NOFOLLOW` temp
    file. `generate.ts:runGenerate` checks every target before writing any, and unlinks a stale
    file only if its real path is inside the real output directory.
- **Image build** (`build.ts:runBuild`)
  - It requires `--target` (only `SUPPORTED_TARGETS`), `--native-dir` and a committed
    `Cargo.lock`, because the build is `--locked`.
  - It cross-builds and validates every target before anything is staged. If one fails,
    `native/` is left unchanged.
  - Each cross-built library must pass two checks: it must be a `.so` that
    `elf.ts:assertMuslLibrary` accepts (arch matches the triple, and every `DT_NEEDED` is in
    `allowedNeeded`), and it must carry cargo-auditable data rooted at the crate
    (`supply-chain.ts:assertAuditable`).
  - If the committed wrapper differs from the one rendered from the staged library, `native/ffi/`
    is removed and the build exits 1.
- **Supply chain** (`supply-chain.ts`)
  - Git sources in `Cargo.lock` may only come from `ALLOWED_GIT_SOURCE`, whatever `deny.toml` says
    (`supply-chain.ts:assertGitSources`).
  - Every RustSec advisory needs an unexpired entry in `advisory-allowlist.json`. Each entry needs a
    `RUSTSEC-YYYY-NNNN` id, a justification and an `added` date. A malformed allowlist fails the
    build (`loadAdvisoryAllowlist`, `judgeAdvisories`).
  - A `zig` on PATH is used only if `zig version` equals `ZIG_PIN.version`; a different version is
    refused, never replaced. With no zig on PATH, the pinned archive for the host is used: the
    cached copy is re-hashed on every build and re-downloaded if it does not match, and a download
    whose sha256 differs from the pin, an unpinned host, or a failed extraction stops the build
    (`supply-chain.ts:resolveZig`).
  - Every pinned cargo tool must report exactly its pinned version
    (`supply-chain.ts:checkCargoTools`); cargo-auditable's version is read from `.crates2.json`
    beside its bin directory.
    `zigbuildEnv` sets `CARGO_ZIGBUILD_ZIG_COMMAND` so that cargo-zigbuild links with that exact
    zig.

## Side Effects
- **Child processes** (`spawnSync`)
  - `cargo build --release` runs from `cargo.ts:hostBuild`.
  - From `build.ts:runBuild`: `cargo --version`, `rustup target list --installed`, `rustc -V`, and
    `cargo auditable zigbuild --release --locked --target <triple>`, with
    `-C target-feature=-crt-static` appended to `RUSTFLAGS`.
  - From `supply-chain.ts`: each pinned tool's version probe and `zig version`
    (`checkCargoTools`, `resolveZig`), `cargo deny --locked check bans licenses sources` and
    `cargo deny --locked --format json … check advisories` (`runCargoDeny`), `cargo cyclonedx …`
    (`buildSbom`), and `tar -xJf` for the zig archive. Cargo's stderr is inherited, except the
    advisories run, whose JSON stderr is captured.
- **Network.** `supply-chain.ts:resolveZig` downloads the pinned zig from `ZIG_PIN.baseUrl` with
  `globalThis.fetch`, using a 10-minute timeout.
- **Disk writes**
  - `init.ts:runInit` writes `knext.ffi.json` and the template tree.
  - `generate.ts:runGenerate` writes or unlinks files under `config.out`.
  - `build.ts:runBuild` replaces `<native>/ffi/` with `lib<name>.so`, `provenance.json` and
    `sbom.cdx.json` per triple.
  - `cacheArchive` caches the zig archive (directories 0700, file 0600, written by rename) under
    `zigCacheDir`: `$KNEXT_CACHE_DIR`, `$XDG_CACHE_HOME/knext` or `~/.cache/knext`, then
    `zig/<version>`.
  - `extractZig` extracts zig into a `mkdtemp` `knext-zig-*` directory under the OS temp dir,
    which `releaseZig` removes (`SupplyChain.dispose`, called in `runBuild`'s `finally`).
  - `buildSbom` creates and removes `knext-ffi-sbom-<triple>.json` in the crate directory.
- **What the generated module does at run time** (`render.ts:renderModule`): it calls `dlopen` on
  the library (on Linux through the verified descriptor, which stays open) and reads `KNEXT_FFI_SLOW_CALL_MS` (default 50 ms, `0` turns counting off),
  `NODE_ENV` and `NEXT_PHASE`. It keeps a process-wide metrics registry at
  `globalThis[Symbol.for('knext.ffi.metrics')]`, publishes a Prometheus renderer at
  `Symbol.for('knext.ffi.renderMetrics')` after the first successful load
  (`knext_ffi_slow_calls_total`, `knext_ffi_load_seconds`), and logs with `console.warn` on the
  first slow call per function, on a development-build load, and on an unparseable
  `KNEXT_FFI_SLOW_CALL_MS`.

## Verification
- Run: the repo root `test` script, scoped to `packages/ffi`
