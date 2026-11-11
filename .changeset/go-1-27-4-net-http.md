---
"@getknext/grpc": patch
---

The Go function template now builds with Go 1.27.4, which fixes a crash in the Go HTTP/1 server (GO-2026-6859, a header race in `MaxBytesReader`). Functions scaffolded from the template, and rebuilt, pick up the fixed standard library.
