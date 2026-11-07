# @getknext/ffi (packages/ffi)

## Overview
`@getknext/ffi` (Beta, `private: true` in `package.json`) is an optional package for in-process
Rust in Bun zones. It provides the `knext ffi` commands (`init`, `generate`, `check`, `build`) and
a generator for typed, `server-only` wrappers over `bun:ffi`. `@getknext/core` owns the `knext`
binary and loads this package only for `knext ffi` (`src/cli.ts`, header comment). The core range
is declared as an optional peer dependency (`package.json` `peerDependencies['@getknext/core']`
`>=2.0.0-0 <3.0.0`, with `peerDependenciesMeta` setting `optional: true`).

The only direct source file at this level is `tsup.config.ts`.

## Interface
- **Package exports** (`package.json` `exports`)
  - `./cli` maps to `dist/cli.js`, built from `src/cli.ts` (`run`, `DISPATCH_PROTOCOL`,
    `CORE_PEER_RANGE` and the rest).
  - `./render` maps to `dist/render.js`, built from `src/render.ts`: `renderModule`, plus
    `scanManifest` and `ManifestError` re-exported.
  - `./package.json`.
- **Build config** (`tsup.config.ts`)
  - Entries are `cli` and `render`, plus `build` (`src/build.ts`) when that file exists.
  - Output is ESM, `dts: true`, `target: 'node22'`, written to `dist/`.
- **Recorded crate pin.** `package.json` `knextFfi.crateRev` is a 40-hex commit of the `knext-ffi`
  crate, read by `src/init.ts:recordedCrateRev`.
- **Subdirectories**
  - [./src/EGM.md](./src/EGM.md): the verbs, the manifest scanner, the module renderer, the
    confined output writer, the ELF musl check and the supply-chain gates.
  - [./scripts/EGM.md](./scripts/EGM.md): the CI and e2e harness (fixture zone and musl-matrix
    staging, the Server Action driver, the toolchain installer, compat-smoke against a twin or
    the shipped image).
  - [./templates/EGM.md](./templates/EGM.md): the starter `rust/` crate that `knext ffi init`
    writes.
  - `fixtures/` holds test fixtures, which this contract does not document.

## Invariants
- The tarball ships only `dist` and `templates` (`package.json` `files`). `dist/cli.js` reads
  `../package.json` and `../templates/` at run time (`tsup.config.ts`, header comment;
  `src/cli.ts`; `src/init.ts:TEMPLATE_DIR`).
- `DISPATCH_PROTOCOL` (`src/cli.ts`) changes only on a breaking change to the module shape that
  core calls.
- The wrapper is derived from the built library's embedded `KNEXTFFI1` manifest, never from the
  Rust source. The generated module checks each function's `_schema` hash against the library
  when it loads.
- The wrapper must match its library in two places. `knext ffi check` exits 1 on drift
  (`src/generate.ts:runGenerate`). `knext ffi build` removes `native/ffi/` and exits 1 if the
  committed wrapper does not match the library staged for the image (`src/build.ts:runBuild`).
- The generated module runs only on Bun. It refuses during `next build` prerendering, and in
  production it loads only an integrity-verified library (`src/render.ts:renderModule`).

## Side Effects
- `knext ffi` runs `cargo`, `rustup`, `rustc`, `tar` and the pinned cargo subcommands as child
  processes. It may download zig from `ziglang.org`. It writes `knext.ffi.json`, the starter
  crate, the generated output directory and `<native>/ffi/`. `src/EGM.md` has the details.
- The scripts use Docker, Redis and HTTP, and write staging trees. `scripts/EGM.md` has the
  details.

## Verification
- Run: the repo root `test` script, scoped to `packages/ffi`
- Typecheck: the `package.json` `typecheck` script, which runs `tsc` against
  `tsconfig.typecheck.json` and `fixtures/app/tsconfig.json`.
