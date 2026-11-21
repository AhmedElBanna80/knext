# ADR-0074: A sealed load for sharp's native addon (one rule for `native/`, two texts)

- **Status:** **Proposed (2026-11-21), revised after review round 1.** Design only. This change
  adds no code, test, env var or docs page. The S18-2 implementation lands the decision, and the
  sprint-close review accepts it or files debt.
- **Task:** v2 Sprint 18, S18-2 (from debt TD-S18-1a).
- **Prerequisite:** a separate, small PR fixes the live bug in Context step 3: today the shim does
  not hash libvips. S18-2 starts after that PR merges.
- **Closes, when implemented:** the open action item of ADR-0069 Amendment 1 (on `integration/v2`,
  `0069:963`), "The sharp shim: the descriptor pin and the owner and mode rule (open debt)". It
  also closes the "One tree, two rules" consequence (`0069:951`).
- **Relates to:** ADR-0069 D13, D18 and Amendment 1 (the in-process Rust loader), ADR-0048
  Amendments 2 and 3 (the sharp `process.dlopen` shim, `native/` and its integrity manifest),
  ADR-0060 (the self-contained executable, invariant I2 execPath anchoring), ADR-0006 (image
  optimisation through sharp), ADR-0036 (vinext is an opt-in, compat-gated build target). Related
  work: #257 (open) changes the in-process Rust loader's rule. Nothing in this ADR depends on #257,
  and every rule here is stated in full below.
- **Trigger class:** a new ADR (Proposed, design-only), and a security invariant
  (`.claude/rules/security.md`). The implementation is also a `src/cli/` trigger, because of the
  build smoke (D6).

## Context

### What loads, and how, today

`packages/kn-next/src/adapters/sharp-addon-dlopen.mjs` replaces `sharp/dist/sharp.mjs` inside a
`bun build --compile` binary. `vinext-compile.mjs:956-1000` (`sharpAddonDlopen`) injects the
shim's source text verbatim into sharp's module slot. So the shim must stay self-contained over
node builtins: it may have no relative imports, and the compile refuses one. Some tests also run
it under Node (`tests/native-integrity-absence-exception.test.ts`). The shim:

1. **Picks the addon.** It takes `KNEXT_SHARP_ADDON`; else the tree a self-contained binary
   extracted (`globalThis[Symbol.for('knext.sharp.nativeRoot')]`); else
   `native/sharp-<platform>/lib/*.node` beside `process.execPath`; else a flat `sharp.node` there
   (`addonPath()`, `:78-138`).
2. **Finds the manifest.** `findManifest` (`:195-205`) looks for `.integrity.json` in the addon's
   directory and at most three parents, by `existsSync`, which follows links. It reads the file by
   path, and requires the addon to be listed (`:338`).
3. **Hashes by path.** It hashes by path (`readFileSync`) every listed file that `isNativePayload`
   (`:207-210`, used at `:349`) accepts. That regex is
   `/\.(node|dylib|so)$|\.so\.[0-9]+$/`. It accepts the addon and `libvips-cpp.so.42`, the name
   the test fixtures use (`sharp-addon-dlopen.test.ts:371`, `native-integrity.test.ts:114`). It
   does **not** accept the real file, `libvips-cpp.so.8.18.7`. So **libvips is not hashed today**,
   and of the two native payloads only the addon is checked. The header and the threat model both
   claim otherwise. The prerequisite PR fixes this now. D2 depends on that fix and pins it with a
   real-soname fixture.
4. **Loads by path.** It calls `process.dlopen(container, path)` by path (`:381`).

It never checks an owner or a mode. It never opens a file without following links, and it pins no
`dev:ino`. Between the hash in step 3 and the loader's own `open()` in step 4, anyone who can write
the tree can change what gets mapped. They can rename a file over the path, rename the tree, write
in place, or reach the inode through a hard link. The header's "an unlisted payload is FATAL" holds
for the addon alone: a planted file next to libvips is not looked for.

The shim runs **at boot**. Outside self-contained mode, sharp's module slot is evaluated at the top
level (`vinext-build.ts:695-700`), so a refusal crashes the process before it listens. On Knative,
a revision that never becomes Ready takes no traffic, and the previous revision keeps serving. In
self-contained mode, `lazySharp` (`sharp-native-extract.mjs:293-318`) defers the load to the first
image request. It **catches** a throw, caches it, and keeps serving every other route.

### What the in-process Rust loader does on `integration/v2`

ADR-0069 Amendment 1, as merged (`0069:874-964`), judges the Rust library on the descriptor it
hashed. It requires root ownership and no group or other write on three things: the library, every
directory from its parent up to `native/`, and the directory `native/` sits in. It does **not**
judge `native/.integrity.json` or any directory above the one `native/` sits in. It judges
directories with `stat`, not `lstat`. It then `dlopen`s `/proc/self/fd/<n>`. #257 proposes a
stricter rule; that is related work only.

The merged Amendment's consequences record the gap this ADR closes (`0069:951`): "One tree, two
rules … sharp is protected only by the same image layout."

### Why the port is not mechanical (TD-S18-1a), measured

These were measured by hand on 2026-11-21 with a throwaway probe. The setup was Docker 29.8.2 on an
arm64 Mac, with amd64 images under emulation: `oven/bun:1.4.2-alpine` (musl) and `oven/bun:1.4.2`
(Debian, glibc 2.41). The packages were **sharp 0.35.5 and `@img/sharp-libvips` 1.3.4**, the
versions `bun.lock` pins. A first run on 0.35.4 / 1.3.3 gave the same results. These rows are
evidence for rejecting option (a); they are not knext behaviour, so no CI job re-runs them. The
appendix says how to repeat them.

| # | Measurement | musl | glibc |
|---|---|---|---|
| M1 | The addon's dynamic section | `DT_RPATH` (no `RUNPATH`) with five `$ORIGIN` entries: `../../sharp-libvips-linuxmusl-x64/lib`, `../../../sharp-libvips-linuxmusl-x64/1.3.4/lib`, `../../node_modules/@img/sharp-libvips-linuxmusl-x64/lib`, `../../../node_modules/@img/…/lib`, `../../../../../@img-sharp-libvips-linuxmusl-x64-npm-1.3.4-<hash>/node_modules/@img/…/lib`. `NEEDED`: `libvips-cpp.so.8.18.7`, `libstdc++.so.6`, `libgcc_s.so.1`, libc. | The same five entries for `linux-x64`. `NEEDED` adds `libm`, `libpthread` and `ld-linux`. |
| M2 | `libvips-cpp.so.8.18.7`'s dynamic section | `RUNPATH $ORIGIN/`; `NEEDED`: libstdc++, libgcc_s, libc | The same `RUNPATH`; `NEEDED` adds `libresolv`, `libdl`, `libm`, `libpthread` |
| M3 | `process.dlopen('/proc/self/fd/<n>')` of the addon | **Fails**: `Error loading shared library libvips-cpp.so.8.18.7: No such file or directory (needed by /proc/self/fd/7)`. `$ORIGIN` becomes `/proc/self/fd`. | **Fails**: `cannot open shared object file` |
| M4 | libvips preloaded by its descriptor through `bun:ffi`, then the addon by descriptor | **Still fails**, with the same error | **Loads** |
| M5 | `patchelf --set-rpath` to an absolute `/app/native/…/lib`, then the addon by descriptor | Loads, but libvips is still opened by path | Not measured |
| M6 | The addon by path | Loads | Loads |
| M7 | `/proc/self/maps` after a by-path load | Lists the addon and libvips with the `dev` (`00:59`, which is 89) and the inode that `lstat` reports | The same |
| M8 | The Bun executable's own `NEEDED` | `libstdc++.so.6`, libc | Not measured |
| M9 | Cost of D1-D4's bookkeeping per load | **0.57-0.67 ms** (n = 200, three runs) | — |
| M10 | Two `/proc/self/maps` reads (D5) | 0.04-0.05 ms | — |
| M11 | Hashing through a descriptor | The addon (~300 KB): 32-38 ms, which includes the first use of the hash path under emulation. libvips (18.8 MB): **~53 ms**. | — |

