# knext-ffi-macros

## Overview
The `knext-ffi-macros` proc-macro crate (`Cargo.toml`: `proc-macro = true`, version 0.1.0, `publish = false`, depends on `proc-macro2`, `quote` and `syn` 3). It is meant to be used through `knext-ffi`, which re-exports its macros.

## Subdirectories & Boundaries
- src: [./src/EGM.md](./src/EGM.md). `#[export]` (the `extern "C"` shim, the `_schema` companion and the manifest record) and `#[record]` (serde encoding, `KnextSchema`, `Wire` and the manifest record), plus the type-table classification in `types.rs`.
