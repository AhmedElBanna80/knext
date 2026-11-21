# ADR-0074: A sealed load for sharp's native addon (one rule for `native/`, two texts)

- **Status:** **Proposed (2026-11-21), revised after review rounds 1 and 2.** Design only. This
  change adds no code, test, env var or docs page.
  - **It stays Proposed until both tripwire measurements in D5 are done.** One runs on a
    kind / GitHub-runner kernel, and the S18-2 implementer does it. The other runs on the OKE 5.15
    and EKS 6.1 node kernels, and only the founder can do it.
  - After both, the sprint-close review accepts the ADR or files debt.
- **Task:** v2 Sprint 18, S18-2 (from debt TD-S18-1a).
- **Prerequisite:** **#259** (open), which makes the shim hash libvips. Its spec
  `sharp-native-payload.test.ts` runs the real shim against a tree whose libvips is named with the
  multi-part soname `libvips-cpp.so.8.18.6`. S18-2 starts after #259 merges.
- **Closes, when implemented:** the open action item of ADR-0069 Amendment 1 (on `integration/v2`,
  `0069:963`), "The sharp shim: the descriptor pin and the owner and mode rule (open debt)". It
  also closes that amendment's "One tree, two rules" consequence (`0069:951`).
- **Relates to:**
  - ADR-0069 D13, D18 and Amendment 1 (the in-process Rust loader);
  - ADR-0048 Amendments 2 and 3 (the sharp `process.dlopen` shim, `native/` and its integrity
    manifest);
  - ADR-0060 (the self-contained executable, and invariant I2, execPath anchoring);
  - ADR-0006 (image optimisation through sharp);
  - ADR-0036 (vinext is an opt-in, compat-gated build target).

  Related work: #257 (open) changes the in-process Rust loader's rule. Nothing here depends on it,
  and every rule is stated in full below.
- **Trigger class:** a new ADR (Proposed, design-only), and a security invariant
  (`.claude/rules/security.md`). The implementation is also a `src/cli/` trigger, because it
  changes the build smoke (D7).

## Context

### What loads, and how, today

`packages/kn-next/src/adapters/sharp-addon-dlopen.mjs` replaces `sharp/dist/sharp.mjs` inside a
`bun build --compile` binary. `vinext-compile.mjs:956-1000` (`sharpAddonDlopen`) injects the shim's
source text verbatim into sharp's module slot. So the shim must stay self-contained over node
builtins: it may have no relative imports, and the compile refuses one.

It runs **only under Bun**: inside compiled binaries, and in Bun tests. Every test that runs the
real shim imports `bun:test` and spawns `process.execPath`, which is Bun. That includes
`tests/native-integrity-absence-exception.test.ts`. The shim:

1. **Picks the addon** (`addonPath()`, `:78-138`), in this order:
   1. `KNEXT_SHARP_ADDON`, if it is not empty (`:84-85`);
   2. **if nothing was extracted**, a flat `sharp.node` beside `process.execPath`, if it exists
      (`:96-97`);
   3. otherwise the "native root": the extracted tree
      (`globalThis[Symbol.for('knext.sharp.nativeRoot')]`) if one was set, else `native/` beside the
      executable. From it, the shim takes the addon for this runtime's platform (`:104-121`). If
      addons are staged and none matches, it refuses (`:123-136`).
   4. Else, the flat path, whether or not it exists (`:137`).
2. **Finds the manifest.** `findManifest` (`:195-205`) looks for `.integrity.json` in the addon's
   directory and at most three parents, using `existsSync`, which follows links. It reads the file
   by path and requires the addon to be listed (`:338`).
3. **Hashes the payloads by path** (`readFileSync`). It hashes every listed file that
   `isNativePayload` accepts (`:207-210`, used at `:349`). Today that regex is
   `/\.(node|dylib|so)$|\.so\.[0-9]+$/`. It does **not** accept a multi-part soname such as
   `libvips-cpp.so.8.18.6`, so **libvips is not hashed today**. The test fixtures name it
   `libvips-cpp.so.42`, which the regex does accept. The prerequisite, #259, fixes the regex.
4. **Loads by path:** `process.dlopen(container, path)` (`:381`).

It never checks an owner or a mode. It never opens a file without following links, and it pins no
`dev:ino`. Between the hash in step 3 and the loader's own `open()` in step 4, anyone who can write
the tree can change what gets mapped. They can rename a file over the path, rename the tree, write
in place, or reach the inode through a hard link.

**When it runs:**

- **Staged mode** (the shipped image): **at boot, before the server listens.** The entry imports
  `sharp` statically (`vinext-build.ts:695-700`), so a refusal crashes the process before it
  listens. #259 measured the cost that hashing libvips adds to that path; D6 has the numbers.
- **Self-contained mode:** on the **first image request**. `lazySharp`
  (`sharp-native-extract.mjs:293-318`) defers the load, **catches** a throw and caches it. The image
  optimizer then **fails open**: on any error from `sharp(...)` it returns the original bytes
  (`vinext-image-optimizer.ts:175-176`), and it logs nothing.

### What the in-process Rust loader does on `integration/v2`

ADR-0069 Amendment 1, as merged (`0069:874-964`), judges the Rust library on the descriptor it
opened. It requires root ownership and no group or other write on three things: the library, each
directory from its parent up to `native/`, and the directory `native/` sits in.

The generated loader (`packages/ffi/src/render.ts`) does each of these:

- it checks the manifest with `existsSync` (`:804`) and reads it by path (`:811`), so it follows a
  link, blocks on a FIFO, and never judges the manifest;
- it opens the library with `openSync(path, 'r')` (`:826`), which follows a link and has no
  `O_NONBLOCK`;
- it `fstat`s the library without checking for a regular file;
- it `stat`s the directories, which also follows links;
- it stops the walk at the directory that holds `native/`;
- it pins nothing and asserts no real path;
- it then `dlopen`s `/proc/self/fd/<n>`.

Those are the differences D11 tests for.

### Why the port is not mechanical (TD-S18-1a), measured

These rows were measured by hand on 2026-11-21 with a throwaway probe. The host was Docker 29.8.2
on an arm64 Mac, running amd64 images under emulation: `oven/bun:1.4.2-alpine` (musl) and
`oven/bun:1.4.2` (Debian, glibc 2.41). The packages were **sharp 0.35.5 and `@img/sharp-libvips`
1.3.4**, the versions `bun.lock` pins; libvips 1.3.4 ships `libvips-cpp.so.8.18.7`. A first run
on 0.35.4 / 1.3.3 (`libvips-cpp.so.8.18.6`) gave the same results.

The rows are evidence for rejecting option (a). They are not knext behaviour, so no CI job re-runs
them. The appendix says how to repeat them.

| # | Measurement | musl | glibc |
|---|---|---|---|
| M1 | The addon's dynamic section | `DT_RPATH`, no `RUNPATH`. Five `$ORIGIN` entries, numbered 1 to 5 from here on: `../../sharp-libvips-<plat>/lib`, `../../../sharp-libvips-<plat>/1.3.4/lib`, `../../node_modules/@img/sharp-libvips-<plat>/lib`, `../../../node_modules/@img/…/lib`, `../../../../../@img-sharp-libvips-<plat>-npm-1.3.4-<hash>/node_modules/@img/…/lib`. `NEEDED`: `libvips-cpp.so.8.18.7`, `libstdc++.so.6`, `libgcc_s.so.1`, libc. | The same five entries. `NEEDED` adds `libm`, `libpthread` and `ld-linux`. |
| M2 | libvips' dynamic section | `RUNPATH $ORIGIN/`. `NEEDED`: libstdc++, libgcc_s, libc. | The same `RUNPATH`. `NEEDED` adds `libresolv`, `libdl`, `libm` and `libpthread`. |
| M3 | `process.dlopen('/proc/self/fd/<n>')` of the addon | **Fails**: `Error loading shared library libvips-cpp.so.8.18.7: No such file or directory (needed by /proc/self/fd/7)` | **Fails**: `cannot open shared object file` |
| M4 | libvips preloaded through its descriptor with `bun:ffi`, then the addon through its descriptor | **Still fails**, with the same error | **Loads** |
| M5 | `patchelf --set-rpath` to an absolute `/app/native/…/lib`, then the addon through its descriptor | Loads, but libvips is still opened by path | Not measured |
| M6 | The addon by path | Loads | Loads |
| M7 | `/proc/self/maps` after a by-path load | The addon and libvips appear with the `dev` (`00:59`, which is 89) and inode that `lstat` reports. **This was a Docker overlay2 mount on OrbStack's kernel; containerd's overlayfs on other kernels is not measured.** | The same |
| M8 | The Bun executable's own `NEEDED` | `libstdc++.so.6`, libc | Not measured |
| M9 | D1-D4's bookkeeping per load | **0.57-0.67 ms** (n = 200, three runs) | — |
| M10 | Two `/proc/self/maps` reads (D5) | 0.04-0.05 ms | — |

M9 counts the following work:

- one `realpath`;
- three descriptor opens with `fstat`: the manifest, the addon and libvips;
- the seven directories of both branches, `lstat`-ed three times;
- the `lstat` of every ancestor of the nearest existing directory, for each of D4's nine search
  entries;
- two `readdir`s.

How long hashing libvips takes is #259's measurement (D6), not a row here.

**How the dynamic loaders search.** This is read from their source, not measured.

