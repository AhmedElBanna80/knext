# knext-ffi

## Overview
The `knext-ffi` crate (`Cargo.toml`: version 0.1.0, edition 2021, `publish = false`) is the runtime for knext in-process Rust over `bun:ffi` (ABI v1, Beta). It depends on `knext-ffi-macros`, `serde` and `serde_json`. Its `tests/` directory (trybuild rejection cases and panic tests) is a test-only directory and is not documented here.

## Subdirectories & Boundaries
- src: [./src/EGM.md](./src/EGM.md). The C ABI symbols `knext_ffi_v1_free` and `knext_ffi_v1_abi`, the status codes, the macro-only `__rt` runtime (`call`, argument decoding, `schema_hash`, manifest assembly), and the `wire` JSON codec (64-bit integers as decimal strings, finite floats only).
