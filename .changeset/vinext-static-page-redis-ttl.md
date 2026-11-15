---
"@getknext/core": patch
---

On the vinext target, a page with `export const revalidate = false` is now served from the Redis cache. Before this fix it was re-rendered on every request: vinext passes such a page's revalidate window as `Infinity`, the cache handler turned that into an invalid Redis expiry, and Redis rejected the write. The entry now takes the default one-hour TTL, the same as a `revalidate: false` page on the Node target.
