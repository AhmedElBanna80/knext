---
"@getknext/core": minor
---

A zone function can now turn off its NetworkPolicy with `spec.security.networkPolicy: false` on its `BackendService`, the same field a `NextApp` has. The policy is still written by default. Turning it off is for clusters whose ingress is not Kourier (Istio, Contour, Gateway API) and whose CNI enforces NetworkPolicy, where the default policy leaves the function unreachable. It removes the function's pod-level network isolation, so replace it with a policy of your own. Upgrade the operator and CRD before using the field.
