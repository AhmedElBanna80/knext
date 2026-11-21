# ADR-0074: A sealed load for sharp's native addon (one rule for `native/`, two texts)

- **Status:** **Proposed (2026-11-21).** Design only. This change adds no code, test, env var or
  docs page. The S18-2 implementation lands the decision, and the sprint-close review accepts it
  or files debt.
- **Task:** v2 Sprint 18, S18-2 (from debt TD-S18-1a).
- **Relates to:** ADR-0069 Amendment 1 (the in-process Rust loader's rule, PR #257, not yet merged
  to `integration/v2`), ADR-0048 Amendments 2 and 3 (the sharp `process.dlopen` shim, `native/` and
  its integrity manifest), ADR-0060 (the self-contained executable, invariant I2 execPath
  anchoring), ADR-0006 (image optimisation through sharp), ADR-0036 (vinext is an opt-in,
  compat-gated build target).
- **Supersedes, once #257 merges:** the sentence in ADR-0069 Amendment 1, Consequences, last bullet,
  that S18-2 moves the judgement "into one core-owned fragment that the generated loader and that
  shim both use, kept identical by a byte-compare test". It also replaces that amendment's
  action-item row "The sharp shim: … from the shared fragment". D8 explains why.
- **Trigger class:** a new ADR (Proposed, design-only), and a security invariant
  (`.claude/rules/security.md`). The implementation is also a `src/cli/` trigger, because of the
  build smoke in D6.

## Context

### What loads, and how, today

`packages/kn-next/src/adapters/sharp-addon-dlopen.mjs` replaces `sharp/dist/sharp.mjs` inside a
`bun build --compile` binary. `vinext-compile.mjs:956-1000` (`sharpAddonDlopen`) injects the
shim's source text verbatim into sharp's module slot. So the shim must stay self-contained over
node builtins: it may have no relative imports, and the compile refuses one. The shim:

1. picks the addon: `KNEXT_SHARP_ADDON`, or the tree a self-contained binary extracted
   (`globalThis[Symbol.for('knext.sharp.nativeRoot')]`), or `native/sharp-<platform>/lib/*.node`
   beside `process.execPath`, or a flat `sharp.node` (`addonPath()`, lines 78-138);
2. finds `.integrity.json` at most four levels up (`findManifest`, 195-205), reads it by path, and
   requires the addon to be listed (338);
3. hashes every listed native payload by path (`readFileSync`, 212-214), which today means the
   addon and `libvips-cpp.so.<ver>`;
4. calls `process.dlopen(container, path)` by path (381).

It never checks an owner or a mode. It never opens a file without following links, and it pins
no `dev:ino`. Between the hash in step 3 and the loader's own `open()` in step 4, anyone who can
write the tree can change what gets mapped. They can rename a file over the path, rename the
tree, write in place, or reach the inode through a hard link. The header's claim that "an
unlisted payload is FATAL" is true of the addon alone: a planted file next to libvips is not
looked for.

The shim runs **at boot**. Outside self-contained mode, sharp's module slot is evaluated at the top
level (`vinext-build.ts:695-700`), so a refusal crashes the process before it listens. On
Knative, a revision that never becomes Ready takes no traffic, and the previous revision keeps
serving. In self-contained mode, `lazySharp` defers the load to the first image request
(`vinext-compile.mjs:1289-1296`).

The same `native/` tree can hold the Rust library. Since ADR-0069 Amendment 1, the generated
loader refuses that library unless root owns it and the manifest, and every directory from it up
to `/` is root's and closed to group and other. The threat model records the gap:
"**One tree, two loaders, two rules** … sharp's addon is exactly as protected as the image layout,
no more" (`docs/security/threat-model.md`, `/app/native`).

### Why the port is not mechanical (TD-S18-1a), measured

These were measured on 2026-11-21 with a throwaway probe: Docker 29.8.2 on an arm64 Mac, with
amd64 images run under emulation. The images were `oven/bun:1.4.2-alpine` (musl) and
`oven/bun:1.4.2` (Debian, glibc 2.41), with sharp 0.35.4 and `@img/sharp-libvips` 1.3.3. The
musl tree was a staged `linuxmusl-x64` `native/`. The glibc tree was installed into the container.
S18-2 commits the load results below as tests (exit criteria E3 and E4).

