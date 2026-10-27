---
"@getknext/core": patch
---

New apps scaffold Next.js 16.4.3 instead of 16.3.8. Every Next.js up to and including 16.4.0 is affected by two critical remote-code-execution advisories and a high denial-of-service advisory, fixed only on 16.4.x. `knext doctor` now fails when the installed Next.js is affected and names the version to upgrade to.
