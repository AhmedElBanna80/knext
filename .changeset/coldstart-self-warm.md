---
"@getknext/core": minor
---

A cold-started server now loads and renders your `/` route while the pod is still waiting for Kubernetes to make it reachable, so the first visitor no longer pays for it. On a managed cluster this cut the time from ready to the first response byte from a median of 94 ms to 16 ms. Set `KNEXT_WARM_PATHS` to choose other paths, or to an empty value to turn it off. The request carries the header `x-knext-warm: 1`.
