# Z11: the activator-path drill (kind + Calico)

When a function is at zero, calls reach it through Knative's activator. Its
NetworkPolicy therefore admits the activator, so it cannot tell the zone from
any other caller. This drill proves which control holds on that path.

```bash
packages/grpc/e2e/z11-activator-drill/run.sh        # creates the cluster on first run
PHASES="token direct noauth" packages/grpc/e2e/z11-activator-drill/run.sh   # against a kept cluster
```

The drill needs `docker`, `kind`, `kubectl`, `jq`, `curl`, `go` and `bun` on the
PATH. It never deletes a cluster, and it deletes only namespaces it stamped
`e2e.kn-next.dev/z11-owned=true`.

| Phase | What it does and proves |
| --- | --- |
| `up` | Creates a kind cluster with the default CNI disabled, and installs Calico through `scripts/kind-manifests/apply-calico.sh` (checksum-pinned and image-digest-pinned). It then runs the Z7 lane's `up` phase on that cluster: the registry, cert-manager, Knative and Kourier, and the operator built from this checkout. |
| `deploy` | Runs the Z10 lane's `images` and `deploy` phases (the zone warm, the Go function at minScale 0, wake-ahead off). It builds the same Go function with its token interceptor removed. It also starts a caller pod in a second namespace. |
| `token` | With the function at zero, the foreign pod calls it on its cluster-local URL, so through Kourier and the activator. The call has no token, and then a garbage token. Both are refused with `401 unauthenticated`, and the call did wake the function. Control: the zone's own call through its generated glue reaches the function (`NotFound`, not 401). |
| `direct` | The foreign pod dials the warm function pod directly, on 8080 (the function) and 8012 (queue-proxy). Calico drops both. Mutation: with `spec.security.networkPolicy: false` the operator removes the policy, and the dial to 8080 connects. That shows the refusal was the policy's doing. The policy is turned back on afterwards. |
| `noauth` | Mutation: the function is switched to the image without its token interceptor. The foreign no-token call then reaches the handler (`404 not_found`). On the activator path the token is the control, not the network. The original image is restored, and the drill waits until the function is Ready on it. |

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `KIND_CLUSTER` | `knext-z11-drill` | The Calico cluster, created if missing and kept afterwards. |
| `REGISTRY_NAME` / `REGISTRY_PORT` | `knext-z11-registry` / `5002` | The local registry. |
| `Z11_NAMESPACE` | `z11-e2e` | The zone's namespace. The caller runs in `<namespace>-foreign`. |
| `PHASES` | all | Any subset of `up deploy token direct noauth`. The phases always run in that order. |

## What it does not prove

- **mTLS between pods.** Nothing here encrypts or authenticates the network path. The token is the per-call control.
- **Other CNIs.** Only Calico is tested. A CNI that does not enforce NetworkPolicy (flannel) leaves only the token.
