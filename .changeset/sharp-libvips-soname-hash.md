---
"@getknext/core": patch
---

The compiled image now verifies the real libvips library (`libvips-cpp.so.8.18.6`) against the native integrity manifest before loading sharp, where previously only `.node`, `.so`, `.dylib` and single-number `.so.N` files were checked and a tampered libvips went unnoticed.
