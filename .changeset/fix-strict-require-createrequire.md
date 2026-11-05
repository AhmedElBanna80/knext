---
"@getknext/core": patch
---

The strict require check (`KNEXT_COMPILE_STRICT_REQUIRES=1`, and `--self-contained` builds, which force it on) no longer rejects a server bundle that includes `next/og`'s `@vercel/og` with `unrecognised createRequire(import.meta.url) binding`. The check now reads how each `createRequire(import.meta.url)` value is used from the parsed code rather than from text patterns, so a value that is provably discarded is accepted however much code surrounds it. A `createRequire` whose value is handed on (returned, passed as an argument, stored), and a server module the parser cannot read, still fail a strict build.
