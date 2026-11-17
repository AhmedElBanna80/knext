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

It needs `docker`, `kind`, `kubectl`, `jq`, `curl`, `bun` and `python3` on the PATH, and the local registry that the Z7 `up` phase creates. The zone and the
two functions are the same images as the Z7 lane's: the Go and Rust templates, and
the small Node zone in `../z7-identity-kind/zone-caller`, which calls through the
real generated glue.

| Phase | What it does and proves |
| --- | --- |
| `images` | Builds and pushes the Go function, the Rust function and the zone. Every image is referenced by digest. |
| `deploy` | Recreates the namespace (Pod Security `restricted` enforced) and applies the zone at minScale 1 and the functions at minScale 0. It waits until the functions are Ready and the zone is bound to both. |
| `cold` | Waits until each function has no pod at all, terminating ones included. A write through the zone then wakes it: the generated Server Action for Go, and a call with a zone token for Rust. The call must succeed, and a function pod must exist afterwards. A read then returns the value from the woken pod. |
| `trailers` | Waits until each function is back at zero. A read of a missing item then comes back as `NotFound` (Go, through the generated glue) or `not_found` (Rust) through the cold activator path. A warm control makes the same call again and must get the same code. |
| `grpctrailers` | The same question over the gRPC protocol (HTTP/2, `createGrpcTransport`), where an error travels only as the `grpc-status` trailer. The zone's `/example/grpc` route makes the call and reports the code its client derived and the raw `grpc-status` it saw. A write to the Go function at zero must succeed with `grpc-status` 0; after it scales to zero again, a read of a missing item must come back `NotFound` from `grpc-status` 5. A warm control repeats the read and must get the same code and status. The phase fails closed: a call with no `grpc-status`, a status that disagrees with the code, or a cold result that differs from the warm one fails it. Go only; the Rust function is not covered. |
| `zerozone` | Checks from the objects that the operator rendered the function for h2c: its Knative Service port is named `h2c`, the URL injected into the zone is plain `http://` to the function's cluster-local name, and `EXAMPLE_SERVICE_HTTP_VERSION` is unset or `2` (an explicit `1.1` would win over the Node default). Sets the zone to minScale 0 and waits until the zone and the Go function both have no pod at all, and checks both again right before the call. One request through the zone (a single `curl`, not retried) must then return 200 and leave a pod on both sides. The woken zone's log must name h2c as the transport it chose for the function, and never HTTP/1.1. A read then returns the value written, and the zone is set back to minScale 1. |
| `rollout` | Changes the Go function's served contract version and waits until the zone runs with it. A newer function (1.1.0) is called by the zone, which was generated against 1.0.0. An older one (0.9.0) is refused by the zone's glue with `FailedPrecondition` before any call is made. The same version (1.0.0) is called again. After a 20 s hold, each bump must have created exactly one new zone revision (none if the version was already served). |
| `sovereignty` | A second zone lists four functions. Three of them take another zone's Secret, one through each source (`env` secretKeyRef, `envFrom`, a Secret volume). Each must be refused with `SovereigntyCompliant=False/SecretNotAllowed`, and after a 20 s hold must still have no Knative Service and no pod. The control takes its own zone's Secret through all three sources, and must be compliant and rendered. |
| `crosszone` | A function names a zone (`xz-owner`) that exists but does not list it, and another zone (`xz-listing`) lists it. After a 20 s hold, the listing zone must report `BackendBindings=False/CrossZoneBinding` with no `XZ_SERVICE_*` variable in its Knative Service, and the function must report `Bound=False/ZoneNotListed` and `Ready=False/ZoneNotListed`, with no Knative Service and no pod. |
| `wake` | Wake-ahead. The zone is restarted (a new revision) on an image that loads knext's real wake-ahead preload with `node --require` (the preload file, not knext's process-start loader). With the Go function opted out (`wakeAhead: false`), the function must stay at zero for 30 s after the zone starts, and the zone's first call pays the cold start. With it opted in (after it is back at zero), the operator renders `KNEXT_WAKE_FUNCTIONS=example` into the zone, which starts a new zone process, and that start must wake the function before any call, and the first call must be faster than the opted-out one. |

The functions here use the Connect protocol over h2c, the default for a Node zone.
In it, a failed unary call travels as an HTTP status plus a JSON error body, not as
gRPC trailers. The `trailers` phase checks that this code survives the activator (the `grpctrailers` phase checks the gRPC-protocol case). A
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
| `PHASES` | all | Any subset of `images deploy cold trailers grpctrailers zerozone rollout sovereignty crosszone wake`. |

## What it does not prove (the rest of Z10)

- A built Next.js zone, using the file-manager harness. That is a later slice.
- Cold-chain numbers on OKE.
- The read, write, auth-reject and warm-rotation scenarios. The Z7 lane covers these and they are not repeated here.
