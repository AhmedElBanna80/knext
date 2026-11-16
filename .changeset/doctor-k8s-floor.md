---
"@getknext/core": patch
---

`knext doctor` now warns when the cluster's Kubernetes server is older than 1.30, even before the operator is installed. Previously only the operator write policy row mentioned the floor, and it was skipped when no operator existed yet. Reachable clusters with no operator now show a new `Kubernetes version` row in `knext doctor` output: pass at or above 1.30, warn below it.
