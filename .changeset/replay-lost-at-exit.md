---
"@getknext/core": patch
---

A pod that exits (scale to zero, restart) while it still holds Redis-outage invalidations it could not apply now logs one `[CacheHandler] exiting with … not yet replayed to Redis` line per cache handler, and `'use cache'` counts the lost tags in `knext_use_cache_events_total{event="tags_lost_at_exit"}`. The loss itself is unchanged: those entries are served until their TTL.
