---
"@getknext/core": minor
"@getknext/grpc": minor
---

A zone can choose the HTTP version it calls a function with. Set `httpVersion: "2"` (h2c) or `"1.1"` on a `backends` entry in `kn-next.config.ts`, and the operator renders it into the zone as `<NAME>_SERVICE_HTTP_VERSION`. Leave it out and nothing changes: the zone's server picks, h2c on Node and HTTP/1.1 on Bun. Install the operator release that includes this before you set it.
