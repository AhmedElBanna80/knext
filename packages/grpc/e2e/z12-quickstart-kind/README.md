# Z12: the zone-functions quickstart on kind

The quickstart, run for real. A Next.js zone is made the way the docs say
(`knext create`, `knext add function`, `knext generate`, `knext deploy function`,
`knext deploy`). It then calls its function through the generated glue from a Route
Handler, on a production build.

The Z7 and Z10 lanes use a small Node zone. This lane runs the real Next.js build,
its cache and its runtime loader, so it catches what those lanes cannot.

```bash
PHASES=up packages/grpc/e2e/z7-identity-kind/run.sh   # cluster, Knative, operator from this checkout
packages/grpc/e2e/z12-quickstart-kind/run.sh
```

It needs `docker`, `kind`, `kubectl`, `jq`, `curl`, `node`, `npm` and `bun` on the
PATH, plus the local registry that the Z7 `up` phase creates. The workspace must be
installed (`bun install`).

| Phase | What it does and proves |
| --- | --- |
| `pack` | Builds `@getknext/lib`, `db`, `core` and `grpc` from this checkout and packs them with `bun pm pack`. All four get one version, so the zone installs this checkout's code instead of a published release. Only the packed copies change; the tracked manifests do not. |
| `scaffold` | Runs `knext create --runtime node --cache-components` and installs the packs. It then runs `knext add function orders --lang go`, writes an `authorize()` that reads the user from an `x-sub` header, adds a Route Handler that writes and reads through the glue, and runs `knext generate`. |
| `function` | Builds and pushes the Go function. It then runs `knext deploy function` with no `--proto-version`, and checks that the served version (`1.0.0`) comes from the function's contract. The `specDigest` pin the command prints is kept for the next phase. |
| `zone` | Binds the function in `knext.config.ts` with that pin and runs `knext deploy`. The zone must become Ready, with its `BackendBindings` condition True. |
| `calls` | The function must be at zero first. A write through the generated Server Action, called from a Route Handler, wakes the function and must return. A read through the generated `'use cache'` query must return the value. A missing item must keep its `NotFound` code through `'use cache'` in production. A call that `authorize()` refuses must not be served. |
| `wake` | The function must be at zero first. A change to the zone starts a new zone process, and knext's own process-start loader must wake the function before any call is made. |

## Environment

| Variable | Default | Meaning |
| --- | --- | --- |
| `KIND_CLUSTER` | `knext-z7-e2e` | The kind cluster to use. |
| `REGISTRY_PORT` | `5001` | The local registry's port. |
| `Z12_NAMESPACE` | `z12-e2e` | The namespace to create. It is deleted and recreated each run, and only if this lane created it. |
| `PHASES` | all | The phases to run, separated by spaces. |
| `INTERNAL_PORT` | `18092` | The local port forwarded to the cluster-local gateway. |
| `Z12_ZERO_TIMEOUT` | `600` | Seconds to wait for the function to scale to zero. A function keeps its last pod for 5m30s by default. |

The packs, the scaffolded app and the recorded digests stay in
`$TMPDIR/knext-z12-e2e-state-<cluster>`, so a later run can start from any phase.
The script never deletes a cluster.
