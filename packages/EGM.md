# packages

## Overview

The knext workspace packages. Three of them publish together under the
`@getknext/*` scope as the user-facing SDK: `core`, `lib` and `db`.
`kn-next-alias` also publishes, as a forwarding alias. The other packages are
private: the Go operator, the database layer, two opt-in Beta modules, a UI kit
and a GitHub Action. Each package has its own contract below.

## Subdirectories & Boundaries

- kn-next: [./kn-next/EGM.md](./kn-next/EGM.md) - `@getknext/core`, published:
  the `knext` CLI, the official Next.js adapter and runtime, and the
  `knext.config.ts` types.
- kn-next-operator: [./kn-next-operator/EGM.md](./kn-next-operator/EGM.md) - the
  Go operator. It reconciles `NextApp`, `BackendService` and `KnextPlatform`
  custom resources into Knative Serving objects, and is the single source of
  truth for cluster state.
- lib: [./lib/EGM.md](./lib/EGM.md) - `@getknext/lib`, published: the shared
  runtime library (logging, Postgres/Redis/Cerbos/MinIO clients, request
  correlation, health checks).
- db: [./db/EGM.md](./db/EGM.md) - `@getknext/db`, published: the data SDK, a
  thin drizzle-orm wrapper over the Postgres pools `@getknext/lib` owns.
- scale-zero-pg: [./scale-zero-pg/EGM.md](./scale-zero-pg/EGM.md) - private: the
  wake-on-connect Postgres gateway plus the AppDatabase and Zone operators (Go
  and Kubernetes).
- grpc: [./grpc/EGM.md](./grpc/EGM.md) - `@getknext/grpc`, private, Beta: zone
  functions over Connect, with protobuf as the contract. Core loads it lazily
  for the `generate`, `add` and `deploy` verbs.
- ffi: [./ffi/EGM.md](./ffi/EGM.md) - `@getknext/ffi`, private, Beta: in-process
  Rust in Bun zones through `bun:ffi`. Core loads it only for `knext ffi`.
- ui: [./ui/EGM.md](./ui/EGM.md) - `@getknext/ui`, private and never published: a
  React 19 component library consumed from source.
- kn-next-alias: [./kn-next-alias/EGM.md](./kn-next-alias/EGM.md) - the legacy
  bare-name npm alias. It only forwards to the `@getknext/core` CLI.
- kn-next-action: [./kn-next-action/EGM.md](./kn-next-action/EGM.md) -
  `@getknext/action`, private: a composite GitHub Action that delegates to
  `knext deploy`.
