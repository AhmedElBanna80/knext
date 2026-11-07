# cmd/policygen

## Overview
A small developer CLI (`go run ./cmd/policygen`) that prints the operator's rendered NetworkPolicy (or a zone function's objects) as YAML on stdout. The NetworkPolicy enforcement drill applies this output instead of a hand-copied manifest, so a change to the operator's real rules also changes what the drill applies.

## Interface
- `main.go:main`, with these flags:
  - `-app`: render `controller.DesiredNetworkPolicy(app, namespace)`.
  - `-function`, `-zone`, `-image`: render `controller.RenderFunctionObjects(bs, 0)`, which returns the function's ServiceAccount and Knative Service, plus its NetworkPolicy (the synthetic BackendService leaves the NetworkPolicy at its default-on setting), joined by `---`.
  - `-port` (default `8080`, the h2c container port) and `-namespace` (default `default`).

## Invariants
- `main.go:main`: `-function` requires both `-zone` and `-image`, otherwise exit 2. With neither `-app` nor `-function` it also exits 2. When both are given, `-function` wins.
- `main.go:main`: the drill that consumes this output is `test/networkpolicy-enforcement-drill.sh`.
- `main.go:main`: the synthetic BackendService it renders sets `ProtoVersion: "1.0.0"` and passes a zone retention of `0`.
- Rendering delegates to `internal/controller`. This command holds no policy logic of its own.

## Side Effects
- Writes YAML to stdout and errors to stderr. It reads no cluster objects (`RenderFunctionObjects` reads none). Exits 1 on an encode or render failure.

## Verification
- Run: `go test ./cmd/...` (in `packages/kn-next-operator`), or `make test`.
