# knext-ffi-fixture

## Overview
The `knext-ffi-fixture` test fixture crate (`Cargo.toml`: edition 2024, `crate-type = ["cdylib", "rlib"]`, `publish = false`, depends on `knext-ffi` by path). Edition 2024 is deliberate: it shows that the macro output compiles on both editions. Its `tests/` directory (the ABI and ownership tests) is a test-only directory and is not documented here.

## Subdirectories & Boundaries
- src: [./src/EGM.md](./src/EGM.md). One export per row of the type table, plus the `Point`, `Color`, `Child` and `Reading` records that the Bun harnesses and the Rust ABI tests call.