| # | Measurement | musl | glibc |
|---|---|---|---|
| M1 | The addon's dynamic section | `DT_RPATH` (not `RUNPATH`) with five entries; the first is `$ORIGIN/../../sharp-libvips-linuxmusl-x64/lib`; `NEEDED` `libvips-cpp.so.8.18.6`, `libstdc++.so.6`, `libgcc_s.so.1`, libc | the same shape |
| M2 | `libvips-cpp.so.8.18.6`'s dynamic section | `RUNPATH $ORIGIN/`; `NEEDED` libstdc++, libgcc_s, libc | — |
| M3 | `process.dlopen('/proc/self/fd/<n>')` of the addon | **fails**: `Error loading shared library libvips-cpp.so.8.18.6 … (needed by /proc/self/fd/7)`. `$ORIGIN` becomes `/proc/self/fd`. | **fails** the same way |
| M4 | libvips preloaded by its descriptor through `bun:ffi`, then the addon by descriptor | **still fails**, with the same error. The reason is inferred from musl's loader, not measured: it matches an already-loaded library by the name it was loaded under, and by inode only after a path search has found the file. | **loads**. glibc reuses the loaded library by `DT_SONAME`. |
| M5 | `patchelf --set-rpath /app/native/sharp-libvips-linuxmusl-x64/lib`, then the addon by descriptor | loads, but libvips is still opened by path | not measured |
| M6 | The addon by path | loads | loads |
| M7 | `/proc/self/maps` after a by-path load | lists the addon and libvips with the `dev` (`00:59` = 89) and inode that `lstat` reports | the same |
| M8 | The Bun executable's own `NEEDED` | `libstdc++.so.6`, libc. libstdc++ is therefore already loaded when the shim runs, and the addon's rpath is not searched for it. | — |
| M9 | Cost of the rule's bookkeeping: a `realpath`, seven directory `lstat`s twice, two `O_NOFOLLOW` opens with `fstat` | 0.06 ms per load (n = 200, three runs) | — |
| M10 | Cost of one `/proc/self/maps` read | 0.04 ms | — |
| M11 | Today's hash of the addon and libvips, which is paid either way | ~116 ms (emulated) | — |

Three things follow:

- **Loading through a descriptor cannot work on the shipped platform.** The image is
  `alpine:3.22` (`templates/app/Dockerfile.hbs:28`). The relative rpath (M1, M3) breaks every
  musl variant except patching the binary (M4, M5).
- **Every app is affected.** Every vinext app that uses `next/image` loads sharp through this shim,
  so a rule with no opt-out changes the behaviour of all of them. Four shapes in particular, from
  the code:
  - **The template image passes.** `COPY --chown=0:0 --chmod=a-w native /app/native` (`:89`),
    `WORKDIR /app` and `USER 65532:65532` (`:100`) give the layout ADR-0069 Amendment 1 item 6
    measured under BuildKit: `/app` and `native/` root-owned 0755, the directories below 0555,
    the files 0444.
  - **`apps/file-manager/Dockerfile` should pass, but nobody has measured it.**
    `COPY --from=builder /repo/native /app/native` (`:174`) has no `--chown` or `--chmod`. The
    builder runs as root, and `cp -RL` ran under umask 022.
  - **`knext build` would be refused.** Its post-compile smoke (`cli/build.ts:177-247`) boots a
    host-arch twin from the app's own directory, with `KNEXT_SHARP_ADDON` pointing into
    `.knext-smoke-native/`. No build that does not run as root can make that directory root's.
  - **Self-contained mode cannot pass a root-only rule.** It extracts the tree as the app's uid
    under `KNEXT_NATIVE_TMPDIR` or `TMPDIR`, with directories 0700 and files 0500
    (`sharp-native-extract.mjs`), so the tree can never be root's.
- **The fd pin buys nothing over the ancestor rule against the actor that matters.** ADR-0069
  Amendment 1 item 3 makes the point. To rename or replace any part of the path, an actor must be
  able to write its parent. If every directory from `native/` up to `/` is root-owned and closed
  to group and other, nobody but root can redirect a lookup. Against root, nothing a lookup does
  helps, because root can write in place. The Rust loader dlopens its descriptor because it can:
  a Rust `cdylib` has no relative-rpath dependency. Sharp's addon has one.

## Decision

The shim gets a sealed load: **option (b)** in the table below. It opens files by path, but every
step is sealed: an `O_NOFOLLOW|O_NONBLOCK` descriptor, a regular-file check, owner and mode judged
on the descriptor, the hash read through that descriptor, and `dev:ino` pins checked before and
after both the hash and the `dlopen`. On top of that come the StrictModes-style walk of every
ancestor, two profiles chosen by where the tree came from, and a `/proc/self/maps` tripwire. It is
on by default, with one parsed off switch that reports instead of refusing.

