# @getknext/grpc source

## Overview

The source of `@getknext/grpc`, the opt-in zone-functions module (Beta). It has
two halves:

- **CLI verbs** that core loads lazily: `knext generate` (buf lint, optional
  buf breaking, and in-process codegen), `knext add function` (contract and
  server-project scaffold) and `knext deploy function` (build and apply a
  `BackendService` CR through a host seam that core supplies).
- **Runtime** that the generated code imports from `@getknext/grpc/runtime`: the
  policy-enforcing Connect client, the Next.js glue helpers, and the zone
  identity-token signer.

The tsup entries are `cli.ts`, `runtime.ts` and `skew.ts`
(`../tsup.config.ts`).

## Interface

### CLI dispatch (`cli.ts`)

- `DISPATCH_PROTOCOL` (1), `GRPC_VERSION`, `CORE_PEER_RANGE` (read from
  `../package.json` `peerDependencies['@getknext/core']`), `VERBS`
  (`generate`, `add`, `deploy`), `helpText(verb)`, `RunIo` (adds `cwd` and the
  `host: DeployHost` seam), and `run(verb, argv, io)`, which returns an exit
  code.

### Settings (`config.ts`)

- `CONFIG_FILE` (`knext.grpc.json`), `LANGUAGES` (`go`, `rust`), `Language`,
  `FunctionEntry`, `GrpcConfig` (`proto`, `out`, `deadlineMs`,
  `gatewayTimeoutSeconds`, optional `authorize`, optional `deployedTagTemplate`,
  `functions`), `DEFAULT_CONFIG`
  (`proto`, `src/generated/grpc`, 10000 ms, 300 s), `GrpcUsageError`.
- `AUTHORIZE_EXTENSIONS`, `exportsAuthorize(source)`, `checkFunctionName(name)`,
  `urlEnvFor(name)` (`<NAME>_SERVICE_URL`), `SERVICE_PROTO_VERSION_SUFFIX`,
  `protoVersionEnvFor(name)`, `SERVICE_HTTP_VERSION_SUFFIX`, `httpVersionEnvFor(name)`
  (`<NAME>_SERVICE_HTTP_VERSION`), `parseConfig(raw)`, `loadConfig(cwd)`,
  `serializeConfig(config)`.

### Generate (`generate.ts`, `plugin.ts`, `glue-plugin.ts`, `policy.ts`, `baseline.ts`, `buf.ts`)

- `generate.ts`: `MANIFEST` (`.knext-generated.json`), `Io`,
  `generateFiles(cwd, config)`, `Drift`, `previouslyWritten(outDir)`,
  `diffOutput(expected, outDir)`, `writeFileAtomic(target, content)`,
  `RunGenerateOptions`, `runGenerate(opts)`.
- `plugin.ts` (`protoc-gen-knext`): `PLUGIN_NAME`, `FORMAT_VERSION` (`v1`),
  `RUNTIME_MODULE` (`@getknext/grpc/runtime`), `KnextPluginOptions`,
  `knextClientPlugin`. It writes `<file>_knext.ts` with one
  `defineFunctionClient(...)` per service.
- `glue-plugin.ts` (`protoc-gen-knext-glue`): `GLUE_PLUGIN_NAME`,
  `GluePluginOptions`, `serviceTag(fn, method)` (`knext:<fn>:<service>`),
  `emitActionGuard(method)`, `knextGluePlugin`. It writes `<file>_knext_server.ts`
  (cached queries and server-streaming generators) and `<file>_knext_actions.ts`
  (`"use server"` Server Actions).
- `policy.ts`: `MethodKind`, `READ_MAX_ATTEMPTS` (3), `DEFAULT_DEADLINE_MS`
  (10000), `DEFAULT_GATEWAY_TIMEOUT_SECONDS` (300), `methodKind(method)`,
  `checkBudget(deadlineMs, gatewayTimeoutMs)`.
- `baseline.ts`: `DeployedRef`, `DeployedBaselineSource`,
  `BaselineUnavailableError`, `resolveBaseline(spec, deployed)`,
  `ServedVersionReader`, `DEFAULT_DEPLOYED_TAG_TEMPLATE` (`proto/v{version}`),
  `DeployedBaselineOptions`, `checkTagTemplate(template)`,
  `createDeployedBaselineSource(opts)`. `RunGenerateOptions` also takes
  `servedVersionReader` and `context`; `RunIo` (`cli.ts`) carries the
  `servedVersionReader` core supplies to `generate`.
