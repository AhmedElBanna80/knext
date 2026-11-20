---
"@getknext/core": patch
---

In-process Rust (Beta): on macOS, the module `knext ffi generate` writes now loads the Rust library through the descriptor its sha256 was checked from (`/dev/fd/<n>`), as it already did on Linux (`/proc/self/fd/<n>`). A library renamed or symlinked over the path between the integrity check and the load is no longer the one loaded. Regenerate your wrapper with `knext ffi generate`; `knext ffi check` reports the committed one as out of date until you do.

On any other platform the module now refuses to load instead of falling back to a by-path load. The Dockerfile `knext build` generates now copies `native/` owned by root and read-only (`COPY --chown=0:0 --chmod=a-w`), so the non-root app user cannot rewrite a checked library. Do not mount a shared, sidecar or group-writable volume at `native/`.
