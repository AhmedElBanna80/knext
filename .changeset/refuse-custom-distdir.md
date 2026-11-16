---
"@getknext/core": patch
---

`knext build` now refuses a build when your Next.js config sets a custom `distDir`, and says why (with knext's adapter, at the start of the build; see the resolved-config change in this release). knext reads the build output from `.next`, so a different `distDir` used to fail later with a missing-output error. Remove `distDir` from `next.config` to build.