M9 covers the following work:

- a `realpath`;
- three descriptor opens with `fstat`: the manifest, the addon and libvips;
- the seven directories of both branches, `lstat`-ed three times;
- the `lstat` of every ancestor of the nearest existing directory for each of the nine search
  entries in D4;
- two `readdir`s.

M11's libvips cost is **the prerequisite PR's**, not this ADR's. Today's boot does not pay it,
because libvips is not hashed. The prerequisite PR quotes a native, non-emulated measurement.

**Two loader facts this design depends on.** The search order below comes from the loaders'
source; it was not measured.

- **glibc** checks a `NEEDED` name against what is already loaded, by name or `DT_SONAME`. It then
  searches:
  1. the requesting object's `DT_RPATH`, if it has no `DT_RUNPATH`, and then the `DT_RPATH` of each
     object that loaded it;
  2. `LD_LIBRARY_PATH`;
  3. the requesting object's `DT_RUNPATH`;
  4. `ld.so.cache`, then the default directories.

  So for the addon's dependencies the addon's `DT_RPATH` comes before `LD_LIBRARY_PATH`. For
  libvips' dependencies, `LD_LIBRARY_PATH` comes before libvips' `RUNPATH`.
- **musl** checks a `NEEDED` name against what is already loaded, by the name each library was
  loaded under, and by inode once a path search has found a file. It then searches:
  1. `LD_LIBRARY_PATH`;
  2. the rpath of the requesting object and of each object that needed it (musl makes no difference
     between `DT_RPATH` and `DT_RUNPATH`);
  3. `/etc/ld-musl-<arch>.path`, or else `/lib:/usr/local/lib:/usr/lib`.

  The search stops at the first file found. This also explains M4: a library loaded under the name
  `/proc/self/fd/<n>` never matches the name `libvips-cpp.so.8.18.7`. That is inferred, not
  measured.

What follows:

- **Loading through a descriptor cannot work on the shipped platform.** The image is
  `alpine:3.22` (`packages/kn-next/templates/app/Dockerfile.hbs:28`). The relative rpath (M1, M3)
  breaks every musl variant except patching the binary (M4, M5).
- **Against the actor that matters, the descriptor buys nothing over the ancestor rule.** To rename
  or replace any part of a path, an actor must be able to write its parent. If every directory from
  the tree up to `/` is root-owned and closed to group and other, nobody but root can redirect a
  lookup. Against root, nothing a lookup does helps, because root can write in place. The Rust
  loader dlopens its descriptor because it can: a Rust `cdylib` has no relative-rpath dependency,
  and sharp's addon has one.
- **How this ADR reads the sprint row's "fd pin".** It reads it as follows: every judged file is
  opened once without following links, and is judged and hashed through that descriptor; its inode
  is pinned and checked again after the `dlopen`. It does not mean `dlopen` the descriptor, which
  M3 and M4 show cannot load sharp on musl. The sprint-close review accepts or rejects that
  reading.

### Who boots the shim today, and from what tree (the blast radius)

| Where | Tree, owner and mode | Under a root-only rule, unchanged |
|---|---|---|
| Template vinext image (`packages/kn-next/templates/app/Dockerfile.hbs`) | `COPY --chown=0:0 --chmod=a-w native /app/native` (`:89`), `WORKDIR /app` (`:46`), `USER 65532:65532` (`:100`). Under BuildKit: `/app` and `native/` are root-owned 0755, the directories below 0555, the files 0444. Recorded by ADR-0069 Amendment 1 item 6 for the same layout. | Passes |
| `apps/file-manager/Dockerfile` | `COPY --from=builder /repo/native /app/native` (`:174`), with no `--chown` or `--chmod`. The builder runs as root and staged with `cp -RL`. | Expected to pass; not measured (E3) |
| `knext build`'s post-compile smoke (`cli/build.ts:177-247`) | The app's own directory, owned by the developer or the CI user. There are three paths: the host-arch twin with `KNEXT_SHARP_ADDON` into `.knext-smoke-native/` (`:244-246`); the **reuse** path, where the ship binary boots its own `native/` (`vinext-build.ts:361-376`, `reuseShipBinary`); and the self-contained path. | Refused on every path |
| CI `compat-smoke` (`ci.yml:539-575`) | `native/` staged with `cp -RL` into `apps/file-manager/` in the runner's workspace | Refused |
| `compat-vinext.yml` through `scripts/e2e-deploy-vinext.sh` | Disk mode: `native/` staged into `APP_DIR` (`:541-564`); the suite is served from a fresh directory under `RUNNER_TEMP` holding the binary and `native/` (`:698-707`). Both are owned by the runner. | Refused (disk mode) |
| `sharp-addon-dlopen.test.ts:392-438` (`loadShim`, `discoverShim`) and `tests/native-integrity-absence-exception.test.ts:73-91` | Temp directories owned by the test user, under a sticky `/tmp`, with `process.dlopen` stubbed | Refused |
| Self-contained mode (opt-in) | Extracted by the app's uid under `KNEXT_NATIVE_TMPDIR` or `TMPDIR`, with directories 0700 and files 0500 (`sharp-native-extract.mjs`) | Refused, always |
| A compiled binary run by hand (`darwin-arm64` and `darwin-x64` are shippable arches, `vinext-build.ts:100-115`) | Usually under the user's home directory | Refused |

### The manifest-absence exemption runs out on 2026-12-01

`scripts/lib/native-integrity-policy.mjs:45` dates the exemption that lets an absent manifest warn
and load: it expires on 2026-12-01. On that day its clock turns CI red, and whether to flip the
default or do something else is the founder's call. This ADR proposes nothing about the exemption.
It designs the no-manifest branch so that it is correct in either order (D7).

## Decision

The shim gets a sealed load: **option (b)** below. It opens files by path, but every step is
sealed:

- each file is opened with `O_NOFOLLOW|O_NONBLOCK`, must be a regular file, and is judged and
  hashed through that one descriptor;
- `dev:ino` pins are taken before the manifest is read, and checked again after the hash and after
  the `dlopen`;
- every directory up to `/` is walked;
- two profiles are chosen by where the tree came from;
- the loader's whole search path is judged;
- a `/proc/self/maps` tripwire runs after the load, and a refusal there ends the process.

It is on by default. One parsed off switch reports instead of refusing, and it is honoured only
outside Knative.

The jev scores, from `jev.py pick` on 2026-11-21:

| Decision | Chosen | Score | The others |
|---|---|---|---|
| Design | (b) sealed by-path load | **1.00** | a1 0.00, a2 0.00, c 0.00, d 0.00 |
| Default and switch (round 1) | On by default, one parsed off switch | **0.90** | no opt-out 0.05, default off with an opt-in 0.05, report-only with a dated flip 0.00 |
| Switch scope (round 2) | Honoured only when `K_SERVICE` is unset | **0.69** in the review round's run (unscoped 0.17, dated 0.08, reported 0.06); **1.00** in a re-run with the table's descriptions | — |
| Where the source lives (round 1) | Inside the shim | **0.97** | a concatenated core fragment 0.03, a byte-identical fragment 0.00, in the Rust package 0.00 |
| Lockstep with the Rust loader (round 2) | One repo-root parity test | **0.99** | per-package vector suites 0.01, a core test importing the renderer 0.00, a text compare 0.00 |
| Self-contained tree | A second profile, owned by the process's uid | **1.00** | refuse it 0.00, exempt it 0.00, extract as root at build 0.00 |
| D4 invariant (round 2) | Judge the search closure | **0.98** | every `NEEDED` listed or already mapped 0.02, the tree's own directories only 0.00 |

### D1. Two profiles, chosen by where the tree came from, never by a setting

All stat values are read with `{ bigint: true }` and compared as bigints, for example
`st.uid === 0n` and `(st.mode & 0o022n) === 0n`.

**The tree root.**

