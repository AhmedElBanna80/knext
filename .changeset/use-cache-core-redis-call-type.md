---
"@getknext/core": patch
---

The `UseCacheCore.redisCall` type now declares its second `client` parameter, matching the cache handler, which passes the client at every call.