- `buf.ts`: `BUF_VERSION` (`1.73.0`), `BUF_SHA256` (per-platform npm package and
  sha256), `BufPlatform`, `BufIntegrityError`, `bufPlatform()`,
  `verifyBufBinary(path, expected)`, `ResolveOptions`, `resolveBufBinary(opts)`,
  `RunBufOptions`, `BufResult`, `runBuf(args, opts)`.

### Add function (`add-function.ts`, `scaffold-template.ts`, `scaffold-go.ts`, `scaffold-rust.ts`)

- `add-function.ts`: `packagedOptionsProto()`, `pascal(name)`,
  `contractFor(name)`, `DEFAULT_AUTHORIZE` (`src/knext/authorize.ts`),
  `AUTHORIZE_STUB`, `AddFunctionOptions`, `addFunction(opts)`.
- `scaffold-template.ts`: `TemplateExclude`, `isExcludedBy`,
  `resolveLangTemplateDir`, `walkFiles`, `StagedFunction`, `StageInput`,
  `stageProject`.
- `scaffold-go.ts`: `GO_TEMPLATE_EXCLUDES`, `isExcluded`, `resolveTemplateDir`,
  `goTemplateDir`, `goTemplateFiles`, `scaffoldedFromTemplate`,
  `checkModulePath`, `GoScaffold`, `substitute`, `StagedGoFunction`,
  `stageGoFunction`.
- `scaffold-rust.ts`: `RUST_TEMPLATE_EXCLUDES`, `RUST_GITIGNORE`, `isExcluded`,
  `resolveRustTemplateDir`, `rustTemplateDir`, `rustTemplateFiles`,
  `scaffoldedRustFromTemplate`, `RUST_KEYWORDS_2024`, `RUST_TOOLCHAIN_CRATES`,
  `lockedPackageNames`, `checkCrateName`, `RustScaffold`, `upperSnake`,
  `stripVectorGate`, `renameLockedPackage`, `substituteRust`, `codegenCacheDir`,
  `StagedRustFunction`, `stageRustFunction`.

### Deploy function (`deploy-function.ts`, `backend-service.ts`, `spec-digest.ts`)

- `deploy-function.ts`: `PreflightResult` (`verdict`: `ok` | `skew` | `blocked`),
  `DeployHost` (`preflight`, `apply`), `DEPLOY_USAGE`,
  `formatPreflightFailure(outcome)`, `contractVersionFor(protoDir, name)`,
  `DeployFunctionArgs`, `deployFunction(args)`.
- `backend-service.ts`: `BACKEND_SERVICE_API_VERSION` (the same group and version
  as `NextApp`), `BACKEND_SERVICE_KIND` (`BackendService`),
  `BackendServiceScalingInput`, `BackendServiceInput`, `BackendServiceCR`,
  `checkImageDigest(image)`, `buildBackendServiceCR(input)`,
  `renderBackendServiceCR(cr)`.
- `spec-digest.ts`: `SPEC_DIGEST_DOMAIN` (`knext/backendservice-spec/v1\n`),
  `BACKEND_SPEC_PINNED_FIELDS` (`image`, `env`, `envFrom`, `volumes`),
  `canonicalBackendSpec(spec)`, `backendSpecDigest(spec)` (`sha256:<hex>`).

### Runtime (`runtime.ts`, `glue.ts`, `signer.ts`, `skew.ts`, `semver.ts`)

- `runtime.ts`: `MethodPolicy`, `MethodPolicies`, `FunctionClientDefinition`,
  `TokenSource`, `CallOptions`, `WriteCallOptions`, `FunctionClient`,
  `HttpVersion`, `RuntimeDeps`, `IDEMPOTENCY_KEY_HEADER` (`idempotency-key`),
  `CONTRACT_VERSION_HEADER` (`knext-contract-version`), `AUTHORIZATION_HEADER`,
  `runningOnBun()`, `TransportChoice`, `chooseTransport(opts)`,
  `defineFunctionClient(def, deps)`. It re-exports from `glue.ts`:
  `Authorize`, `AuthorizeContext`, `Principal`, `TokenMinter`, `TokenRequest`,
  `PUBLIC_SUBJECT`, `QUERY_CACHE_LIFE`, `QUERY_ERROR_CACHE_LIFE`, `CachedResult`,
  `cacheableCall`, `unwrapCached`, `userSubject`, `subjectSub`,
  `servedVersion`, `registerTokenMinter`, `mintCallToken`, `wasNotSent`,
  `refreshAfterWrite`, `normalizeRequest`, `encodeRequest`, `decodeRequest`;
  and from `signer.ts`:
  `SIGNING_KEY_DIR`, `ZONE_ISSUER_ENV`, `TOKEN_TTL_SECONDS`,
  `ZoneSignerOptions`, `audienceFromServiceUrl`, `contractKid`,
  `createZoneTokenSigner`. `markNotSent` and `defaultZoneSigner` are not
  re-exported.
