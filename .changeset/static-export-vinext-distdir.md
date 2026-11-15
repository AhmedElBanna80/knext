---
"@getknext/core": patch
---

The static-export refusal (`output: 'export'`) now covers the vinext build target, which previously built an export with nothing to deploy: `knext build`, `knext deploy` and `knext preview` refuse it before the build starts, with the same guidance as the Next.js path. On the Next.js path the refusal uses the `output` and `distDir` Next.js resolved (see the resolved-config change in this release). On vinext only an unconditional top-level `output: 'export'` is refused; one under a condition or nested value prints a warning and the build continues. The vinext check reads `next.config` literally, so an `output` computed at runtime is not detected there, and a `next.config` that exists but cannot be read is refused rather than assumed clean. Other build steps still assume the default `.next` directory.
