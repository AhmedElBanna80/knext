---
"@getknext/core": patch
---

`knext doctor` now warns when the cluster's Kubernetes server is older than 1.30, even before the operator is installed. Previously only the operator write policy row mentioned the floor, and it was skipped when no operator existed yet.
