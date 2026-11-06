---
"@getknext/core": patch
---

The scaffolded Dockerfiles now pin their BuildKit frontend (`# syntax=docker/dockerfile:1.28`) by digest instead of following the floating `docker/dockerfile:1` tag, so a build uses the same frontend every time.