- `glue.ts`: `AuthorizeContext`, `Principal`, `Authorize`, `PUBLIC_SUBJECT`
  (`public`), `userSubject(authorize, ctx)`, `subjectSub(subject)`,
  `servedVersion(fn, envName, zoneVersion, env)`, `TokenRequest`, `TokenMinter`,
  `registerTokenMinter(minter)`, `mintCallToken(request)`, `markNotSent(err)`,
  `wasNotSent(err)`, `refreshAfterWrite(tag, updateTag, revalidateTag)`,
  `normalizeRequest`, `encodeRequest`, `decodeRequest`,
  `QUERY_CACHE_LIFE` (`stale: 60, revalidate: 300, expire: 3600`),
  `QUERY_ERROR_CACHE_LIFE` (`stale: 0, revalidate: 1, expire: 2`),
  `CachedResult`, `cacheableCall(call, cacheLife)`, `unwrapCached(result)`.
- `signer.ts`: `SIGNING_KEY_DIR` (`/var/run/knext/signing-key`),
  `ZONE_ISSUER_ENV` (`KNEXT_ZONE_ISSUER`), `TOKEN_TTL_SECONDS` (60),
  `ZoneSignerOptions`, `audienceFromServiceUrl(fn, urlEnv, url)`,
  `contractKid(publicKey)`, `createZoneTokenSigner(options)`,
  `defaultZoneSigner()`.
- `skew.ts` (`@getknext/grpc/skew`): `ROLLOUT_ORDER` (`function`, `zone`),
  `SkewInput`, `SkewVerdict`, `checkContractSkew(input)`.
- `semver.ts`: `Version`, `parseVersion(input)`, `compareVersions(a, b)`.

## Invariants

### CLI and settings

- `run` never calls `process.exit`. An unknown verb, a usage error, or a
  `GrpcUsageError` / `BaselineUnavailableError` / `BufIntegrityError` returns
  exit code 1 (`cli.ts:run`, `generate.ts:runGenerate`). Any other error is
  rethrown, including the plain `Error` that `buf.ts:resolveBufBinary` throws
  for an unsupported platform or a missing buf install.
- `parseConfig` rejects unknown keys. `proto` must be a relative directory with
  no `..`. `out` must be a real subdirectory of the app, never the app root,
  never outside it, never in or under `node_modules` (compared
  case-insensitively). `authorize` must be a normalised relative path ending in
  `.ts`, `.tsx`, `.js` or `.jsx` (`config.ts:outDir`, `config.ts:authorizePath`).
- A function name must match `^[a-z][a-z0-9]*(-[a-z0-9]+)*$`, be at most 63
  characters, and not be `knext` (`config.ts:checkFunctionName`).
- `exportsAuthorize` fails closed: a default export, `export *`, a type-only
  export or a comment does not count.
- `serializeConfig` is stable: fixed key order, functions sorted, trailing newline.

### Generate

- `knext generate` refuses a deadline that is not strictly shorter than the
  gateway timeout (`policy.ts:checkBudget`, called by `generate.ts:generateFiles`
  and `plugin.ts:parseOptions`).
- When `authorize` is set, the module must exist and export `authorize` by name
  (`generate.ts:generateFiles`). The glue plugin refuses to generate without an
  authorize() hook (`glue-plugin.ts:plan`).
- `protoc-gen-knext` refuses a file with services that has no valid
  `(knext.v1.function)` or `(knext.v1.contract_version)` (`plugin.ts:generateTs`).
