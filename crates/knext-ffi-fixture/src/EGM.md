# knext-ffi-fixture/src

## Overview
Test fixture library (`publish = false`, edition 2024, `crate-type = ["cdylib", "rlib"]`). It has one `#[export]` per row of the type table, plus error, panic and non-finite-float exports. The Bun harnesses load it as a cdylib, and the Rust ABI tests (`tests/abi.rs`) use it as an rlib (`lib.rs` crate docs).

## Interface
- Records, declared in the private module `types` and glob re-exported with `pub use types::*`:
  - `Point`: every JSON field kind, including 64-bit (`id`, `delta`, `size`, `offset`, `ids`), `Option` (`maybe`, `child`, `count`), `Vec` (`tags`, `raw`, `deltas`), enum (`color`) and nested-record (`child`) fields
  - `Color`: unit enum with `Red`, `Green`, `Blue`
  - `Child`: `name: String`, `flag: bool`
  - `Reading`: `value: Option<f64>`, `samples: Vec<Option<f32>>`
- `#[export]` functions:
  - Scalars: `echo_i8`, `echo_i16`, `echo_i32`, `echo_u8`, `echo_u16`, `echo_u32`, `echo_i64`, `echo_u64`, `echo_isize`, `echo_usize`, `echo_f32`, `echo_f64`, `not`, `add` (wrapping)
  - Strings: `greet`, `greet_ref`, `echo_string`, `str_len`, `concat`, `empty_string`, `make_string`
  - Bytes: `echo_bytes`, `sum_bytes`, `bytes_len`, `empty_bytes`, `make_bytes`
  - Unit: `noop`, `unit_ret`
  - JSON: `echo_point`, `mid`, `next_color`, `echo_opt_i64`, `echo_opt_u64`, `echo_opt_string`, `echo_vec_point`, `echo_vec_i64`, `echo_vec_usize`, `echo_vec_string`, `echo_opt_color`, `echo_opt_f64`, `echo_reading`
  - Non-finite refusal: `non_finite_opt`, `non_finite_reading`
  - `Result`: `parse_i32`, `fallible_unit`, `fallible_point`
  - Panics: `boom`, `boom_static`, `boom_any` (`panic_any(42_i32)`)

## Invariants
- `crates/harness/ffi-harness.ts:modeManifest` counts the lines that are exactly `#[export]` and `#[record]` in this file and requires exactly that many manifest records, so every export and record must keep its attribute on its own line. It also requires the doc comment `Says hello.` on `greet`.
- `crates/harness/ffi-generated.ts:wrapper` matches `#[export]` followed by optional `///` lines and `pub fn <name>`, requires more than 30 such exports and the scanned manifest to list exactly those, and expects the records `['Child', 'Point', 'Reading']` and the enum `['Color']`.
- `crates/harness/ffi-harness.ts:modeLeakPhase` uses `echo_string`, `echo_bytes` and `echo_point` as its leak-check calls.
- `non_finite_opt` and `non_finite_reading` deliberately return non-finite floats so that the call is refused with status 3.

## Side Effects
- None beyond what `knext-ffi` provides (`boom*` panic on purpose, and `__rt::call` catches the panic).

## Verification
- Run: `cargo test -p knext-ffi-fixture` (in `crates/`). For the Bun checks, build the release-profile cdylib and run `bun crates/harness/ffi-harness.ts <manifest|roundtrip|panic|leak> <lib>`.
