---
"@getknext/core": patch
---

When `knext deploy function` stops because the cluster's BackendService CRD is older than the CLI, the message now names the fields by comparing against the BackendService CRD (or, when knext cannot read it, from the cluster's own error). It used to compare against the NextApp CRD and could name the wrong fields. Whether the deploy stops is unchanged.
