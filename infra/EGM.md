# infra

## Overview

Groups build infrastructure that runs outside the knext packages. It has no direct source files;
its only code subdirectory builds a patched Bun on Cloud Build for CI verification of upstream Bun
fixes, never for users.

## Subdirectories & Boundaries

- bun-base: [./bun-base/EGM.md](./bun-base/EGM.md) - `build.sh` builds a release Bun from a pinned
  `oven-sh/bun` main commit (`UPSTREAM_SHA`) plus `patches/*.patch` for the x64 and aarch64 musl
  targets, with every network fetch either checked against a value committed in that directory
  (`fetch-pins.sha256`, the LLVM signer fingerprint, `keys/`, `UPSTREAM_SHA`) or listed in
  `unpinned-fetches.json`. `prefix.sh` derives the `<upstream-sha>-<patchset-hash>` artifact
  prefix, and `cloudbuild.yaml` uploads binaries, SBOMs and `SHA256SUMS` to
  `gs://gsw-mcp-bun-base/`.
