---
"@getknext/core": patch
---

CDN caching on CloudFront and Azure Front Door no longer edge-caches a request whose URL has a query string. Their cache key depends on a policy you configure and may leave the query out, so `/search?q=a` and `/search?q=b` could share one edge entry and a crafted query could fill it for every visitor. Those requests now go to your origin with no `s-maxage` and no `Cache-Tag`. The same page without a query string is edge-cached as before. Cloudflare and Google Cloud CDN key on the query string by default and are unchanged.
