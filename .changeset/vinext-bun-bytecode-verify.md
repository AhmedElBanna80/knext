---
"@getknext/core": patch
---

`knext build` now verifies the compiled executable for the vinext and Bun target before it lets the build finish. It checks the binary itself for bytecode and for the per-build marker, and, when `compile.include` is set, that the binary carries exactly the number of included modules the compile step reported. A binary that is missing any of these is removed and the build fails with the reason, instead of shipping an executable that boots but pays a full compile on every cold start.
