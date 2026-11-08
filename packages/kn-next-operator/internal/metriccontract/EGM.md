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
- `scan.go` (package doc) counts a metric only when it is live: its package is linked into the binary built from `mainDir` for every architecture in `ShippedArchs`; it is registered on `metrics.Registry` by a statement in the leading run of registrations of an `init()` function (`markTopLevel`, an allowlist: every statement up to and including it is an expression statement, or the single right-hand side of an assignment or `var` declaration, optionally parenthesised, calling `Register`/`MustRegister` with arguments that call nothing but a known constructor); and it is built by a known constructor (`scan.go:constructors`) with a compile-time-constant name. Anything else in that run, such as a condition, loop, block, `defer`, `go`, closure call, helper call or any other statement, ends it and refuses every later registration, so the check fails closed. Not proven: that the registration succeeds (a `Register` error may be discarded). Not detected, but fatal to the whole process before anything is served: a panic in a package-level variable initialiser, or a panic while the run itself executes (a nil selector, an out-of-range index, a bad metric name, a fake constructor matched by name in a nested argument).
- Identifiers are resolved by scope (`go/types`), never by name. A shadowed or reassigned collector is an error.
- Anything the scanner cannot prove is an error, never a silent skip. `GoldenJSON` refuses an empty result.
- `scan.go:Scan`: the architectures must register the same set. Any difference is an error.

## Side Effects
- Reads Go source files from disk (`go/build`, `go/parser`). It does not write anything itself. The golden is written by its test when `KNEXT_UPDATE_METRIC_GOLDEN=1` is set.

## Verification
- Run: `go test ./internal/metriccontract/...` (in `packages/kn-next-operator`).
