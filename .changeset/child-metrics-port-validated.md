---
"@getknext/core": patch
---

The child's metrics listener now resolves `KN_CHILD_METRICS_PORT` the same way the deep-health listener already did: the leading integer of the value, used when it is 1..65535, otherwise 9092. Before, the child listener used `Number(...)`, so a value with no leading integer (or an empty one) gave NaN or 0 while the deep-health listener fell back to 9092, and the supervisor's scrape missed one of the two. Two spellings `Number(...)` used to accept now resolve differently for the child listener, matching the deep-health listener: hex such as `0x1F` falls back to 9092, and exponent form such as `1e3` reads as 1.