- **glibc** first checks a `NEEDED` name against the libraries already loaded, by name or by
  `DT_SONAME`. Then it searches, in order:
  1. the requesting object's `DT_RPATH`, but only if it has no `DT_RUNPATH`, and then the
     `DT_RPATH` of each object that loaded it;
  2. `LD_LIBRARY_PATH`;
  3. the requesting object's own `DT_RUNPATH`;
  4. `ld.so.cache`;
  5. the default directories, including the multiarch pair (`/lib/<triple>`, `/usr/lib/<triple>`).

  So for the addon's own dependencies its `DT_RPATH` comes first. For libvips' dependencies,
  `LD_LIBRARY_PATH` comes before libvips' `RUNPATH`.
- **musl** first checks a `NEEDED` name against the libraries already loaded. It matches by the
  name each was loaded under, and also by inode once a path search has found a file. Then it
  searches, in order:
  1. `LD_LIBRARY_PATH`;
  2. the rpath of the requesting object, then that of each object that needed it, treating
     `RPATH` and `RUNPATH` alike;
  3. `/etc/ld-musl-<arch>.path`, or else `/lib:/usr/local/lib:/usr/lib`.
- On both, the search stops at the first file it finds. That also explains M4, though the
  explanation is inferred: a library loaded under the name `/proc/self/fd/<n>` never matches
  `libvips-cpp.so.8.18.7`.

**What follows from the measurements:**

- **Loading through a descriptor cannot work on the shipped platform.** The image is
  `alpine:3.22` (`packages/kn-next/templates/app/Dockerfile.hbs:28`). The relative rpath (M1, M3)
  breaks every musl variant except patching the binary (M4, M5).
- **Against a non-root actor, a descriptor-named load buys nothing over the ancestor rule.**
  Renaming or replacing part of a path needs write permission on the parent directory. If every
  directory from the tree up to `/` belongs to root and is closed to group and other, nobody but
  root can redirect a lookup. Against root nothing a lookup does helps, because root can write in
  place.
- **How this ADR reads the sprint row's "fd pin".** Every judged file is opened once without
  following links, and is judged and hashed through that one descriptor. Its inode is pinned and
  checked again after the `dlopen`. That is the meaning used here. It does **not** mean "dlopen the
  descriptor", which M3 and M4 show cannot load sharp on musl. The sprint-close review accepts or
  rejects that reading.

### Who boots the shim today, and from what tree (the blast radius)

The last column says what happens under a root-only rule, if nothing else changes.

| Where | Tree, owner and mode | Root-only rule |
|---|---|---|
| Template vinext image (`packages/kn-next/templates/app/Dockerfile.hbs`) | `COPY --chown=0:0 --chmod=a-w native /app/native` (`:89`), `WORKDIR /app` (`:46`), `USER 65532:65532` (`:100`). Under BuildKit, `/app` and `native/` are root-owned 0755, the directories below are 0555, and the files are 0444 (ADR-0069 Amendment 1 item 6). | Passes |
| `apps/file-manager/Dockerfile` | `COPY --from=builder /repo/native /app/native` (`:174`), with no `--chown` or `--chmod`. The builder runs as root and used `cp -RL`. | Expected to pass; not measured (E3) |
| `knext build`'s post-compile smoke (`cli/build.ts:177-247`) | The app's own directory, on three paths: the host-arch twin, with `KNEXT_SHARP_ADDON` pointing into `.knext-smoke-native/` (`:244-246`); the **reuse** path, where the ship binary boots its own `native/` (`vinext-build.ts:361-376`); and the self-contained path | Refused on every path |
| CI `compat-smoke` (`ci.yml:539-575`), a **glibc** binary on `ubuntu-latest` | `native/` copied with `cp -RL` into `apps/file-manager/` in the runner's workspace | Refused |
| `compat-vinext.yml` through `scripts/e2e-deploy-vinext.sh`. The script has no Knative deploy. | `native/` is staged into `APP_DIR` (`:541-564`). **Disk mode** boots `${KNEXT_EXEC}` from `APP_DIR` (`:724-732`). **`KNEXT_SELF_CONTAINED=1`** serves the suite from a fresh directory under `RUNNER_TEMP` (`:698-722`). | Disk mode refused; self-contained mode uses the extracted profile |
| `apps/file-manager/self-contained-exec-e2e.test.ts` | `KNEXT_NATIVE_TMPDIR` is set to a fresh, real-path temp directory the test owns | Extracted profile |
| Tests that run the real shim: `sharp-addon-dlopen.test.ts:392-438`, `tests/native-integrity-absence-exception.test.ts:73-91`, and #259's `sharp-native-payload.test.ts` | Temp directories owned by the test user, under a sticky `/tmp`. They stub `process.dlopen` and write non-ELF payload bytes (`"ADDON BYTES"`). | Refused |
| Self-contained mode (opt-in) | Extracted by the app's uid under `KNEXT_NATIVE_TMPDIR` or `TMPDIR`, with directories 0700 and files 0500 | Refused, always |
| A compiled binary run by hand. `darwin-arm64` and `darwin-x64` are shippable arches (`vinext-build.ts:100-115`). | Usually under the user's home directory | Refused |

### The manifest-absence exemption runs out on 2026-12-01

`scripts/lib/native-integrity-policy.mjs:45` dates the exemption that lets an absent manifest warn
and load: it expires on 2026-12-01. On that day its clock turns CI red, and the next step is the
founder's call. This ADR proposes nothing about the exemption. It designs the no-manifest branch so
that it is right in either order (D8).

## Decision

The shim gets a sealed load: **option (b)** below. It still opens files by path, and every step is
sealed:

- **Files:** each file is opened with `O_NOFOLLOW|O_NONBLOCK`, must be a regular file, and is
  judged and hashed through that one descriptor.
- **Pins:** `dev:ino` pins are taken before the manifest is read and checked again after the hash
  and after the `dlopen`.
- **Walk:** every directory up to `/` is judged.
- **Profiles:** there are two, chosen by where the tree came from.
- **Search path:** the dynamic loader's whole search path is judged.
- **Tripwire:** a `/proc/self/maps` check runs after the `dlopen`, and its refusal ends the
  process.

The load stays **eager at boot** in staged mode. The rule is on by default, with one parsed off
switch that reports instead of refusing, and that switch is honoured only outside Knative.

Each decision below was scored with `jev.py pick`. Each row gives one score set and says which run
produced it.

| Decision | Chosen | Score | The others | Run |
|---|---|---|---|---|
| Design | (b), a sealed load by path | **1.00** | a1 0.00, a2 0.00, c 0.00, d 0.00 | this ADR, round 1 |
| Default and switch | On by default, one parsed off switch | **0.90** | no opt-out 0.05, default off 0.05, report-only with a dated flip 0.00 | this ADR, round 1 |
| Switch scope | Honoured only when `K_SERVICE` is unset | **1.00** | unscoped 0.00, dated 0.00, reported 0.00 | this ADR, round 2, with the wording in its table. The review round's own run, worded its own way, also chose scoped (0.69). |
| Where the source lives | Inside the shim | **0.97** | a concatenated core fragment 0.03, a byte-identical fragment 0.00, the fragment in the Rust package 0.00 | this ADR, round 1 |
| Lockstep with the Rust loader | One repo-root parity test | **0.99** | per-package vector suites 0.01, a core test that imports the renderer 0.00, a text compare 0.00 | this ADR, round 2 |
| Self-contained tree | A second profile, owned by the process's uid | **1.00** | refuse it 0.00, exempt it 0.00, extract as root at build 0.00 | this ADR, round 1 |
| D4 invariant | Judge the search closure | **0.98** | every `NEEDED` name listed or already mapped 0.02, the tree's own directories only 0.00 | this ADR, round 2 |
| D5: the tripwire | Keep the `dev:ino` exit, and gate acceptance on a measurement on containerd overlayfs | **0.97** | warn only 0.02, path and size 0.01, drop it 0.00 | the review round's run |
| D5: a refusal after the `dlopen` | `writeSync` to stderr, then `process.exit(78)` | **0.76** | a poison flag 0.14, fail only image requests 0.06, throw 0.04 | this ADR, round 3 |
| D6: staged load timing | Eager at boot | **0.47** | eager-async 0.40, lazy-staged 0.13 | the review round's run |
| D13: CI lanes | A fresh root-owned lane directory | **0.99** | run in a container 0.01, the fake-root harness 0.00, report mode 0.00 | this ADR, round 3 |

### D1. Two profiles, chosen by where the tree came from, never by a setting

All stat values are read with `{ bigint: true }` and compared as bigints, for example
`st.uid === 0n` and `(st.mode & 0o022n) === 0n`.

**Which profile, and what the "tree root" is**, following Context step 1's order:

| What `addonPath` chose | Profile | Tree root |
|---|---|---|
| `KNEXT_SHARP_ADDON` | staged | The directory that holds the manifest `findManifest` found. With no manifest, the parent of the addon's package directory. |
| A flat `sharp.node` beside the executable, when nothing was extracted | staged | **The executable's directory.** There is no directory inside the tree. libvips can then be found only through the search in D4, which judges it. |
| `native/` beside the executable | staged | That `native/` |
| The extracted tree (`knext.sharp.nativeRoot` set, `KNEXT_SHARP_ADDON` unset) | extracted | The extraction root. A flat `sharp.node` is never consulted then. |

**Staged** is the default.

- **Files.** The manifest and every native payload (D2) must satisfy
  `st.uid === 0n && (st.mode & 0o022n) === 0n`, judged on the descriptor each was opened as. The
  process's own uid is never read and never exempt. That user can `chmod` what it owns, so a tree
  it owns protects nothing against a file-write bug.
- **Directories.** Each of these must be a real directory by `lstat`, owned by uid 0, and closed
  to group and other:
  - every directory from each payload's directory up to the tree root, on **both** the addon's
    branch and libvips' branch;
  - the tree root itself;
  - the directory that holds the tree root;
  - every directory above that, up to `/`.

  The mode bits are the whole test, so a sticky `/tmp` is refused too. That is the conservative
  reading, the same one OpenSSH `StrictModes` takes.
