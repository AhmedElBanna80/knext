# deploy

## Overview

Groups release build recipes for artifacts knext consumes. It has no direct source files; its only
code subdirectory builds the opt-in patched Bun toolchain on Cloud Build.

## Subdirectories & Boundaries

- bun-patched: [./bun-patched/EGM.md](./bun-patched/EGM.md) - `sysroot.sh`, `build.sh` and
  `smoke.sh` build `bun-v1.4.2` plus the oven-sh/bun#44059 `--compile --include` backport for one
  linux-gnu target per build against a glibc 2.31 sysroot. They then prove lazy `--include` loading
  against a stock-Bun negative control, and `cloudbuild.yaml` uploads to
  `gs://gsw-mcp-bun-verify/bun-patched/`. This is the `compile.bun: 'knext-patched'` toolchain and is
  scheduled for retirement once a stock Bun ships the fix.
