---
"@getknext/core": minor
---

The default standalone image can now render chosen pages while a woken pod waits for Kubernetes to make it reachable. Set `KNEXT_WARM_PATH` (one path or a comma-separated list) to turn it on; `KNEXT_EAGER_WARM=0` turns it off. **Behaviour change:** if you already set `KNEXT_WARM_PATH` for the build-time compile-cache warm-up, your pods now also warm those pages at start; set `KNEXT_EAGER_WARM=0` to keep the old behaviour. Only warm pages that are the same for every visitor: the warm request has no cookies and its render goes into the shared page cache. In one test on a managed cluster this cut the time from ready to the first response byte from 94 ms to 16 ms; the total cold start was not measurably shorter.
