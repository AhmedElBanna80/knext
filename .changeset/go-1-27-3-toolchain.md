---
"@getknext/core": patch
---

The Go zone-function template now targets Go 1.27.3. Its `go.mod` requires Go 1.27.3 and its Dockerfile builds with the `golang:1.27.3` image, which carries the fix for the `crypto/x509` vulnerability CVE-2026-111943. Zones scaffolded from the Go template build and run on the patched toolchain.