- The glue plugin refuses, and writes nothing for: an RPC with no
  `(knext.v1.auth)`, an auth other than `AUTH_USER` / `AUTH_PUBLIC`,
  `AUTH_PUBLIC` on an RPC that is not `NO_SIDE_EFFECTS`, client- or
  bidi-streaming RPCs, and two RPCs in one file that export the same name
  (`glue-plugin.ts:shapeOf`, `authOf`, `plan`). A streaming RPC is never emitted
  as a Server Action (`glue-plugin.ts:emitActionGuard`).
- Generated output depends only on the contract and its parameters. The header
  names `FORMAT_VERSION`, not the package version (`plugin.ts` header). Every
  generated client file has `import "server-only"`.
- Ownership of generated files comes only from the previous `MANIFEST`. Entries
  that are absolute, contain `..` or `\`, or escape `outDir` are ignored
  (`generate.ts:previouslyWritten`). Only regular files can be stale
  (`generate.ts:diffOutput`).
- Writes never go through a symlink or a hardlink. Every target is checked
  before any is written (`generate.ts:ConfinedWriter.check`), and each file is
  replaced by a temp file and `rename` (`generate.ts:writeFileAtomic`, opened
  `O_EXCL | O_NOFOLLOW`; the existing permission bits are kept without
  setuid/setgid).
- buf runs only after the platform package's `package.json` version equals
  `BUF_VERSION` and the binary's sha256 matches `BUF_SHA256`; on either
  mismatch it throws `BufIntegrityError` before running anything. The platform
  package is resolved directly, bypassing `@bufbuild/buf`'s `bin/buf` shim (`buf.ts:resolveBufBinary`, `verifyBufBinary`). The verified
  result is cached per process by path, size and mtime (`buf.ts` header states
  this gap).
- A `deployed:<ns>/<name>` baseline with no `DeployedBaselineSource` throws
  `BaselineUnavailableError` rather than passing (`baseline.ts:resolveBaseline`).
- `createDeployedBaselineSource` reads the served version only through the
  injected `ServedVersionReader` and returns `<absolute common git dir>#format=git,tag=<tag>`
  plus `,subdir=<cwd relative to the repo root>` when the workspace is not the
  root (the same workspace buf lints, never the `proto` setting). It throws
  `BaselineUnavailableError` on a reader failure, an empty served version, a
  non-semver version, a rendered tag `git check-ref-format` rejects, a cwd
  outside git, a missing tag, or a git dir or workspace path containing a
  comma, `#` or whitespace (the rendered tag is checked for those first); git
  missing or older than 2.31 is reported as such. A tag template must hold `{version}` exactly once,
  may hold `{name}`, and no other placeholder or comma, `#` or whitespace
  (`baseline.ts:createDeployedBaselineSource`, `checkTagTemplate`). The tag is a
  locator only: nothing verifies the tagged tree against the running image.

### Generated-call policy (runtime)

- Method kind comes from the descriptor: a unary `NO_SIDE_EFFECTS` RPC is a
  `read`, any other unary RPC is a `mutation`, everything else is a `stream`
  (`policy.ts:methodKind`). `defineFunctionClient` re-derives it and refuses a
  definition whose policy differs, that has a missing or unknown method policy,
  a `maxAttempts` outside 1-5, a bad budget, a `urlEnv` that is not
  `<NAME>_SERVICE_URL`, or a contract version that is not semver
  (`runtime.ts:checkDefinition`).
- Only reads are retried, only on `Unavailable`, within one shared deadline,
  with backoff `100 ms * attempt`. A write gets one attempt. Streams are never
  retried (`runtime.ts:defineFunctionClient`).
- A write without a key of 1-255 visible ASCII characters fails with
  `InvalidArgument` before sending (`runtime.ts:checkIdempotencyKey`). Every
  call sets `knext-contract-version`.
- The endpoint is read from `<NAME>_SERVICE_URL` at call time and must be
  `http:` or `https:`, otherwise `FailedPrecondition`. Transport: an explicit
  `<NAME>_SERVICE_HTTP_VERSION` (`2` or `1.1`) wins; otherwise HTTP/2 on Node (h2c for an
  `http:` URL, HTTP/2 over TLS for `https:`) and HTTP/1.1 on Bun
  (`runtime.ts:chooseTransport`).
- A token source is asked for a new token on every attempt. A stream takes only
  a string token. A token must be 1-8192 visible ASCII characters
  (`runtime.ts:tokenFor`).
