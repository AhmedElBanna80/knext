---
"@getknext/core": patch
---

`knext doctor` now warns when the cluster's Kubernetes server is older than 1.30, even before the operator is installed. Previously only the operator write policy row mentioned the floor, and it was skipped when no operator existed yet. Reachable clusters with no operator now show a new `Kubernetes version` row in `knext doctor` output: pass at or above 1.30, warn below it. If the server version cannot be read, the row is skipped and says so. When the cluster is unreachable the row is absent, because the cluster row already reports that.
