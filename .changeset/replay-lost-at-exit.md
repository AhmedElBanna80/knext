---
"@getknext/core": patch
---

A pod that exits (scale to zero, restart) while it still holds Redis-outage invalidations it could not apply now logs one `[CacheHandler] exiting with … not yet replayed to Redis` line per cache handler, saying how many tags (and, for ISR, deletes) it lost. The loss itself is unchanged: those entries are served until their TTL.
