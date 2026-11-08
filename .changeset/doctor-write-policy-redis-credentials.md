---
"@getknext/core": patch
---

`knext doctor` now recognises the operator's current Secret write policy. The policy the operator bundle ships allows the operator to write a per-app Redis credentials Secret (the name ends in `-redis-credentials`) as well as the zone signing key, and `doctor` compares the installed policy with its own copy of the shipped one. The copy listed only the signing-key suffix, so a correctly installed new bundle was reported as a modified policy. The copy now matches.
