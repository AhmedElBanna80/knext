---
"@getknext/core": minor
---

ISR no longer serves pages from a pod's own memory while a configured Redis server is unreachable. Each read is a miss and the page is rendered again, the same as `'use cache'`, so a page another pod revalidated cannot keep serving on this pod during an outage. Expect more rendering while Redis is down. With no Redis configured (local development), or when the Redis client cannot be loaded in the pod (logged at startup), the in-memory cache works as before.
