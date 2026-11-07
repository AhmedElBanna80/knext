# @getknext/core source

## Overview

The source of `@getknext/core`. The five files directly in this directory are the
configuration schema and its loader, plus the Next.js version policy and
advisory table the CLI and `knext doctor` read. The runtime, the CLI, the
generators and the shared utilities each live in a subdirectory with its own
contract. `__tests__/` holds test code and fixtures only and has no contract.

## Interface

- `config.ts`: the `knext.config.ts` type surface, published as the package root
  export `.` (`dist/config.js`). Types only: `KnativeNextConfig` plus its parts
  `StorageConfig` (`StorageProvider` = `s3` | `gcs` | `azure` | `minio`),
  `CacheConfig` (`RedisCacheConfig`, `CacheProvider` = `redis`), `QueueConfig`
  (`KafkaQueueConfig` | `NoQueueConfig`, `QueueProvider` = `kafka` | `none`), `PostgresConfig`, `RedisInfraConfig`,
  `MinioInfraConfig`, `CompileConfig`, `InfrastructureConfig`, `WarmWindow`,
  `ScalingConfig`, `DatabaseSecretRef`, `DatabaseConfig`, `ObservabilityConfig`,
  `SecretRef`, `SecretsConfig`, `BackendBindingConfig`, `NetworkingConfig`,
  `CdnProvider`, `CdnPurgeConfig` and `CdnConfig`.
- `loader.ts`: `loadConfig(configPath): Promise<KnativeNextConfig>`, published as
  `./internal/loader`.
- `next-compat.ts`: `NEXT_PEER_RANGE` (`>=16.4.0 <16.5.0`),
  `CREDENTIALED_NEXT_MINORS` (`["16.4"]`) and `NEXT_MATRIX_VERSIONS`
  (`["16.4.3"]`).
- `next-advisories.ts`: `NEXT_ADVISORIES`, `NextAdvisory`, `NextAdvisoryRange`,
  `NextAdvisoryHit`, `isComparableNextVersion`, `minorWithoutFixedRelease` and
  `nextAdvisoriesFor`.
- `validate-public.ts`: re-exports `ConfigValidationError` and `validateConfig`
  from `./cli/validate`, published as `./validate`.
- Subdirectories:
  - [adapters](./adapters/EGM.md): the Next.js deployment adapter, the
    standalone-server supervisor, the cache handlers, observability and the
    single-executable compile pipeline.
  - [cli](./cli/EGM.md): the `knext` CLI (`bin` `knext` →
    `dist/cli/kn-next.js`).
  - [generators](./generators/EGM.md): the k6 load-test script and manifest
    generator.
  - [utils](./utils/EGM.md): static-asset upload and retention GC, plus the
    logger.

## Invariants

- `loadConfig` resolves the path against `process.cwd()` and throws if the file
  is missing, has no default export, or lacks `name` or `registry`. `storage` is
  deliberately not required (`loader.ts`); `cli/validate.ts` must stay in step
  with this check.
- `loadConfig` throws the missing-file error (`Configuration file not found:
  <path>`) before its `try`, so that one is not wrapped. Every later error (no
  default export, missing `name` or `registry`, or a failure inside the config's
  own `import()`) is re-thrown as `Failed to load config from <path>: <message>`
  (`loader.ts:loadConfig`).
- `NEXT_PEER_RANGE`, `CREDENTIALED_NEXT_MINORS` and `NEXT_MATRIX_VERSIONS` are
  the single source for the Next.js policy. `tests/release-policy-matrix.test.ts`,
  `next-peer-policy.test.ts` and `tests/next-minor-matrix.test.ts` assert that
  the manifests, the scaffold pins and the docs agree with them.
- `NEXT_ADVISORIES` lists only CRITICAL or HIGH advisories that have a published
  fix, so every `knext doctor` FAIL row comes with a version to upgrade to
  (`next-advisories.ts` header).
- `validate-public.ts` and everything it imports must stay pure: no
  `process.exit`, because consumers import it into their own build or test
  process (`validate-public.ts` header).

## Side Effects

- `loader.ts`: `existsSync` on the config path and a dynamic `import()` of it,
  which runs the user's config module.
- `config.ts`, `next-compat.ts`, `next-advisories.ts` and `validate-public.ts`:
  None.

## Verification

- Run: `node ../../scripts/bun-test.mjs packages/kn-next` (from
  `packages/kn-next`)
