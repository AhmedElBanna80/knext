# crates

## Overview
A Cargo workspace for knext's in-process Rust crates (Beta) only. It deliberately sits outside the repository root so no tool mistakes the monorepo for a Rust project (`Cargo.toml` header comment).
- `Cargo.toml` `[workspace]` sets `resolver = "2"` and has the members `knext-ffi`, `knext-ffi-macros` and `knext-ffi-fixture`.
- `[profile.release]` sets `opt-level = 3`, `lto = true`, `codegen-units = 1` and `strip = true`. The comment there says this is the profile the manifest-survival check (`crates/harness/ffi-harness.ts`, mode `manifest`) builds the fixture with, so embedded manifest records must survive it.
- The toolchain is pinned in `rust-toolchain.toml` (channel `1.97.1`, profile `minimal`, with `rustfmt` and `clippy`).
- `deny.toml` is the cargo-deny policy, run by `.github/workflows/rust-crates.yml`: yanked crates and any advisory not in the (empty) `ignore` list fail; licenses are limited to `Apache-2.0`, `MIT` and `Unicode-3.0`; wildcard versions are denied (workspace path dependencies excepted); only the crates.io registry is allowed, with no git sources.
- `.gitignore` ignores `/target` and re-includes the three crate directories, because the root `.gitignore`'s unanchored `knext-*/` pattern would otherwise match them.
- The human-maintained ABI and type contract is [README.md](./README.md).

## Subdirectories & Boundaries
- knext-ffi: [./knext-ffi/EGM.md](./knext-ffi/EGM.md). The runtime crate: C ABI v1 symbols, shim status codes, the panic-catching `__rt::call`, and the JSON `wire` codec.
- knext-ffi-macros: [./knext-ffi-macros/EGM.md](./knext-ffi-macros/EGM.md). The `#[export]` and `#[record]` proc macros, which generate the shims, schema hashes and embedded `KNEXTFFI1` manifest records.
- knext-ffi-fixture: [./knext-ffi-fixture/EGM.md](./knext-ffi-fixture/EGM.md). The cdylib and rlib test fixture, with one export per type-table row.
- harness: [./harness/EGM.md](./harness/EGM.md). Bun scripts that load the fixture library through `bun:ffi` and through the `@getknext/ffi` generated module.

Verification: run `cargo test` in `crates/`. Run the Bun harness modes after `cargo build --release -p knext-ffi-fixture`.
