---
"@getknext/grpc": minor
---

`knext deploy function` now sets the contract version the function serves from its contract's `option (knext.v1.contract_version)`, so you no longer need `--proto-version`. Without that version the zone could not call the function at all: every generated call was refused because the zone did not know which version the function served. `--proto-version` still overrides it, and contract files that disagree on the version stop the command.
