---
"@getknext/core": patch
---

`knext create` now fails closed when the CLI's own version cannot be read, instead of silently scaffolding against `0.0.0`.
