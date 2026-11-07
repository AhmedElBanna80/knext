# templates/init/rust/src

## Overview
The starter Rust source that `knext ffi init` copies into a zone's new `rust/src/` crate
directory. `src/init.ts:runInit` copies every file under `templates/init/` verbatim, apart from
stripping a `.tmpl` suffix and filling placeholders. This file has no placeholders, so it lands
unchanged.

## Interface
- `lib.rs:greet(name: &str) -> String` is marked `#[knext_ffi::export]` and returns
  `format!("Hello, {name}!")`. `knext ffi generate` turns it into the typed `greet` export of the
  generated module.

## Invariants
- An exported function must be a `pub fn` marked `#[knext_ffi::export]` (from the doc comment in
  `lib.rs`). The `knext-ffi` macro crate that expands it is not in this package.
- The doc comment says a call should stay well under a millisecond, because it blocks the server
  while it runs. The generated module counts calls slower than `KNEXT_FFI_SLOW_CALL_MS`
  (`src/render.ts:renderModule`, runtime `$slow`).

## Side Effects
- None. `greet` is a pure string format.

## Verification
- Run: `node scripts/bun-test.mjs packages/ffi` (from the repo root)
