---
'@getknext/core': patch
---

The CDN and `'use cache'` counters now reach the metrics port through a family allowlist, like the in-process Rust counters. Only `knext_cdn_edge_decision_total`, `knext_cdn_foreign_edge_strip_total`, `knext_cdn_purge_total` and `knext_use_cache_events_total` are served from those sources, on the standalone and the self-contained runtime alike. The metrics an app serves today are unchanged.
