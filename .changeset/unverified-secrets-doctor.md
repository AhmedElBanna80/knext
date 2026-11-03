---
"@getknext/core": patch
---

`knext doctor` now warns about zone functions the operator cannot verify the Secrets of, listing each one and the `kubectl auth can-i get secrets` check to run. The operator also exports the held functions as a metric, ships two alerts for them, and raises a Warning event when a Secret read is first denied, ahead of the 10-minute removal.