- **Why every ancestor is enough against non-root.** Renaming or replacing a directory needs write
  permission on its parent. With every directory on the path owned by root and closed, no user but
  root can swap any part of it. So by-path lookups are sound without a directory descriptor. That
  matters because Bun's `fs` has no `openat`, and macOS has no descriptor-relative path.
- **Not read:** ACLs (only mode bits are judged), and `access()`, which answers yes to root for
  everything.

**Extracted** applies to opt-in self-contained mode. The process wrote this tree itself, so its
owner cannot be root.

- **Files.** Each file must be owned by `process.getuid()`, with no write bit for anyone:
  `(st.mode & 0o222n) === 0n`. The extractor writes 0500. A platform without `getuid` is refused.
- **Directories inside the tree.** Each must be a real directory, owned by this uid, with
  `(st.mode & 0o022n) === 0n`. The extractor makes them 0700.
- **The base**, which is the extraction root's parent, must pass the extractor's own base rule.
  The shim restates that rule, and `sharp-extract-base-lockstep.test.ts` (E4) holds the two copies
  in step. The rule, exactly as `assertSafeBase` has it (`sharp-native-extract.mjs:142-183`; it is
  private to that module, so the implementation exports it for the test):
  - it tests only the world-write bit, `0o002`;
  - a world-writable base that is not sticky passes only if root owns it, which is the operator's
    default `/tmp` `emptyDir`;
  - a base that is not world-writable must be owned by this uid or by root;
  - **group write is not tested at all.**
- **Every directory above the base, up to `/`.** Each must be owned by root or by this uid, and
  closed to group and other. There is one exception: a **sticky** directory passes when the next
  entry on the path **already exists** and is owned by root or by this uid. A sticky directory
  stops other users from renaming or removing an entry they do not own. **It does not stop them
  from creating a new one,** so the exception is void for an entry that does not exist yet (see D4).
  The exception keeps `KNEXT_NATIVE_TMPDIR=/tmp/<private dir>` working: that private directory
  exists, and this uid owns it.

**What the extracted profile does not stop:**

- **The app's own uid.** It owns the tree, so it can `chmod` and write it.
- **Every writer of the base**, wherever the base is not sticky. With the operator's default (a
  root-owned 0777 `emptyDir` with no sticky bit) that means every uid in the container, and every
  container in the pod that mounts the volume. With a group-writable base it means the base's
  group. Any of them can rename the extraction root away and put another in its place between the
  checks. The pins (D3) see a tree that is swapped in and left there. A tree that is put back is
  seen only by the tripwire (D5), and only after its constructors have run.
- **Rpath entries 2 and 4** (D4), which resolve under the base, where any base writer can create
  them.

What the extracted profile does deny: a pure file-write primitive (the files have no write bit),
another uid's tree, and a base or ancestor that drifts. **The strong guarantee needs the staged
layout.**

### D2. Files

The files are the manifest and every native payload. A native payload is a listed file whose name
matches `/\.(node|dylib)$|\.so(\.\d+)*$/`, which is #259's pattern.

**Each file is handled in four steps:**

1. **Opened** with `O_RDONLY|O_NOFOLLOW|O_NONBLOCK`. A platform where either flag is not a positive
   number is refused. An absent flag ORs in as 0, and the open would then follow a link or block
   with no sign.
