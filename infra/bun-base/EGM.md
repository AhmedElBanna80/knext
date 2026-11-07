# infra/bun-base

## Overview

Cloud Build recipe for a patched **release** Bun built from a pinned `oven-sh/bun` main commit
(`UPSTREAM_SHA`) plus `patches/*.patch`, for the two musl targets `linux-x64-musl` and
`linux-aarch64-musl`, cross-compiled from one x64 host against Alpine-derived musl sysroots
(`build.sh` header). The output is for CI verification of upstream Bun fixes only and is never
shipped to users (`build.sh` header; `build.sh` `manifest.json` heredoc field `purpose`). The
human-maintained guide is [`README.md`](./README.md); this file is the code contract.

## Interface

- `build.sh` (entry point, run as `bash /workspace/build.sh` by the `build` step of
  `cloudbuild.yaml`). Environment inputs: `BUN_BASE_TARGETS` (default `x64 aarch64`, bound to
  `TARGETS`), `BUILD_ID` (default `local` in the manifest). Toolchain pins: `LLVM_MAJOR=23`,
  `LLVM_PKG_VERSION`, `LLVM_SIGNER_FPR`, `ALPINE_RELEASE=3.23`, `APK_TOOLS_STATIC_VERSION`,
  `BOOTSTRAP_BUN=1.4.2`, `RUSTUP_VERSION=1.29.1`.
  - `build.sh:pin` — verifies a downloaded file against exactly one line of `fetch-pins.sha256`.
  - `build.sh:lap` — prints a `### LAP <phase> at <time>` wall-clock stamp per phase.
  - A target other than `x64` or `aarch64` in `TARGETS` exits 1 (`build.sh` build-loop `case`).
  - Outputs in `/workspace/out`: `bun-linux-<arch>-musl`, `bun-linux-x64-musl.revision`,
    `manifest.json` (fields `purpose`, `upstream`, `upstream_sha`, `patched_head`, `prefix`,
    `patches`, `targets`, `profile`, `build_id`); writes the prefix to `/workspace/.prefix`.
