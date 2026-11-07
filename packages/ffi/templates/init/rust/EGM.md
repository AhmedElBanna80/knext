# templates/init/rust

## Overview
The starter crate that `knext ffi init` (`src/init.ts:runInit`) writes as the zone's `rust/`
directory. The files here are manifests and policy, not source. The only code is in `src/`.

- `Cargo.toml.tmpl` declares package `zone` with `crate-type = ["cdylib"]`. Its `knext-ffi`
  dependency is a git dependency at `{{KNEXT_FFI_GIT}}` / `{{KNEXT_FFI_REV}}`, which `runInit`
  fills with `src/init.ts:CRATE_GIT` and the 40-hex `package.json` `knextFfi.crateRev`. Its
  release profile sets `lto = true`, `codegen-units = 1` and `strip = true`.
- `rust-toolchain.toml` pins channel `1.97.1` with targets `x86_64-unknown-linux-musl` and
  `aarch64-unknown-linux-musl`.
- `deny.toml` is the cargo-deny policy. `knext ffi build` runs it via
  `src/supply-chain.ts:runCargoDeny`, and it sets `yanked = "deny"` and `ignore = []`.

## Subdirectories & Boundaries
- src: [./src/EGM.md](./src/EGM.md) holds the starter `lib.rs`, with one
  `#[knext_ffi::export]` function, `greet`.