| Layout | Tree root |
|---|---|
| `native/` beside the executable | that `native/` |
| `KNEXT_SHARP_ADDON` | the directory that holds the manifest `findManifest` found; with no manifest, the parent of the addon's package directory |
| Flat `sharp.node` | the executable's directory itself. There is no directory inside the tree, and the walk starts at the executable's directory. libvips is then reachable only through the search in D4, which judges it. |
| Extracted | the extraction root |

**Staged** is the default. It applies to `native/` beside the executable, the flat `sharp.node` and
`KNEXT_SHARP_ADDON`.

- **Files.** The manifest, and every native payload (D2), must be owned by uid 0 and not writable
  by group or other: `st.uid === 0n && (st.mode & 0o022n) === 0n`. They are judged on the
  descriptor each was opened as. The process's own uid is never read, and there is no exception for
  it: that user can `chmod` what it owns, so a tree it owns protects nothing from a file-write bug.
- **Directories.** Each of the following must be a real directory by `lstat`, owned by uid 0, and
  not writable by group or other. The mode bits are the whole test, so a sticky `/tmp` is refused
  too: this is the conservative reading, as in OpenSSH `StrictModes`.
  - every directory from each payload's directory up to the tree root, covering **both** the
    addon's branch and libvips' branch;
  - the tree root;
  - the directory that holds the tree root;
  - every directory above that, up to `/`.
- **Why every ancestor is enough against non-root.** Renaming or replacing a directory needs write
  on its parent. With every directory on the path owned by root and closed, no user but root can
  swap any part of it, so by-path lookups are sound without a directory descriptor. Bun's `fs` has
  no `openat`, and macOS has no descriptor-relative path.
- **Not read:** ACLs (mode bits only) and `access()` (which answers yes to root for everything).

**Extracted** applies to self-contained mode. It is used when `knext.sharp.nativeRoot` is set by
the generated facade and `KNEXT_SHARP_ADDON` is unset, which is exactly when the facade extracts.
The tree's owner cannot be root, because the process wrote the tree itself.

- **Files:** owned by `process.getuid()`, and no write bit for anyone: `(st.mode & 0o222n) === 0n`.
  The extractor writes 0500. A platform without `getuid` is refused.