- `prefix.sh` (run as `bash prefix.sh`, never sourced) — prints `<upstream-sha>-<patchset-hash>`,
  where the hash is the first 12 hex of a sha256 over `sha256sum` of every `patches/*.patch` in
  C-locale order. Shared by `build.sh` and `.github/workflows/bun-base-build.yml` (`prefix.sh`
  header comment; the workflow's `bash infra/bun-base/prefix.sh`).
- `unpinned.mjs` — ES module exports `BEGIN`, `END`, `entries()` (parses
  `unpinned-fetches.json`) and `render()` (renders the list as a Markdown block between the
  markers). `node infra/bun-base/unpinned.mjs --write` rewrites that block in `README.md`.
- `cloudbuild.yaml` — steps `build` (digest-pinned `ubuntu:24.04`), `sbom` and `sbom-artifacts`
  (digest-pinned `anchore/syft:v1.52.0`), `digests-and-upload` (digest-pinned cloud-sdk:slim);
  substitution `_TARGETS`; runs as service account
  `bun-base-build@gsw-mcp.iam.gserviceaccount.com`.
- Data files read by the scripts: `UPSTREAM_SHA` (first non-comment line, 40-hex), `fetch-pins.sha256`,
  `unpinned-fetches.json` (entries with `id`, `scope`, `calls`, `match`, `what`, `why`),
  `keys/SHA256SUMS` plus `keys/<arch>/*.rsa.pub`, `patches/*.patch` (currently none; see
  [`patches/README.md`](./patches/README.md)).

## Invariants

- `UPSTREAM_SHA` must be a 40-hex commit or `prefix.sh` exits 1 (`prefix.sh` regex check); the
  checked-out HEAD must equal it (`build.sh`: `test "$(git rev-parse HEAD)" = "$UPSTREAM_SHA"`).
- Every patch filename must match `^[0-9]{3}-[a-z0-9-]+\.patch$` and its body must contain
  `oven-sh/bun#<N>` and `knext-shim: <id>`, checked before any expensive work (`build.sh` patch
  header lint loop).
- The directly downloaded files (`bun-linux-x64.zip`, `rustup-init`, `apk-tools-static.apk`, and
  the per-arch `bun-webkit-linux-<arch>-musl-lto-<16-hex>.tar.gz`) are checked against
  `fetch-pins.sha256` via `pin`, which demands exactly one matching line (`build.sh:pin`); the
  bootstrap Bun zip is additionally checked against the release's `SHASUMS256.txt`. Every other
  network fetch (Ubuntu apt packages, the rustup toolchain, Alpine packages, `bun install`, and
  Bun's own build-script fetches) is listed in `unpinned-fetches.json` instead (`build.sh` header).
- The apt.llvm.org key must be exactly one primary key whose fingerprint equals `LLVM_SIGNER_FPR`,
  and is scoped via `signed-by` to the LLVM source only (`build.sh` toolchain block).
- Pinned LLVM / apk-tools-static versions fail closed when the upstream has rotated them out
  (`build.sh` `|| { ... bump ... exit 1; }` branches).
- Alpine keys must pass `sha256sum -c --strict keys/SHA256SUMS`, and `apk.static` runs with
  `--keys-dir` (no `--allow-untrusted`) (`build.sh` sysroot block).
- The prebuilt WebKit tarball is pinned by its `WEBKIT_VERSION` (exactly one match in
  `scripts/build/deps/webkit.ts` at the pin), seeded into `BUN_BUILD_PREFETCH_DIR/by-url/<key>`,
  and the build log must contain `using prefetch cache: …` for that key (`build.sh` build loop).
- The x64 binary's `--revision` must contain the first 9 hex of the patched HEAD (`build.sh` sanity
  block).
- Script style constraints stated in the file: no arithmetic, array, subscript or slice, and every
  variable bound exactly once (`build.sh` comment above `lap`); `tests/bun-base-supply-chain.test.ts`
  scans `build.sh` and fails on a network fetch that is neither pinned nor listed in
  `unpinned-fetches.json`, and fails if the README block drifts from `unpinned.mjs:render`
  (`build.sh` header, `unpinned.mjs` header).
- Patches are applied with a fixed committer identity and `--committer-date-is-author-date` so the
  patched HEAD is reproducible (`build.sh` `git am` call).

## Side Effects

- Network: `apt-get` (Ubuntu archive and apt.llvm.org), `github.com/oven-sh/bun` releases and git
  fetch, `static.rust-lang.org`, `dl-cdn.alpinelinux.org`, `github.com/oven-sh/WebKit` releases,
  plus fetches made by `bun install` and Bun's `scripts/build.ts` (`build.sh`;
  `unpinned-fetches.json`).
- Filesystem (inside the build container): installs packages, writes `/etc/apt/keyrings`,
  `/etc/apt/sources.list.d/llvm.list`, `/usr/local/bin` symlinks, musl sysroots under
  `/opt/linux-sysroot-musl` and `/opt/linux-sysroot-musl-arm64`, the seeded WebKit cache under
  `BUN_BUILD_PREFETCH_DIR=/tmp/bun-prefetch`, `/workspace/bun`, `/workspace/out`,
  `/workspace/.prefix` (`build.sh`).
- `unpinned.mjs --write` overwrites the marked block of `infra/bun-base/README.md`.
- GCS upload: `cloudbuild.yaml` `digests-and-upload` copies binaries, CycloneDX SBOMs,
  `manifest.json`, per-file `.sha256` and `SHA256SUMS` to
  `gs://gsw-mcp-bun-base/<prefix>/<BUILD_ID>/`. No signing happens here (`cloudbuild.yaml` header).

## Verification

- Run: `node scripts/bun-test.mjs tests/bun-base-supply-chain.test.ts` (from repo root).
