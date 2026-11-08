# internal/metriccontract

## Overview
A Go-AST scanner that derives the metric families the operator binary actually registers on controller-runtime's `metrics.Registry`. It produces the committed golden `operator-metrics.golden.json`, which the TypeScript observability metric contract (`packages/kn-next/src/adapters/metric-contract.ts`) reads.

## Interface
- `scan.go:Scan(moduleRoot, mainDir string) (map[string]Family, error)`: scans every architecture in `ShippedArchs`.
- `scan.go:Family{Type string; Vec bool}`: `Type` is one of counter, gauge, histogram or summary.
- `scan.go:GoldenJSON(map[string]Family) ([]byte, error)`: renders `{"$comment", "families": name->type}`, sorted and newline-terminated.
- `scan.go:GoldenPath = "internal/metriccontract/operator-metrics.golden.json"`.
- `scan.go:ShippedArchs = []string{"amd64", "arm64"}`.
- Data: `operator-metrics.golden.json`, regenerated with `KNEXT_UPDATE_METRIC_GOLDEN=1 go test ./internal/metriccontract/`.

## Invariants
- `scan.go` (package doc) counts a metric only when it is live: its package is linked into the binary built from `mainDir` for every architecture in `ShippedArchs`; it is registered on `metrics.Registry` by a top-level statement of an `init()` function (an expression statement, or the right-hand side of an assignment or `var` declaration, optionally parenthesised) with no earlier `return`, `goto`, labeled statement or `panic` in that `init()` (including a `panic` inside a function literal called on the spot, deferred inside such a literal, or go-started, a `go panic(...)`, and a panic while evaluating the arguments of a deferred or go-started call); and it is built by a known constructor (`scan.go:constructors`) with a compile-time-constant name. Refused, never counted: a registration under an `if`, `switch`, `select`, `range`, type switch, loop, bare block, closure, `defer` or `go` statement, as an argument to another call, or after an earlier exit. Not proven: that the registration succeeds (a `Register` error may be discarded), or that `init()` is reached (a non-terminating loop, `os.Exit`, or a `panic` inside a named helper, or inside a literal bound to a variable and called through it, is not detected).
- Identifiers are resolved by scope (`go/types`), never by name. A shadowed or reassigned collector is an error.
- Anything the scanner cannot prove is an error, never a silent skip. `GoldenJSON` refuses an empty result.
- `scan.go:Scan`: the architectures must register the same set. Any difference is an error.

## Side Effects
- Reads Go source files from disk (`go/build`, `go/parser`). It does not write anything itself. The golden is written by its test when `KNEXT_UPDATE_METRIC_GOLDEN=1` is set.

## Verification
- Run: `go test ./internal/metriccontract/...` (in `packages/kn-next-operator`).