- **Directories inside the tree** (from each payload's directory up to the extraction root): owned
  by this uid, real directories, and `(st.mode & 0o022n) === 0n`. The extractor makes them 0700.
- **The base** (the extraction root's parent) passes the extractor's own base rule, restated in
  the shim and **held in step with it by a test** (`sharp-extract-base-lockstep.test.ts`, E4):
  - `assertSafeBase` is private to `sharp-native-extract.mjs`, so the implementation exports it for
    that test;
  - the rule tests only `0o002`. A world-writable base that is not sticky passes only if root owns
    it, which is the operator's default `/tmp` `emptyDir`;
  - a base that is not world-writable must be owned by this uid or by root;
  - **group write is not tested.**
- **Every directory above the base, up to `/`:** owned by root or by this uid. It must be closed to
  group and other, except that a **sticky** directory passes when the next directory on the path
  is owned by root or by this uid. In a sticky directory only the entry's owner, the directory's
  owner and root can rename the entry. That keeps `KNEXT_NATIVE_TMPDIR=/tmp/<private dir>`
  working, as the self-contained exec test uses it.

**What the extracted profile does not stop, stated rather than implied.**

- **The app's own uid.** It owns the tree and can `chmod` and write it.
- **Every writer of the base**, wherever the base is not sticky:
  - with the operator's default, a root-owned 0777 `emptyDir` with no sticky bit, that means every
    uid in the container and every container in the pod that mounts the volume;
  - with a group-writable base, its group;
  - they can rename the extraction root away and put another in its place between the checks. The
    pins (D3) see a tree that is swapped in and left there. Only the tripwire (D5) sees one that is
    put back, and only after its constructors have run.
- **Directories a writer of the base can create**, which the addon's rpath may search (D4).

What it does deny: a pure file-write primitive (the files have no write bit), another uid's tree,
and a base or an ancestor that drifts. **The strong guarantee needs the staged layout.**

### D2. Files

The files are the manifest and every native payload. A native payload is a listed file whose name
matches `/\.(node|dylib)$|\.so(\.\d+)*$/`. That covers `libvips-cpp.so.8.18.7`, and the
prerequisite PR fixes it in `isNativePayload` with a fixture that uses the real soname.

Each file is handled in four steps:

1. **Opened** with `O_RDONLY|O_NOFOLLOW|O_NONBLOCK`. A platform where either flag is not a
   positive number is refused: an absent flag ORs in as 0 and would silently follow or block.
2. **`fstat`-ed** with `{ bigint: true }`. It must be `S_IFREG`.
3. **Judged** on that descriptor by the profile's rule.
4. **Read** through that descriptor, both to parse it (the manifest, and the ELF dynamic section of
   each payload for D4) and to hash it. Nothing is read by path.

**How an open failure is classified, in both modes.**

| Result of the open | Classified as |
|---|---|
| `ENOENT` | absent |
| `ELOOP` (a link) | **unreadable**; never absent |
| a non-regular file (a FIFO, a device, a directory) | **unreadable**; never absent |
| any other error | **unreadable**; never absent |

An unreadable manifest or payload is fatal (D6). `findManifest` uses `lstat` instead of
`existsSync`. So a dangling link at `.integrity.json` counts as present but unreadable, and can
never downgrade the load to the absence branch.

Each descriptor stays open until the checks after the `dlopen` (D5) have run, and is then closed.
That is safe: by-path `dlopen` does not use the descriptor.

### D3. Directories, pins and the real path

- **Judged first.** Every directory D1 names is `lstat`-ed (bigint), must be `S_IFDIR` (a link is
  refused, never followed), and is judged by the profile's rule. All of this happens **before** the
  manifest is opened, and one refusal lists **every** failing directory.
- **Pinned and checked twice.** The `dev:ino` of each directory is pinned as a bigint, so two
  inodes that differ only above 2^53 are two directories. The pins are checked again after the last
  payload is hashed, and **after `process.dlopen` returns**. After the hash, each judged file's
  path must also still `lstat` to the inode that was read. Any change is a refusal.
- **The tree root must be its own real path.** It is compared with `realpathSync`, and a difference
  is refused:
  - **default root:** Bun reports `process.execPath` already resolved, so this is a fail-closed
    assertion;
  - **`KNEXT_SHARP_ADDON` through a link:** refused, with "point it at the real path". A link
    outside the judged path could aim the load at any complete tree root wrote;
  - **extracted root:** `sharp-native-extract.mjs` returns `join(realpath(base), name)` instead of
    `join(base, name)`, so a macOS `TMPDIR` under `/var -> /private/var` passes.

### D4. The loader's search path is judged

**The invariant.** Before the `dlopen`, every directory that a search for any `NEEDED` name of the
addon or libvips can reach is judged. Each one must either exist and pass the profile's directory
rule, together with every directory above it, or not exist with its nearest existing ancestor
passing that rule, so that only an actor the profile trusts can create it. Directories of that set
inside the tree may hold only listed regular files, and directories that lead to listed files.
**With that, no actor the profile stops can change which file any search finds.**

The set of directories, with the libc's order in Context:

- every entry of `LD_LIBRARY_PATH`;
- the addon's `DT_RPATH` and `DT_RUNPATH` entries, and libvips', after `$ORIGIN` is expanded to the
  real directory of the object that names it. Today those are the five entries in M1 and libvips'
  `$ORIGIN/`;
- the libc's default directories:
  - musl: the entries of `/etc/ld-musl-<arch>.path`, a file judged by the file rule, or else
    `/lib`, `/usr/local/lib` and `/usr/lib`;
  - glibc: `/etc/ld.so.cache` judged as a file, plus `/lib` and `/usr/lib`. glibc is never shipped
    (`vinext-build.ts:90-99`), and runs only in the build smoke, in report mode, so the directories
    the cache names are not enumerated.

The entries come from the bytes already read through each payload's descriptor. A small ELF64
little-endian reader takes `PT_DYNAMIC`, and from it `DT_STRTAB`, `DT_NEEDED`, `DT_RPATH` and
`DT_RUNPATH`. These are refused:

- a payload that is not ELF64 little-endian on Linux;
- a dynamic section that cannot be parsed;
- an rpath token other than `$ORIGIN` or `${ORIGIN}`, such as `$LIB` or `$PLATFORM`.

**In the extracted profile, by design.** Entries 2 and 4 resolve under the **base**. A missing
entry there whose nearest existing ancestor is the base passes when the base passes the base rule,
and the base's writers are already in D1's residual. An entry that exists there is judged with the
extracted directory rule.

**What the closure actually protects today.** The search matters for libvips, which is always
found in the addon's first entry, inside the tree, and pinned. It matters for nothing else: the C++
runtime and libc are already loaded by the Bun executable (M8), so no search happens for them. The
closure keeps that true if `LD_LIBRARY_PATH` is set or a later sharp needs a new library. Its cost
is part of M9.

### D5. After the `dlopen` (Linux): the mapped-inode tripwire, and a refusal ends the process

`/proc/self/maps` is read just before and just after `process.dlopen`. A refusal follows unless
both of these hold:

- the pinned addon and the pinned libvips are both mapped, with their pinned `dev` and inode;
- every file newly mapped by the call is either a pinned payload or sits in a directory that D4
  judged.

The maps file prints `dev` as hex `major:minor`, which must be decoded the way the kernel's
`new_encode_dev` encodes it.

**The tripwire detects; it does not prevent.** By the time it reads the maps file, the ELF
constructors of whatever was mapped have already run. It sees:

- a swap by root that is put back between the last pin check and the loader's open;
- a libvips from `LD_PRELOAD`, which is mapped before the shim runs, so the pinned inode is the
  one that goes missing;
- a libvips already loaded under another path, which glibc reuses by SONAME and musl by name.

**A refusal after the `dlopen` ends the process in enforce mode.** Throwing is not enough: in
self-contained mode `lazySharp` catches the throw and keeps serving with the library still mapped.
The shim writes the refusal to stderr with `writeSync(2, …)` and then calls `process.exit(78)`
(`EX_CONFIG`). Nothing can catch that exit. Refusals **before** the `dlopen` still throw, since
nothing has been mapped yet; `lazySharp` caches them, and only image requests fail.

**macOS** is a shippable arch (`darwin-arm64`, `darwin-x64`). It has no `/proc`, so neither the
tripwire nor D4's ELF closure runs there; both are Linux-only. D1 to D3 apply on macOS, and the
residual D4 and D5 cover on Linux stays open there, including `dyld`'s search paths.

### D6. One parsed off switch, scoped to outside Knative: `KNEXT_SHARP_SEALED_LOAD`

- **Values.** The switch reuses the shim's `REQUIRE_ON` and `REQUIRE_OFF` lists (`:217-218`) and
  `requireIntegrity()`'s three outcomes:
  - unset, empty, or an on spelling: **enforce**;
  - an off spelling: **report mode**, but **only when `K_SERVICE` is unset or empty**;
  - anything else: the shim **throws** before any file is opened, listing the accepted values.
- **Inside Knative.** Knative sets `K_SERVICE` in every user container. There, an off value is
  **fatal**: the shim throws before any file is opened, says the switch is not honoured inside
  Knative, and names the layout fix. Refusal messages inside Knative never mention the switch.
  Outside Knative they name it, with the sentence that it loads a tree nobody has judged. In
  self-contained mode this surfaces on the first image request, as every sharp load failure does
  there.
- **What report mode does.** Every check in D1 to D5 runs. The findings are printed as **one
  warning per load** that lists every path that would have been refused. Then the addon loads by
  path, and a finding after the `dlopen` warns instead of ending the process. Files are still
  opened with `O_NOFOLLOW|O_NONBLOCK`, so a FIFO cannot hang the load and a link is still not
  followed.
- **What stays fatal in report mode:**
  - a hash mismatch;
  - an unlisted addon;
  - an unknown manifest version;
  - an **unreadable manifest** (`:309`), which per D2 includes a link, a FIFO and any non-regular
    file at the manifest's path;
  - an unreadable payload, classified the same way;
  - a staged tree for the wrong platform.

  An absent manifest stays governed by `KNEXT_REQUIRE_NATIVE_INTEGRITY` (D7).
- **Scope.** The switch is sharp's only. The in-process Rust loader has no opt-out and never reads
  this variable.
- **It has no expiry date.** Its remaining users are the build smoke and a developer running a
  compiled binary by hand. Neither runs in Knative, and neither ships.
- **Who sets it.** Only `knext build`'s post-compile smoke sets it, and **unconditionally, on every
  smoke path**: the host-arch twin, the reuse path (`reuseShipBinary`) and the self-contained path.
  It goes in the smoke child's env in `cli/build.ts`, no longer only beside `KNEXT_SHARP_ADDON`
  (`:244-246`). **No CI lane sets it** (D12), and nothing that ships sets it: no template, generator
  template, Dockerfile, operator render or docs recipe. A scanning test enforces this (E6).

### D7. The no-manifest branch, correct in either order of the 2026-12-01 decision

"Absent" means `ENOENT` on D2's open, and nothing else. With no manifest, the shim first judges
everything it can:

- the directories and pins (D1, D3);
- the addon, and every file in the payload directories that matches D2's pattern, each judged on
  its own descriptor;
- the search closure (D4).

There is no list, so the "nothing unlisted" part of D4 cannot apply. Every entry in the payload
directories is judged as a payload instead. Then it hands over **unchanged** to the existing
absence decision (`requireIntegrity()` and the exemption):

- **If the exemption is still live when S18-2 lands:** a judged tree with no manifest warns and
  loads, as today, unless `KNEXT_REQUIRE_NATIVE_INTEGRITY` is on. An enforce-mode refusal from the
  rule fires before the absence decision.
- **If the default flips first:** the absence decision refuses. The rule's findings come first in
  the same message, and nothing else changes.

This ADR does not depend on the flip, and the S18-2 implementation does not edit
`native-integrity-policy.mjs`. The no-manifest tests run twice, once with the exemption in force
(`KNEXT_REQUIRE_NATIVE_INTEGRITY=0`) and once with absence fatal (`=1`), so neither order turns
them red. A side effect in both orders: removing the manifest needs write on the tree root, which
only root has under the staged profile. That closes the "strip the manifest to downgrade" residual
for non-root actors at runtime.

### D8. Refusal messages

Each refusal names:

- the path, and what failed (its owner, its full mode including the sticky and setgid bits, or its
  type);
- the fix, chosen by situation:
  - a directory inside the tree is fixed in place, with `chmod go-w` and `chown root`, or a
    Dockerfile `RUN` after the `COPY`;
  - the template's `COPY --chown=0:0 --chmod=a-w native /app/native` is the layout that passes;
  - a sticky or shared directory means moving the install;
  - a home directory is never given to root;
- the switch, only outside Knative (D6).

Every printed path, value and system error goes through an escaping function. It shows C0 and C1
controls, U+2028 and U+2029, every Unicode `Cf` character and lone surrogates as escapes, never
raw. It doubles backslashes and escapes carets, so a newline in a directory name cannot forge a
line in the list.

### D9. Where the source lives: core-owned, inlined by the existing renderer, not one shared text

- **The logic lives in `sharp-addon-dlopen.mjs` itself.** That file is core runtime. It stays
  self-contained over node builtins: the existing test pins that it has no relative imports.
- **The renderer that inlines it already exists.** It is `vinext-compile.mjs`'s `sharpAddonDlopen`
  `onLoad`, which injects the verbatim text, together with tsup's verbatim copy
  `dist/adapters/sharp-addon-dlopen.source.mjs`. S18-2 does not edit `vinext-compile.mjs`, which
  S18-3 owns.
- **Core-vs-Beta boundary (ADR-0069 D18).** Core never imports the in-process Rust package. The
  shim names it nowhere, comments included, because `ffi-dispatch.test.ts` scans core source and
  allows the name only in `cli/ffi-dispatch.ts`. No test under `packages/kn-next/src` imports the
  Rust package's code either: `ffi-metrics-seam.test.ts` only reads `render.ts` as text. The Rust
  package does not import core.
- **Why not one byte-identical text.** The Rust loader is generated TypeScript **committed into
  apps**. Every change to its text forces every app to regenerate its wrappers. It also speaks
  `FfiLoadError`, has no switch and has no extracted profile. A shared text would couple core's
  sharp releases to app wrapper regeneration, or force the two loaders into one set of messages
  and one policy, which D1 and D6 deliberately keep apart.

### D10. Lockstep by one repo-root parity test

`tests/native-sealed-parity.test.ts` sits in the repo root's `tests/`, which belongs to neither
package, so D18 does not constrain it. It imports the Rust package's pure `renderModule`, and it
runs the core shim from its source path. Both run in Bun subprocesses that share one table.

**The row schema:**

```ts
type Role = 'exec-dir' | 'above' | 'tree-root' | 'payload-dir' | 'payload' | 'manifest';
interface Vector {
  id: string;                       // 'V01'
  what: string;                     // one line
  ops: Op[];                        // applied to each loader's tree, by role
  fake?: {                          // read by the harness (D11), never by a loader
    owner?: Partial<Record<Role, number>>;
    mode?: Partial<Record<Role, number>>;
    type?: Partial<Record<Role, 'fifo' | 'link' | 'dir'>>;
  };
  expect: Verdict | { ffi: Verdict; sharp: Verdict; why: string };
}
type Op =
  | { op: 'chmod'; role: Role; mode: number }
  | { op: 'symlink-over'; role: Role }
  | { op: 'hardlink-out'; role: 'payload' }       // a second name, in a test-owned directory
  | { op: 'mkfifo'; role: 'manifest' | 'payload' }
  | { op: 'swap-tree'; at: 'manifest-open'; putBack: boolean }
  | { op: 'write-in-place'; role: 'payload'; at: 'after-hash' }
  | { op: 'plant'; role: 'payload-dir'; name: string };
type Verdict = { load: true } | { refuse: Role };  // the role whose path the refusal names
```

**How roles map to each loader's tree.** Both trees put the executable at `<dir>/server` and the
tree root at `<dir>/native`.

| Role | The Rust loader | The sharp shim |
|---|---|---|
| `payload` | `native/ffi/<triple>/lib<name>.so` | **two**: `native/sharp-<id>/lib/sharp-<id>-<ver>.node` and `native/sharp-libvips-<id>/lib/libvips-cpp.so.<x.y.z>` |
| `payload-dir` | `native/ffi/<triple>`, `native/ffi` | `native/sharp-<id>/lib`, `native/sharp-<id>`, `native/sharp-libvips-<id>/lib`, `native/sharp-libvips-<id>` |
| `manifest` | `native/.integrity.json` | `native/.integrity.json` |
| `tree-root`, `exec-dir`, `above` | the same in both | the same in both |

A vector that names `payload` or `payload-dir` **expands into one case per sharp path**. Each case
must match the Rust loader's verdict, and a refusal's printed path is mapped back to its role
before the comparison.

**How each `dlopen` is stubbed.**

- **The Rust loader.** The test renders a module from a one-function fixture manifest and writes it
  into the tree. A Bun subprocess first replaces `process.getBuiltinModule` so that `'bun:ffi'`
  returns an object whose `dlopen(name)` prints `REACHED_LOAD <name>` and throws a sentinel. Then
  it imports the module and calls the function. A pass is the `REACHED_LOAD` line; a refusal is the
  `FfiLoadError` text.
- **The sharp shim.** A Bun subprocess sets `process.execPath` to the fixture's executable and
  replaces `process.dlopen` with a recorder that prints `REACHED_LOAD <path>` and sets `exports`.
  Then it imports the shim. The harness supplies a `/proc/self/maps` that lists the pinned payloads
  with their real `dev:ino` after the stub, so the tripwire passes a pass vector.

**Rows where the loaders differ by design.** Each is its own row, with a `why`:

- the switch;
- the extracted profile;
- D4's closure and the "nothing unlisted" check;
- the tripwire and the exit (D5);
- the classification in D2;
- every rule where the Rust loader on `integration/v2` at implementation time is weaker than D1.
  Today that is the manifest, which it does not judge, the directories above the tree root's
  parent, and `stat` instead of `lstat`. These rows shrink if #257 merges first.

### D11. A new owner-faking harness, for bigint stats

The Rust package's loader tests have a harness of their own (`ffi-loader.test.ts:179-201`), and it
does not fit this rule. It is local to that file. It replaces `fstatSync` and `statSync` but not
`lstatSync`. And it injects a number `uid` even into a bigint stat. So S18-2 adds `packages/kn-next/src/__tests__/helpers/fake-stat.mjs`: plain JavaScript,
loaded by every subprocess harness above and by D10's test. It must:

1. **Replace the stat functions.** That means `fs.statSync`, `fs.lstatSync` and `fs.fstatSync`, and
   then `module.syncBuiltinESMExports()`, so that the shim's named imports from `node:fs` see the
   replacements. It must do this **under both Bun and Node**, because
   `tests/native-integrity-absence-exception.test.ts` runs the shim under Node.
2. **Answer in kind.** With `{ bigint: true }` it returns `uid`, `gid`, `mode`, `dev` and `ino` as
   bigints, for example `BigInt(fakeUid)`. Otherwise it returns numbers.
3. **Override precisely.**
   - The owner can be overridden by path, by `dev:ino` (the key that survives a rename, and the one
     `fstat` needs), or by default.
   - The permission bits, the sticky bit included, can be overridden by path.
   - The type bits (FIFO, link) can be overridden by path, for `lstat` only.
   - `process.getuid()` can be faked.
   - `/proc/self/maps` can be supplied through a `readFileSync` override.
   - Every other value stays real.
4. **Record every call**, as a path or `fd`, with whether it asked for bigint. Tests can then
   assert that every stat is bigint and that the walk is exactly the expected set.
5. **Be configured only by `FAKE_*` env JSON, read only by the helper.** A scanning test asserts
   that the shim's source contains no `FAKE_`, so no test seam ships.
6. **Prove itself.** A self-test shows the shim refusing a tree whose owner the harness fakes to a
   non-root uid, under each runtime. A harness that fails to take effect then turns the test red
   instead of passing silently.

### D12. CI lanes certify the shipped mode: a root-owned layout, never the switch

The compat credential has to certify what ships, so **no lane uses the switch**. Each lane that
boots the compiled binary from its own tree stages a **root-owned layout** instead:

- the directory is created with `sudo` (GitHub's runners give the runner user passwordless sudo);
- every directory from it up to `/` must be root-owned and closed to group and other, and is
  checked **before** staging. GitHub's `ubuntu-latest` has `/opt` at mode 0777, as #257's CI runs
  observed, so `/opt/<lane>` fails there. The lanes use `/var/lib/knext-lane/<job>-<run_id>`, and
  stop with a clear message if no candidate passes;
- everything that must sit beside the executable is copied in, then given
  `chown -R 0:0` and `chmod -R go-w`: the binary, `native/`, and `.output/public` where I2 needs it;
- the binary runs as the runner user, which is not root, and the directory is removed at the end.

Lanes inside an image already have the root layout. Self-contained lanes use the extracted profile
and need no change beyond an assertion that it ran in enforce mode.

## Options considered

### The design

The **residual** column is the window left between the check and the map. "Non-root" there means
the app user, a sidecar, an `fsGroup` writer or a co-tenant uid.

| Option | Residual | Behaviour change for existing sharp users | glibc / musl | Bun / Node | Cold start | Testability | jev |
|---|---|---|---|---|---|---|---|
| **(a1)** Pin by descriptor and dlopen through `/proc/self/fd`, with libvips preloaded by descriptor through `bun:ffi` first | **musl:** none, because nothing loads at all. **glibc:** none against non-root, and only if the owner/mode rule is added as well. An fd pins the inode, not its bytes. | **On musl (every shipped image) sharp never loads,** and every vinext app with `next/image` crashes at boot (M4). | **Fails on musl** (M4); loads on glibc (M4), which is the smoke twin only. | The preload needs `bun:ffi`. Node's `process.dlopen` is for addons (not measured; moot, because the shim ships only in Bun binaries). | One extra `dlopen` | Needs real native loads per libc. The musl leg cannot pass. | 0.00 |
| **(a2)** The same, with `patchelf` rewriting the addon's rpath to an absolute path at build | The addon's path swap is closed, but **libvips is still opened by path** (M5). The rule is still needed against in-place writes. | The bytes of a third-party binary change, so the sha256 no longer matches the upstream tarball's. An absolute rpath breaks every relocated tree: `KNEXT_SHARP_ADDON`, the self-contained root (unknown at build) and `.knext-smoke-native/`. `patchelf` joins the build supply chain. | Loads on musl (M5); glibc not measured. | Same on both | Runtime none; one build step | Needs `patchelf` in the build tests plus real loads per layout | 0.00 |
| **(b) Sealed by-path load: chosen** (D1-D12) | **Non-root, staged: none.** No directory on the path or the search closure can be renamed, and no judged file can be written. **Root, a capability as good as root, or a second writable mount:** they can write in place, and nothing a loader does stops that. A swap put back between the last pin check and the loader's open is seen only by the tripwire, after the constructors have run. **Extracted:** the app's uid and the base's writers (D1). **macOS:** no closure and no tripwire (D5). | The template image passes. `apps/file-manager` is expected to pass (E3). Every drifted layout is refused at boot with its path and fix: a `chown`-ed `/app`; a builder that ignores `--chmod` **when the build context's directories are group- or other-writable** (umask 002); an install under a home directory or `/tmp`; an `fsGroup`-writable volume; `KNEXT_SHARP_ADDON` through a link. The build smoke runs in report mode. CI lanes move to a root-owned layout. | One rule on both. The two libcs' search orders are both covered by D4. | Portable: `O_NOFOLLOW` and `O_NONBLOCK`, bigint stats, `realpath` and `/proc/self/maps` exist in both. No `openat` needed. | **About +0.7 ms per load** (M9 + M10), at the same point as today. | Fully testable without root, with real hard links, in-place writes, links, FIFOs and renames, plus a real-root leg (E1-E3). | **1.00** |
| **(c)** The owner/mode rule only, by path, with no descriptor, no `O_NOFOLLOW`, no pins and no ancestor walk, with an opt-out | **Non-root: the tree swap stays open.** A writer of any directory above the judged ones renames the tree between the steps. A FIFO at the manifest hangs boot, and a link is followed. | The same refusals as (b) for files that are themselves drifted. Swapped trees pass. | Same on both | Portable | Less than (b) | The swap and hard-link-in-a-swapped-tree tests stay green for the attacker. | 0.00 |
| **(d)** Document the risk only | Today's window: the hash runs by path (and skips libvips), then the `dlopen` runs by path, open to any writer of the tree. | None | — | — | None | Nothing to test | 0.00 |

### The default and the switch

| Option | What it costs | Who it breaks | Score |
|---|---|---|---|
| **On by default, with one parsed off switch honoured only when `K_SERVICE` is unset: chosen** | A refusal at boot inside Knative, where the old revision keeps serving | No one silently. Inside Knative the only way out is the layout fix, which is what the compat credential certifies. | 0.69 (review run; unscoped 0.17, dated 0.08, reported 0.06), 1.00 (re-run) |
| On, with the switch honoured everywhere (round 1) | A production pod can run unjudged with one env line | No one, but it weakens what the credential certifies | 0.17 / 0.00 |
| On, with the switch honoured everywhere until an expiry the CI clock enforces | Forces a later removal of a switch the build smoke and hand runs always need | The smoke, after the expiry | 0.08 / 0.00 |
| On, with the switch honoured everywhere, and every use reported as a log line and a metric | Visibility without a boundary | No one, but production can still opt out | 0.06 / 0.00 |
| On, with no opt-out (the Rust loader's model) | The smoke and every hand-run binary under a home directory are refused | Every `knext build` of a vinext app with sharp | 0.05 (round 1) |
| Off by default, with an opt-in | Protects only those who read this ADR | No one; protects no one | 0.05 (round 1) |

### Where the source lives, and how it stays in step

| Option | Boundary (D18) | Cost | Score |
|---|---|---|---|
| **The logic inside the shim, inlined by the existing `onLoad`, with one repo-root parity test (D10): chosen** | Clean: the root `tests/` belongs to neither package | One test that spawns two runtimes' worth of fixtures | 0.97 (location), 0.99 (lockstep) |
| A neutral vector file consumed separately by each package's suite | Clean | Two harnesses that drift from each other, and no single place that shows a divergence | 0.01 |
| A core test that imports the Rust package's renderer by relative path | **Crosses it:** `packages/kn-next/src/__tests__` is under `packages/kn-next/src` | — | 0.00 |
| A text compare of the two sources | Clean | Compares spellings, not behaviour, so it is decorative | 0.00 |
| One byte-identical fragment shared by both | Clean | Couples core releases to app wrapper regeneration, and forces one set of messages and one policy | 0.00 |
| The fragment in the Rust package, imported by core | **Crosses it** | — | 0.00 |

### The self-contained tree

| Option | Guarantee | Breaks | Score |
|---|---|---|---|
| **A second profile owned by this uid (D1): chosen** | Denies a pure write primitive, another uid's tree and a drifted base. The app's uid and the base's writers remain, stated. | Nothing that works today | 1.00 |
| Refuse an extracted tree while the rule is on | Strong | Every self-contained deployment, inside Knative where there is no switch | 0.00 |
| Exempt it, so only the hash applies | Today's | Nothing, but it leaves the window open | 0.00 |
| Extract as root at image build | Staged-strength | The single-file image that self-contained mode exists for | 0.00 |

### The D4 invariant

| Option | Holds against non-root | Cost | Score |
|---|---|---|---|
| **Judge the search closure: chosen** | Yes, for every `NEEDED` name, whatever `LD_LIBRARY_PATH` holds | One ELF dynamic-section reader and a few `lstat`s, within M9 | 0.98 |
| Assert before the `dlopen` that every `NEEDED` is listed or already mapped | Cannot be checked: `/proc/self/maps` shows resolved file names (`libstdc++.so.6.0.x`), not `NEEDED` names, and musl's name table is internal | — | 0.02 |
| Judge only the tree's own directories, and rely on the tripwire | No: a library planted where `LD_LIBRARY_PATH` points runs its constructor first | Least | 0.00 |

## Consequences

- **What it closes.** "One tree, two rules" becomes one rule in two texts, proved equal by D10.
  Under the staged profile, the sharp payloads can no longer be swapped or written between the hash
  and the map by any writer that is not root: not the app's own user through a file-write bug, not
  a sidecar, not an `fsGroup` writer, not a co-tenant. The loader's search path is closed to them
  too. A drifted layout is now a named refusal at boot instead of a silent load.
- **The manifest-absence downgrade narrows, in either order** (D7). Removing the manifest needs
  write on the tree root, which is root-only under the staged profile.
- **Every vinext app with `next/image` is affected** (a `@getknext/core` **minor** changeset):
  - The template image is unchanged and loads. The `apps/file-manager` image is expected to load,
    and E3 measures it.
  - A drifted layout fails its first boot. Knative keeps the old revision serving. Inside Knative
    there is no switch, and the message names the fix.
  - A self-contained binary gets the extracted profile, with its residual stated.
  - `knext build`'s smoke runs in report mode on every path, so its output carries the rule's
    findings for the binary it boots as one warning.
- **The CI lanes change** (D12): `compat-smoke`, the compat-vinext disk-mode lane and the unit
  tests that run the real shim. The credential then certifies the enforced mode.
- **Ownership.** The S18-2 implementation goes beyond the sprint row's "Owns" column:
  - `cli/build.ts` (the smoke env), which is a `src/cli/` trigger;
  - `sharp-native-extract.mjs` (the real-path return, the stale-file sweep and the export for the
    lockstep test);
  - `scripts/e2e-deploy-vinext.sh`;
  - two `ci.yml` jobs, which overlaps S18-4, whose row owns the workflow yml.

  Because the sprint is serial, S18-2 lands first and S18-4 starts on top of it. ADR-0069 belongs
  to S18-1: the pointer from its open action item to this ADR goes in through #257, or is filed at
  sprint close. S18-2 does not edit ADR-0069.
- **Docs are user-visible.** `apps/docs/content/docs/image-optimization.mdx` gets the layout rule,
  the two profiles, the switch and its Knative scope, and the refusal-to-fix table.
  `apps/docs/content/docs/threat-model.mdx` mirrors the internal threat model. Neither carries an
  ADR, issue or PR number.
- **Not covered: outside the Bun binary, sharp's addon is loaded with no check at all.** The
  vinext/node runtime and the Next.js standalone runtimes load sharp from `node_modules` through
  sharp's own loader, with no integrity or owner check. This ADR does not change that. It is filed
  as debt.
- **Residuals that remain:**
  - uid 0, and every capability as good as root (`CAP_DAC_OVERRIDE`, `CAP_FOWNER`, `CAP_CHOWN`,
    `CAP_SETUID`, `CAP_SYS_ADMIN`, `CAP_SYS_PTRACE`, `CAP_MKNOD`, `CAP_SYS_MODULE`,
    `CAP_SYS_RAWIO`, `CAP_BPF` and others);
  - a second writable mount, and ACLs;
  - a seekable write through `/proc/self/mem`;
  - a rootless container whose host user owns the image files;
  - `LD_PRELOAD` objects, which are mapped before the shim runs. The tripwire sees them only as a
    missing pinned inode;
  - the extracted profile's app uid and base writers;
  - macOS's search paths.

  The tripwire detects; it does not prevent.

## Action items

### Before S18-2

- [ ] The prerequisite PR: `isNativePayload` accepts `.so.N.N.N` (D2's pattern), with a fixture that
      uses the real soname `libvips-cpp.so.8.18.7`, and corrects the shim's header and the threat
      model's claim that libvips is hashed. It quotes the boot cost of hashing libvips, measured
      natively.

### S18-2 implementation (one PR, serial after S18-1)

- [ ] `sharp-addon-dlopen.mjs`: D1-D8, with the header rewritten to match. It must never name the
      in-process Rust package.
- [ ] `sharp-native-extract.mjs`, three changes:
      - return `join(realpath(base), name)` (D3);
      - **sweep stale temp files.** `writeAtomic` (`:186-198`) leaves `<target>.<pid>.tmp` behind
        when a process is killed mid-extraction. The content-addressed root is reused, so D4 would
        refuse that tree forever. Before verifying or reusing, the extractor removes every entry
        matching `<a listed name>.<digits>.tmp`, and nothing else;
      - export `assertSafeBase` for the lockstep test.
- [ ] `cli/build.ts`: set `KNEXT_SHARP_SEALED_LOAD: 'off'` in the smoke child's env on **every** path
      (the twin, `reuseShipBinary`, self-contained), built by one exported helper, and nowhere else.
- [ ] **CI lanes (D12), each with what changes:**
      - `ci.yml` `compat-smoke` (`:539-575`): after "Compile the single executable" and "Stage the
        sharp native tree", stage the binary, `native/` and `.output/public` under
        `/var/lib/knext-lane/compat-smoke-<run_id>` as root, after checking its ancestry. Point
        `SERVER_CMD` and `SERVER_PATH` at the staged binary, run it as the runner user, and assert
        that `KNEXT_SHARP_SEALED_LOAD` is unset in the job.
      - `compat-vinext.yml` through `scripts/e2e-deploy-vinext.sh`, disk mode: the `native/`
        staging (`:541-564`) and the empty-dir suite staging (`:698-707`, today under `RUNNER_TEMP`)
        both go to the root-owned lane directory before the binary boots. Self-contained mode keeps
        its layout and asserts the extracted profile ran in enforce mode. The Knative deploy in the
        same script uses the image, so it changes nothing.
      - `ci.yml` `Prod image next/image optimization (strict, #66)`: the E3 legs.
      - `sharp-addon-dlopen.test.ts:392-438` (`loadShim`, `discoverShim`): load through the D11
        harness, with owners faked to 0 and the directories above the fixture faked to root 0755.
        Strip `KNEXT_SHARP_SEALED_LOAD` and `K_SERVICE` from the inherited env, so each test runs
        in enforce mode unless it says otherwise.
      - `tests/native-integrity-absence-exception.test.ts:73-91` (`loadShim`, under Node): the same
        harness, with the no-manifest rows run under both absence outcomes (D7).
        `scripts/mutation-prove-native-integrity-exception.mjs` drives that test, so it inherits
        the harness.
      - **Sweep for more.** Every other place that boots a compiled vinext binary or imports the
        real shim outside an image either moves to the lane layout or the harness, or is listed in
        the PR with a reason. Candidates to check: `apps/file-manager/self-contained-e2e.test.ts`,
        `self-contained-exec-e2e.test.ts` and `tests/e2e-empty-dir.test.ts`.
- [ ] A changeset (`@getknext/core`, minor): the behaviour change, the switch and its Knative scope,
      and the fix.
- [ ] Docs: the two pages named in Consequences, `docs/security/threat-model.md` (`/app/native`, the
      in-process Rust entry and the libvips correction), and `packages/kn-next/src/adapters/EGM.md`
      (the Images invariants, the env var under Interface, and the new export).

### Exit criteria the implementer can test

Every refusal test has a **pass twin** that loads, because a guard has to assert both halves.

**E1. Real hard-link and in-place-write tests**, in a new `sharp-addon-sealed.test.ts`. They use
the D11 harness, with real files, real modes and real links:

- **K1, a real hard link to an inode the attacker owns.** The test makes the addon a second name
  of a file this non-root uid owns (`linkSync` into a test-owned directory), and asserts
  `nlink === 2n`. Mode 0444, matching hash, owner **not** faked: **refused** as "owned by uid N".
  Twin: the same inode, with its `dev:ino` owner faked to 0, which loads.
- **K2, a real hard link inside a swapped tree.** An attacker's tree, with its own manifest and a
  real hard link to the real addon, is renamed over `native/` when the shim opens the manifest.
  It is **refused**, either at a pinned directory or at the manifest's owner. Twin: no swap, which
  loads.
- **I1, an in-place write the rule stops.** libvips is really 0664, and a real hard link to it is
  held in a test-owned directory, so the group could write the bytes in place. Owners are faked to
  0. It is **refused before any hash**, naming **libvips**, not the addon. Twin: really 0444, which
  loads.
- **I2, an in-place write that only the rule can stop.** Owners are faked to 0 and the mode is
  really 0644, so only the owner may write. The stubbed `process.dlopen` first writes through the
  held hard link: the bytes on disk really change, and the inode does not. The test asserts that
  the pins and the tripwire do **not** refuse. That pins down that the owner/mode rule is the only
  guard against an in-place write, and that root's own write is a residual. It is the pair to I1
  and I3.
- **I3, the extracted profile.** A tree written by the real `extractEmbeddedNative` loads. The same
  tree with one file made `u+w` is **refused**, and so is one whose owner is faked to another uid.

**E2. The rest of the rule.** These tests cover:

- a link at the tree root, at the addon, at libvips and at the manifest;
- a FIFO at the manifest, which must not hang (the test sets a timeout), in both modes;
- a dangling link at the manifest, which is unreadable and fatal, never absent;
- a group-writable directory above the executable;
- a sticky `/tmp` ancestor in the staged profile, which is refused with the full mode printed;
- a sticky ancestor above the extraction base whose next entry this uid owns, which passes;
- `KNEXT_SHARP_ADDON` through a link;
- a tree swapped in and left, and one swapped in and put back;
- two pinned inodes that differ only above 2^53;
- an unlisted `libstdc++.so.6` planted in libvips' `lib/`;
- an `LD_LIBRARY_PATH` entry owned by the test user;
- an rpath entry that does not exist under a writable directory;
- the tripwire fed a maps file that maps another libvips, which **exits** with code 78 even through
  `lazySharp`;
- the switch:
  - `off` with `K_SERVICE` unset loads a refused tree with **one** warning, and still refuses a
    hash mismatch and a FIFO manifest;
  - `off` with `K_SERVICE=svc` is fatal, and the refusal never mentions the switch;
  - `enabled` throws before any open;
  - unset enforces;
- the smoke env helper sets the switch on the twin, reuse and self-contained paths;
- a stale `<libvips>.12345.tmp` in an extracted tree is swept, and the tree loads.

**E3. A real-root leg**, in `ci.yml`'s `Prod image next/image optimization (strict, #66)` job.
That job builds an image and runs it, so it needs no Bun CLI and no `patchelf`, and runs as the
image's own user:

- the `apps/file-manager` image boots as uid 65532 with the rule in force (no switch, and the job
  asserts that) and returns an optimised `/_next/image`;
- inside the running container as 65532, these must each fail, with the errno printed:
  - `sh -c 'printf x >> <libvips>'`;
  - `ln <libvips> /app/native/x`;
  - `ln <libvips> /tmp/held`, which `fs.protected_hardlinks=1` refuses. That is Ubuntu's default,
    and a container inherits it from the host kernel, so the leg prints the sysctl;
- a derived image (`FROM` the built one, `USER root`, `RUN chown -R 65532:65532 /app/native`,
  `USER 65532`) is **refused at boot**, and the message names the path.

**E4. Lockstep.** `tests/native-sealed-parity.test.ts` (D10) is green, and so is
`sharp-extract-base-lockstep.test.ts`. The latter runs the exported `assertSafeBase` and the shim's
restated base rule over the same table and requires the same verdict on each row. The table is
owner ∈ {0, self, other} × mode ∈ {0700, 0750, 0755, 0770, 0775, 0777, 1777}. The ffi-dispatch
boundary test stays green.

**E5. A prover**, `scripts/mutation-prove-s18-2-sharp-sealed-load.mjs`, removes one guard per row
and requires a named test to go red:

- it branches on exit codes and never greps output;
- each anchor must match exactly once, or the prover aborts;
- it runs after the green commit;
- a row whose mutation did not apply is a failure, never a pass.

| Group | Row | Guard removed |
|---|---|---|
| Files | L01 | The manifest is not judged |
| | L02 | The addon is not judged |
| | L03 | libvips is not judged (only the dlopened file) |
| | L04 | A payload is opened following links |
| | L05 | The manifest is opened following links |
| | L06 | `O_NOFOLLOW` and `O_NONBLOCK` are only checked to be numbers |
| | F01 | `O_NONBLOCK` is dropped (a FIFO hangs) |
| | F02 | A non-regular file is read |
| | H01 | The hash reads by path, not through the judged descriptor |
| | Y01 | The payload pattern reverts to `\.so\.[0-9]+$` (libvips is no longer judged) |
| Classification | A01 | `ELOOP` at the manifest is classified as absent |
| | A02 | `findManifest` goes back to `existsSync`, so a dangling link reads as absent |
| Directories | W01 | No ancestor above the tree root's parent is walked |
| | W02 | The walk stops one short of `/` |
| | W03 | The ancestors are not judged |
| | W04 | A sticky world-writable ancestor is let through, in the staged profile |
| | W05 | `stat` instead of `lstat` |
| | W06 | libvips' branch is not walked |
| | R01 | The real-path comparison is removed |
| Pins | P01 | No check again after the hash |
| | P02 | No check again after the `dlopen` |
| | P03 | A file's path is not checked again |
| | P04 | Pins are compared as numbers |
| Search closure | S01 | An unlisted file in the addon's `lib/` is accepted |
| | S02 | The same in libvips' `lib/` |
| | S03 | An rpath entry outside the tree is not judged |
| | S04 | `LD_LIBRARY_PATH` is not judged |
| | S05 | An unknown `$` token in an rpath entry is expanded as text instead of refused |
| Tripwire | T01 | It is skipped |
| | T02 | It compares paths, not `dev:ino` |
| | T03 | A new mapping outside the judged directories is accepted |
| | T04 | A refusal after the `dlopen` throws instead of exiting |
| Profiles | X01 | The extracted profile accepts another non-root uid |
| | X02 | The extracted profile accepts an owner write bit |
| | X03 | The staged profile accepts this uid |
| | X04 | Above the base, a sticky ancestor whose next entry another uid owns is accepted |
| | X05 | The shim's base rule drifts from the extractor's |
| | Z01 | The extractor no longer sweeps stale temp files |
| Switch | O01 | An unrecognised value reads as off |
| | O02 | It reads as on |
| | O03 | `off` prints no warning |
| | O04 | `off` also skips the hash |
| | O05 | `off` is honoured inside Knative |
| | O06 | The switch is mentioned in a refusal inside Knative |
| | B01 | The smoke env omits the switch on the reuse path |
| | B02 | The same on the self-contained path |
| Messages | M01 | The refusal does not name the path |
| | C01 | A control character in a path is printed raw |

**E6. A scanning test.** It covers templates, generator templates, every Dockerfile, the operator's
source, the docs content, `.github/workflows/` and `scripts/`. It finds `KNEXT_SHARP_SEALED_LOAD`
set to an off value **nowhere** except `cli/build.ts`'s smoke helper. Mutation: plant it in
`packages/kn-next/templates/app/Dockerfile.hbs` and in the `compat-smoke` job; each must go red.

**E7. The no-manifest rows run under both absence outcomes** (D7). Neither order of the 2026-12-01
decision turns them red.

**E8. The OKE standing stage.** Deploy the template vinext app that uses `next/image`. The revision
must become Ready, and `/_next/image` must return an optimised image. The bookkeeping costs about
0.7 ms (M9, M10), so no cold-start A/B is needed. The implementer quotes a local before/after of
the first sharp import on top of the prerequisite.

### Debt this ADR records (for the sprint-close review)

- **Tighten the extracted directories** to 0500 after extraction, so that not even a write
  primitive running as their owner can create an entry. The extractor would make them writable
  again to re-extract (P3).
- **Anchor the extracted tree's digests in the binary.** They should come from the binary's
  embedded manifest, passed by the facade, instead of from the extracted copy. That touches
  `vinext-compile.mjs`, which S18-3 owns (P3).
- **Check sharp outside the Bun binary.** The vinext/node and Next.js standalone runtimes load
  sharp's addon with no integrity or owner check (P3).
- **Add a builder matrix.** No CI leg builds the template under a builder other than BuildKit
  (kaniko, buildah), where `--chmod` support decides whether a group-writable context passes (P3).
- **Read the search closure on macOS.** A Mach-O reader for `LC_RPATH` and `@loader_path`, and a
  `dyld` image list in place of `/proc/self/maps` (P3).

## Appendix: repeating M1 to M11

For each libc, use the pinned Bun image (`oven/bun:1.4.2-alpine` for musl, and `oven/bun:1.4.2`
for glibc, with `--platform linux/amd64`):

1. `bun add --no-save @img/sharp-<platform>@0.35.5 @img/sharp-libvips-<platform>@1.3.4`.
2. Copy both packages with `cp -RL` into `/app/native/`.
3. Read each payload's `PT_DYNAMIC` for M1 and M2 (any ELF reader).
4. Then, from a Bun script:
   - `process.dlopen` the addon by `/proc/self/fd/<n>` (M3);
   - preload libvips by descriptor with `bun:ffi` `dlopen`, then retry M3 (M4);
   - load the addon by path (M6), and compare `/proc/self/maps` with `lstat` (M7).
5. For M5, run `patchelf --set-rpath /app/native/sharp-libvips-linuxmusl-x64/lib` on a copy of the
   addon, and retry M3.
6. Time D1-D4's calls and two maps reads over 200 iterations (M9, M10).
7. Time hashing each payload through an `O_NOFOLLOW` descriptor (M11).