jev scores (`jev.py pick`, 2026-11-21, with the Context above as the state):

- **Design:** b **1.00**; a1 0.00, a2 0.00, c 0.00, d 0.00.
- **Opt-out policy:** default on with a parsed off switch in report mode **0.90**; no opt-out
  0.05; default off with an opt-in 0.05; report-only by default with a dated flip 0.00.
- **Where the source lives:** inside the shim, kept in step by a shared vector table **0.97**; a
  new core fragment concatenated in, which ffi would also import, 0.03; one byte-identical
  fragment 0.00; the fragment in the ffi package 0.00.
- **Self-contained tree:** a second profile owned by the process's uid **1.00**; refuse it 0.00;
  exempt it 0.00; extract it as root at build 0.00.

### D1. Two profiles, chosen by where the tree came from, never by a setting

- **Staged** is the default. It covers `native/` beside the executable, the flat `sharp.node` and
  `KNEXT_SHARP_ADDON`. The owner rule is ADR-0069 Amendment 1 items 1-4 and 7-9, unchanged:
  every file below and every directory on the path is owned by **uid 0** and is not writable by
  group or other. The mode bits are the whole test, so a sticky `/tmp` is refused too. The rule
  never reads the process's own uid and has no exception for it. The directories walked are:
  - each directory from every judged payload's directory up to `native/`, which takes in **both**
    the addon's branch and libvips' branch;
  - `native/` itself;
  - the directory that holds `native/`, and every directory above it up to `/`.

  For `KNEXT_SHARP_ADDON`, "`native/`" is the directory that holds the manifest. With no
  manifest, it is the addon's package directory's parent.
- **Extracted** applies to self-contained mode. It is used when `knext.sharp.nativeRoot` is set by
  the generated facade and `KNEXT_SHARP_ADDON` is unset, which is exactly when the facade
  extracts. A root owner is impossible here, so the rule is the closest a process can come with a
  tree it wrote itself:
  - every file and directory of the extracted tree is owned by **this process's uid**
    (`process.getuid()`; a platform without it is refused);
  - no file carries a write bit for anyone, owner included (`mode & 0o222 === 0`; the extractor
    writes 0500);
  - no directory is writable by group or other (the extractor makes 0700);
  - the base the tree sits in passes the extractor's own base rule (`assertSafeBase`): sticky and
    world-writable, a root-owned 0777 kubelet `emptyDir`, or owned by this uid and closed;
  - every directory above the base, up to `/`, is owned by root or by this uid and is closed to
    group and other. A sticky directory is refused above the base.

  **The app's own uid remains a residual, and this profile states it.** That user can `chmod` its
  own tree and write it, which the staged profile exists to deny. What the profile does deny is a
  pure file-write primitive, a co-tenant uid and a drifted base. The strong guarantee needs the
  staged layout.

No setting switches between the profiles, and the extracted profile is never applied to a staged
tree.

### D2. Files

The files are the manifest and every native payload the OS loader will map: the addon and each
listed `.so` or `.so.N`, which today means libvips. Each one is handled as follows:

1. It is opened `O_RDONLY|O_NOFOLLOW|O_NONBLOCK`. A platform where either flag is not a positive
   number is refused, as in Amendment 1 item 7. A symbolic link is refused (`ELOOP`) and is never
   followed. A FIFO cannot hang boot.
2. It is `fstat`-ed with `{ bigint: true }` and must be `S_IFREG`.
3. It is judged on that descriptor by the profile's rule.
4. It is read through that descriptor, both for parsing (the manifest) and for hashing (the
   payloads). Nothing is read by path.

Each descriptor stays open until the checks after the `dlopen` (D5) have run, and is then closed.
That is safe: by-path `dlopen` does not use the descriptor, unlike the Rust loader's
descriptor-named library.

### D3. Directories, pins and the real path

- Every directory D1 names is `lstat`-ed with `{ bigint: true }`, must be `S_IFDIR` (a link is
  refused, never followed) and is judged by the profile's rule. One refusal lists **every**
  failing directory, not the first one found.
- The `dev:ino` of each directory is pinned **before** the manifest is opened. The pins are checked
  again twice: after the last payload is hashed, and **after `process.dlopen` returns**. After the
  hash, each judged file's path must also still name the inode that was read (`$same` in
  Amendment 1). Any change is a refusal.
