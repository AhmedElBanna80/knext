---
"@getknext/core": patch
---

Internal: the ISR invalidation replay and the `'use cache'` tag replay now share one implementation of their outage backlog (the 1000-entry bound, deduplication and collapse), and the CDN purge queue takes its bound from it. No behaviour change.
