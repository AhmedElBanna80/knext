---
"@getknext/core": patch
---

An unusable `KN_CHILD_METRICS_PORT` (not a number, 0, or above 65535) now falls back to 9092 for the child's metrics listener too, as it already did for the deep-health listener. Before, the child listener got NaN or 0 and the supervisor's scrape missed one of the two.
