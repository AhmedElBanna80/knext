# knext.v1 options contract

## Overview

`options.proto` is the protobuf contract every zone-function `.proto` file
imports. It declares which function serves a file's services, the contract
version of the file, and who may call each RPC. `knext add function` copies this
file into an app's proto directory (`src/add-function.ts:packagedOptionsProto`
reads it from here), and the code generators read the options it declares
(`src/plugin.ts:generateTs`, `src/glue-plugin.ts:plan`).

## Interface

- Package `knext.v1` (`options.proto`), importing `google/protobuf/descriptor.proto`.
- File option `string function = 50701` (`extend google.protobuf.FileOptions`):
  the zone function that serves the file's services. It names the
  `<NAME>_SERVICE_URL` binding (`src/config.ts:urlEnvFor`).
- File option `string contract_version = 50702`: the file's contract version as
  MAJOR.MINOR.PATCH.
- Enum `Auth`: `AUTH_UNSPECIFIED = 0`, `AUTH_USER = 1`, `AUTH_PUBLIC = 2`;
  number `3` and name `AUTH_PUBLIC_MUTATION` are reserved.
- Method option `Auth auth = 50703` (`extend google.protobuf.MethodOptions`).

## Invariants

- Field numbers never change, and a removed option's number is reserved rather
  than reused (`options.proto` header comment). `../../../buf.yaml` sets
  `breaking.use: FILE` and `lint.use: STANDARD` over the `proto` module.
- A file with services must set `(knext.v1.function)` to a valid function name
  and `(knext.v1.contract_version)` to a semantic version, or
  `protoc-gen-knext` refuses it (`src/plugin.ts:generateTs`).
- Every RPC must state `(knext.v1.auth)`. Only `AUTH_USER` or `AUTH_PUBLIC` is
  accepted, and `AUTH_PUBLIC` only with `idempotency_level = NO_SIDE_EFFECTS`
  (`src/glue-plugin.ts:authOf`). No public write exists: `3` is reserved
  (`options.proto:Auth`).
- The function's contract version must be at least the version the zone was
  generated against (`options.proto` comment on `contract_version`; enforced at
  call time by `src/glue.ts:servedVersion` through `src/skew.ts:checkContractSkew`).

## Side Effects

- None. This is a declarative schema.

## Verification

- Run: `node scripts/bun-test.mjs packages/grpc` (from the repository root).