- The tree's root must be its own real path. It is compared with `realpathSync` first, and a
  difference is refused. This is a fail-closed assertion for the default root (Bun reports
  `process.execPath` already resolved, Amendment 1 item 7). For `KNEXT_SHARP_ADDON`, a path
  through a link is refused with "point it at the real path". The reason is the old-tree repoint
  that Amendment 1 item 3 closes: a link outside the judged path could aim the load at any
  complete tree root wrote. For the extracted root, `sharp-native-extract.mjs` returns
  `join(realpath(base), name)` instead of `join(base, name)`, so a macOS `TMPDIR` under
  `/var -> /private/var` passes. That is a one-line change in the extractor.

### D4. The directories the OS loader searches hold nothing unlisted

The OS loader searches the directory of every listed native payload, which today is the addon's
`lib/` and libvips' `lib/`. Two facts make those directories matter:

- libvips' `RUNPATH $ORIGIN/` (M2) and the addon's first `DT_RPATH` entry (M1) make them the first
  place the loader looks for any `NEEDED` library that is not already loaded;
- on musl, `LD_LIBRARY_PATH` is searched before the rpath, while glibc searches `DT_RPATH` first.

Each such directory may hold only listed regular files, and directories that lead to listed
files. Anything else is a refusal that names the entry: an unlisted file, a link, a FIFO or a
device. With no manifest, under the dated absence exception, there is no list to compare against,
so every entry in those directories is judged as a payload instead. This closes the header's
overclaim.

Against a non-root actor it adds nothing to D1, because the directories are already closed. It is
defence in depth against root, a second mount and image drift. It is cheap: one `readdir` for each
of two directories.

### D5. After the `dlopen` (Linux): the mapped-inode tripwire

`/proc/self/maps` is read just before and just after `process.dlopen`. A refusal follows unless
both of these hold:

- the pinned addon and the pinned libvips are both mapped, with the pinned `dev` and inode;
- every file newly mapped by the call is either a pinned payload or sits in a system library
  directory (`/lib`, `/usr/lib`) that passes the staged rule.

The maps file prints `dev` as hex `major:minor`, which must be decoded the way the kernel's
`new_encode_dev` encodes it. This catches several things:

- a swap by root that is put back between the last pin check and the loader's open;
- a libvips taken from `LD_LIBRARY_PATH` or `LD_PRELOAD`;
- a libvips already loaded under another path, which glibc reuses by SONAME and musl by its
  short name.

**It is a tripwire, not prevention.** By the time it reads the maps file, the ELF constructors of
whatever was mapped have already run, so it turns a silent substitution into a boot refusal only
for code that does not defend itself. It costs 0.04 ms (M10). On macOS there is no `/proc`, so it
is skipped. macOS is reached only by the build-host smoke, which runs in report mode (D6).

### D6. On by default, with one parsed off switch: `KNEXT_SHARP_SEALED_LOAD`

- **Values:**
  - unset, empty, or `1`, `true`, `yes`, `on` (trimmed, any case): **enforce**;
  - `0`, `false`, `no`, `off`: **report mode**;
  - anything else: the shim **throws** before any file is opened, listing the accepted values.

  It uses the same three outcomes as `KNEXT_REQUIRE_NATIVE_INTEGRITY` (`requireIntegrity()`), for
  the same reason: a security control that silently reads as off is worse than none. Unlike that
  variable, the default here is **on**, so an empty value means the default.
- **What report mode does:** every check in D1-D5 runs, and the findings are printed as **one
  warning per load** that lists every path that would have been refused. Then the addon loads by
  path, as it does today.
- **What stays fatal in report mode:** everything that is fatal now. That is a hash mismatch, an
  unlisted addon, an unknown manifest version, an unreadable payload and a staged tree for the
  wrong platform. A missing manifest stays governed by `KNEXT_REQUIRE_NATIVE_INTEGRITY` and its
  dated exception (`scripts/lib/native-integrity-policy.mjs`). This ADR does not change that.
- **Scope:** the switch is sharp's only. The in-process Rust loader keeps no opt-out and never
  reads this variable.
- **It has no expiry date.** It has two legitimate users that no future layout removes, the build
  smoke and a developer running a compiled binary under their home directory. Neither ships.
- **Who sets it:**
  - only `knext build`'s post-compile smoke sets it, in the smoke child's env (`cli/build.ts`,
    next to `KNEXT_SHARP_ADDON`, 245);
  - **nothing that ships sets it**: no template, generator template, Dockerfile, operator render
    or docs recipe. A scanning test enforces this (E6).

### D7. Refusal messages

Each refusal names:

- the path, and what failed (its owner, its full mode including the sticky and setgid bits, or
  its type);
