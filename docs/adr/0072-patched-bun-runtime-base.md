# ADR-0072: Do not ship a patched Bun runtime base for oven-sh/bun#45007; verify the fix in CI only

- **Status:** **Accepted (2026-11-07, founder decision): option (a).** Proposed 2026-11-06.
  Options (b) and (c) would reverse a recorded founder decision (decision A, 2026-09-26, quoted
  below). Reopening either one needs a revisit trigger (T1-T3) and explicit founder sign-off.
- **Date:** 2026-11-06
- **Trigger class:** supply chain (`.claude/rules/security.md`: which binary runs in users' pods),
  the `knext.config.ts` schema / CLI surface (options b and c), and the credential (ADR-0056 cells).
  The recommended option touches none of the tracked trigger paths.
- **Relates to:** ADR-0007 (the 2026-11-05 amendment and its upstream-runtime-defect ledger,
  which now points back here for the patched-base question),
  ADR-0056 (credential cells and fingerprints), ADR-0058 (the runtime × builder matrix and the Bun
  default), ADR-0036/0048 (build targets), ADR-0001 (unchanged by every option here).
- **Decision method:** each option was scored with jev (`jev-1.14.0`). Scores are quoted where they
  are used. The evidence for each claim is the cited file or run, not the score.

## Context

### The bug and who it reaches

oven-sh/bun#45007: Bun's parser reports an assignment to a `const` as a **load-time** error, even in
code that never runs. Node defers the same thing to a runtime `TypeError` that is never reached. The
minimal repro is in the ledger: `if (process.argv[2]==="x") { const e = 1; e = 2 }` loads under node
and exits 1 under bun 1.4.2 (`test/deploy-tests-manifest.knext.json:1014`).

Next 16.4.3 Turbopack emits that shape **only when the app sets the experimental flag
`experimental.turbopackModuleFragments`**. So the bug reaches one combination: runtime `bun` +
builder `turbopack` + that flag. The guard's check is exactly that
(`packages/kn-next/src/cli/turbopack-fragments-guard.ts:58`). webpack and vinext builds never emit
fragment chunks, and Node is unaffected.

The upstream fix is oven-sh/bun#45010. It is open, not approved (`REVIEW_REQUIRED`), and in no Bun
release. It was opened 2026-10-12 and changes `src/js_parser/p.rs` and
`src/js_parser/visit/visit_expr.rs` on Bun `main`. (Checked with the GitHub CLI on 2026-11-06.)

### How users are protected today

- **A fail-closed build refusal.** `assertNoBunTurbopackFragments`
  (`turbopack-fragments-guard.ts:52-72`) stops `knext build`, `deploy` and `preview` when it sees
  the flag, and the doctor row reports the same condition. It also refuses when a `next.config`
  exists but cannot be read (`:59-66`). The fix hint is one line: turn the flag off, or set
  `runtime: "node"` (`:49-50`). Its retirement condition is a Bun release that contains #45010
  (`:10-12`).
- **A capped, lane-scoped compat ledger.** The `$knextUpstreamRuntimeDefects` ledger
  (`test/deploy-tests-manifest.knext.json:1001`) deselects two whole files, `treeshake-mw` and
  `turbopack-tree-shaking-chunkgroup`, and only when three things hold: the lane is bun/turbopack,
  the ref is Next v16.4.3, and the Bun is 1.4.2. ADR-0007's 2026-11-05 amendment
  (`docs/adr/0007-compat-suite.md:918-1010`) sets those rules. The same files pass on node ×
  webpack, node × turbopack and bun × webpack (`docs/adr/0007-compat-suite.md:927-930`). The entry
  cannot outlive the bug: it is pinned to the lane's Bun, so moving the pin is red until the entry
  has been re-measured (`:978-983`).

### What the shipped executable runs on

On runtime `bun`, the standalone server is compiled into a Bun single executable. That is the
default runtime for the default builder (`packages/kn-next/src/config.ts:337-353`). The executable's
runtime base is **stock Bun for `bun-linux-*-musl`**, which Bun downloads itself during the
cross-target compile (`packages/kn-next/src/cli/bun-toolchain.ts:34-37`;
`packages/kn-next/src/cli/vinext-build.ts:87-88`; the harness compiles with `--target
bun-linux-x64-musl` in `scripts/e2e-deploy.sh:910-915`). **bun × turbopack and bun × webpack ship
the same base.** Any change to the base therefore moves both Bun cells, not only the one with the
bug.

### The two patched-Bun pipelines that exist, and what they are for

| | `infra/bun-base/` | `deploy/bun-patched/` |
|---|---|---|
| Builds | a musl **runtime base** | a glibc **compile toolchain** |
| Source | Bun **`main`** at `b12539ce` (`infra/bun-base/UPSTREAM_SHA:5`) | tag **`bun-v1.4.2`** + #44059 (`deploy/bun-patched/README.md:94-96`) |
| Who gets it | **CI only**, by design (`infra/bun-base/README.md:6-19`) | users who opt in, vinext target only (`packages/kn-next/src/cli/compile-config.ts:52-55`; `config.ts:436-437`) |
| Seam | `KNEXT_BUN_BASE_EXE`, refused unless `GITHUB_ACTIONS=true` (`packages/kn-next/src/adapters/bun-base-exe.mjs:70-76`) | `compile.bun: 'knext-patched'`, sha256 embedded in `@getknext/core` (`bun-toolchain.ts:99-118`) |
| Signing | workflow signs `SHA256SUMS` keyless (`.github/workflows/bun-base-build.yml:143`) | release workflow signs + attests (`deploy/bun-patched/README.md:43-48`) |
| Live state | **fails closed on every run.** The 2026-10-19, 10-26 and 11-02 weekly runs each stopped at `vars.GCP_WIF_PROVIDER and vars.GCP_BUN_BASE_SA must be set`, because the founder-only IAM provisioning is not done (`infra/bun-base/README.md:325-376`) | **stale.** `bun-patched-drift-nightly` has been red every night since at least 2026-11-03: "stock Bun 1.4.4 has shipped, but the knext-patched toolchain is still built from 1.4.2". Its upstream PR, #44059, has been open since 2026-09-26 |

**Neither pipeline produces the artifact this question asks about**, stock Bun 1.4.2 + #45010 as
a musl runtime base. `infra/bun-base` builds musl from `main`. `deploy/bun-patched` builds from the
1.4.2 tag, but it builds glibc and **refuses musl on purpose**: on musl, the compiler itself would
become the shipped runtime (`deploy/bun-patched/README.md:117-119`). #45010 targets `main`'s parser.
Whether it backports cleanly onto `bun-v1.4.2` has not been measured.

### Decision A, already on record

`infra/bun-base/README.md:8-10`: *"Not shipped to users. No `@getknext/*` package, image, or
release asset contains the patched binary. Users get knext-side shims on stock Bun (founder decision
A, 2026-09-26). If that ever changes, it is a supply-chain decision that needs its own review, not a
flag flip."* This ADR is that review.

### What the founder asked for, and the honesty constraint

The founder wants the bug patched and compat green. A green compat run on a patched base supports a
claim **only about the base it ran on**. It says something about knext users only if they get that
base. jev agrees: asked whether a compat run on a patched base honestly backs a claim about the
default stock-Bun bun/turbopack cell, it gave P(yes) = **0.08**. A second gap makes this
mechanical. The credential fingerprint records the Bun **on PATH** (`bun --version` / `bun
--revision`, `.github/workflows/test-e2e-deploy.yml:678-690`). It does not record the base
executable's digest, and no compat workflow sets `KNEXT_BUN_BASE_EXE` today: only
`bun-base-build.yml` mentions it. So a patched-base night would carry a stock-Bun fingerprint.

## Options considered

### (a) Keep the refusal and the ledger, verify #45010 in CI only, and revisit on named triggers

- **Supply chain.** No change. Users run stock Bun, and no knext-built binary reaches a pod. The
  CI-only base stays behind its seam (`bun-base-exe.mjs:70-76`). Its signature, SBOM and
  reproducibility limits (`infra/bun-base/README.md:95-119`, `:192-199`) stay what they are today,
  which is acceptable for a test input.
- **Config / CRD.** None.
- **Retirement.** Already mechanical. The ledger entries go red when the lane's Bun pin moves
  (ADR-0007 `:978-983`). The guard is deleted together with them (`turbopack-fragments-guard.ts:10-12`).
  One gap: `tests/upstream-retirement/registry.ts` has no probe for #45007. The only patched-Bun
  entry is `bun-patched-toolchain` at `:432`. So nothing turns red on its own when a stock Bun
  release first ships the fix (action item 4).
- **Credential, per cell.** node × turbopack and node × webpack are unaffected. bun × webpack is
  unaffected: it never emits fragment chunks, and its base does not change. bun × turbopack keeps
  its claim with the two files deselected at v16.4.3 + Bun 1.4.2. That claim is honest because knext
  refuses the configuration that would reach them. The v1.0 credential nights run the pinned rc tag
  at v16.3.8 and are unchanged (`docs/adr/0007-compat-suite.md:1003-1005`). vinext is not involved.
  The CI-only verification run is **credited to no cell**.
- **Maintenance.** The cost is in action items 1-4: one patch file in a pipeline that already
  exists, one dispatch input, and one registry probe. There is no release train.
- **The cost.** Users cannot run `turbopackModuleFragments` on Bun until upstream ships. The
  default bun/turbopack cell is not green on those two files; it is deselected. The wait is
  unbounded: #44059, the precedent, has been open for 41 days.

### (b) Ship the patched base as an opt-in, the way `compile.bun` is

- **Supply chain.** This is a new artifact class: a knext-built Bun that is the **runtime of
  production pods**. Today the patched toolchain runs only at compile time
  (`bun-toolchain.ts:34-37`), and the patched base runs only in CI (`infra/bun-base/README.md:8-10`).
  What `security.md` requires (`:27` SBOM, `:29` scan, `:34` sign + reproducible, `:41` digest pin),
  and where this option stands:
  - *Digest pin.* Doable. Embed the sha256 the way `PATCHED_BUN` does (`bun-toolchain.ts:99-118`).
  - *Signing.* The release-workflow pattern exists (`deploy/bun-patched/README.md:63-81`). But
    `knext build` verifies only the sha256, not the signature or the attestation
    (`bun-toolchain.ts:28-33`). The signature also does not attest the Cloud Build worker
    (`infra/bun-base/README.md:95-102`), and the least-privilege build SA is still not provisioned
    (the failed runs above).
  - *SBOM and scan.* syft "identifies little inside a Zig/C++ binary" (`infra/bun-base/README.md:35-36`).
    The image SBOM would bind the bytes but not name a Bun version. Whether Trivy/Grype then match
    Bun advisories against that binary has not been measured; plan for "they don't".
  - *Reproducibility.* There is one x64 match, it predates the pins and the dedicated SA
    (`infra/bun-base/README.md:106-119`), and six fetch classes are still unpinned (`:192-199`).
  - *Security releases.* knext owns rebasing on every Bun security release, for the users who opted
    in. The existing toolchain shows how that goes in practice: Bun 1.4.3 and 1.4.4 shipped, and it
    is still on 1.4.2.
- **Build work.** This needs a **third** recipe: a musl build of `bun-v1.4.2` + a #45010 backport.
  `infra/bun-base` cannot simply be repointed at the tag, because its purpose is verifying fixes
  against `main` (`infra/bun-base/README.md:3-4`). `deploy/bun-patched` refuses musl by design. On
  top of the recipe come a release workflow, x64 and arm64 smoke tests, an e2e test and a drift
  nightly: a copy of the whole `deploy/bun-patched` train.
- **Config / CRD.** This adds a new public config key. `compile.bun` is the wrong key for it: it
  selects the *compiler* (`bun-toolchain.ts:34-37`), it is vinext-only (`compile-config.ts:52-55`),
  and the bug is on turbopack. A separate key would work, for example `compile.base: 'stock' |
  'knext-patched'`, valid on runtime `bun` for the turbopack and webpack builders. That makes it a
  config-schema / CLI-surface trigger (`.claude/rules/workflow.md`). The guard relaxes only when the
  key is set. **No CRD field.** The base is compiled into the image, the CR carries only the image
  digest, and the operator cannot change it. ADR-0001 is untouched.
- **Retirement.** Delete the key, the recipe, its workflows and the pins once a stock release has
  #45010. Users who set the key have to remove it from their config: one deprecation cycle.
- **Credential, per cell.** No change to the four stock cells, and the bun/turbopack ledger entries
  **stay**: the default user still runs stock Bun. The opt-in either earns no claim ("not covered
  by the compatibility credential", like `compile.bun`, `config.ts:433-434`) or becomes a fifth
  cell. A fifth cell needs its own lane in `CREDENTIAL_CELLS`, a fingerprint that folds in the base
  digest, and 14 green runs (ADR-0056 D2, `docs/adr/0056-credential-the-cell-matrix-against-a-frozen-rc-ref.md:90-99`).
  It cannot make the default cell green.
- **Maintenance.** It is the `deploy/bun-patched` burden again, and that pipeline is already stale.

### (c) Make the patched base the default for the Bun target

- **Supply chain.** Everything in (b), applied to **every default deployment**: runtime `bun` is the
  default (`config.ts:337-353`). Every user's production pods would run a knext-built Bun by default.
  This reverses decision A outright.
- **Config / CRD.** This changes default behaviour, so it needs docs and an escape hatch
  (`compile.base: 'stock'`). No CRD field, for the same reason as (b).
- **Retirement.** This is a second default flip back to stock, and it moves the bytes of every Bun
  user's executable again.
- **Credential, per cell.** This is the only option that can honestly turn bun/turbopack green
  with the two ledger entries removed, because users would then get the base the run used. The
  price: **both** Bun cells move base. bun × webpack does not have the bug, but its base moves too.
  Once the base digest is in the fingerprint, both windows restart (ADR-0056 D2), and they restart
  **again** when the default flips back to stock. Without that fingerprint fix, the windows would
  *not* restart, and that continuity would be false.
- **Positioning.** knext would become a Bun distributor by default. That pulls against the narrow
  adapter (`CLAUDE.md` §1) and against verified-adapter status (`CLAUDE.md` §2): the adapter would
  run on a fork of its runtime by default.
- **Maintenance.** The (b) burden, with every Bun user exposed to its lag.

### (d) A knext-side build-time shim on stock Bun

Rewrite each offending assignment in Turbopack's emitted chunks into a `throw new TypeError(...)`.
That is the same thing #45010 does, done in knext, and it fits decision A ("knext-side shims on
stock Bun"). But it needs a scope-aware JS parse of every server chunk on the default cell at build
time. It rewrites a third party's emitted code, it adds correctness risk to every Bun build for the
sake of an experimental flag, and none of it has been built or measured. jev scored it at 0.02. It is
not taken here; if trigger T1 fires, it is re-scored alongside (b) and (c).

### Trade-off table

| | (a) refuse + CI-verify | (b) opt-in base | (c) default base | (d) chunk shim |
|---|---|---|---|---|
| Binary in users' pods | stock Bun | stock, or knext Bun if opted in | **knext Bun for every Bun user** | stock Bun |
| New supply-chain surface | none (CI-only, existing) | new runtime artifact + release train | same, default-exposed | none (code, not binary) |
| Pipeline that builds it today | `infra/bun-base` (main), once provisioned | **none**: needs a musl 1.4.2 recipe + backport | **none** | n/a |
| Config surface | none | new public key | default change + escape hatch | none |
| CRD | none | none | none | none |
| bun/turbopack credential | ledger stays, honest via the refusal | ledger stays; opt-in = uncredentialed or a fifth cell | ledger removable, **both Bun windows restart twice** | ledger removable once proven |
| bun/webpack credential | unchanged | unchanged | restarts with no benefit | changes bytes |
| Retirement | already mechanical (Bun pin) + one probe | key deprecation + delete a train | second default flip | delete the shim |
| Maintenance | ~0 | a second `deploy/bun-patched`, already stale once | same, every user exposed | parser shim on every build |
| Reverses decision A | no | **yes** | **yes** | no |
| jev (`jev pick`, four options) | **0.52** | 0.46 | 0.00 | 0.02 |

Supporting jev reads (`jev ask`, the same context): P(the bug's impact justifies distributing a
forked Bun to production pods) = **0.14**; P(option (b) reverses decision A and needs founder
sign-off) = **0.51**; P(knext should reconsider if Next turns module fragments on by default) =
**0.90**. (a) and (b) are close (0.52 against 0.46). What separates them is the evidence above, not
the score. Neither pipeline (b) depends on is in a working state today: one cannot run, and the
other is stale. And (b) cannot deliver the thing that would justify its cost, a green *default*
cell.

## Decision

**Adopt (a).** Keep `assertNoBunTurbopackFragments` and the two upstream-runtime-defect ledger
entries. Do **not** ship a patched Bun runtime base, as an opt-in or as a default. Use the
existing CI-only base to **prove** #45010 against the two failing files, and put that evidence on
the upstream PR to help it merge. Credit that run to no knext cell.

What this gives the founder, plainly: "patched" holds in CI as evidence, and "compat green" holds in
the run sense, because the cell runs green with the two files deselected. Neither is a claim about
users. Only (c) would make the default cell green with nothing deselected, and the cost is this:
every Bun user's production runtime becomes a knext build, both Bun credential windows restart twice,
and decision A is reversed, all for two cases behind an experimental flag. This ADR recommends
against paying that.

**Revisit triggers.** Any one of these reopens this ADR. Re-score (a)-(d) with the new impact.
- **T1.** A Next.js release turns `turbopackModuleFragments` on by default, or makes it stable. The
  refusal would then fire on the *default* configuration (turbopack + Bun), and the impact stops
  being "an experimental flag".
- **T2.** oven-sh/bun#45010 is closed without merging, or is still in no Bun release when the next
  Next minor ref is adopted.
- **T3.** A user reports needing module fragments on Bun, with `runtime: "node"` not acceptable.

## Consequences

- User-visible behaviour does not change. The refusal and its one-line fix stay. No docs change
  follows from this ADR.
- The credential cells and fingerprints do not change.
- If the founder overrides this in favour of (b) or (c), the preconditions are action items 1 and 3
  below (provisioning, and the base digest in the fingerprint), plus a new musl 1.4.2 recipe and its
  release train. Those come first, before any config key.
- The accepted cost: Bun users cannot use an experimental Next flag until upstream ships, and the
  wait has no bound. T2 is the bound on how long we accept that silently.

## Action items

1. **Founder (IAM, one-time):** run the provisioning block in `infra/bun-base/README.md:325-376`.
   Until it is done, `bun-base-build` fails closed on every run, and neither (a)'s verification nor
   any other option can produce a base.
2. Add `infra/bun-base/patches/001-bun-45007-const-assign-runtime-error.patch`, built from
   #45010 against `UPSTREAM_SHA`. Its header must name `oven-sh/bun#45010` and a `knext-shim:` id for
   the guard (`infra/bun-base/patches/README.md:8-10`). Then dispatch `bun-base-build`.
3. Add a **dispatch-only** `bun-base-run` input to `test-e2e-deploy.yml` that downloads and
   cosign-verifies the base and sets `KNEXT_BUN_BASE_EXE` for the compile step. While it is set,
   **fold the base's sha256 into the fingerprint and refuse to record a credential night.** Run
   bun/turbopack at v16.4.3 with the ledger entries disabled, and post the result on oven-sh/bun#45010.
   **Tracked in #2804.**
4. Add a `bun-45007-const-assign` probe to `tests/upstream-retirement/registry.ts`, using the
   ledger's minimal repro, so the first stock Bun release with the fix turns red and starts the
   retirement of the guard and the ledger entries in one change. **Tracked in #2805.**
5. Track T1-T3 in the issue that carries this ADR. Check T1 on every Next ref bump.
