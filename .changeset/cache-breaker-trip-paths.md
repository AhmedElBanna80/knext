---
"@getknext/core": patch
---

The ISR cache handler now stops dialling Redis while it is down in two more cases: a Bun-native connect that completes but leaves the client disconnected, and a failed delete from `revalidatePath`/`set(key, null)`. Both now open the circuit breaker, so requests during the outage stop paying a connect attempt each.