2. **`fstat`-ed** with `{ bigint: true }`, and required to be `S_IFREG`.
3. **Judged** on that descriptor, by the profile's rule.
4. **Read through that descriptor, never by path.** That covers parsing (the manifest as JSON, and
   each payload's header and dynamic section for D4) and hashing.

**Each payload's format is checked by its first bytes.**

| Platform | Accepted | Refused |
|---|---|---|
| Linux | An ELF64 little-endian object, parsed for D4 | Anything else, by name: a Mach-O object (`0xfeedfacf`, `0xcffaedfe`, or the fat `0xcafebabe`) is "a macOS binary in a tree staged for another platform", the same refusal as a wrong-platform tree (`:123-136`) |
| macOS | Mach-O | An ELF object, the same way |

The format check is **fatal in both modes**: a foreign object cannot load anyway, and a named
refusal is easier to diagnose than `Exec format error`. Real-shim tests therefore use synthetic
ELF64 fixtures (D12).

**How an open failure is classified, in both modes.**

| Result | Classified as |
|---|---|
| `ENOENT` | absent |
| `ELOOP` (a symbolic link) | **unreadable**, never absent |
| A FIFO, a device or a directory | **unreadable**, never absent |
| Any other error | **unreadable**, never absent |

An unreadable manifest or payload is fatal (D7). `findManifest` uses `lstat` instead of
`existsSync`, so a dangling link at `.integrity.json` is "present and unreadable". It can never
downgrade the load to the absence branch.

Each descriptor stays open until the checks after the `dlopen` (D5) have run, and is then closed.

### D3. Directories, pins and the real path

- **Judged before anything is opened.** Every directory D1 names is `lstat`-ed as a bigint stat and
  must be `S_IFDIR`; a link is refused and never followed. It is then judged by the profile's rule.
  All of this happens **before** the manifest is opened, and one refusal lists **every** failing
  directory.
- **Pinned and checked twice.** Each directory's `dev:ino` is pinned as a bigint, so two inodes that
  differ only above 2^53 count as two directories. The pins are checked again after the last
  payload is hashed, and again **after `process.dlopen` returns**. After the hash, each judged
  file's path must also still `lstat` to the inode that was read. Any change is a refusal.
- **The tree root must be its own real path.** It is compared with `realpathSync`, and a difference
  is refused:
  - **The default root:** Bun reports `process.execPath` already resolved, so this is a fail-closed
    assertion.
  - **`KNEXT_SHARP_ADDON` through a link:** refused, with "point it at the real path". A link
    outside the judged path could aim the load at any complete tree that root wrote.
  - **The extracted root:** `sharp-native-extract.mjs` returns `join(realpath(base), name)` instead
    of `join(base, name)`. A macOS `TMPDIR` under `/var -> /private/var` then passes.

### D4. The dynamic loader's search path is judged

**The invariant.** Before the `dlopen`, the shim judges every directory a search for any `NEEDED`
name of the addon or of libvips can reach. Each one must do one of two things:

- **exist** and pass the rule that applies to it below, together with every directory above it; or
- **not exist**, with its nearest existing ancestor passing that rule **with no sticky exception**,
  because a sticky directory does not stop anyone from creating the missing entry.

The directories of that set that lie inside the tree may hold only listed regular files, and
directories that lead to listed files. **With that, no actor the profile stops can change which
file any search finds.**

**The set, and the rule each part meets:**

- **`LD_LIBRARY_PATH`, every entry, in both profiles: the staged rule.** Root-owned and closed, with
  no sticky exception. On musl this list is searched first, even before the addon's rpath, so an
  entry under a sticky `/tmp`, whether it exists yet or not, would let anyone plant a libvips.
  **It is refused.**
- **The rpath entries.** These are the addon's `DT_RPATH`/`DT_RUNPATH` entries and libvips', with
  `$ORIGIN` expanded to the real directory of the object that names it:
  - **Staged:** the staged rule. In the template image entries 2 and 4 fall under `/app`, entry 5
    under `/`, and entries 1 and 3 inside the tree. All five pass.
  - **Extracted:** this depends on where each entry resolves. Here `<root>` is
    `<base>/knext-native-<uid>-<hash>`.
    - **Entries 1 and 3, inside the tree:** the extracted rule for directories inside the tree.
    - **Entries 2 and 4, under the base:** the base rule. Their creators are the base's writers,
      who are already in D1's residual.
    - **Entry 5, above the base:** it resolves under **the base's grandparent**
      (`$ORIGIN/../../../../..`). It is judged by the rule for directories above the base, without
      the sticky exception.
      - With base `/tmp` or `/tmp/<private>`, entry 5 is under `/` and passes.
      - With a **deep** base such as `KNEXT_NATIVE_TMPDIR=/tmp/a/b`, entry 5 is under `/tmp`, where
        anyone can create it. **That is refused**, and the message says to use a base whose
        grandparent is closed.
- **The libc's default directories: the staged rule.**
  - **musl:** the entries of `/etc/ld-musl-<arch>.path`, which is judged as a file, or else `/lib`,
    `/usr/local/lib` and `/usr/lib`.
  - **glibc:** `/etc/ld.so.cache`, judged as a file, plus `/lib`, `/usr/lib` and the multiarch pair
    `/lib/<triple>` and `/usr/lib/<triple>`, where `<triple>` is `x86_64-linux-gnu` or
    `aarch64-linux-gnu`. glibc is **enforced**: the `compat-smoke` lane runs a glibc binary (D13).
    The directories that `ld.so.cache` and `/etc/ld.so.conf.d/*` name beyond these are not
    enumerated. That is a stated residual: a root-owned configuration that names a writable
    directory.

**System links.** Inside the tree, and on the path to the tree root, a link is always refused.
**In the search set only**, a symbolic link at an entry or at one of its ancestors is accepted on
two conditions:

- the link itself (`lstat`) is owned by uid 0, and
- its parent directory passes the staged rule, so only root could have made it or can change it.

It is then resolved once with `realpathSync`, and the target and the target's ancestors are judged.
This is what `/lib -> usr/lib` on `ubuntu-latest` needs. A link that is not owned by root, or that
sits in a directory someone else can write, is refused.

**Where the entries come from.** They come from the bytes already read through each payload's
descriptor. A small ELF64 little-endian reader takes `PT_DYNAMIC`, and from it `DT_STRTAB`,
`DT_NEEDED`, `DT_RPATH` and `DT_RUNPATH`. It refuses three things:

- a dynamic section it cannot parse;
- an rpath token other than `$ORIGIN` or `${ORIGIN}`, such as `$LIB` or `$PLATFORM`;
- on macOS, any attempt to read the closure. There is no Mach-O reader, which is a residual (D5).

**What the closure protects today.** Searching matters for libvips, which is always found in entry
1, inside the tree, and pinned. Searching does not matter for the C++ runtime or libc, which the
Bun executable has already loaded on musl (M8), so no search happens for them. The closure keeps
that true if `LD_LIBRARY_PATH` is set, or if a later sharp needs a library it does not need today.
Its cost is part of M9.

### D5. After the `dlopen` (Linux): the mapped-inode tripwire, and a refusal ends the process

**The check.** The shim reads `/proc/self/maps` just before and just after `process.dlopen`. Each
line has the form `start-end perms offset major:minor inode pathname`. A line's device is
`dev = (minor & 0xffn) | (major << 8n) | ((minor & ~0xffn) << 12n)`, from its hex `major:minor`,
which is how the kernel's `new_encode_dev` builds the `st_dev` that `fstat` reports.

The load passes only if all three hold:

1. **Each pinned payload P** (the addon, libvips) has at least one mapping whose `pathname` equals
   P's real path, and whose `(dev, inode)` equals the `(st_dev, st_ino)` of **the descriptor P was
   hashed through**.
2. No mapping whose `pathname` equals P's path has any other `(dev, inode)`. A ` (deleted)` suffix
   counts as no match.
3. Every line that is new after the call is either a pinned payload, matched as in 1, or a file in
   a directory D4 judged.

There is **no fallback** to comparing path and size.

**The overlayfs risk, and why acceptance waits on measurements.** On overlayfs, `fstat` on the
descriptor reports the overlay's `st_dev`. The inode `/proc/<pid>/maps` reports for an overlayfs
mapping changed during Linux's 6.x series: it used to be the backing layer's inode and became the
user-visible overlay inode. M7 matched on OrbStack's kernel. The version of that change is not
pinned here, and this design does not rely on it.

If a node kernel reports the backing layer's `dev:ino`, rule 1 refuses **every** load on that node.
So acceptance waits on two measurements, and **this ADR stays Proposed until both are done**:

- **Kind / GitHub runner** (S18-2 implementer, part of E9). Run on the `ubuntu-latest` kernel, in a
  kind node with containerd's overlayfs snapshotter. Boot the template image as uid 65532 and
  record, for each payload, the maps `dev:ino` next to the `fstat` `dev:ino`.
- **OKE 5.15 and EKS 6.1 node kernels** (**founder item**; agents do not touch OKE). Take the same
  record on one node of each.

If either does not match, the ADR is amended before it is accepted. The amendment would either
change the match rule for that kernel family, with its evidence, or move the tripwire to warn on
it.

**What a false refusal does to traffic.** This is why the gate matters.

- **Staged:** every container start exits with code 78.
  - A new revision never becomes Ready, so Knative keeps the old one serving during the rollout.
  - A revision scaled to zero **never serves again**: each cold start crash-loops, and the
    activator holds requests until they time out.
  - A node kernel upgrade under a running app has the same effect on every pod scheduled there.
- **Self-contained:** the pod becomes Ready first. Its **first image request** then exits the
  process, killing a Ready pod that was serving traffic and dropping its in-flight requests. Each
  restart repeats this on the next image request, until `CrashLoopBackOff`.

**A refusal after the `dlopen` ends the process in enforce mode.** The shim writes the refusal to
stderr with `writeSync(2, …)` and then calls `process.exit(78)` (`EX_CONFIG`). Throwing is not
enough: `lazySharp` would catch the throw, and the image optimizer would keep serving with the
library mapped. Refusals **before** the `dlopen` still throw, because nothing has been mapped yet.

| Option | After a refusal | Cost | Score |
|---|---|---|---|
| **`writeSync`, then `process.exit(78)`: chosen** | The process ends; nothing can catch it | The traffic effects above | 0.76 |
| A process-wide poison flag | Every later sharp call throws; the library stays mapped in a process that keeps serving | Leaves mapped code running | 0.14 |
| Fail only image requests (500 from then on) | The same mapping stays live | The same | 0.06 |
| Throw | `lazySharp` and the optimizer swallow it, and originals are served | Silent | 0.04 |

**The tripwire detects; it does not prevent.** Before it reads the maps file, the ELF constructors
of whatever was mapped have already run. Three cases it sees:

- a swap by root that is put back between the last pin check and the loader's open;
- a libvips loaded through `LD_PRELOAD`: it is mapped before the shim runs, so the pinned inode is
  the one that goes missing;
- a libvips already loaded under another path.

**macOS** (`darwin-arm64` and `darwin-x64` are shippable) has no `/proc`. So neither the tripwire
nor D4's ELF closure runs there. D1 to D3 apply. The residual that D4 and D5 cover on Linux,
`dyld`'s search paths included, stays open on macOS.

### D6. Staged load timing: eager at boot

The staged load stays where it is today: at module evaluation, **before the server listens**. A
refusal is then a boot failure. A new revision never becomes Ready, and the old one keeps serving.

**The honest cost on that path.**

- **Hashing libvips adds about 10 ms of boot time.** This is #259's change, not this ADR's, and #259
  measured it natively:
  - arm64 Mac, Bun 1.4.2, warm page cache, real sharp 0.35.5 addon, 30 imports after 3 warm-ups;
  - **9.81 ms median** (p95 10.53 ms) for a 16.6 MB linux libvips;
  - about 10.5 ms expected for the pinned 18.2 MB file;
  - in a stub build with the same `onLoad` interception, the verify-and-dlopen log line came
    **+9.8 to +14.6 ms** before the listen line.

  A cold page cache is not measured.
- **This ADR adds about 0.7 ms** (M9 + M10).

| Option | When a refusal shows | Traffic effect of a refusal | Boot cost | Score |
|---|---|---|---|---|
| **Eager at boot: chosen** | Before the server listens | The revision never becomes Ready, and the old one serves | about 10.7 ms per cold start (#259 + this ADR) | 0.47 |
| Eager-async (start the verify at boot, listen at once, image requests wait for it) | After Ready | A refusal after the `dlopen` kills a Ready pod. One before it serves originals silently. | about 0 on the listen path | 0.40 |
| Lazy in staged mode too (on the first image request) | On the first image request | The same as self-contained mode: Ready pods die | 0 at boot | 0.13 |

Debt **TD-S18-2a** (below) is a founder-run OKE cold-start A/B of #259 and S18-2 together.

### D7. One parsed off switch, scoped to outside Knative: `KNEXT_SHARP_SEALED_LOAD`

- **Values.** It has the three outcomes of `requireIntegrity()`, and it reads the same on and off
  spellings:
  - unset, empty, or an on spelling: **enforce**;
  - an off spelling: **report mode**, but only when `K_SERVICE` is unset or empty;
  - anything else: the shim **throws** before any file is opened, listing the accepted values.

  `REQUIRE_ON` and `REQUIRE_OFF` (`:217-218`) are shared through one parse helper, so neither line
  appears twice. `scripts/mutation-prove-native-integrity-exception.mjs` anchors on the exact line
  `if (REQUIRE_ON.includes(value)) return true;` (`:84`), and that prover aborts on an anchor it
  finds twice. Its anchors therefore move in the same PR and are proved again. The same goes for
  its `findManifest` anchor (`:173`), which D2's `lstat` change rewrites.
- **Inside Knative** (Knative sets `K_SERVICE` in every user container), an off value is
  **fatal**. The shim throws before any file is opened, says the switch is not honoured inside
  Knative, and names the layout fix. Refusal messages inside Knative never mention the switch.
  Outside Knative they name it, with the sentence that it loads a tree nobody has judged.
- **What report mode does.** Every check in D1 to D5 runs, and the findings are printed as **one
  warning per load**, prefixed `knext: sharp sealed load (report mode)`. Then the addon loads by
  path. A finding after the `dlopen` warns instead of exiting. Files are still opened with
  `O_NOFOLLOW|O_NONBLOCK`, so a FIFO cannot hang the load and a link is still not followed.
- **What stays fatal in report mode:**
  - a hash mismatch;
  - an unlisted addon;
  - an unknown manifest version;
  - an **unreadable manifest** (`:309`), which per D2 includes a link, a FIFO or any other
    non-regular file at the manifest's path;
  - an unreadable payload, classified the same way;
  - a payload in the wrong format (D2);
  - a staged tree for the wrong platform.

  Absence stays governed by D8.
- **Scope.** The switch is sharp's alone. The in-process Rust loader has no opt-out, and it never
  reads this variable.
- **No expiry date.** Its legitimate users, the build smoke and binaries run by hand, are never in
  Knative and never ship.
- **Who sets it:**
  - **`knext build`'s post-compile smoke, unconditionally on every smoke path.** That means the
    host-arch twin, the reuse path (`reuseShipBinary`) and the self-contained path. One exported
    helper in `cli/build.ts` builds the smoke child's env, where today the env is set only next to
    `KNEXT_SHARP_ADDON` (`:244-246`).
  - **No CI lane sets it** (D13), and nothing that ships sets it. E6 defines the scan.

### D8. The no-manifest branch, correct in either order of the 2026-12-01 decision

"Absent" means `ENOENT` on D2's open and nothing else. With no manifest, the shim first judges
everything it can:

- the directories and the pins (D1, D3);
- the addon, and every file in the payload directories that matches D2's pattern, each on its own
  descriptor;
- the search closure (D4).

There is no manifest to list the tree, so D4's "nothing unlisted" check cannot apply. Every entry
in the payload directories is judged as a payload instead.

Then the shim hands over **unchanged** to the existing absence decision (`requireIntegrity()` and
the exemption). The outcome depends on which lands first:

- **The exemption is still live when S18-2 lands.** A judged tree with no manifest warns and loads,
  as today, unless `KNEXT_REQUIRE_NATIVE_INTEGRITY` is on. A refusal from the rule in enforce mode
  fires before the absence decision.
- **The default flips first.** The absence decision refuses. The rule's findings come first in the
  same message.

Nothing here depends on the flip, and S18-2 does not edit `native-integrity-policy.mjs`. Removing
the manifest needs write permission on the tree root, which only root has under the staged
profile. So the "strip the manifest to downgrade the check" residual is closed for non-root actors
in both orders.

### D9. Refusal messages

**Every refusal is written to stderr, once, before it is thrown.** In self-contained mode,
`lazySharp` caches a throw and the optimizer swallows it (`vinext-image-optimizer.ts:175-176`), so
without this a refusal would be completely silent.

Each refusal names three things:

1. **The path**, and what failed: its owner, its full mode (including the sticky and setgid bits),
   or its type.
2. **The fix**, chosen by situation:
   - a directory inside the tree is fixed in place, with `chmod go-w` and `chown root`, or with a
     Dockerfile `RUN` after the `COPY`;
   - the template's `COPY --chown=0:0 --chmod=a-w native /app/native` is the layout that passes;
   - a sticky or shared directory means moving the install;
   - a deep extraction base means choosing a shallower one (D4);
   - a home directory is never given to root.
3. **The switch**, but only outside Knative (D7).

**Every printed path, value and system error is escaped.** C0 and C1 control characters, U+2028
and U+2029, every Unicode `Cf` character and lone surrogates are printed as escapes, never raw.
Backslashes are doubled and carets are escaped, so a newline in a directory name cannot forge a
line in the list.

### D10. Where the source lives: core-owned, inlined by the existing renderer, not one shared text

- **The logic lives in `sharp-addon-dlopen.mjs` itself,** which is core runtime. The file stays
  self-contained over node builtins.
- **The renderer that inlines it already exists.** It is `vinext-compile.mjs`'s
  `sharpAddonDlopen` `onLoad`, together with tsup's verbatim copy
  `dist/adapters/sharp-addon-dlopen.source.mjs`. S18-2 does not edit `vinext-compile.mjs`, which
  S18-3 owns.
- **The core-vs-Beta boundary (ADR-0069 D18).**
  - Core never imports the in-process Rust package.
  - The shim names that package nowhere, comments included: `ffi-dispatch.test.ts` scans core
    source and allows the name only in `cli/ffi-dispatch.ts`.
  - No test under `packages/kn-next/src` imports the Rust package's code either.
    `ffi-metrics-seam.test.ts` only reads `render.ts` as text.
  - The Rust package does not import core.
- **Why not one byte-identical text.** The Rust loader is generated TypeScript **committed into
  apps**, so every change to its text forces every app to regenerate its wrappers. It also speaks
  `FfiLoadError`, has no switch and has no extracted profile. A shared text would either couple
  core's sharp releases to wrapper regeneration in every app, or force one set of messages and one
  policy on two loaders that D1 and D7 keep apart on purpose.

### D11. Lockstep by one repo-root parity test

`tests/native-sealed-parity.test.ts` sits in the repo root's `tests/`, which belongs to neither
package, so D18 does not constrain it. It imports the Rust package's pure `renderModule` and runs
the core shim from its source path. Both run in Bun subprocesses over one table.

**The row schema.**

```ts
type Role = 'exec-dir' | 'above' | 'tree-root' | 'payload-dir' | 'payload' | 'manifest';
interface Vector {
  id: string;                       // 'V01'
  what: string;                     // one line
  ops: Op[];                        // applied to each loader's tree, by role
  fake?: {                          // read only by the harness (D12)
    owner?: Partial<Record<Role, number>>;
    mode?: Partial<Record<Role, number>>;
    type?: Partial<Record<Role, 'fifo' | 'link'>>;
  };
  expect: Verdict | { ffi: Verdict; sharp: Verdict; why: string };
}
type Op =
  | { op: 'chmod'; role: Role; mode: number }
  | { op: 'symlink-over'; role: Role }
  | { op: 'hardlink-out'; role: 'payload' }       // a second name, in a test-owned directory
  | { op: 'mkfifo'; role: 'manifest' | 'payload' }
  | { op: 'swap-tree'; on: 'open'; role: 'manifest'; putBack: boolean } // run by D12's open hook
  | { op: 'write-in-place'; role: 'payload'; at: 'after-hash' }
  | { op: 'plant'; role: 'payload-dir'; name: string };
type Verdict = { load: true } | { refuse: Role } | { hang: true };
```

**How roles map to each loader's tree.** Both put the executable at `<dir>/server` and the tree
root at `<dir>/native`.

| Role | The Rust loader | The sharp shim |
|---|---|---|
| `payload` | `native/ffi/<triple>/lib<name>.so` | **two** files: `native/sharp-<id>/lib/sharp-<id>-<ver>.node` and `native/sharp-libvips-<id>/lib/libvips-cpp.so.<x.y.z>`, both synthetic ELF64 (D12) |
| `payload-dir` | `native/ffi/<triple>`, `native/ffi` | `native/sharp-<id>/lib`, `native/sharp-<id>`, `native/sharp-libvips-<id>/lib`, `native/sharp-libvips-<id>` |
| `manifest`, `tree-root`, `exec-dir`, `above` | the same paths in both | the same paths in both |

A vector that names `payload` or `payload-dir` **expands into one case per sharp path**. Each case
must match the Rust loader's verdict. A refusal's printed path is mapped back to its role before
the comparison.

**How each `dlopen` is stubbed, and how a verdict is read.**

- **The Rust loader.** The test renders a module from a one-function fixture manifest, writes it
  into the tree, and runs a Bun subprocess. That subprocess first replaces
  `process.getBuiltinModule` so that `'bun:ffi'` returns an object whose `dlopen(name)` prints
  `REACHED_LOAD <name>` and throws a sentinel. Then it imports the module and calls the function.
  The verdict is read like this:
  - **`load`:** the `REACHED_LOAD` line appeared. The module then wraps the sentinel in an
    `FfiLoadError`; that error is expected and is not read as a refusal.
  - **`refuse`:** an `FfiLoadError` with no `REACHED_LOAD` line.
  - **`hang`:** the subprocess is still running at a 5 s timeout and is killed. That is the
    expected verdict for a FIFO under the Rust loader on `integration/v2`, which opens without
    `O_NONBLOCK`.
- **The sharp shim.** A Bun subprocess sets `process.execPath` to the fixture's executable and
  replaces `process.dlopen` with a recorder that prints `REACHED_LOAD <path>` and sets `exports`.
  Then it imports the shim. The harness feeds a `/proc/self/maps` that, after the stub, lists the
  pinned payloads with their real `dev:ino`, so the tripwire passes a `load` vector.

**Rows where the loaders differ.** Each is a row of its own, with a `why`. These are the true
differences from the Rust loader on `integration/v2`:

- it follows links (`existsSync`, `readFileSync` and `openSync` by path; `statSync` on directories);
- it opens without `O_NONBLOCK`, so a FIFO gives `hang`;
- it does not check `S_IFREG`;
- it does not judge the manifest;
- it stops the walk at the directory that holds `native/`;
- it has no pins and no real-path assertion;
- it has no search closure, no tripwire and no exit;
- it has no switch and no extracted profile.

These rows shrink if #257 merges first. A change to either loader turns its rows red until they are
classified again.

### D12. The test harness and the fixtures

**The harness, `packages/kn-next/src/__tests__/helpers/fake-stat.mjs`.** The Rust package's own
harness (`ffi-loader.test.ts:179-201`) does not fit: it is local to that file, it replaces
`fstatSync` and `statSync` but not `lstatSync`, and it injects a number `uid` even into a bigint
stat. So S18-2 adds a new one, in plain JavaScript, loaded by every Bun subprocess above. It:

1. **Replaces** `fs.statSync`, `fs.lstatSync` and `fs.fstatSync`, and calls
   `module.syncBuiltinESMExports()` so the shim's named imports from `node:fs` see the
   replacements.
2. **Answers in kind.** With `{ bigint: true }` it returns `uid`, `gid`, `mode`, `dev` and `ino` as
   bigints, for example `BigInt(fakeUid)`. Otherwise it returns numbers.
3. **Overrides:**
   - an owner, by path or by `dev:ino` (the key that survives a rename, and the one `fstat` needs),
     or as a default;
   - the permission bits, by path, sticky bit included;
   - the type bits, by path, for `lstat`: a FIFO or a link;
   - `process.getuid()`;
   - `/proc/self/maps`, through a `readFileSync` override.

   Everything else stays real.
4. **Has an `open` hook.** When `openSync`, `readFileSync` or `existsSync` first touches a given
   role's path, it runs one vector op, such as K2's tree swap at the manifest open. It works the
   same for both loaders, because the Rust loader reaches the manifest through `existsSync` and
   `readFileSync`.
5. **Records every call**, as a path or `fd`, with whether it asked for bigint. Tests can then
   assert that every stat is bigint and that the walk is exactly the expected set.
6. **Is configured only by `FAKE_*` env JSON**, read only by the helper. A scanning test asserts the
   shim's source contains no `FAKE_`, so no test seam ships.
7. **Proves itself, under Bun:** a self-test shows the shim refusing a tree whose owner the harness
   fakes to a non-root uid. A harness that fails to take effect then turns the test red instead of
   passing silently.

**Synthetic ELF64 fixtures, `packages/kn-next/src/__tests__/helpers/elf64-fixture.mjs`.** D2 and
D4 refuse a payload that is not ELF64 on Linux, and every real-shim test today writes
`"ADDON BYTES"`. So the generator writes a minimal valid little-endian `ET_DYN`: one `PT_LOAD` and
one `PT_DYNAMIC`, with `DT_STRTAB`, `DT_STRSZ`, `DT_NEEDED`, `DT_RPATH`, `DT_RUNPATH` and
`DT_SONAME` as each test asks, padded with marker bytes so that every fixture hashes differently.
It is never `dlopen`ed, because the `dlopen` is stubbed. A Mach-O variant, for the format refusal,
is just the magic number followed by padding.

### D13. CI lanes certify the shipped mode: a root-owned lane directory, never the switch

The compat credential has to certify what ships, so **no lane uses the switch**. Each lane that
boots the compiled binary from a tree it staged does five things:

1. **Creates its lane directory, unique to that boot,** with
   `sudo mktemp -d /var/lib/knext-lane/<job>-<run_id>-<run_attempt>-XXXXXX`. The lane's single
   candidate parent is `/var/lib/knext-lane`, created with
   `sudo install -d -m 0755 -o 0 -g 0`. Before staging, the lane checks that every directory from
   the lane directory up to `/` is owned by root and closed to group and other. If one is not, the
   lane fails and names it.

   There is no other candidate. `/opt` is mode 0777 on GitHub's `ubuntu-latest`, as #257's CI runs
   observed, and falling back to `/` would litter the host.
2. **Copies in** everything that must sit beside the executable: the binary, `native/`, and
   `.output/public` where I2 needs it. Then it runs `chown -R 0:0` and `chmod -R go-w`.
3. **Runs the binary as the runner user**, who is not root.
4. **Proves enforce mode** with a signal of three parts:
   - neither `KNEXT_SHARP_SEALED_LOAD` nor `K_SERVICE` appears in the server's
     `/proc/<pid>/environ`;
   - the server log has no line with the report-mode prefix `knext: sharp sealed load (report
     mode)`;
   - a **negative control:** the same binary, booted once from the unstaged tree the runner owns,
     exits non-zero with the refusal prefix `knext: refusing to load sharp`.
5. **Removes the lane directory** at the end, with `sudo rm -rf`.

Self-contained lanes use the extracted profile and keep their layout. They still run the same
three-part enforce check.

| Option | Certifies the enforced mode | Cost | Score |
|---|---|---|---|
| **A fresh root-owned lane directory: chosen** | Yes, with a negative control | `sudo` steps in each lane | 0.99 |
| Run every lane inside a template-layout container | Yes | Rewrites lanes that boot on bare runners by design | 0.01 |
| Run lanes under the fake-root harness | No; it fakes the owners being certified | — | 0.00 |
| Run lanes in report mode and grep for no findings | No; report mode is not the shipped mode | — | 0.00 |

## Options considered

### The design

In the **residual** column, "non-root" means the app user, a sidecar, an `fsGroup` writer or a
co-tenant uid.

| Option | Residual | Behaviour change for existing sharp users | glibc / musl | Bun / Node | Cold start | Testability | jev |
|---|---|---|---|---|---|---|---|
| **(a1)** Pin by descriptor and dlopen `/proc/self/fd`, with libvips preloaded through its descriptor by `bun:ffi` | musl: none, because nothing loads. glibc: none against non-root, and only if the owner and mode rule is added too. | **On musl sharp never loads**, so every vinext app with `next/image` crashes at boot (M4) | Fails on musl; loads on glibc | Needs `bun:ffi`; Node's `process.dlopen` is for addons (not measured; moot, since the shim runs only in Bun) | One extra `dlopen` | Needs real native loads on each libc, and the musl leg cannot pass | 0.00 |
| **(a2)** The same, with `patchelf` rewriting the addon's rpath to an absolute path | The addon's path is pinned, but libvips is still opened by path (M5) | Third-party bytes change, so they no longer match the upstream tarball. An absolute rpath breaks every relocated tree. `patchelf` joins the supply chain. | Loads on musl; glibc not measured | Same on both | Runtime none; one build step | Needs `patchelf` in the build tests | 0.00 |
| **(b) A sealed load by path, D1-D13: chosen** | **Staged, non-root: none.** **Root or the like, or a second mount:** they can write in place. A swap that is put back is seen only by the tripwire, after constructors run. **Extracted:** the app's uid and the base's writers. **macOS:** no closure and no tripwire. | The template image passes, and `apps/file-manager` is expected to (E3). Every drifted layout is refused with its path and the fix: a `chown`-ed `/app`; a builder that ignores `--chmod` **while the build context's directories are group- or other-writable**; an install under a home directory or `/tmp`; an `fsGroup`-writable volume; `KNEXT_SHARP_ADDON` through a link; a deep extraction base. The smoke runs in report mode. CI moves to lane directories. | One rule on both, with the search order of each judged (D4) | Runs under Bun only today. The APIs it needs exist in both runtimes. | **About +0.7 ms**, on top of #259's ~10 ms, at boot in staged mode (D6) | Fully testable without root (D12), plus a real-root leg (E3) | **1.00** |
| **(c)** Owner and mode only, by path: no descriptor, no `O_NOFOLLOW`, no pins and no ancestor walk, with an opt-out | **Non-root: a tree swap stays open.** A FIFO hangs boot, and links are followed. | The same refusals, but swapped trees pass | Same on both | Portable | Less than (b) | The swap tests stay green for the attacker | 0.00 |
| **(d)** Document the risk only | Today's window | None | — | — | None | Nothing to test | 0.00 |

### The default and the switch

The scores are from this ADR's runs, with the wording below. Scope is from round 2 and the default
from round 1.

| Option | What it costs | Who it breaks | Score |
|---|---|---|---|
| **On by default, with one off switch honoured only when `K_SERVICE` is unset: chosen** | A refusal at boot inside Knative, where the old revision keeps serving | No one silently. Inside Knative the only way out is to fix the layout. | 1.00 |
| On, with the switch honoured everywhere | One env line opts a production pod out | No one, but it weakens what the credential certifies | 0.00 |
| On, with the switch honoured until an expiry the CI clock enforces | A forced removal later of a switch the smoke always needs | The smoke, after the date | 0.00 |
| On, with the switch honoured everywhere and every use logged and counted in a metric | Visibility without a boundary | No one | 0.00 |
| On, with no opt-out | The smoke and every binary run by hand | Every `knext build` with sharp | 0.05 (round 1) |
| Off by default, with an opt-in | It protects only those who opt in | No one; it protects no one | 0.05 (round 1) |

The tripwire, the handling of a refusal after the `dlopen`, the load timing and the CI lanes have
their tables in D5, D6 and D13.

### Where the source lives, and how it stays in step

| Option | Boundary (D18) | Cost | Score |
|---|---|---|---|
| **The logic inside the shim, plus a repo-root parity test: chosen** | Clean | One test that runs two loaders | 0.97 (location), 0.99 (lockstep) |
| A neutral vector file that each package's own suite reads | Clean | Two harnesses that drift apart | 0.01 |
| A core test that imports the renderer by relative path | **Crosses it**: that test lives under `packages/kn-next/src` | — | 0.00 |
| A text compare of the two sources | Clean | It compares spellings, so it is decorative | 0.00 |
| One byte-identical fragment | Clean | It couples core releases to wrapper regeneration | 0.00 |
| The fragment in the Rust package | **Crosses it** | — | 0.00 |

### The self-contained tree

| Option | Guarantee | Breaks | Score |
|---|---|---|---|
| **A second profile, owned by this uid: chosen** | It denies a pure write primitive, another uid's tree and a drifted base. The app's uid and the base's writers stay, and are stated. | A deep base whose grandparent is open (D4) | 1.00 |
| Refuse an extracted tree | Strong | Every self-contained deployment, with no switch inside Knative | 0.00 |
| Exempt it, leaving only the hash | Today's | Nothing; it leaves the window open | 0.00 |
| Extract it as root at image build | As strong as staged | The single-file image | 0.00 |

### The D4 invariant

| Option | Holds against non-root | Cost | Score |
|---|---|---|---|
| **Judge the search closure: chosen** | Yes, for every `NEEDED` name, whatever `LD_LIBRARY_PATH` holds | An ELF dynamic-section reader and a few `lstat`s, within M9 | 0.98 |
| Check that every `NEEDED` name is listed or already mapped | Cannot be checked: the maps file shows resolved file names (`libstdc++.so.6.0.x`), not `NEEDED` names, and musl's name table is internal | — | 0.02 |
| Judge only the tree's own directories | No: a library planted where `LD_LIBRARY_PATH` points runs first | Least | 0.00 |

## Consequences

- **What it closes.** "One tree, two rules" becomes one rule in two texts, and D11 shows where the
  texts differ. Under the staged profile, no writer that is not root can swap the sharp payloads,
  write them, or touch the loader's search path between the hash and the map. That covers the app's
  own user through a file-write bug, a sidecar, an `fsGroup` writer and a co-tenant. A drifted
  layout becomes a named refusal.
- **The manifest-absence downgrade narrows, in either order** (D8).
- **Every vinext app with `next/image` is affected,** so the change gets a `@getknext/core`
  **minor** changeset.
  - **Staged.** The template image loads unchanged, and the `apps/file-manager` image is expected
    to (E3). A drifted layout fails its first boot. Knative keeps the old revision serving, and
    inside Knative there is no switch.
  - **Self-contained** (correcting round 2). **The revision becomes Ready first**, because nothing
    loads until the first image request. After that:
    - a refusal before the `dlopen` is written once to stderr (D9) and cached by `lazySharp`.
      **Every image request then gets the original, unoptimised bytes with a 200**, because the
      optimizer fails open (`vinext-image-optimizer.ts:175-176`). It is not a 500;
    - a refusal after the `dlopen` **exits the process with code 78 on the first image request**.
      That kills a Ready pod and drops its in-flight requests, and the next image request on the
      restarted pod repeats it (D5).
  - **The build smoke** runs in report mode on every path, so the build log carries one warning.
- **The tripwire can crash-loop a whole node family** if its kernel reports a different overlayfs
  inode. That is why acceptance waits on the D5 measurements, one of them the founder's.
- **The CI lanes change** (D13), and the compat credential then certifies the enforced mode.
- **Ownership.** S18-2 goes beyond the sprint row's "Owns" column:
  - `cli/build.ts`, the smoke env (a `src/cli/` trigger);
  - `sharp-native-extract.mjs`: the real-path return, the stale temp file sweep, and the export for
    the lockstep test;
  - `scripts/e2e-deploy-vinext.sh`;
  - two `ci.yml` jobs, which overlaps S18-4, whose row owns the workflow yml;
  - `apps/docs/rust-in-process-doc.test.ts`.

  The sprint is serial, so S18-2 lands first and S18-4 builds on it. ADR-0069 belongs to S18-1:
  the pointer from its open action item to this ADR goes in through #257, or is filed at sprint
  close. S18-2 does not edit ADR-0069.
- **Docs are user-visible.** `apps/docs/content/docs/image-optimization.mdx` gets the layout rule,
  the profiles, the switch and its Knative scope, and a table from refusal to fix.
  `apps/docs/content/docs/threat-model.mdx` mirrors the internal threat model. Neither carries an
  ADR, issue or PR number.
- **Not covered:** outside the Bun binary, sharp's addon is loaded with no check at all. The
  vinext/node and Next.js standalone runtimes load sharp from `node_modules` through sharp's own
  loader. This is filed as debt.
- **Residuals that remain:**
  - uid 0, and every capability as good as root: `CAP_DAC_OVERRIDE`, `CAP_FOWNER`, `CAP_CHOWN`,
    `CAP_SETUID`, `CAP_SYS_ADMIN`, `CAP_SYS_PTRACE`, `CAP_MKNOD`, `CAP_SYS_MODULE`,
    `CAP_SYS_RAWIO`, `CAP_BPF` and others;
  - a second writable mount, and ACLs;
  - a seekable write through `/proc/self/mem`;
  - a rootless container whose host user owns the image files;
  - objects loaded through `LD_PRELOAD`;
  - directories that `ld.so.cache` names beyond D4's set;
  - the extracted profile's app uid and base writers;
  - `dyld`'s search paths on macOS;
  - **the switch still works wherever `K_SERVICE` is unset:** a plain `docker run`, a Kubernetes
    Deployment outside Knative, or a VM.

  The tripwire detects; it does not prevent.

## Action items

### Before S18-2

- [ ] **#259** merges. It is the prerequisite: `isNativePayload` gains the multi-part soname
      pattern, together with `sharp-native-payload.test.ts` and
      `scripts/mutation-prove-sharp-soname.mjs`. It also measured libvips' boot cost natively (D6).

### S18-2 implementation (one PR, serial after S18-1 and #259)

- [ ] **`sharp-addon-dlopen.mjs`:** D1 to D9. Rewrite the header to match, and never name the
      in-process Rust package.
- [ ] **`sharp-native-extract.mjs`:**
      - return `join(realpath(base), name)` (D3);
      - export `assertSafeBase` for the lockstep test;
      - **sweep stale temp files**, as described below.

      `writeAtomic` (`:186-198`) leaves `<target>.<pid>.tmp` behind when a process is killed
      mid-extraction. The content-addressed root is reused, so D4 would refuse that tree. Before
      verifying or reusing a tree, the extractor removes only entries that match
      `<a listed name>.<pid>.tmp` **and** satisfy one of two conditions:
      - the pid is no longer running (`process.kill(pid, 0)` gives `ESRCH`); or
      - the file is older than 60 s, which covers a reused pid.

      It leaves a younger file whose pid is running. That makes D4 refuse the tree in this
      process, and `lazySharp` **caches that refusal for the process's lifetime**: images are served
      unoptimised until a restart.

      The sweep is best effort. Another pid namespace that shares the base can make a pid look
      alive or dead when it is not. Two processes of one uid extracting at once is the only way to
      reach the case that is left.
- [ ] **`cli/build.ts`:** one exported helper sets `KNEXT_SHARP_SEALED_LOAD: 'off'` in the smoke
      child's env on **every** smoke path: the twin, `reuseShipBinary` and self-contained. Nothing
      else sets it.
- [ ] **`scripts/mutation-prove-native-integrity-exception.mjs`:** move its anchors `:84` and
      `:173` (D7), and prove them again.
- [ ] **CI lanes (D13).** For each one, what changes:
      - **`ci.yml` `compat-smoke` (`:539-575`, glibc):** after "Compile the single executable" and
        "Stage the sharp native tree", stage into a lane directory, point `SERVER_CMD` and
        `SERVER_PATH` at the staged binary, and run the three-part enforce check.
      - **`compat-vinext.yml` through `scripts/e2e-deploy-vinext.sh`:**
        - **Disk mode** boots from `APP_DIR` (`:724-732`). Stage the binary, `native/` (staged at
          `:541-564`) and `.output/public` into a lane directory instead, and boot from there.
        - **`KNEXT_SELF_CONTAINED=1`** (`:698-722`) keeps its fresh `RUNNER_TEMP` directory and
          the extracted profile, and adds the enforce check.
      - **`apps/file-manager/self-contained-exec-e2e.test.ts`:** the extracted profile applies. Its
        `KNEXT_NATIVE_TMPDIR` is a fresh real-path temp directory, so entry 5 resolves under `/`
        (D4). Add the enforce check.
      - **`ci.yml` `Prod image next/image optimization (strict, #66)`:** the E3 legs.
- [ ] **Tests that run the real shim:** `sharp-addon-dlopen.test.ts:392-438`,
      `tests/native-integrity-absence-exception.test.ts:73-91` and #259's
      `sharp-native-payload.test.ts`. Each of them:
      - loads through the D12 harness, with owners faked to 0 and the directories above the
        fixture faked to root 0755;
      - writes synthetic ELF64 payloads (D12) instead of `"ADDON BYTES"`;
      - strips `KNEXT_SHARP_SEALED_LOAD` and `K_SERVICE` from the inherited env.

      The no-manifest rows run under both absence outcomes (D8). Every other place that boots a
      compiled vinext binary or imports the real shim outside an image either moves to a lane
      directory or the harness, or is listed in the PR with a reason. `tests/e2e-empty-dir.test.ts`
      is a candidate to check.
- [ ] **`apps/docs/rust-in-process-doc.test.ts:487-493`:** it pins sentences of the threat model's
      `/app/native` section ("One tree, two loaders, two rules", "hashes the file by path and then
      `dlopen`s by path", "no owner or mode check", "**Open debt:**"). S18-2 rewrites those
      sentences, so the test moves to the new ones in the same PR.
- [ ] **A changeset** (`@getknext/core`, minor): the behaviour change, the switch and its Knative
      scope, and the fix.
- [ ] **Docs:**
      - the two pages named in Consequences;
      - `docs/security/threat-model.md`: the `/app/native` section, and the in-process Rust entry;
      - `packages/kn-next/src/adapters/EGM.md`: the Images invariants, the env var under
        Interface, and the new export.

### Exit criteria the implementer can test

Every refusal test has a **pass twin** that loads, because a guard has to be shown to pass as well
as to refuse.

**E1. Real hard-link and in-place-write tests,** in a new `sharp-addon-sealed.test.ts`, using the
D12 harness with real files, real modes and real links:

- **K1, a real hard link to an inode the attacker owns.** The addon is given a second name with
  `linkSync` into a test-owned directory, and the test asserts `nlink === 2n`. The file is 0444,
  its hash matches, and its owner is **not** faked. It is **refused** as "owned by uid N". The twin
  fakes that `dev:ino`'s owner to 0 and loads.
- **K2, a real hard link inside a swapped tree.** The attacker's tree has its own manifest and a
  real hard link to the real addon. It is renamed over `native/` by the `open` hook at the manifest
  open, and the load is **refused** at a pinned directory or at the manifest's owner. The twin does
  no swap and loads.
- **I1, an in-place write the rule stops.** libvips is really 0664, a real hard link to it is held
  in a test-owned directory, and owners are faked to 0. It is **refused before any hash**, and the
  refusal names libvips. The twin, really 0444, loads.
- **I2, an in-place write that only the rule can stop.** Owners are faked to 0, and the mode is
  really 0644. The stubbed `process.dlopen` first writes through the held hard link, so the bytes
  change and the inode does not. The test asserts that the pins and the tripwire do **not** refuse.
  This is the pair to I1 and I3: it shows the owner and mode rule is the only guard against an
  in-place write, and that root's own write is a residual.
- **I3, the extracted profile.** A tree written by the real `extractEmbeddedNative` loads. The same
  tree with one file made `u+w` is **refused**, and so is one whose owner is faked to another uid.

**E2. The rest of the rule.**

- **Links:**
  - a link at the tree root, at the addon, at libvips and at the manifest is refused;
  - a dangling link at the manifest is unreadable and fatal, never absent;
  - a root-owned system link in D4's set (`/lib -> usr/lib`) passes;
  - a link in that set that the test user owns is refused.
- **FIFOs:** a FIFO at the manifest does not hang, with a timeout, in both modes.
- **Directories:**
  - a group-writable directory above the executable is refused;
  - a sticky `/tmp` ancestor in the staged profile is refused, with its full mode printed;
  - a sticky ancestor above the extraction base whose next entry exists and belongs to this uid
    passes;
  - a deep base whose entry 5 falls under `/tmp` is refused.
- **Environment:** `KNEXT_SHARP_ADDON` through a link is refused, and an `LD_LIBRARY_PATH` entry
  under `/tmp` (sticky, and the entry not yet existing) is refused.
- **Trees:** a tree swapped in and left is refused, and so is one swapped in and put back.
- **Pins and files:**
  - two pinned inodes that differ only above 2^53 count as two;
  - an unlisted `libstdc++.so.6` planted in libvips' `lib/` is refused;
  - a Mach-O addon in a Linux tree is refused by name, in both modes.
- **Tripwire:** fed a maps file that maps another libvips, it **exits** with code 78, even through
  `lazySharp`.
- **Switch:**
  - `off` with `K_SERVICE` unset loads a refused tree with one warning, and still refuses a hash
    mismatch and a FIFO manifest;
  - `off` with `K_SERVICE=svc` is fatal, and no message mentions the switch;
  - `enabled` throws before any open;
  - unset enforces.
- **Smoke:** the env helper sets the switch on the twin, reuse and self-contained paths.
- **Sweep:** a `<libvips>.<dead pid>.tmp` is swept and the tree loads. One whose pid is live and
  younger than 60 s is left, and the load is refused and cached.
- **Messages:** every refusal reaches stderr even when the optimizer swallows the throw.

**E3. A real-root leg,** in `ci.yml`'s `Prod image next/image optimization (strict, #66)` job. That
job builds an image and runs it as the image's own user.

- The `apps/file-manager` image boots as uid 65532 with the rule in force, which the job asserts
  (D13's check), and returns an optimised `/_next/image`.
- Inside the running container, as uid 65532, three attempts fail, each with its errno printed:
  - `sh -c 'printf x >> <libvips>'`;
  - `ln <libvips> /app/native/x`;
  - `ln <libvips> /tmp/held`, which `fs.protected_hardlinks=1` refuses. That is Ubuntu's default,
    and a container inherits it from the host, so the leg prints the sysctl.
- A derived image (`FROM` the built one, `USER root`, `RUN chown -R 65532:65532 /app/native`,
  `USER 65532`) is **refused at boot**, and the refusal names the path.

**E4. Lockstep.** `tests/native-sealed-parity.test.ts` (D11) is green, `hang` verdicts included.
`sharp-extract-base-lockstep.test.ts` runs the exported `assertSafeBase` and the shim's copy of the
base rule over owner ∈ {0, self, other} × mode ∈ {0700, 0750, 0755, 0770, 0775, 0777, 1777}, and
requires the same verdict on every row. The ffi-dispatch boundary test stays green.

**E5. A prover,** `scripts/mutation-prove-s18-2-sharp-sealed-load.mjs`, removes one guard per row
and requires a named test to go red. It branches on exit codes and never greps output. Each anchor
must match exactly once, or the prover aborts. It runs after the green commit. A row whose mutation
did not apply is a failure, never a pass. The row IDs are disjoint from the measurement IDs M1 to
M10.

| Group | Row | Guard removed |
|---|---|---|
| Files | L01 | The manifest is not judged |
| | L02 | The addon is not judged |
| | L03 | libvips is not judged |
| | L04 | A payload is opened following links |
| | L05 | The manifest is opened following links |
| | L06 | The two flags are only checked to be numbers |
| | F01 | `O_NONBLOCK` is dropped |
| | F02 | A non-regular file is read |
| | F03 | A Mach-O payload is accepted on Linux |
| | H01 | The hash reads by path |
| Classification | A01 | `ELOOP` at the manifest reads as absent |
| | A02 | `findManifest` uses `existsSync` again |
| Directories | W01 | No ancestor above the tree root's parent is walked |
| | W02 | The walk stops one short of `/` |
| | W03 | The ancestors are not judged |
| | W04 | A sticky ancestor is let through, in the staged profile |
| | W05 | `stat` instead of `lstat` |
| | W06 | libvips' branch is not walked |
| | R01 | The real-path comparison is removed |
| Pins | P01 | No check after the hash |
| | P02 | No check after the `dlopen` |
| | P03 | A file's path is not checked again |
| | P04 | Pins are compared as numbers |
| Search closure | S01 | An unlisted file in the addon's `lib/` is accepted |
| | S02 | The same in libvips' `lib/` |
| | S03 | An rpath entry outside the tree is not judged |
| | S04 | `LD_LIBRARY_PATH` is not judged |
| | S05 | An unknown `$` token is expanded as text |
| | S06 | A non-root system link is followed |
| | S07 | The sticky exception applies to a missing entry |
| Tripwire | T01 | It is skipped |
| | T02 | It compares paths, not `dev:ino` |
| | T03 | A new mapping outside the judged directories is accepted |
| | T04 | A refusal after the `dlopen` throws instead of exiting |
| | T05 | `dev` is decoded without the `new_encode_dev` layout |
| Profiles | X01 | The extracted profile accepts another non-root uid |
| | X02 | The extracted profile accepts an owner write bit |
| | X03 | The staged profile accepts this uid |
| | X04 | Above the base, a sticky ancestor whose next entry another uid owns is accepted |
| | X05 | The shim's base rule drifts from the extractor's |
| | X06 | A deep base's entry 5 is judged by the base rule |
| | Z01 | The extractor no longer sweeps stale temp files |
| | Z02 | It sweeps a file whose pid is live and which is younger than 60 s |
| Switch | O01 | An unrecognised value reads as off |
| | O02 | It reads as on |
| | O03 | `off` prints no warning |
| | O04 | `off` also skips the hash |
| | O05 | `off` is honoured inside Knative |
| | O06 | A refusal inside Knative mentions the switch |
| | B01 | The smoke env omits the switch on the reuse path |
| | B02 | The same on the self-contained path |
| Messages | N01 | A refusal does not name the path |
| | N02 | A refusal is thrown without being written to stderr |
| | C01 | A control character in a path is printed raw |

**E6. A scan for the switch.** No **executable context** may set `KNEXT_SHARP_SEALED_LOAD` to an
off value, except `cli/build.ts`'s smoke helper. The executable contexts are:

- the `env:` and `run:` of workflow files;
- shell assignments and `export`s in `scripts/`;
- `ENV` and `ARG` in every Dockerfile;
- env blocks in templates and generator templates;
- the operator's source;
- fenced `dockerfile`, `yaml`, `sh` and `bash` code blocks in the docs.

The docs may name the off value in prose and in the env-var reference table. That is how a reader
learns it exists and that Knative does not honour it. They may not show a recipe that sets it.

Mutation: plant it in `packages/kn-next/templates/app/Dockerfile.hbs`, in the `compat-smoke` job,
and in a fenced `yaml` block in `image-optimization.mdx`. Each must go red. A prose mention must
stay green.

**E7. The no-manifest rows run under both absence outcomes** (D8).

**E8. The OKE standing stage (founder).** Deploy the template vinext app that uses `next/image`. The
revision must become Ready, and `/_next/image` must return an optimised image. TD-S18-2a measures
the cold-start cost.

**E9. The tripwire measurement on kind and a GitHub runner** (D5). It runs on the `ubuntu-latest`
kernel, in a kind node with containerd's overlayfs snapshotter. The template image boots as uid
65532, and for each payload the maps `dev:ino` is recorded next to the `fstat` `dev:ino`. They must
be equal. The record goes into the S18-2 PR, kernel version included. The founder's OKE 5.15 and
EKS 6.1 record follows the same recipe. **Until both are in, this ADR stays Proposed.**

### Debt this ADR records (for the sprint-close review)

- **TD-S18-2a (founder-run): an OKE cold-start A/B of #259 and S18-2 together.** Eager staged
  hashing of libvips plus the sealed rule, against the parent commit. Report the median and p95
  of cold start at scale-to-zero, n per arm as the bench ledger sets it.
- **Tighten the extracted directories** to 0500 after extraction (P3).
- **Anchor the extracted tree's digests** in the binary's embedded manifest instead of the extracted
  copy. That touches `vinext-compile.mjs`, which S18-3 owns (P3).
- **Check sharp outside the Bun binary**, in the vinext/node and Next.js standalone runtimes (P3).
- **A builder matrix:** kaniko and buildah, against a group-writable build context (P3).
- **Read the search closure on macOS:** a Mach-O reader, and a `dyld` image list in place of
  `/proc/self/maps` (P3).

## Appendix: repeating M1 to M10

For each libc, use the pinned Bun image: `oven/bun:1.4.2-alpine` (musl) and `oven/bun:1.4.2`
(glibc), with `--platform linux/amd64`.

1. Install the pair:
   `bun add --no-save @img/sharp-<platform>@0.35.5 @img/sharp-libvips-<platform>@1.3.4`.
2. Copy both packages with `cp -RL` into `/app/native/`.
3. Read each payload's `PT_DYNAMIC` with any ELF reader (M1, M2).
4. From a Bun script:
   - `process.dlopen` the addon through `/proc/self/fd/<n>` (M3);
   - preload libvips through its descriptor with `bun:ffi`'s `dlopen`, then repeat M3 (M4);
   - load the addon by path (M6), and compare `/proc/self/maps` with `lstat` (M7).
5. For M5, run `patchelf --set-rpath /app/native/sharp-libvips-linuxmusl-x64/lib` on a copy of the
   addon, then repeat M3.
6. Time D1 to D4's calls and two maps reads over 200 iterations (M9, M10).
