---
"@getknext/grpc": minor
---

`knext deploy function` now sets the contract version the function serves from `option (knext.v1.contract_version)` in the function's own copy of its contract (`functions/<name>/proto`, the copy its image is built from), so you no longer need `--proto-version`. Without that version the zone could not call the function at all: every generated call was refused because the zone did not know which version the function served. If that copy and the zone's `proto/` disagree, the command stops instead of declaring a version the image does not serve. `--proto-version` still overrides it.
