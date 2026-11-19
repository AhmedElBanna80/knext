# Z11: the activator-path drill (kind + Calico)

When a function is at zero, calls reach it through Knative's activator. Its
NetworkPolicy therefore admits the activator, so it cannot tell the zone from
any other caller. This drill proves which control holds on that path.

```bash
packages/grpc/e2e/z11-activator-drill/run.sh        # creates the cluster on first run
PHASES="token direct policyoff noauth" packages/grpc/e2e/z11-activator-drill/run.sh   # against a kept cluster
```

The drill needs `docker`, `kind`, `kubectl`, `jq`, `curl`, `go` and `bun` on the
PATH. It never deletes a cluster. It deletes the caller namespace only when it
carries `e2e.kn-next.dev/z11-owned=true`. It deletes the zone namespace only
through the Z10 lane's deploy phase, which checks that namespace's own label. If
the drill aborts in the middle of a mutation, its exit handler turns the policy
back on, puts the function back on its own image, and removes the hold quota, the detached-pod label and the minScale 1 setting if a hold was in progress.

| Phase | What it does and proves |
| --- | --- |
| `up` | Creates a kind cluster with the default CNI disabled, and installs Calico through `scripts/kind-manifests/apply-calico.sh` (checksum-pinned and image-digest-pinned). It then runs the Z7 lane's `up` phase on that cluster: the registry, cert-manager, Knative and Kourier, and the operator built from this checkout. |
| `deploy` | Runs the Z10 lane's `images` and `deploy` phases (the zone warm, the Go and the Rust function at minScale 0, wake-ahead off). It builds the same Go function with its token interceptor removed. It also starts a caller pod in a second namespace. |
| `token` | With the function at zero, the foreign pod calls it on its cluster-local URL, so through Kourier and the activator. The call has no token, and then a garbage token, each made with the function at zero. Both are refused with `401 unauthenticated` and the verifier's own message (`missing bearer token`, `token rejected`), and the first call did wake the function. Control: the zone's own call through its generated glue reaches the function (`NotFound`, not 401). |
| `direct` | The zone wakes the function, and its call must reach the handler. The foreign pod then dials the Ready function pod directly on 8080 (the function) and 8013 (queue-proxy). Both must time out (curl exit 28), which is what a Calico drop produces. A refused port or a tool failure does not count. Mutation: with `spec.security.networkPolicy: false` the operator removes the policy, and both dials connect. That shows the refusal was the policy's doing. The policy is turned back on afterwards. |
| `policyoff` | With `spec.security.networkPolicy: false` (the policy object is asserted gone), a token-less call is still refused by the function itself. A cold call through the activator gets `401 unauthenticated` and wakes the function. A direct dial to the warm pod's user port, which the policy would drop, now connects, and a no-token call and a garbage-token call to it are each answered `401 unauthenticated` by the function's own token check. The policy is turned back on afterwards. The same leg then runs against the Rust template function (its policy is switched off and asserted gone first): a cold no-token call through the activator gets `401 unauthenticated` and wakes it, and a direct no-token call and a garbage-token call to the warm pod are each answered `401 unauthenticated` by the Rust function's own token check. Both functions are waited on at the same time, so the Rust leg adds no wait of its own. |
| `noauth` | Mutation: the function is switched to the image without its token interceptor. The foreign no-token call then reaches the handler (`404 not_found`). On the activator path the token is the control, not the network. The original image is restored, and the drill waits until the function's latest ready revision runs it. It refuses to start if the function is already on the mutation image. With the mutation image running, the drill also turns the NetworkPolicy off (object asserted gone), dials the warm pod's user port directly with no token, and requires `404 not_found`: with both the network control and the token check removed, nothing refuses the call. The policy is turned back on before the image is restored. |
| `rotcold` | The zone's key is rotated, switched and retired while the function is at zero. The cold pod that wakes afterwards refuses a token signed by the retired key (`401 unauthenticated`), and a second cold pod accepts one signed by the new key (`404 not_found`). Control: before the rotation a cold pod accepts the old key. Each pod's start time is compared with the retirement time. |
| `held` | One call is held in the activator for 80 s, longer than the token's 60 s life plus 5 s of skew, and is refused by the function as `401 unauthenticated` with the message `token rejected`. Control: the same hold for 30 s is accepted (`404 not_found`), so the refusal is the token's age. Afterwards a fresh token is accepted and a garbage token is still refused. The hold is a `ResourceQuota` in the function's namespace that admits no pod, so the pod the activator waits for cannot be created. No node is cordoned. |
| `heldwarm` | The two cases together, on two warm pods. The function is kept at minScale and maxScale 2. Each pod is isolated in turn (the others are detached from the Service, with the pod quota in place so nothing replaces them) and given one call with the current key, so each caches the old key set, and neither gets another call. The key is rotated and retired under them. Control: a call signed with the new key is held 30 s and released to pod A only; it is accepted (`404 not_found`), so a pod holding only the old set finds the new key. Test: the same, held 80 s (`Z11_HELD_SECONDS`) and released to pod B only, in the same state, is refused (`401 unauthenticated`, `token rejected`). Only the target pod is re-attached for each call, and the set of pod uids is checked unchanged during and after each hold. Which pod answered is observed, not assumed: the drill reads each pod's queue-proxy request counter before and after the call, and the pod whose total rose by exactly one must be the target (a counter that cannot be read, or is empty or not a number, fails the run). After its refusal, pod B is given a fresh token alone and must accept it (`404 not_found`), so the refusal was the token's age and the pod is healthy. The labels, the quota and the scale are put back afterwards, also on an abort, the labels first. |

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `KIND_CLUSTER` | `knext-z11-drill` | The Calico cluster, created if missing and kept afterwards. |
| `REGISTRY_NAME` / `REGISTRY_PORT` | `knext-z11-registry` / `5002` | The local registry. |
| `Z11_NAMESPACE` | `z11-e2e` | The zone's namespace. The caller runs in `<namespace>-foreign`. |
| `PHASES` | all | Any subset of `up deploy token direct policyoff noauth rotcold held heldwarm`. The phases always run in that order. |

