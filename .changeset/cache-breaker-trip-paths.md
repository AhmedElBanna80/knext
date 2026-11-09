---
"@getknext/core": patch
---

The ISR cache handler now stops dialling Redis while it is down in two more cases: a Bun-native connect that completes but leaves the client disconnected, and a failed delete of a cache entry (`set(key, null)`). Both now open the circuit breaker: after the first, requests during the outage stop dialling Redis again, and after the second, they stop reusing the client that just failed.