- the fix, chosen by situation with Amendment 1's advice model:
  - a directory inside `native/` is fixed in place, with `chmod go-w` and `chown root`, or a
    Dockerfile `RUN` after the `COPY`;
  - the template's `COPY --chown=0:0 --chmod=a-w native /app/native` is the line that passes;
  - a sticky or shared directory means moving the install;
  - a home directory is never given to root;
- the switch, with the sentence that `KNEXT_SHARP_SEALED_LOAD=off` loads a tree nobody has judged.

Every printed path, value and system error goes through an escaping function with the same
contract as the Rust loader's `$show` (C0 and C1 controls, U+2028 and U+2029, Cf characters, lone
surrogates). It is restated in the shim rather than shared.

### D8. Where the source lives: core-owned, inlined by the existing renderer, not one shared text

- **The logic lives in `sharp-addon-dlopen.mjs` itself.** That file is core runtime
  (`packages/kn-next/src/adapters/`). It stays self-contained over node builtins: the existing
  test pins that it has no relative imports.
- **The renderer that inlines it already exists.** It is `vinext-compile.mjs`'s `sharpAddonDlopen`
  `onLoad`, which injects the verbatim text, together with tsup's verbatim copy
  `dist/adapters/sharp-addon-dlopen.source.mjs`. S18-2 does **not** edit `vinext-compile.mjs`,
  which S18-3 owns.
- **Core-vs-Beta boundary.** The shim is core source used only by the vinext target, which is
  Beta (ADR-0036). It does not import the in-process Rust package, share text with it or name it.
  That includes comments: `ffi-dispatch.test.ts` scans core source, comments included, and allows
  the package name only in `cli/ffi-dispatch.ts`. The package still does not import core.
