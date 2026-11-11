# Z11 drill: recorded run, 2026-11-11

Run with `packages/grpc/e2e/z11-activator-drill/run.sh` (all phases), on kind `knext-z11-drill` with Calico v3.28.2, Knative v1.16.0, and the operator built from this branch. These are the assertion lines from the run log, exit 0:

```
== kind cluster knext-z11-drill with the default CNI disabled, and Calico
ok: Calico is the CNI: NetworkPolicy is enforced on this cluster
== kind cluster knext-z11-drill
== local registry knext-z11-registry (localhost:5002), wired to every node
== cert-manager and Knative Serving + Kourier (knative-v1.16.0)
== the operator, built from this checkout (propagation bound 120s, the shipped default)
ok: operator running with its shipped 120s propagation bound (no flag)
== PASS (phases: up)
== images: Go function, zone, Rust function
ok: function-go -> sha256:b76357df2ea66cc3a23fc0c680466dea6866f6078184dd987cafeb22e5b899dd
ok: zone-caller -> sha256:16e2663a9697a7c03865aa2ef265799c228a77c15271fa82f94b059aeff8ab81
== namespace z11-e2e: the zone storefront warm, its functions at minScale 0
ok: the zone is Ready and bound; the functions may scale to zero
== Z10 lane: images deploy passed
== the Go function without its token interceptor (mutation image for the noauth phase)
ok: function-go-noauth -> sha256:c700da2ef6a71edc934b17040e3d5592be8ef063b2083dc25ebfb7fc94f5a4f8
== a caller pod in another namespace (z11-e2e-foreign)
ok: foreign caller ready
== token: (see the re-run below)
```

The `token`, `direct` and `noauth` phases were re-run on the same cluster after the direct leg moved from 8012 to 8013 (queue-proxy's serving port for an h2c function; 8012 is not opened), with `PHASES="token direct noauth"`, exit 0:

```
== token: a foreign pod's call through the activator is refused without a valid token
ok: example-go has scaled to zero
ok: a foreign call with no token woke the function through the activator and was refused (401 unauthenticated)
ok: example-go has scaled to zero
ok: a foreign call with a garbage token, also cold, is refused by the verifier (401 unauthenticated, token rejected)
ok: control: the zone's own call through its glue reaches the function (NotFound, not 401)
== direct: a foreign pod's direct dial to the warm function pod is dropped
ok: the foreign pod's direct dials to the function pod (8080, 8013) time out: dropped by the policy
== mutation: with the function's NetworkPolicy off, the same direct dials connect
ok: with the policy off both direct dials connect: the refusal is the policy's doing (policy restored)
== noauth: the function WITHOUT its token interceptor answers the foreign call
ok: example-go has scaled to zero
ok: without the interceptor the same foreign call reaches the handler (404 not_found): the token is the control (image restored)
== Z11 drill: token direct noauth passed
```
