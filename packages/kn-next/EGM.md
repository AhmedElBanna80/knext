# @getknext/core Blueprint

## System Overview

`@getknext/core` is the scale-to-zero Next.js adapter for Knative. It ships four
things from one package:

- the `knext` CLI, which builds the app, pushes a digest-pinned image and applies
  a `NextApp` custom resource for the operator to reconcile;
- the runtime pieces that run inside the app's pod: the official `NextAdapter`,
  the standalone-server supervisor, the Redis cache handlers and the
  observability preloads;
- the `knext.config.ts` type surface and its validator;
- the `templates/` tree the CLI renders: the `knext create` app scaffold
  (`templates/app/*.hbs`), the standalone runtime templates
  (`templates/runtime-standalone/`) and the vinext patch set
  (`templates/vinext-patches/manifest.json` plus its `.patch` files).

The published surface is the `exports` map in `package.json`: `.` (config
types), `./adapter`, `./validate`, five `./adapters/*` subpaths and the
`./internal/*` wiring subpaths. The tarball contains only `dist` and `templates`,
and the package requires Node >= 24.

## Local Interface & Invariants

- `tsup.config.ts`: the build. Each published subpath and each CLI verb the
  dispatcher loads lazily has its own named `entry` (for example `cli/kn-next` ←
  `src/cli/deploy.ts`, `adapters/cache-handler` ← `src/adapters/cache-handler.public.js`),
  so a dynamic import resolves to a stable `dist` path.
- `Dockerfile.standalone-bun.trivyscan` and
  `Dockerfile.standalone-self-contained.trivyscan`: minimal Dockerfiles that
  reproduce the shipped standalone images' runtime OS layer for the built-image
  Trivy scan (`../../tests/built-image-trivy.test.ts`, `SCAN_FIXTURE`). They are
  test fixtures and are not in the tarball.
- Invariant: `adapters/cache-handler` is built from the thin `.public.js`
  re-export, not from the implementation (`tsup.config.ts` comment at that
  entry).

## Subdirectories & System Boundaries

- src: [./src/EGM.md](./src/EGM.md) - the config schema, the config loader and
  the Next.js version policy, plus the `adapters`, `cli`, `generators` and
  `utils` contracts.
- bench: [./bench/EGM.md](./bench/EGM.md) - manual benchmark scripts for
  supervisor cold-start overhead, boot phases and HTTP load. Not run by the test
  suite.
- templates: ships in the tarball (`package.json` `files`) and has no contract,
  since it holds render templates and patches, not code.

## Global Invariants

- App-state cluster writes from the CLI target only the `NextApp` and
  `BackendService` custom resources, and every `kubectl apply` passes
  `--validate=strict` (see [./src/cli/EGM.md](./src/cli/EGM.md)).
- The image in the custom resource must be pinned by `@sha256` digest.
- Redis faults in the cache handlers fail open; the CDN edge decision and the
  single-executable compile pipeline fail closed (see
  [./src/adapters/EGM.md](./src/adapters/EGM.md)).

## Global Side Effects

- Kubernetes API (through `kubectl`), container registries, Redis, object
  storage (`gsutil`, `aws`, `mc`, `az`), the CDN provider APIs, Postgres
  (deep-health probe) and Prometheus scraping on the metrics port.

## System Verification

- Run: `node ../../scripts/bun-test.mjs packages/kn-next` (from
  `packages/kn-next`), or `npm test` in this directory.
