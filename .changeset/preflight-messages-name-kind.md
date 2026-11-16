---
"@getknext/core": patch
---

Preflight failure messages now name the kind actually being preflighted. A BackendService that fails the server-side dry run is described as a BackendService, with its own CRD in the `kubectl get crd` hint, instead of as a NextApp. The NextApp messages are unchanged.
