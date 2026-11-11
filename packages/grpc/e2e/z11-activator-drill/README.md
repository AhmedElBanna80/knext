# Z11: the activator-path drill (kind + Calico)

When a function is at zero, calls reach it through Knative's activator. Its
NetworkPolicy therefore admits the activator, so it cannot tell the zone from
any other caller. This drill proves which control holds on that path.

```bash
packages/grpc/e2e/z11-activator-drill/run.sh        # creates the cluster on first run
PHASES="token direct noauth" packages/grpc/e2e/z11-activator-drill/run.sh   # against a kept cluster
```

The drill needs `docker`, `kind`, `kubectl`, `jq`, `curl`, `go` and `bun` on the
PATH. It never deletes a cluster. It deletes the caller namespace only when it
carries `e2e.kn-next.dev/z11-owned=true`. It deletes the zone namespace only
through the Z10 lane's deploy phase, which checks that namespace's own label. If
the drill aborts in the middle of a mutation, its exit handler turns the policy
back on and puts the function back on its own image.

| Phase | What it does and proves |
| --- | --- |
| `up` | Creates a kind cluster with the default CNI disabled, and installs Calico through `scripts/kind-manifests/apply-calico.sh` (checksum-pinned and image-digest-pinned). It then runs the Z7 lane's `up` phase on that cluster: the registry, cert-manager, Knative and Kourier, and the operator built from this checkout. |
| `deploy` | Runs the Z10 lane's `images` and `deploy` phases (the zone warm, the Go function at minScale 0, wake-ahead off). It builds the same Go function with its token interceptor removed. It also starts a caller pod in a second namespace. |
| `token` | With the function at zero, the foreign pod calls it on its cluster-local URL, so through Kourier and the activator. The call has no token, and then a garbage token, each made with the function at zero. Both are refused with `401 unauthenticated` and the verifier's own message (`missing bearer token`, `token rejected`), and the first call did wake the function. Control: the zone's own call through its generated glue reaches the function (`NotFound`, not 401). |
| `direct` | The zone wakes the function, and its call must reach the handler. The foreign pod then dials the Ready function pod directly on 8080 (the function) and 8012 (queue-proxy). Both must time out (curl exit 28), which is what a Calico drop produces. A refused port or a tool failure does not count. Mutation: with `spec.security.networkPolicy: false` the operator removes the policy, and both dials connect. That shows the refusal was the policy's doing. The policy is turned back on afterwards. |
| `noauth` | Mutation: the function is switched to the image without its token interceptor. The foreign no-token call then reaches the handler (`404 not_found`). On the activator path the token is the control, not the network. The original image is restored, and the drill waits until the function's latest ready revision runs it. It refuses to start if the function is already on the mutation image. |

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `KIND_CLUSTER` | `knext-z11-drill` | The Calico cluster, created if missing and kept afterwards. |
| `REGISTRY_NAME` / `REGISTRY_PORT` | `knext-z11-registry` / `5002` | The local registry. |
| `Z11_NAMESPACE` | `z11-e2e` | The zone's namespace. The caller runs in `<namespace>-foreign`. |
| `PHASES` | all | Any subset of `up deploy token direct noauth`. The phases always run in that order. |

## What it does not prove

- **A correctly signed token with the wrong properties** (another key, another function's audience, another RPC, expired, another issuer, a replay to the same pod). The Z7 lane proves those refusals on warm functions. They are the same interceptor, so the activator path adds nothing to them. This drill sends only no token and a malformed one.
- **Another zone's legitimate token presented to this zone's function.** It is refused only because each function trusts its own zone's JWKS. That holds by construction (the operator mounts the owning zone's JWKS), but it is not exercised here end to end.
- **Same-namespace callers.** The caller sits in another namespace. The policy admits Knative peers, not namespaces, so a same-namespace pod meets the same two controls (the token on the activator path, the policy on a direct dial), but no leg runs from inside the namespace.
- **Replay after scale-to-zero.** A token is single-use per pod, held in memory. A new pod after a scale-to-zero, or another replica, has not seen it, so it can be replayed within its 60-second lifetime. The token does not bind the request body.
- **The cold-pod key-rotation case and a request held beyond 60 s.** The ADR-0004 Amendment 1 note asks this drill for both, and it covers neither, so that note stays open.
- **A compromised activator, autoscaler or Kourier gateway.** These are trusted peers of the policy. If one is compromised, the token is the only barrier.
- **mTLS between pods.** Nothing here encrypts or authenticates the network path. The token is the per-call control.
- **Other CNIs.** Only Calico is tested. A CNI that does not enforce NetworkPolicy (flannel) leaves only the token.
- **Continuous verification.** The drill is a manual run: see `RECORDED-RUN.md` for the date and versions. No CI workflow runs it.
