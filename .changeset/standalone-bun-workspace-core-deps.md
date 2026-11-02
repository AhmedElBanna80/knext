---
"@getknext/core": patch
---

Standalone images built from a Bun workspace no longer crash on start with `ENOENT` for `pino`. In a Bun workspace, `@getknext/core`'s own `node_modules` holds links into Bun's package store, and those links pointed nowhere inside the image. The build now leaves that folder out of the image, and the image's own dependency install provides `pino`, `prom-client` and `@opentelemetry/api`. Images for a flat (non-workspace) app are unchanged.
