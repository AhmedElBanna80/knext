# deploy/bun-patched

## Overview

Cloud Build recipe for the opt-in patched Bun toolchain selected by `compile.bun: 'knext-patched'`:
a release Bun built from the `bun-v1.4.2` tag plus `patches/001-bun-44059-compile-include.patch`
(a backport of oven-sh/bun#44059, `--compile --include`), for one linux-gnu target per build, linked
against a glibc 2.31 sysroot. knext runs it for the `bun build --compile` step only (`build.sh`
header; `cloudbuild.yaml` header). The human-maintained guide is [`README.md`](./README.md); this
file is the code contract.

## Interface

- `sysroot.sh <x64|aarch64>` (Cloud Build step `sysroot`, digest-pinned `ubuntu:20.04`) — produces
  `/workspace/sysroot-<target>.tar` from the container's own `usr/include`, `usr/lib`, `lib`
  (and `lib64`), overlaid with the pinned `gcc-13-focal-<debarch>.tar.gz` debs. Unknown target exits 2.
- `build.sh <x64|aarch64>` (step `build`, digest-pinned `ubuntu:24.04`) — reads `UPSTREAM`
  (`<tag> <40-hex>`), applies `patches/*.patch`, builds with
  `bun scripts/build.ts --profile=release --os=linux --arch=<target> --abi=gnu --canary=off`, and
  writes `/workspace/out/bun-linux-<target>`, `bun-linux-x64.revision` (x64 only),
  `manifest-<target>.json` (fields `upstream_tag`, `upstream_sha`, `patched_head`, `patches`,
  `target`, `profile`, `toolchain`, `max_glibc_symbol`, `build_id`, plus `purpose` and
  `upstream`), and `/workspace/stock-bun` (stock 1.4.2 for the smoke's negative control). Pins:
  `LLVM_MAJOR=21`, `LLVM_SIGNER_FPR`, `BOOTSTRAP_BUN=1.4.2`, `RUSTUP_VERSION=1.29.1`. Unknown
  target exits 2; it also installs the opposite-arch cross binutils (`XBINUTILS`).
  - `build.sh:pin`, `sysroot.sh:pin` — verify a file against exactly one `fetch-pins.sha256` line.
  - `build.sh:lap` — per-phase wall-clock stamp.
- `smoke.sh` (Cloud Build step `smoke` runs it for `_TARGET=x64` only and just echoes for other
  targets; `.github/workflows/bun-patched-release.yml` also runs it against the downloaded x64 and
  aarch64 release assets) —
  env `BUN` (default `/workspace/out/bun-linux-x64`) and `STOCK_BUN` (default
  `/workspace/stock-bun`); compiles a probe with `--include=./plugins`, deletes the sources, runs
  from an empty directory, and prints `SMOKE_OK …` on success.
- `cloudbuild.yaml` — steps `sysroot` and `smoke` (digest-pinned `ubuntu:20.04`), `build`
  (digest-pinned `ubuntu:24.04`), `sbom-source` and `sbom-binary` (digest-pinned
  `anchore/syft:v1.52.0`, writing `bun-source-<target>.cdx.json` and
  `bun-linux-<target>.cdx.json`), `digests-and-upload` (digest-pinned cloud-sdk:slim); substitution
  `_TARGET` (default `x64`).
- Data files: `UPSTREAM`, `fetch-pins.sha256`, `patches/SHA256SUMS`, `RELEASE.sha256` (sha256 of the
  released `bun-linux-x64` / `bun-linux-aarch64`, read by `.github/workflows/bun-patched-release.yml`).

## Invariants

- `UPSTREAM`'s second field must be 40-hex, and the fetched `refs/tags/<tag>` must resolve to
  exactly that commit (`build.sh` `read -r UPSTREAM_TAG UPSTREAM_SHA` and `test … = "$UPSTREAM_SHA"`).
- Each patch filename must match `^[0-9]{3}-[a-z0-9-]+\.patch$` and contain the lines
  `Upstream: oven-sh/bun#<N>` and `knext-shim: <id>`; `patches/SHA256SUMS` must pass
  `sha256sum -c --strict` before the toolchain is installed (`build.sh` patch header lint).
- Downloads (bootstrap Bun zip, rustup-init, WebKit tarball, `gcc-13-focal-<debarch>.tar.gz`) are checked via `pin`;
  the Bun zip is also checked against the release's `SHASUMS256.txt` (`build.sh`, `sysroot.sh`).
- The apt.llvm.org key must be one primary key matching `LLVM_SIGNER_FPR`, scoped with `signed-by`
  (`build.sh` toolchain block). Unlike `infra/bun-base`, the LLVM package version is not pinned; it
  is recorded from `dpkg-query` into the manifest (`build.sh` `LLVM_PKG`).
- The sysroot must contain `usr/include/c++/13`, keep `lib` as the merged-/usr symlink, and contain
  `libc.so`, `libc.so.6` and `libc_nonshared.a` for the triple (`sysroot.sh` final `test` checks).
- The build log must show the seeded WebKit prefetch-cache key was used, and the binary's highest
  `GLIBC_2.x` symbol must be `<= 2.31`, else the build fails (`build.sh` `maxglibc` case).
- x64: `--revision` must contain the first 9 hex of the patched HEAD (`build.sh`).
- Smoke: the included module must not be evaluated at startup and must load on demand from the
  executable; if the stock 1.4.2 control loads it, the smoke fails as non-discriminating
  (`smoke.sh`).
- Retirement: delete this directory once a stock Bun release ships oven-sh/bun#44059, signalled by
  the `bun-patched-toolchain` probe in `tests/upstream-retirement/registry.ts` (`UPSTREAM` comment,
  `build.sh` header).

## Side Effects

- Network: Ubuntu archive / `ports.ubuntu.com` (arm64), apt.llvm.org, `github.com/oven-sh/bun`
  releases and tag fetch, `static.rust-lang.org`, `github.com/oven-sh/WebKit` releases (WebKit and
  `gcc-13-focal-debs`), plus `bun install` and Bun's own build fetches (`build.sh`, `sysroot.sh`).
- Filesystem (build containers): rewrites `/etc/apt/sources.list` and adds the arm64 dpkg
  architecture (`sysroot.sh`, aarch64), writes `/workspace/sysroot-<target>.tar`, the sysroot under
  `/opt/linux-sysroot-glibc[-arm64]` with re-rooted absolute symlinks, `/workspace/bun`,
  `/workspace/out`, `/workspace/stock-bun`, the seeded WebKit cache under
  `BUN_BUILD_PREFETCH_DIR=/tmp/bun-prefetch` (`build.sh`); `smoke.sh` writes into a `mktemp -d`.
- GCS upload: `digests-and-upload` writes `bun-linux-<target>.sha256` and `SHA256SUMS-<target>`
  (every file in `/workspace/out` except `*.sha256`) and copies `/workspace/out/*` (binary,
  manifest, both SBOMs, digests) to `gs://gsw-mcp-bun-verify/bun-patched/<BUILD_ID>/`. No signing here;
  runs as the project's default build service account (`cloudbuild.yaml` header).

## Verification

- Run: `node scripts/bun-test.mjs tests/bun-patched-release-workflow.test.ts` (from repo root).
