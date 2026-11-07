# generators

## Overview

Pure text generators for the standalone `loadtest` CLI entry
(`dist/cli/loadtest.js`, not a verb of the `knext` bin). `loadtest-job.ts` builds a
k6 JavaScript load-test script and a matching Kubernetes `ConfigMap` + `Job` YAML
pair that runs the script in-cluster against a Knative service URL. It is the only
file in this directory (raw Knative manifest generation was removed; the CLI emits
the `NextApp` CR through `src/cli/cr-builder.ts` instead).

The load test is a manual/nightly runbook (`scripts/load-test.sh`), not a PR gate;
only the generator output shape is unit-tested. Consumer: `src/cli/loadtest.ts`.

## Interface

- `type LoadTestType = "smoke" | "load" | "spike" | "scale-to-zero"`
  (`loadtest-job.ts:LoadTestType`).
- `generateK6Script(targetUrl: string, type: LoadTestType): string`
  (`loadtest-job.ts:generateK6Script`) - returns a k6 script that issues
  `http.get(targetUrl)`, checks `status was 200` and `transaction time OK`
  (`duration < 200` ms), then `sleep(1)`. `type` selects the `options` block:
  - `smoke`: `vus: 1`, `duration: '1m'`.
  - `load`: stages 30s to 50 VUs, 2m at 50, 30s to 0.
  - `spike`: stages 10s to 10, 1m to 200, 10s to 10.
  - `scale-to-zero`: two `shared-iterations` scenarios (`cold_start`,
    `after_scale_down` with `startTime: '5m'`), 10 VUs / 100 iterations each,
    to wake the ksvc, wait past the scale-to-zero window, and hit a cold start.
- `generateLoadTestManifests(appName, namespace, targetUrl, type, prometheusUrl?): [string, string]`
  (`loadtest-job.ts:generateLoadTestManifests`) - returns `[configMap, job]`:
  - `ConfigMap` `k6-script-<jobName>` with the script under `data["test.js"]` as
    a block scalar.
  - `batch/v1` `Job` `<jobName>` (`jobName = k6-<appName>-<type>-<Date.now()>`),
    labels `app: k6-loadtest`, `target: <appName>`, `ttlSecondsAfterFinished: 3600`,
    `restartPolicy: Never`, image `grafana/k6:0.49.0`, script mounted at `/scripts`.
  - When `prometheusUrl` is set: args
    `["run", "--out", "experimental-prometheus-rw", "/scripts/test.js"]` and env
    `K6_PROMETHEUS_RW_SERVER_URL=<prometheusUrl>/api/v1/write`; otherwise
    `["run", "/scripts/test.js"]` with `env: []`.

## Invariants

- Pure functions: no `bun` or shell imports, no I/O, so the module stays
  unit-testable (`loadtest-job.ts` header).
- The script is indented by splitting on a real newline (`"\n"`) and prefixing
  non-empty lines with 4 spaces; empty lines stay empty. Splitting on a literal
  `"\\n"` produced a broken single-line ConfigMap and must not come back.
- The `ConfigMap` name and the `Job` volume's `configMap.name` are both
  `k6-script-<jobName>`; they must stay equal.
- `jobName` embeds `Date.now()`, so output is not deterministic across calls.
- Input strings (`targetUrl`, `appName`, `namespace`, `prometheusUrl`) are
  interpolated verbatim; no escaping or validation happens here.
- These manifests are a named, counted exception to the "CLI writes only knext
  CRs" rule (`scripts/lib/cli-cluster-write-scan.mjs`, `KIND_EXCEPTIONS` /
  `MANIFEST_WRITES`). Do not add new raw cluster kinds here without updating that
  scan.

## Side Effects

- None in this module. It returns strings only. The caller (`src/cli/loadtest.ts`)
  applies them to the cluster.
- `Date.now()` is read to name the job.

## Verification

- Run (from `packages/kn-next`): `node ../../scripts/bun-test.mjs packages/kn-next`