## What it does not prove

- **A correctly signed token with the wrong properties** (another key, another function's audience, another RPC, expired, another issuer, a replay to the same pod). The Z7 lane proves those refusals on warm functions. They are the same interceptor, so the activator path adds nothing to them. This drill sends only no token and a malformed one.
- **Another zone's legitimate token presented to this zone's function.** It is refused only because each function trusts its own zone's JWKS. That holds by construction (the operator mounts the owning zone's JWKS), but it is not exercised here end to end.
- **Same-namespace callers.** The caller sits in another namespace. The policy admits Knative peers, not namespaces, so a same-namespace pod meets the same two controls (the token on the activator path, the policy on a direct dial), but no leg runs from inside the namespace.
- **Replay after scale-to-zero.** A token is single-use per pod, held in memory. A new pod after a scale-to-zero, or another replica, has not seen it, so it can be replayed within its 60-second lifetime. The token does not bind the request body.
- **The Rust function for the cold-pod key rotation, the held call and the combined case.** The `rotcold`, `held` and `heldwarm` phases run on the Go function only.
- **Which check refuses the long-held call.** The verifier re-reads its mounted JWKS at the start of every call when the file changed or is older than 10 s, looks the kid up (an unknown kid is refused, not fetched), checks the signature, and only then the expiry. A refusal says `token rejected` whatever the cause and is not logged, so no log line or counter tells an unknown kid from an expired token. `heldwarm` proves the pair (new key accepted by a pod holding the old set when the hold is short, refused when it is over 60 s), not which check fired.
- **A call held in the activator while the key rotates.** In `heldwarm` the rotation is finished before the call is sent. The call is held after the rotation, by the warm pod's missing endpoint, not during it.
- **A Rust function without its token interceptor.** The `noauth` mutation image is built from the Go template only. The Rust interceptor's mutation proof is the template's own prover.
- **A compromised activator, autoscaler or Kourier gateway.** These are trusted peers of the policy. If one is compromised, the token is the only barrier.
- **mTLS between pods.** Nothing here encrypts or authenticates the network path. The token is the per-call control.
- **Other CNIs.** Only Calico is tested. A CNI that does not enforce NetworkPolicy (flannel) leaves only the token.
- **Continuous verification beyond CI.** `.github/workflows/z11-activator-drill-e2e.yml` runs every phase on pushes and pull requests that touch the drill or the operator. It is not a required check. `RECORDED-RUN.md` holds an earlier manual run.
