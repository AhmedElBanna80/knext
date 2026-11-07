# templates/init

## Overview
The tree that `src/init.ts:TEMPLATE_DIR` points to. `src/init.ts:runInit` copies every file in it,
recursively and sorted, into the app root. Each `.tmpl` suffix is stripped and the
`{{KNEXT_FFI_GIT}}` and `{{KNEXT_FFI_REV}}` placeholders are filled. If `knext.ffi.json`, or any
top-level entry of this tree, already exists in the app, `runInit` writes nothing.

## Subdirectories & Boundaries
- rust: [./rust/EGM.md](./rust/EGM.md) is the starter zone crate (cdylib manifest, pinned
  toolchain, cargo-deny policy and `src/lib.rs`).