- **Why not one byte-identical fragment** (Amendment 1's first plan):
  - The Rust loader is generated TypeScript that is **committed into apps**. Every change to its
    text forces every app to regenerate its wrappers (`knext ffi check` goes red).
  - It speaks `FfiLoadError` and the vinext close-line advice.
  - It has no switch and no extracted profile.

  A shared text would either couple core's sharp releases to app wrapper regeneration, or force
  the two loaders into the same messages and policy, which D1 and D6 deliberately keep different.
- **What keeps them in step instead** is one rule, restated in two texts, and held together by a
  **vector table** (D9).

### D9. Parity by vectors, not bytes

A new test, `packages/kn-next/src/__tests__/native-sealed-parity.test.ts`, holds one table of
fixture trees. It runs each tree through both loaders:

- the shim, with `process.dlopen` stubbed;
- a module rendered by the Rust package's `renderModule`, imported from core's test directory. Core
  tests may import that package's source: `ffi-metrics-seam.test.ts` already does, and so does
  `ffi-vinext-known-good.test.ts`, which #257 adds. Only core source is barred from naming it.

For each **refusal** vector, both loaders refuse and name the same path. For each **pass**
vector, both reach the load. The divergences that are by design are rows of their own, each with
its reason: the switch, the extracted profile, D4 and the tripwire. Owners are faked with the
harness `ffi-loader.test.ts` uses (an in-process `fs` stat override, test-only); modes, links,
FIFOs and renames are real.

## Options considered

The **residual** column describes the window left between the check and the map. "Non-root" there
means the app user, a sidecar, an `fsGroup` writer or a co-tenant uid. The **jev** column comes
from the design question.

| Option | Residual | Behaviour change for existing sharp users | glibc / musl | Bun / Node | Cold start | Testability | jev |
|---|---|---|---|---|---|---|---|
| **(a1)** Pin by descriptor and dlopen through `/proc/self/fd`, with libvips preloaded by descriptor through `bun:ffi` first | **musl:** none, because nothing loads at all. **glibc:** none against non-root, and only if the owner/mode rule is added as well. An fd pins the inode, not its bytes, so an in-place write is still open without the rule. | **musl (every shipped image): sharp never loads**, and every vinext app with `next/image` crashes at boot (M4). A fallback to loading by path is (b) without the pins. | **Fails on musl (M4)**; loads on glibc (M4), which is the smoke twin only. | The preload needs `bun:ffi`. Node's `process.dlopen` is for addons, and core Node has no way to dlopen a plain library (not measured; moot, because the shim runs only in Bun binaries). | One extra `dlopen`, negligible. The ~116 ms hash is unchanged (M11). | Needs real native loads per libc. The musl leg cannot pass. | 0.00 |
| **(a2)** The same, with `patchelf` rewriting the addon's rpath to an absolute path at build | The addon's path swap is closed, but **libvips is still opened by path** (M5), so its window is the same as in (b). The rule is still needed against in-place writes. | The image bytes of a third-party binary change, so the sha256 no longer matches the upstream tarball's. An absolute rpath breaks every relocated tree: `KNEXT_SHARP_ADDON`, the self-contained root (content-addressed under `TMPDIR` and unknown at build) and the smoke's `.knext-smoke-native/`. `patchelf` joins the build supply chain. | Loads on musl (M5); glibc not measured. | The same on both. | Runtime: none. Build: one `patchelf` step. | Needs `patchelf` in the build tests plus real loads per layout. | 0.00 |
| **(b) Sealed by-path load, two profiles, a maps tripwire, one parsed switch: chosen** | **Non-root: none.** No directory on the path can be renamed, and no judged file can be written (D1). **Root, a capability that is as good as root, or a second writable mount:** they can write in place, and nothing a loader does stops that. A swap that is put back between the last pin check and the loader's `open()` is caught by the tripwire, after the constructors have run (D5). **Extracted profile:** the app's own uid (D1). | The template image passes (Amendment 1 item 6 layout). `apps/file-manager` should pass but must be measured (E3). Any other drifted layout is refused at boot with the path and the fix: a `chown`-ed `/app`, a builder that ignores `--chmod`, an install under a home directory or `/tmp`, an `fsGroup`-writable volume, a `KNEXT_SHARP_ADDON` through a link. The build smoke runs in report mode. Self-contained mode gets its own profile. | One rule on both. The difference in `LD_LIBRARY_PATH` order (musl searches it before the rpath, glibc searches `DT_RPATH` first) is covered by D4 and D5. | Portable: `O_NOFOLLOW`/`O_NONBLOCK`, bigint stats, `realpath` and `/proc/self/maps` exist in both. Bun's resolved `process.execPath` is measured (Amendment 1 item 7). No `openat` is needed (Amendment 1 option g). | **+0.1 ms per load** (M9 + M10), against a hash that is unchanged (M11). It runs at the same point as today: boot when staged, the first image request when extracted. | **Fully testable** without root: owners are faked and modes, links, FIFOs and renames are real, as in the Rust loader's harness. A real-root leg runs in Docker (E3). Hard-link and in-place-write tests can be written for both halves (E1). | **1.00** |
| **(c)** The owner/mode rule only, by path, with no descriptor, no `O_NOFOLLOW`, no pins and no ancestor walk; with an opt-out | **Non-root: the TD-S17-close-1 tree swap stays open.** A writer of any directory above the judged ones renames the tree between the steps. A FIFO at the manifest hangs boot. A link is followed. | The same refusals as (b) for files that are themselves drifted. Swapped trees pass. | The same on both. | Portable. | Less than (b). | The swap and hard-link-in-a-swapped-tree tests stay green for the attacker, so it fails the S18-2 exit criteria. | 0.00 |
| **(d)** Document the risk only | Today's window: the hash runs by path, then the `dlopen` runs by path, open to any writer of the tree. | None. | — | — | None. | Nothing to test, and it fails every S18-2 exit criterion. | 0.00 |

**The opt-out policies that were rejected:**

- **No opt-out** (0.05). `knext build`'s smoke and every developer who runs the binary under their
  home directory would be refused. The Rust loader can afford no opt-out because it is opt-in;
  sharp is on every vinext app that uses `next/image`.
- **Default off with an opt-in** (0.05). It protects nobody who has not already read this ADR.
- **Report-only by default with a dated flip** (0.00). The clock would eventually force removing
  the very switch the smoke and local runs need. A refusal is also already safe on Knative: a
  revision that is not Ready takes no traffic.

## Consequences

- **What it closes.** "One tree, two loaders, two rules" in the threat model becomes one rule in
  two texts. Against any writer that is not root, the sharp payloads can no longer be swapped or
  written between the hash and the map. That includes the app's own user through a file-write
  bug, a sidecar, an `fsGroup` writer and a co-tenant. The rule does not depend on the image
  having been built right: a drifted layout is now a named refusal at boot instead of a silent
  load.
- **The manifest-absence downgrade narrows.** Stripping `.integrity.json` to downgrade
  verification to a warning needs write on `native/`. That is now root-only for the staged
  profile, so the threat model's "an attacker who can strip a file … can also downgrade"
  residual is closed for non-root actors at runtime. What remains is image mutation at build time
  and root.
- **Every vinext app with `next/image` is affected** (a `@getknext/core` **minor** changeset):
  - The template image is unchanged and loads. The `apps/file-manager` image is expected to load,
    and E3 measures it.
  - A drifted layout fails its first boot. Knative keeps the old revision serving, and the message
    names the path, the fix and `KNEXT_SHARP_SEALED_LOAD=off`.
  - A self-contained binary gets the extracted profile, with its residual stated.
  - `knext build`'s smoke runs in report mode, so the build's output now carries the rule's
    findings for the host-arch twin as a warning. That is expected: the twin is never shipped.
- **The build smoke edits `src/cli/build.ts`,** which adds one env entry beside
  `KNEXT_SHARP_ADDON`. The S18-2 PR therefore carries the `src/cli/` escalation acknowledgement.
  S18-2's "Owns" column grows by `cli/build.ts` (that one line), `sharp-native-extract.mjs` (the
  real-path return in D3) and a negative leg in the `ci.yml` prod-image job (E3). None of these
  is owned by another S18 task.
