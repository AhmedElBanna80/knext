---
"@getknext/core": patch
---

`knext build` now stops before running the Next.js build when `next.config` sets a custom `distDir`, and says why. knext reads the build output from `.next`, so a different `distDir` used to fail later with a missing-output error. Remove `distDir` from `next.config` to build.
