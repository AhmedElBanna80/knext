---
"@getknext/core": patch
---

`knext build`, `deploy` and `preview` now check `distDir`, `output: 'export'` and, on Bun with Turbopack, `experimental.turbopackModuleFragments` against the config Next.js resolved, not by reading `next.config` as text. Settings made by config wrappers, plugins or values computed from the environment are now judged correctly, both ways: a computed `distDir` that resolves to `.next` is no longer refused, and a wrapper that sets a custom `distDir` is no longer missed. An unsupported setting is refused at the start of the build, before anything compiles. An app without its own `adapterPath` gets the check from a small knext adapter that records these values and changes nothing else. A plain `next build` you run yourself is not checked. When no knext adapter ran in the build, the CLI warns and falls back to the earlier text check, now run after the build.
