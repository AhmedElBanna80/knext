---
"@getknext/core": patch
---

When `knext deploy function` stops because the cluster's BackendService CRD is older than the CLI, the message now names the BackendService fields that CRD lacks. It used to compare against the NextApp CRD and could name the wrong fields. Whether the deploy stops is unchanged.