- On a unary call, errors raised before the transport call (headers,
  idempotency key, endpoint, first token) are marked with `markNotSent`, and
  so is a token refused on a read's retry, an attempt that never left
  (`runtime.ts:defineFunctionClient`); a stream's pre-send errors are not. A
  generated action refreshes its service tag unless `wasNotSent(err)`, with
  `refreshAfterWrite`: `updateTag` in a Server Action, `revalidateTag(tag,
  { expire: 0 })` elsewhere (`glue-plugin.ts:emitAction`).
- A generated query calls its function through `cacheableCall` inside its
  `'use cache'` function and rethrows with `unwrapCached` outside it, because
  Next.js hides errors thrown in a cache scope in production builds. A
  definitive ConnectError is cached like data; a transient code or a not-sent
  refusal gets `QUERY_ERROR_CACHE_LIFE`; any other error is thrown, never
  cached (`glue.ts:cacheableCall`, `glue-plugin.ts:emitQuery`).
- `mintCallToken` uses the minter registered with `registerTokenMinter`, else
  `defaultZoneSigner()`, and refuses a returned token that is not 1-8192
  visible ASCII characters (`Unauthenticated`).
- `servedVersion` fails closed (`FailedPrecondition`) when
  `<NAME>_SERVICE_PROTO_VERSION` is unset, not semver, or older than the zone's
  version. `checkContractSkew` treats an unreadable version as skew.
- `userSubject` returns `user:<sub>` only for a `sub` of 1-512 characters with
  no control characters, otherwise `Unauthenticated`.
- `normalizeRequest`, `encodeRequest` and `decodeRequest` drop `$typeName`,
  `$unknown` and unknown fields (`readUnknownFields: false`); a mismatch is
  `InvalidArgument` (`glue.ts:contractMessage`).
- Generated queries run authorize() outside the `"use cache"` function and mint
  the token inside it, so a token is never part of a cache key. The served
  contract version is part of the key (`glue-plugin.ts:emitQuery`).
- The transport-notice set, the registered minter, the not-sent mark and the
  default signer are anchored on `globalThis` (or on the error) with
  `Symbol.for` keys (`knext.grpc.announcedTransports`, `knext.grpc.tokenMinter`,
  `knext.grpc.notSent`, `knext.grpc.defaultZoneSigner`), so duplicate module
  copies share them. The transport cache is a module-level `Map`
  (`runtime.ts:transports`), so each module copy has its own.

### Zone signer

- Tokens are EdDSA JWTs with header `{alg, typ, kid}` and exactly the claims
  `iss`, `aud`, `method`, `sub`, `jti` (16 random bytes), `iat`, and `exp`
  (`iat + 60`) (`signer.ts:createZoneTokenSigner`).
- It refuses (before sending) when: `method` is not `/<pkg>.<Service>/<Method>`;
  `sub` is empty on a non-`public` request; `KNEXT_ZONE_ISSUER` is unset or not
  `knext:zone:<ns>/<zone>`; the audience is not `knext:fn:<ns>/<name>` or is in
  another namespace; or the URL is not
  `http(s)://<svc>.<ns>.svc.cluster.local[:port][/]`
  (`signer.ts:audienceFromServiceUrl`).
