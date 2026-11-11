---
"@getknext/grpc": minor
"@getknext/core": minor
---

`knext generate --against deployed:<namespace>/<name>` now compares your contract against the one a deployed function serves.

- knext reads the function's served version from its `BackendService` (the cluster is only read, never changed).
- It then compares against the git tag that version was released under, `proto/v<version>` by default.
- Set `deployedTagTemplate` in `knext.grpc.json` to use your own tag name. The template takes `{version}` once and may use `{name}`, the function's name.
- `--context` selects the kubectl context.
- The run fails instead of comparing against nothing when the function has no served version, the version is not a semantic version, or the tag is missing.

Upgrade `@getknext/core` and `@getknext/grpc` together. An older core cannot read the cluster for this check, and says so.
