---
"@getknext/db": patch
---

`defineDrizzleConfig` from `@getknext/db/migrate` no longer reports `drizzle-kit is required` when `drizzle-kit` is installed. The package is ESM, and the check that looks for `drizzle-kit` used a CommonJS-only lookup that always failed there, so `drizzle.config.ts` could not be loaded. It now resolves `drizzle-kit` the ESM way. When `drizzle-kit` really is missing, the same "install it as a devDependency" message is still shown.
