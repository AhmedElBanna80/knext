---
"@getknext/core": minor
---

The default standalone image can now render chosen pages while a woken pod waits for Kubernetes to make it reachable. Set `KNEXT_WARM_PATH` (one path or a comma-separated list) to turn it on; `KNEXT_EAGER_WARM=0` turns it off. **Behaviour change:** the default image used to ignore `KNEXT_WARM_PATH` (it is the vinext build's warm-up setting); if your app's environment already sets it, your pods now warm those pages at start. Set `KNEXT_EAGER_WARM=0` to turn that off. Only warm pages that are the same for every visitor: the warm request has no cookies and its render goes into the shared page cache. In one test on a managed cluster this cut the time from ready to the first response byte from 94 ms to 16 ms; the total cold start was not measurably shorter.
