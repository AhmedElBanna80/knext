# knext Blueprint

## System Overview

knext is the scale-to-zero Next.js adapter for Knative and Kubernetes. A user's
app is built with the official Next.js Deployment Adapter, run as a
digest-pinned image, and described to the cluster by a `NextApp` custom
resource. The Go operator reconciles that resource into Knative Serving objects,
which scale the app to zero when idle.

The control flow has three parts:

- The `knext` CLI (`@getknext/core`) builds and pushes the image, renders the
  `NextApp` (and, for zone functions, `BackendService`) resource, preflights it
  against the cluster's CRD, and applies it with `--validate=strict`.
- The operator (`packages/kn-next-operator`) is the single source of truth for
  cluster state. It turns those resources into Knative Services and their
  supporting objects.
- Inside the pod, the runtime pieces in `@getknext/core` (adapter, standalone
  supervisor, Redis cache handlers, observability) serve the app. The shared
  clients in `@getknext/lib` and the data SDK in `@getknext/db` back them.

This file covers the platform code only. `apps/`, `examples/`, `spikes/`,
`templates/`, `docs/`, `benchmarks/` and the test trees have no contracts.

## Subdirectories & System Boundaries

- packages: [./packages/EGM.md](./packages/EGM.md) - every workspace package: the
  published `@getknext/core`, `lib` and `db` and the `kn-next-alias` alias; the
  operator; the database layer; the Beta `grpc` and `ffi` modules; the UI kit;
  the GitHub Action.
- crates: [./crates/EGM.md](./crates/EGM.md) - the Cargo workspace for the
  in-process Rust crates (Beta), kept outside the repo root so no tool mistakes
  the monorepo for a Rust project.
- scripts: [./scripts/EGM.md](./scripts/EGM.md) - repo tooling: CI guards and
  gates, release and publish automation, the compatibility-harness e2e drivers,
  supply-chain scans and the mutation-prover fleet.
- infra: [./infra/EGM.md](./infra/EGM.md) - build infrastructure outside the
  packages: a patched Bun built on Cloud Build for CI verification only, never
  shipped to users.
- deploy: [./deploy/EGM.md](./deploy/EGM.md) - release build recipes, today the
  opt-in patched Bun compile toolchain built on Cloud Build.

## Global Invariants

- Every app-state cluster write from the CLI targets a knext custom resource
  (`NextApp` or `BackendService`) and nothing else. The operator reconciles it;
  nothing else mutates cluster state out of band (see
  [./packages/kn-next/src/cli/EGM.md](./packages/kn-next/src/cli/EGM.md) and
  [./packages/kn-next-operator/EGM.md](./packages/kn-next-operator/EGM.md)).
- Images are pinned by `@sha256` digest; the CLI refuses a tag-only reference
  (`cr-builder.ts:validateCRImageRef`).
- The publishable `@getknext/core`, `@getknext/lib` and `@getknext/db` ship
  together.

## Global Side Effects

- Kubernetes API (custom resources, Knative Serving objects, network policies),
  container registries, Redis, Postgres, object storage, CDN provider APIs,
  Prometheus scraping, and Cloud Build for the patched Bun toolchains.

## System Verification

- Run: `node scripts/bun-test.mjs` (repo root `test` script). Packages with their
  own toolchains are verified in place: `make test` in
  `packages/kn-next-operator`, the `test` script in `packages/scale-zero-pg`, and
  `cargo test` in `crates`.