- **Docs are user-visible.** `apps/docs/content/docs/image-optimization.mdx` gets the layout rule,
  the two profiles, the switch and the refusal-to-fix table, and
  `apps/docs/content/docs/threat-model.mdx` mirrors the internal threat model. Neither carries an
  ADR, issue or PR number.
- **Not covered: outside the Bun binary, sharp's addon is loaded with no check at all.** The
  vinext/node runtime and the Next.js standalone runtimes load sharp from `node_modules` through
  sharp's own loader, with no integrity check and no owner check. This ADR does not change that.
  It is filed as new debt for the sprint-close review rather than left implied.
- **Residuals that remain, the same class as Amendment 1:** uid 0 and every capability as good as
  root, a second writable mount, ACLs (mode bits only), a seekable write through
  `/proc/self/mem`, and a rootless container whose host user owns the image files. The
  extracted profile adds the app's own uid. The tripwire detects; it does not prevent.

## Action items

### S18-2 implementation (one PR, after #257 merges; serial per the sprint plan)

- [ ] `sharp-addon-dlopen.mjs`: D1-D7, with the header rewritten to match. Say "an unlisted
      payload in a search directory is fatal" only once D4 makes it true, and never name the
      in-process Rust package.
- [ ] `sharp-native-extract.mjs`: return the extraction root as `join(realpath(base), name)` (D3).
- [ ] `cli/build.ts`: add `KNEXT_SHARP_SEALED_LOAD: 'off'` beside `KNEXT_SHARP_ADDON` in the
      smoke's child env, and nowhere else.
- [ ] A changeset (`@getknext/core`, minor) that states the behaviour change, the switch and the
      fix.
- [ ] The docs pages named in Consequences, `docs/security/threat-model.md` (`/app/native` and the
      in-process Rust entry), and `packages/kn-next/src/adapters/EGM.md` (the Images invariants
      and the env var under Interface).
- [ ] ADR-0069: replace the shared-fragment sentence and its action-item row with a pointer here.
      Whichever of #257 and this implementation lands second does it.

### Exit criteria the implementer can test

Every refusal test has a **pass twin** that loads, because a guard has to assert both halves.

**E1. Hard-link and in-place-write tests**, in
`packages/kn-next/src/__tests__/sharp-addon-dlopen.test.ts` or a sibling
`sharp-addon-sealed.test.ts`. They run in a subprocess with the owner-faking harness and real
modes:

- **K1:** the addon is a hard link to a file this non-root uid owns, mode 0444, with a matching
  hash. It is **refused** as "owned by uid N". Twin: the owner faked to 0, which loads.
- **K2:** an attacker's tree, with its own manifest and a **hard link** to the real root-owned
  addon, is renamed over `native/` at the moment the shim opens the manifest. It is **refused**,
  either at a pinned directory or at the manifest's owner. Twin: no swap, which loads.
- **I1:** libvips is 0664, which permits an in-place write by its group. It is **refused**, naming
  **libvips**, not the addon.
- **I2:** a payload this uid owns, even at 0444, is **refused**, because that owner can `chmod` it
  back and write.
- **I3 (extracted profile):** a tree written by the real `extractEmbeddedNative` **loads**. The
  same tree with one file made `u+w` is **refused**, and so is one whose owner is faked to another
  uid.

**E2. The rest of the rule.** These tests cover:

- a link at `native/`, at the addon and at the manifest;
- a FIFO at the manifest, which must not hang (the test sets a timeout);
- a group-writable directory above the executable;
- a sticky `/tmp` ancestor, with the full mode printed;
- a `KNEXT_SHARP_ADDON` through a link;
- a tree swapped in and left, and one swapped in and put back;
- a pinned directory compared as a bigint (two inodes that differ only above 2^53);
- an unlisted `libstdc++.so.6` planted in libvips' `lib/`;
- a tripwire fed a maps file (through the `fs` override) that maps another libvips;
- the switch: `off` loads a refused tree with **one** warning listing every finding, and still
  refuses a hash mismatch; `enabled` throws before any open; unset enforces.

