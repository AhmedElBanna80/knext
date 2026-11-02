---
"@getknext/core": patch
---

The compatibility credential harness now tests Next.js 16.4.3, the release `knext create` already scaffolds, instead of 16.3.8. The Next.js release-matrix list that backs `knext doctor`'s credentialed-minor check now leads with 16.4.3. 16.4 stays reported as supported but not yet credentialed until its 14-run credential completes.
