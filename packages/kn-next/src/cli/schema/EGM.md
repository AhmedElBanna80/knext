# schema

## Overview

Guards deploys against skew between the NextApp CRD fields and the CLI fields.
Before deploy touches the cluster, a runtime prune preflight runs a server-side
strict dry-run apply and then diagnoses any failure from the OpenAPI v3
document or the CRD. Build-time tools scan `../cr-builder.ts` to produce the
generated list of every field path the CLI can emit. Consumers are
`../deploy.ts`, `../preview.ts` (`captureKubectl`, `assertCRSchemaCompatible`
and `preflightImageRef`), `../grpc-dispatch.ts`, `../visibility-guard.ts` and
`../doctor/checks/crd-schema.ts`.

## Interface

- `preflightCRSchema` (`preflight.ts`): returns a verdict of `ok`, `skew` or `blocked`.
- `assertCRSchemaCompatible` (`preflight.ts`): throws on any verdict other than `ok`.
- `dryRunApplyArgv`, `readKnownCRDFields(kubectl, kind = NextApp)`, `unknownFieldsOfCR`, `preflightImageRef`, `formatPreflightFailure` (`preflight.ts`).
- Preflight types in `preflight.ts`: `KubectlCapture`, `KubectlResult`, `PreflightVerdict`, `PreflightReason`, `DiagnosisSource`, `PreflightOutcome`, `KnownFieldsRead` and `PreflightFailureContext`.
- `captureKubectl` (`kubectl-capture.ts`): the production `KubectlCapture` runner.
- `flattenSchemaPaths`, `isFieldKnown`, `unknownEmittedFields`, `partitionMissingFields`, `presentEmittedPaths`, `PartitionedMissingFields` (`crd-schema.ts`): compare the schema with the emitted fields.
- `crdSchemaFromCrdObject`, `crdSchemaFromOpenApiV3Doc`, `parseUnknownFieldsFromError` (`crd-schema.ts`): extractors.
- `openApiV3Argv`, `crdGetArgv` (`crd-schema.ts`): build the kubectl argv.
- Constants in `crd-schema.ts`: `CONDITIONALLY_EMITTED_FIELDS` (`spec.security.writeFree`, `spec.networking`), `NEXTAPP_KIND`, `NEXTAPP_CRD_NAME`, `BACKENDSERVICE_KIND` and `BACKENDSERVICE_CRD_NAME`.
- `extractEmittedFields`, `objectLiteralKeys`, `LiteralKey` (`extract-emitted-fields.ts`): a TypeScript-compiler scanner over `buildNextAppCRObject`. For build and test use only.
- `renderEmittedFieldsModule`, `renderCrFieldsJson`, `renderCrFieldsMarkdown`, `CR_FIELDS_ARTIFACT_VERSION` (`gen-artifacts.ts`): deterministic renderers that return strings.
- `EMITTED_CR_FIELD_PATHS` (`emitted-fields.generated.ts`): the generated list of emitted field paths.

## Invariants

- The verdict comes from `kubectl apply --dry-run=server --validate=strict -f <cr> -n <ns>` [`preflight.ts:dryRunApplyArgv`].
- `skew` means stderr contains `strict decoding error` or `unknown field "`. `blocked` has the reasons `client-too-old` (kubectl before 1.25), `webhook-unavailable` and `apply-failed` [`preflight.ts:preflightCRSchema`].
- The diagnosis and enrichment tiers change only the message, never the verdict. `assertCRSchemaCompatible` throws on both `skew` and `blocked`, with no warn-and-continue path [`preflight.ts`].
- If neither the OpenAPI v3 read nor the CRD read yields a schema (denied, absent or unparseable), the result has source `none`, never an empty field set. An empty set would report every field as missing [`preflight.ts:readKnownCRDFields`].
- The diagnosis reads the schema of the CR's own `kind`: a NextApp CR is checked against `EMITTED_CR_FIELD_PATHS` narrowed to what it carries, and a BackendService CR is walked directly against its CRD (`backendservices.apps.kn-next.dev`), with a map key or array index read as `*`, a key under an opaque node (`.**`) known, and an unknown field reported once at its shallowest path. A kind with no CRD in `CRD_NAME_OF_KIND` reads no schema (source `none`), so the fields are named from the apiserver's message. A CR file that cannot be parsed, or names no `kind`, is diagnosed as a NextApp [`preflight.ts:preflightCRSchema`, `readKnownCRDFields`, `unknownFieldsOfCR`].
- The preflight runs before build and push. When the image ref has no digest, it uses the placeholder digest `sha256:000…0` [`preflight.ts:preflightImageRef`].
- In `doctor`, a missing emitted field is a hard failure unless it is listed in `CONDITIONALLY_EMITTED_FIELDS`, which only warns (`partitionMissingFields`). The preflight does not read that list: there, any unknown field the CR carries is `skew` [`crd-schema.ts`].
- The OpenAPI v3 path needs no cluster-scoped RBAC. `kubectl get crd` is used for enrichment only [`crd-schema.ts:openApiV3Argv`, `crdGetArgv`].
- Do not edit `emitted-fields.generated.ts` by hand. Regenerate it from the repository root with `bun scripts/gen-cr-fields.ts`; `cr-fields-generated.test.ts` checks it. The renderers emit no timestamps, hashes or host paths [`gen-artifacts.ts`].
- The scanner throws if `buildNextAppCRObject` is missing or has no return statement [`extract-emitted-fields.ts:extractEmittedFields`].
- `captureKubectl` uses `shell: false` and a 32 MB `maxBuffer`, and never throws [`kubectl-capture.ts`].

## Side Effects

- Spawns `kubectl` through `spawnSync`. The calls are `apply --dry-run=server --validate=strict` (a server-side dry run that persists nothing), `get --raw /openapi/v3/apis/<group>/<version>` and `get crd <name> -o json`.
- Reads the rendered CR YAML from disk.
- No file writes, network calls or environment reads. The wrapper in the repository-root `scripts/gen-cr-fields.ts` writes the generated artifacts. The code throws instead of calling `process.exit`.

## Verification

- Run from `packages/kn-next`: `node ../../scripts/bun-test.mjs packages/kn-next`.