**E3. A real-root leg** in `ci.yml`'s `Prod image next/image optimization (strict, #66)` job:

- the `apps/file-manager` image boots as uid 65532 with the rule on and returns an optimised
  `/_next/image`, which is the positive half;
- a derived image with `RUN chown -R 65532:65532 /app/native` is refused at boot, naming the path;
- inside the good image as 65532, `printf x >> <libvips>` and `ln <libvips> /app/native/x` both
  fail with `EACCES`.

The musl load results M3 to M6 become committed assertions in the same leg, so this ADR's claims
are re-measured by CI.

**E4.** The vector table in `native-sealed-parity.test.ts` (D9) is green, and the ffi-dispatch
boundary test stays green.

**E5.** A **prover**, `scripts/mutation-prove-s18-2-sharp-sealed-load.mjs`, removes one guard per
row and requires a named test to go red:

- It branches on exit codes and never greps output.
- Each anchor must match exactly once, or the prover aborts.
- It runs after the green commit.
- It counts no row with an unsuccessful mutation as proved.

The rows:

| Group | Row | Guard removed |
|---|---|---|
| Files | L01 | The manifest is not judged |
| | L02 | The addon is not judged |
| | L03 | libvips is not judged (only the dlopened file) |
| | L04 | A payload is opened following links |
| | L05 | The manifest is opened following links |
| | L06 | `O_NOFOLLOW`/`O_NONBLOCK` are only checked to be numbers |
| | F01 | `O_NONBLOCK` is dropped (a FIFO hangs) |
| | F02 | A non-regular file is read |
| | H01 | The hash reads by path, not through the judged descriptor |
| Directories | W01 | No ancestor above `native/`'s parent is walked |
| | W02 | The walk stops one short of `/` |
| | W03 | The ancestors are not judged |
| | W04 | A sticky world-writable ancestor is let through |
| | W05 | `stat` instead of `lstat` |
| | W06 | libvips' branch is not walked |
| | R01 | The real-path comparison is removed |
| Pins | P01 | No re-check after the hash |
| | P02 | No re-check after the `dlopen` |
| | P03 | A file's path is not re-checked |
| | P04 | Pins are compared as numbers |
| Search directories | S01 | An unlisted file in the addon's `lib/` is accepted |
| | S02 | The same in libvips' `lib/` |
| Tripwire | T01 | It is skipped |
| | T02 | It compares paths, not `dev:ino` |
| | T03 | A new mapping outside the tree and the system library directories is accepted |
| Profiles | X01 | The extracted profile accepts another non-root uid |
| | X02 | The extracted profile accepts an owner write bit |
| | X03 | The staged profile accepts this uid |
| Switch | O01 | An unrecognised value reads as off |
| | O02 | It reads as on |
| | O03 | `off` prints no warning |
| | O04 | `off` also skips the hash |
| Messages | M01 | The refusal does not name the path |
| | M02 | It does not name the switch |
| | C01 | A control character in a path is printed raw |

**E6.** A scanning test over templates, generator templates, every Dockerfile, the operator's
source and the docs content finds `KNEXT_SHARP_SEALED_LOAD` set to an off value **nowhere** except
`cli/build.ts`'s smoke. Mutation: plant it in `templates/app/Dockerfile.hbs`, which must go red.

**E7.** The OKE standing stage: deploy the template vinext app that uses `next/image`. The
revision must become Ready, and `/_next/image` must return an optimised image. No cold-start A/B
is needed: the bookkeeping is measured at 0.1 ms (M9, M10). The implementer quotes a local
before/after of the first sharp import instead.

### Debt this ADR records (for the sprint-close review)

- **Tighten the extracted directories.** Make them 0500 after extraction, so that not even a
  write primitive running as their owner can create an entry. The extractor would make them
  writable again to re-extract (P3).
- **Anchor the extracted tree's digests in the binary.** The digests should come from the binary's
  embedded manifest, passed by the facade, instead of from the extracted copy. That touches
  `vinext-compile.mjs`, which S18-3 owns (P3).
- **Check sharp outside the Bun binary.** The vinext/node and Next.js standalone runtimes load
  sharp's addon with no integrity check or owner check (P3, from Consequences).
- **Add a builder matrix.** No CI leg builds the template under a builder other than BuildKit
  (kaniko, buildah), where `--chmod` support decides whether the image passes (P3).
