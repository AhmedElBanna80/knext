---
"@getknext/grpc": patch
---

A cached read (a generated query) now keeps the function's error code in a production build. Next.js hides errors thrown inside a `'use cache'` function, so a `NotFound` from the function used to reach your code as a generic `Unknown` error. The query now returns the error from the cache and throws a `ConnectError` with the function's code and message outside it. Definitive answers such as `NotFound` are cached like results and refreshed by a write; transient ones such as `Unavailable` are kept for a couple of seconds only.
