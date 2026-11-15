---
"@getknext/grpc": patch
---

The Rust function template's own server stack now runs the Connect conformance suite in CI, with only its token check left out. A function created with `knext add function --lang rust` is unchanged: it gets neither the conformance build nor its feature.
