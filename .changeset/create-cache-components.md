---
"@getknext/core": minor
---

`knext create` can turn on Cache Components. Pass `--cache-components`, or answer yes to the new question, and the scaffold writes `cacheComponents: true` and `partialPrefetching: true` to `next.config.ts`. That gives you `'use cache'`, `cacheLife`/`cacheTag` and Partial Prerendering; with `--cache redis`, `'use cache'` entries are shared by every pod. It is off by default, and needs the `turbopack` or `webpack` builder.
