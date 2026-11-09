---
"@getknext/core": patch
---

Under Bun, concurrent first requests now share one Redis connect instead of each dialling Redis. A burst of requests arriving before the first connect completes used to open one connection attempt per request.
