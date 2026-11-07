# gke/variants

## Overview
Bench-only image variants for the GKE cold-start study. `Dockerfile.variants` builds each variant `FROM` the exact digest of its baseline release-cell image (`bc-bun-turbopack` for the bun stages, `bc-node-turbopack` for the node stages), so each variant changes one variable. `cloudbuild.yaml` builds the stages for `linux/amd64` with `docker buildx`. The three source files here are copied into those images. None of them is product code.

## Interface
- `bc-check.mjs`: CLI `bun bc-check.mjs <file>`. It reads a compiled standalone executable, finds every `knext-standalone-exec:<24 hex>` marker in the binary, counts the `// @bun @bytecode` and `// @bun @bun-cjs` pragmas, and prints one JSON line with `file`, `bytes`, `sha256`, `markers`, `pragma_bytecode`, `pragma_plain` and `verdicts`. Each verdict comes from `verifyBytecodeExec(bytes, marker)`.
- `warm-entry.mjs`: a replacement image entry (the warm-before-ready prototype). It starts a loop that GETs `http://127.0.0.1:${PORT}${KNEXT_WARM_PATH}` (defaults `3000`, `/api/health`) every 20 ms, for at most 1500 tries, until the first OK response. It logs `knext-bench warm-up 200` with `ms` and `tries`, and then runs `await import('@getknext/core/internal/node-server')`.
- `instrumentation-stub.js`: exports `module.exports = { register: async function register() {} }`, which is a no-op instrumentation hook.
- `Dockerfile.variants` (not source): the stages `compile`, `bun-nobc`, `bun-sc`, `bun-warm`, `bun-noinstr`, `node-noinstr` and `node-warm`.

## Invariants
- `bc-check.mjs` imports `./bytecode-exec-verify.mjs`, which is not in this directory. `Dockerfile.variants` copies `bytecode-exec-verify.mjs bc-check.mjs /tools/` before running it. The repo's copy of the verifier is `packages/kn-next/src/adapters/bytecode-exec-verify.mjs`.
- `warm-entry.mjs` does not change readiness. It only sends localhost GETs, and the unchanged probe still decides Ready (header comment). The handoff to `@getknext/core/internal/node-server` happens without waiting for the warm-up loop.
- In `Dockerfile.variants`, the `compile` stage disables the fail-closed verifier for the no-bytecode build only, by a `sed` on `if (!verdict.ok)` in `standalone-compile.js`, and builds it with `KNEXT_STANDALONE_COMPILE_NO_BYTECODE_FOR_VERIFIER_TEST=1`. The bytecode and self-contained executables are compiled first, with the verifier active. Before and after the edit it checks that the pattern occurs exactly once (`test "$(grep -c ...)" = 1`).

## Side Effects
- `bc-check.mjs`: reads the file given as `process.argv[2]` and writes JSON to stdout.
- `warm-entry.mjs`: makes HTTP requests to loopback and writes one JSON log line to stdout.
- `instrumentation-stub.js`: none.

## Verification
- Run: `node scripts/bun-test.mjs tests/bench-cold-start-harness.test.ts tests/dockerfile-numeric-nonroot-user.test.ts` (from the repo root)
