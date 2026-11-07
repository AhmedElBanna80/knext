# testport

## Overview

Test-support package: race-free port reservation for tests that need an address that first refuses and later listens (a compute that is asleep and then woken) (`doc.go`). It is not used by production binaries. The files are build-tagged by platform.

## Interface

- `Reserve(t *testing.T) (host string, port int)` and `Listen(host, port) (net.Listener, error)`.
  - Unix build (`testport_unix.go`, `//go:build unix`): the race-free version. `Reserve` binds 127.0.0.1:0 without listening (connects are refused) and parks the fd in the package-level `coldReservations` map; `Listen` claims that fd and turns it into a listener (backlog 128), or plain-binds an unreserved address.
  - Non-unix build (`testport_other.go`, `//go:build !unix`): falls back to the original close-then-rebind reservation, so the test packages still compile off unix.

## Invariants

- Both build variants export the same `Reserve`/`Listen` signatures, so callers do not depend on the platform [`testport_unix.go`, `testport_other.go`].

## Side Effects

- Binds local TCP sockets for the test that calls it. On unix an unclaimed reservation is closed by a `t.Cleanup` registered in `Reserve` [`testport_unix.go:Reserve`].

## Verification

- Run: `cd packages/scale-zero-pg/gateway && go test ./internal/testport/...`
