---
"@getknext/core": patch
---

The strict-require build check (`KNEXT_COMPILE_STRICT_REQUIRES=1`, and every `--self-contained` build) now follows a `createRequire(import.meta.url)` binding through an alias, `import * as m from "node:module"` and a destructured `await import("node:module")`. It reports a binding that is copied, stored, passed on or wrapped as an unrecognised binding. Before, those shapes passed silently and left the required package out of the executable. A default build still only warns. This is build-time only: the executable it produces is unchanged.
