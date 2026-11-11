# Z10 zone functions on kind: the cold path

A warm zone calls a Go and a Rust function that have scaled to zero, so every call
wakes a function through Knative's activator. The lane proves that the call lands,
and that a failed call's code reaches the zone's glue unchanged. CI runs it in the
Z7 job (`.github/workflows/z7-identity-kind-e2e.yml`), on the cluster that job has
just built. You can run the same thing against a kind cluster of your own:

```bash
PHASES=up packages/grpc/e2e/z7-identity-kind/run.sh   # cluster, Knative, operator from this checkout
packages/grpc/e2e/z10-zone-functions-kind/run.sh
```

It needs `docker`, `kind`, `kubectl`, `jq`, `curl` and `bun` on the PATH, and the local registry that the Z7 `up` phase creates. The zone and the
two functions are the same images as the Z7 lane's: the Go and Rust templates, and
the small Node zone in `../z7-identity-kind/zone-caller`, which calls through the
real generated glue.

| Phase | What it does and proves |
| --- | --- |
| `images` | Builds and pushes the Go function, the Rust function and the zone. Every image is referenced by digest. |
| `deploy` | Recreates the namespace (Pod Security `restricted` enforced) and applies the zone at minScale 1 and the functions at minScale 0. It waits until the functions are Ready and the zone is bound to both. |
| `cold` | Waits until each function has no pod at all, terminating ones included. A write through the zone then wakes it: the generated Server Action for Go, and a call with a zone token for Rust. The call must succeed, and a function pod must exist afterwards. A read then returns the value from the woken pod. |
| `trailers` | Waits until each function is back at zero. A read of a missing item then comes back as `NotFound` (Go, through the generated glue) or `not_found` (Rust) through the cold activator path. A warm control makes the same call again and must get the same code. |

The functions here use the Connect protocol over h2c, the default for a Node zone.
In it, a failed unary call travels as an HTTP status plus a JSON error body, not as
gRPC trailers. The `trailers` phase checks that this code survives the activator. A
code that is lost or rewritten on the way (502, `Unavailable`, `Unknown`) fails it.

Each cold call is checked against two conditions: no pod at all before the call (a pod
still draining could serve it), and a pod after it, which can only be one the call
created. A call that landed on a warm pod would prove nothing. Each function sets
`wakeAhead: false`, because the default is on, and a zone that wakes its functions
when it starts would hide the cold path.

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `KIND_CLUSTER` | `knext-z7-e2e` | The cluster that the Z7 `up` phase built. |
| `REGISTRY_PORT` | `5001` | The local registry. |
| `Z10_NAMESPACE` | `z10-e2e` | The lane's namespace. It is stamped `e2e.kn-next.dev/z10-owned=true`, and a namespace without that label is never deleted. |
| `Z10_WITH_RUST` | `1` | `0` skips the Rust function. |
| `Z10_ZERO_TIMEOUT` | `300` | Seconds to wait for a function to scale to zero. A bound function's retention is its zone's retention plus 30 s, followed by Knative's stable window. |
| `PHASES` | all | Any subset of `images deploy cold trailers`. |

## What it does not prove (the rest of Z10)

- Partial-rollout ordering (an old zone calling a new function is accepted, and the reverse is refused) and cross-zone Secret refusal end to end. Both are the next slice.
- A built Next.js zone, using the file-manager harness. That is a later slice.
- Cold-chain numbers on OKE.
- The read, write, auth-reject and warm-rotation scenarios. The Z7 lane covers these and they are not repeated here.
