---
"@getknext/db": patch
---

`defineDrizzleConfig` from `@getknext/db/migrate` no longer reports `drizzle-kit is required` when `drizzle-kit` is installed. The check that looks for `drizzle-kit` always failed in the published package, so a `drizzle.config.ts` using `defineDrizzleConfig` could not be loaded. It now finds `drizzle-kit` correctly. When `drizzle-kit` really is missing, the same "install it as a devDependency" message is still shown.
