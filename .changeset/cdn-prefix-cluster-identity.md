---
"@getknext/core": patch
---

The CDN tag prefix now includes the cluster's identity, so two clusters behind one CDN zone (staging and production with the same app name, say) no longer purge each other's pages. The operator derives it from the `kube-system` Namespace UID, or from the `KnextPlatform`'s `spec.cache.clusterId` when that is set. On upgrade, every app with `spec.cdn` rolls one new revision with the new prefix. Pages already at the edge keep their old tags and are served until they expire (at most `htmlTTLSeconds` plus `staleWhileRevalidateSeconds`), so purge the zone once if a page must not be served stale. If the operator cannot read the cluster identity, it keeps the app's current Knative Service and reports `CDNAdvisory` with reason `ClusterIdentityUnavailable` instead of rendering a guessed prefix.
