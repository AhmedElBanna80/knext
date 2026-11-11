---
"@getknext/grpc": minor
---

`knext deploy function` now sets the contract version the function serves from `option (knext.v1.contract_version)` in the function's own copy of its contract (`functions/<name>/proto`, which its code is generated from), so you no longer need `--proto-version`. Without that version the zone could not call the function at all: every generated call was refused because the zone did not know which version the function served. If the zone's `proto/` is ahead of that copy, the command stops instead of declaring a version the image does not serve; a function ahead of its zone is the normal rollout order and is accepted. `--proto-version` still overrides it.
