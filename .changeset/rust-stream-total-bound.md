---
"@getknext/grpc": patch
---

Rust functions: a client or bidirectional stream may now send many messages, up to 64 MiB in all, instead of being cut off after one message's worth. Each message is still limited to 4 MiB, and a unary request body over the limit is refused with `resource_exhausted`.
