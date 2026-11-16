---
"@getknext/core": patch
---

Apps created with `knext create` (and `turbo gen zone`) now pin Next.js `16.4.5`, which fixes GHSA-mfr8-8qww-v76h (medium): information disclosure across root params when a `'use cache'` function is called, in every Next.js from 16.3.0 through 16.4.4. To upgrade an existing app, pin `next` to `16.4.5` or later on the 16.4.x line, reinstall, rebuild and redeploy. `knext doctor` does not fail on this medium-severity advisory.
