---
"@getknext/core": patch
---

Two Redis outage fixes in the ISR cache. A page deleted from the cache while Redis was unreachable is now deleted from Redis once it is back, instead of being served from Redis until it expired. And a slow Redis connection that fails after a newer one has taken over no longer closes the newer, working connection.