- The key is read only from `current.key` (PKCS#8 Ed25519) and `current.kid` in
  the mounted directory, never from env. Both are read from the directory
  `current.key` resolves to, so the pair comes from one Secret update.
  `current.kid` must equal `contractKid(publicKey)`. The loaded key is cached by
  a fingerprint (dev, inode, size, mtime, ctime) and re-read when it changes, so
  a rotated key is used without a restart; a failed locate/load is retried once
  (`signer.ts:locate`, `load`, `createZoneTokenSigner`). Error messages never
  echo key material.

### Add and deploy

- `addFunction` refuses an existing function (config entry, proto file or
  `functions/<name>`), `--module` with `--lang rust`, and a Rust crate name that
  is a keyword or shadows a template dependency (`scaffold-rust.ts:checkCrateName`),
  and an invalid Go module path (`scaffold-go.ts:checkModulePath`; default
  `example.com/<name>`). Every write is undone in reverse order on failure.
- `addFunction` always records `authorize` in `knext.grpc.json` (the existing
  value, else `DEFAULT_AUTHORIZE`).
- The server project is built in a temporary staging directory and installed
  last (`scaffold-template.ts:stageProject`).
- `buildBackendServiceCR` requires an image pinned by `@sha256:<64 hex>`
  (`checkImageDigest`), DNS-label namespace and zone names, a port of 1-65535,
  a semver `protoVersion`, `containerConcurrency` of 0-1000, and
  `minScale <= maxScale` when `maxScale` is not 0. It never sets an
  `ownerReference` or a `serviceAccountName`.
- `deployFunction` runs `host.preflight` before `host.apply` and stops on any
  verdict other than `ok`. `--dry-run` prints the CR to stdout and writes no
  file. Otherwise, without a `host`, it exits 1. This package never spawns
  kubectl itself (`deploy-function.ts` header).
- Without `--proto-version`, `deployFunction` sets `protoVersion` to the
  `(knext.v1.contract_version)` of `functions/<name>/proto` (`contractVersionFor`:
  every `.proto` declaring `(knext.v1.function) = "<name>"`; files that disagree,
  or one with no version, are a usage error). A zone `proto/` ahead of that
  version, or a zone version that is not semver, is refused before any cluster
  call; a function ahead of its zone is accepted. With no function copy it sets
  nothing and warns on stderr that the zone will refuse calls.
- `backendSpecDigest` hashes only `BACKEND_SPEC_PINNED_FIELDS` and needs a
  non-empty `spec.image`. It drops object members that are null, `""`, `false`,
  an empty list or an empty object, keeps list order, sorts keys by UTF-8
  bytes, and refuses non-integer numbers, a null inside a list and lone
  surrogates (`spec-digest.ts:canonicalBackendSpec`, `normalise`, `encode`).

## Side Effects

- `buf.ts:runBuf`: hashes the buf binary (`readFileSync`) and spawns it
  (`spawnSync`, `maxBuffer` 256 MiB).
- `generate.ts:runGenerate`: runs `buf lint`, optionally `buf breaking`, and
  `buf build` twice. Without `--check`, it creates the output directory, writes
  and renames files in it, and unlinks stale files whose real path is inside it.
- `add-function.ts:addFunction`: writes `buf.yaml` (if absent),
  `<proto>/knext/v1/options.proto` (if absent), `<proto>/<pkg>/v1/<pkg>.proto`,
  the authorize() stub (if absent) and `knext.grpc.json`, and installs
  `functions/<name>/`. Staging uses `mkdtemp` under the OS temp directory
  (prefix `knext-go-function-` / `knext-rust-function-`), and the stage is
  removed afterwards (`scaffold-template.ts:stageProject`).
- `scaffold-go.ts`: spawns `go version`, then runs `buf generate` (the verified
  buf, `buf.ts:runBuf`) in the staging directory; the first run downloads the
  Go plugins pinned in the template's `go.mod` into the Go module cache.
- `scaffold-rust.ts`: spawns `cargo --version`, `./codegen.sh` (with
  `CODEGEN_ROOT=codegenCacheDir()` and `CODEGEN_INSTALL_ONLY=1`), the verified
  `buf generate` and `cargo fmt`, and creates then removes a `.codegen` symlink
  to the cache. `codegenCacheDir` reads `KNEXT_RUST_CODEGEN_DIR` (must be
  absolute, else `GrpcUsageError`), else an absolute `XDG_CACHE_HOME`, giving
  `$XDG_CACHE_HOME/knext/rust-codegen` or `~/.cache/knext/rust-codegen`. The
  staged project also gets a `.gitignore` of `RUST_GITIGNORE`.
- `deploy-function.ts:deployFunction`: unless `--dry-run`, writes
  `.output/backendservice-<name>.json` and calls core's `DeployHost.preflight` /
  `apply` (a cluster write of one `BackendService`); after a successful apply it
  prints the `backends` entry to add, with the `backendSpecDigest` pin and the
  image-only alternative. It reads `KN_NAMESPACE` (default `default`) and
  `KN_CONTEXT`.
- `runtime.ts`: opens Connect transports (cached per HTTP version and URL) and
  logs one transport notice per binding through `console.info`.
- `signer.ts`: `realpathSync` and `statSync` on the signing-key files on every
  mint, `readFileSync` only when their fingerprint changed, and `randomBytes`
  for `jti`.

## Verification

- Run: `node scripts/bun-test.mjs packages/grpc` (from the repository root).
