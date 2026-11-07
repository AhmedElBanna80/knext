# proto

## Overview

Just enough of the Postgres wire protocol to route a connection: initial-packet framing, SSL/GSS negotiation codes, StartupMessage params and building an ErrorResponse. The gateway never speaks the query protocol. Once startup is done it pipes bytes (package doc, `proto.go`).

## Interface

- Wire magic numbers (`proto.go`): `SSLRequestCode` = 80877103, `GSSEncRequestCode` = 80877104, `CancelRequestCode` = 80877102, `Protocol30` = 196608 (3 << 16).
- Message kinds (`proto.go`): `TypeSSL`, `TypeGSSEnc`, `TypeCancel`, `TypeStartup`, and the parsed `Msg` struct (`Type`, `Params`, `Raw`).
- Parsing (`proto.go`): `ReadInitialPacket(buf)` returns `(packet, rest, ok, err)`: ok=false with no error when the buffer is not yet a whole packet, an error for a length outside 8..10000. `ParseInitialPacket(packet)` returns `(Msg, error)`.
- `IsReplication(params)` (`proto.go`): reports whether the `replication` startup param asks for a replication (walreceiver) session (case-insensitive `database`/`true`/`on`/`yes`/`1`).
- Builders (`proto.go`): `BuildStartup(params)`, `BuildSSLRequest()`, `BuildErrorResponse(code, message)`.
- Backend reads (`proto.go`): `ReadBackendMessage(r)` returns the type byte and raw message. `ErrorCode(raw)` pulls the SQLSTATE out of an ErrorResponse.

## Invariants

- Pure codec. It has no package state and does no I/O except through the `io.Reader` passed to `ReadBackendMessage` [`proto.go`].

## Side Effects

- None beyond reading from the caller's `io.Reader` in `ReadBackendMessage`.

## Verification

- Run: `cd packages/scale-zero-pg/gateway && go test ./internal/proto/...`
