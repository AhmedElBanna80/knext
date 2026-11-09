---
"@getknext/grpc": minor
---

A zone function can fix the HTTP version its zone calls it with: `knext deploy function --http-version 2|1.1` sets `spec.httpVersion` on the BackendService, and the operator renders it into the zone as `<NAME>_SERVICE_HTTP_VERSION`. Left unset, nothing changes: the zone's server picks (h2c on Node, HTTP/1.1 on Bun).
