/**
 * The TypeScript emitter: one typed, `server-only` module per library
 * (ADR-0069 D6–D9, D13, D15 step 2).
 *
 * {@link renderModule} is pure — a manifest in, the module's text out, no I/O —
 * so `knext ffi generate`, `knext ffi check` and the image build's drift check
 * (which renders from the library that ships and compares with the committed
 * file) all produce byte-identical output from the same manifest.
 *
 * What the emitted module guarantees, each pinned by render.test.ts and proven
 * against a real library by ffi-loader.test.ts:
 *
 * - `import 'server-only'` first; no `bun:ffi` import and no work at import
 *   time (a static `bun:ffi` import fails `next build` under Node). `bun:ffi`
 *   is obtained on the first call through `process.getBuiltinModule`.
 * - It type-checks with Node types only: the slice of `bun:ffi` it uses is
 *   declared locally, and it hashes with `node:crypto`, not `Bun.CryptoHasher`.
 *   It uses only erasable TypeScript, so Node's type stripping can import it
 *   (and then refuse the call with the Bun-only message).
 * - Loading is fail-closed: the library beside the executable must be listed
 *   in `native/.integrity.json` with a matching sha256. It is loaded through
 *   the descriptor its bytes were hashed from: `/proc/self/fd/<n>` on Linux
 *   (needs `/proc` mounted, as every container runtime does), `/dev/fd/<n>`
 *   on macOS (dyld shares one instance among `/dev/fd` names but keeps it
 *   apart from the same file opened by path). Any other platform is refused.
 *   What this covers: a path swap (a rename or symlink over the path) between
 *   the check and the load, and, because the descriptor pins the inode and not
 *   its bytes, a writer of the file's contents (an in-place write, a hard link
 *   to the inode, a writable mmap): the load is refused unless the library, its
 *   integrity manifest, its directories up to native/, the directory native/
 *   sits in and every directory above that up to / are all owned by root and not
 *   writable by group or other, judged by owner and mode: the library and the
 *   manifest on the descriptor each was opened as and read through (access()
 *   answers yes to root for everything, so it tells nothing), each directory by
 *   lstat. The manifest is judged because it is what authorises a file: one
 *   anyone else could write would let any library root owns pass.
 *   Why every ancestor: a directory a user can write is one that user can
 *   rename the tree out of, and put another tree in its place between the
 *   loader's by-path steps. With every directory from native/ up to / owned by
 *   root and closed to group and other, nobody but root can rename or replace
 *   any of them, so the by-path lookups are sound (the same rule as OpenSSH's
 *   StrictModes, which refuses any group- or world-writable directory on the way
 *   to a key file). A sticky directory (a /tmp) is refused too, for the same
 *   reason the rule is the mode bits and nothing else: sticky limits rename and
 *   unlink to the entry's owner, so this is the conservative reading, not a
 *   measured hole. A binary outside a container is refused only when its
 *   ancestry is not root's (under /opt/<app> it is fine; under a home directory
 *   or /tmp it is not).
 *   Links: none is followed anywhere on the path. Bun reports process.execPath
 *   already resolved (measured on Bun 1.4.2: a binary started through a linked
 *   directory, a current -> releases/N link or /tmp -> /private/tmp reports the
 *   real path), so an install behind a link loads, and the directories judged are
 *   those of the real tree. The loader still compares the directory beside the
 *   executable with its realpath and refuses a difference: a fail-closed
 *   assertion that fires only for a path that is not its own real path (a
 *   relative one, or one through a link), which Bun does not report and only code
 *   that reassigns process.execPath can produce. Inside the tree every directory
 *   is lstat-ed and must be a real directory; both files are opened with
 *   O_NOFOLLOW.
 *   Defence in depth on top of that: both files are opened with O_NONBLOCK and
 *   must be regular files (a FIFO would block the first call for ever); every
 *   directory is pinned (dev:ino, as bigint) before the manifest is read and
 *   looked at again after the library is hashed; the manifest's and the
 *   library's paths must still name the files that were read. Any change is a
 *   refusal. The rule does not depend on the uid the process runs as, and the
 *   app's own user is not trusted: it can chmod what it owns.
 *   What it does NOT stop: whatever can write these files or directories as
 *   root, or as good as root. That is uid 0 itself and any capability that is
 *   equivalent to root, for example CAP_DAC_OVERRIDE and CAP_FOWNER (write or
 *   chmod regardless of the owner), CAP_CHOWN (take ownership, then chmod),
 *   CAP_SETUID (become root), CAP_SYS_ADMIN (mount over a directory, or remount
 *   one writable), CAP_SYS_PTRACE (write into a root process), CAP_MKNOD (a
 *   device node for the disk itself), CAP_SYS_MODULE (code in the kernel),
 *   CAP_SYS_RAWIO (raw access to memory and devices) and CAP_BPF (programs in the
 *   kernel). The list gives examples; it is not a boundary. Dropping every
 *   capability does not help an app that runs as uid 0, which owns the tree: run
 *   the app as a non-root user (runAsNonRoot). Also: a second writable mount of
 *   the same files (a volume shared with a sidecar or writable through an fsGroup
 *   is refused unless its files and directories are root's and closed, and one
 *   that passes is still writable through its other mounts); an ACL (mode bits
 *   only; on macOS an ACL can grant write that the mode does not show); and a
 *   seekable file write as the app user through /proc/self/mem, which patches the
 *   running process rather than a file, so no rule about files sees it. A user
 *   namespace the attacker makes for itself gains nothing (root's files are
 *   unmapped there, and the kernel checks the real uid). The app's own container
 *   in one is two cases. Rootless Podman or Docker: the image's files are owned
 *   by the host user who started the container, who can write them whatever the
 *   app runs as inside, so "root owns it" says nothing about who on the host can
 *   write them, and running as a non-root user inside does not remove that
 *   writer. A pod with hostUsers: false: the image's files belong to the pod's
 *   own root, which is host root where the filesystem supports idmapped mounts
 *   and otherwise the root of a uid range given to that pod alone (not host
 *   root); no other user on the host owns or can write them either way, so
 *   running as a non-root user inside restores the guarantee; an app that runs
 *   as uid 0 inside still owns the tree.
 *   The operator's pods drop ALL capabilities, set allowPrivilegeEscalation:
 *   false and run as non-root unless spec.security.runAsNonRoot says otherwise,
 *   which removes the whole capability class and uid 0 from an app; a container
 *   you run yourself should do the same (--cap-drop=ALL, --security-opt
 *   no-new-privileges, --user). The Dockerfile that `knext build`, `knext deploy`
 *   and `knext preview` stage copies native/ root-owned and non-writable and
 *   `chmod go-w` it and every directory above it, which is the layout this
 *   accepts; an app-owned tree is refused. There is no opt-out.
 *   Not used: a sealed memfd copy of the hashed bytes (memfd_create and
 *   fcntl(F_ADD_SEALS) reached through libc by bun:ffi; measured to work on
 *   Bun 1.4.2). It would bind the bytes against root too, but every module copy
 *   and Worker would get its own copy of the library, which ends the one
 *   library per process that the module copies and Workers rely on (measured:
 *   two fds of one file dlopen as one library, two sealed copies as two).
 *   TODO(TD-S14-6a): bind the bytes against root too, once a sealed copy can
 *   be shared by every opener in the process without a creation race.
 *   Not used either: anchoring every lookup to a directory descriptor (Bun's fs
 *   has no openat, and the Linux stand-in /proc/self/fd/<dirfd>/... has no
 *   macOS equivalent: /dev/fd/<n>/x is ENOENT, measured on Bun 1.4.2). With
 *   the ancestor rule it is not needed against anyone who is not root, and
 *   against root nothing a lookup does helps.
 *   The development build
 *   is used only when `NODE_ENV !== 'production'`; every function's `_schema`
 *   value must match the one computed here; any failure is one cached
 *   `FfiLoadError`.
 * - The spike's binding rules (D13 item 6): `ptr()` only of an explicit
 *   `ArrayBuffer`; (ptr, len) read as two u32 halves; every (ptr, len)
 *   argument encoded into one scratch buffer BEFORE any pointer is computed
 *   from it; an empty one passed as JavaScript `null` (NULL: Bun passes an
 *   empty `Uint8Array` as a non-null pointer); integer arguments range-checked;
 *   every returned buffer copied, then freed in a `finally`.
 * - JSON carries no NaN or Infinity (`JSON.stringify` writes `null`, which
 *   Rust would read as `None`), so a non-finite float anywhere inside a JSON
 *   argument is a `TypeError` naming its path, before the call.
 * - Every symbol call is timed; one slower than `KNEXT_FFI_SLOW_CALL_MS`
 *   (default 50 ms, 0 = off) is counted per function in a process-wide
 *   registry on `globalThis` and logged the first time. Once the library has
 *   loaded, a render function is published under the `knext.ffi.renderMetrics`
 *   registered symbol for core's loopback metrics listener. This makes a blocking call visible; it cannot interrupt one.
 *   TODO(#2432): the vinext single-executable build does not serve it yet.
 */

import {
  type FnRecord,
  fnv1a64,
  type Manifest,
  manifestDigest,
  type RecordType,
  schemaString,
  type TypeDesc,
} from './manifest';

// The image build's drift check (knext ffi build) scans the library it is
// about to ship and renders from it; these are what it needs.
export { type Manifest, ManifestError, scanManifest } from './manifest';

/** `lib<name>.so` / `lib<name>.dylib` -> `<name>`, or `undefined`. */
export function libNameOf(fileName: string): string | undefined {
  return /^lib([A-Za-z0-9_]+)\.(so|dylib)$/.exec(fileName)?.[1];
}

export interface RenderOptions {
  /** The cdylib's file stem without `lib`: `zone` for `libzone.so`. */
  readonly libName: string;
  /** The crate directory relative to the app (the development fallback looks there). */
  readonly crate: string;
}

/** Single-quoted TS string literal. */
function q(s: string): string {
  return `'${s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/\n/g, '\\n')}'`;
}

const IDENT = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const key = (name: string) => (IDENT.test(name) ? name : JSON.stringify(name));
const access = (obj: string, name: string) =>
  IDENT.test(name) ? `${obj}.${name}` : `${obj}[${JSON.stringify(name)}]`;
const noClose = (s: string) => s.replace(/\*\//g, '*\\/');

const INT_RANGE: Record<string, [number, number]> = {
  i8: [-128, 127],
  i16: [-32768, 32767],
  i32: [-2147483648, 2147483647],
  u8: [0, 255],
  u16: [0, 65535],
  u32: [0, 4294967295],
};
const SIGNED_64 = new Set(['i64', 'isize']);
const UNSIGNED_64 = new Set(['u64', 'usize']);
const is64 = (t: string) => SIGNED_64.has(t) || UNSIGNED_64.has(t);

/** The bun:ffi argument type of a by-value scalar. */
const FFI_TYPE: Record<string, string> = {
  i8: 'i8',
  i16: 'i16',
  i32: 'i32',
  u8: 'u8',
  u16: 'u16',
  u32: 'u32',
  i64: 'i64',
  isize: 'i64',
  u64: 'u64',
  usize: 'u64',
  f32: 'f32',
  f64: 'f64',
  bool: 'bool',
};

/** How a by-value scalar return is read from the out slot (little-endian, native width). */
const READ: Record<string, string> = {
  i8: '$view.getInt8(0)',
  i16: '$view.getInt16(0, true)',
  i32: '$view.getInt32(0, true)',
  u8: '$view.getUint8(0)',
  u16: '$view.getUint16(0, true)',
  u32: '$view.getUint32(0, true)',
  i64: '$view.getBigInt64(0, true)',
  isize: '$view.getBigInt64(0, true)',
  u64: '$view.getBigUint64(0, true)',
  usize: '$view.getBigUint64(0, true)',
  f32: '$view.getFloat32(0, true)',
  f64: '$view.getFloat64(0, true)',
  bool: '$view.getUint8(0) !== 0',
};

/** Crosses by value (one C argument), as opposed to a (ptr, len) pair. */
const byValue = (d: TypeDesc) => d.t in FFI_TYPE;
/** Crosses as JSON text (D7). */
const isJson = (d: TypeDesc) =>
  d.t === 'record' || d.t === 'enum' || d.t === 'option' || d.t === 'vec';

/** The TS type of a descriptor. Inside JSON, bytes are `number[]` (D7). */
function tsType(d: TypeDesc, json: boolean): string {
  switch (d.t) {
    case 'record':
    case 'enum':
      return d.name;
    case 'option':
      return `${tsType(d.of, true)} | null`;
    case 'vec': {
      const inner = tsType(d.of, true);
      return inner.includes(' | ') ? `(${inner})[]` : `${inner}[]`;
    }
    case 'bool':
      return 'boolean';
    case 'string':
      return 'string';
    case 'bytes':
      return json ? 'number[]' : 'Uint8Array';
    case 'unit':
      return 'void';
    default:
      return is64(d.t) ? 'bigint' : 'number';
  }
}

interface Expr {
  readonly code: string;
  /** No conversion: the value crosses as-is (so a container of it needs no walk). */
  readonly plain: boolean;
}

class Emitter {
  readonly used = new Set<string>();
  readonly encoders = new Set<string>();
  readonly decoders = new Set<string>();

  constructor(private readonly records: Map<string, RecordType>) {}

  /** Whether a JSON value of type `d` can hold a float, at any depth. */
  floaty(d: TypeDesc, seen: Set<string> = new Set()): boolean {
    if (d.t === 'f32' || d.t === 'f64') return true;
    if (d.t === 'option' || d.t === 'vec') return this.floaty(d.of, seen);
    if (d.t !== 'record' || seen.has(d.name)) return false;
    seen.add(d.name);
    return (this.records.get(d.name)?.fields ?? []).some((f) => this.floaty(f.type, seen));
  }

  /**
   * TS value -> JSON-ready value (64-bit integers become decimal strings, D7;
   * a non-finite float is a TypeError, as JSON would turn it into `null`).
   * `fn`/`at` are code for the export's name and the value's path, used only
   * on that error path (a container that holds no float gets neither).
   */
  enc(d: TypeDesc, expr: string, fn: string, at: string, depth: number): Expr {
    if (is64(d.t)) {
      this.used.add('$s64');
      return { code: `$s64(${expr})`, plain: false };
    }
    if (d.t === 'f32' || d.t === 'f64') {
      this.used.add('$efin');
      return {
        code: `(Number.isFinite(${expr}) ? ${expr} : $efin(${fn}, ${at}, ${expr}))`,
        plain: false,
      };
    }
    if (d.t === 'record') {
      this.needEncoder(d.name);
      const args = this.floaty(d) ? `${fn}, ${at}, ${expr}` : expr;
      return { code: `$e_${d.name}(${args})`, plain: false };
    }
    if (d.t === 'option' || d.t === 'vec') {
      const x = `$x${depth}`;
      const i = `$i${depth}`;
      const indexed = d.t === 'vec' && this.floaty(d.of);
      const inner = this.enc(d.of, x, fn, indexed ? `${at} + '[' + ${i} + ']'` : at, depth + 1);
      if (inner.plain) return { code: expr, plain: true };
      if (d.t === 'vec') {
        const params = indexed ? `${x}, ${i}` : x;
        return { code: `${expr}.map((${params}) => ${inner.code})`, plain: false };
      }
      this.used.add('$opt');
      return { code: `$opt(${expr}, (${x}) => ${inner.code})`, plain: false };
    }
    return { code: expr, plain: true };
  }

  /** Parsed JSON value -> TS value; `fn`/`at` name the export and the path for errors. */
  dec(d: TypeDesc, expr: string, fn: string, at: string, depth: number): Expr {
    if (is64(d.t)) {
      this.used.add('$d64');
      return { code: `$d64(${fn}, ${at}, ${expr})`, plain: false };
    }
    if (d.t === 'f32' || d.t === 'f64') {
      this.used.add('$fin');
      return { code: `$fin(${fn}, ${at}, ${expr})`, plain: false };
    }
    if (d.t === 'record') {
      this.needDecoder(d.name);
      return { code: `$d_${d.name}(${fn}, ${at}, ${expr})`, plain: false };
    }
    if (d.t === 'option') {
      const x = `$x${depth}`;
      const inner = this.dec(d.of, x, fn, at, depth + 1);
      if (inner.plain) return { code: `${expr} as ${tsType(d, true)}`, plain: true };
      this.used.add('$opt');
      return { code: `$opt(${expr}, (${x}) => ${inner.code})`, plain: false };
    }
    if (d.t === 'vec') {
      const x = `$x${depth}`;
      const a = `$at${depth}`;
      const inner = this.dec(d.of, x, fn, a, depth + 1);
      if (inner.plain) return { code: `${expr} as ${tsType(d, true)}`, plain: true };
      this.used.add('$vec');
      return { code: `$vec(${expr}, ${at}, (${x}, ${a}) => ${inner.code})`, plain: false };
    }
    return { code: `${expr} as ${tsType(d, true)}`, plain: true };
  }

  private needEncoder(name: string): void {
    if (this.encoders.has(name)) return;
    this.encoders.add(name);
    for (const f of this.records.get(name)?.fields ?? []) this.enc(f.type, 'x', 'fn', 'at', 0);
  }

  private needDecoder(name: string): void {
    if (this.decoders.has(name)) return;
    this.decoders.add(name);
    for (const f of this.records.get(name)?.fields ?? []) this.dec(f.type, 'x', 'fn', 'at', 0);
  }

  encoder(r: RecordType): string {
    const fields = r.fields.map(
      (f) =>
        `${key(f.name)}: ${this.enc(f.type, access('v', f.name), 'fn', `at + ${q(`.${f.name}`)}`, 0).code}`,
    );
    const params = this.floaty({ t: 'record', name: r.name }) ? 'fn: string, at: string, ' : '';
    return [
      `function $e_${r.name}(${params}v: ${r.name}): unknown {`,
      `  return { ${fields.join(', ')} };`,
      '}',
    ].join('\n');
  }

  decoder(r: RecordType): string {
    const fields = r.fields.map(
      (f) =>
        `${key(f.name)}: ${this.dec(f.type, `o[${q(f.name)}]`, 'fn', `at + ${q(`.${f.name}`)}`, 0).code}`,
    );
    return [
      `function $d_${r.name}(fn: string, at: string, v: unknown): ${r.name} {`,
      '  const o = v as Record<string, unknown>;',
      `  return { ${fields.join(', ')} };`,
      '}',
    ].join('\n');
  }

  /** One exported function. */
  fn(f: FnRecord): string {
    const lines: string[] = [];
    const name = q(f.name);
    const params = f.args.map((a) => `${a.name}: ${tsType(a.type, false)}`).join(', ');
    lines.push(`export function ${f.name}(${params}): ${tsType(f.ret.type, false)} {`);

    // 1. Validate every argument before anything else (D13 item 6).
    for (const a of f.args) {
      const t = a.type.t;
      const range = INT_RANGE[t];
      if (range) {
        this.used.add('$int');
        lines.push(`  $int(${name}, ${q(a.name)}, ${a.name}, ${range[0]}, ${range[1]});`);
      } else if (is64(t)) {
        const [lo, hi] = SIGNED_64.has(t) ? ['$I64_MIN', '$I64_MAX'] : ['$U64_MIN', '$U64_MAX'];
        this.used.add('$big');
        this.used.add(SIGNED_64.has(t) ? '$I64' : '$U64');
        lines.push(`  $big(${name}, ${q(a.name)}, ${a.name}, ${lo}, ${hi});`);
      } else if (t === 'f32' || t === 'f64') {
        this.used.add('$num');
        lines.push(`  $num(${name}, ${q(a.name)}, ${a.name});`);
      } else if (t === 'bool') {
        this.used.add('$bool');
        lines.push(`  $bool(${name}, ${q(a.name)}, ${a.name});`);
      } else if (t === 'string') {
        this.used.add('$str');
        lines.push(`  $str(${name}, ${q(a.name)}, ${a.name});`);
      } else if (t === 'bytes') {
        this.used.add('$bytes');
        lines.push(`  $bytes(${name}, ${q(a.name)}, ${a.name});`);
      }
    }
    lines.push('  if (!$ready) $load();');

    // 2. Encode every (ptr, len) argument into the scratch buffer, THEN take
    //    the pointer: a later argument may grow (replace) the buffer.
    const call: string[] = [];
    let buffers = 0;
    f.args.forEach((a, i) => {
      if (byValue(a.type)) {
        call.push(a.name);
        return;
      }
      buffers++;
      const value = isJson(a.type)
        ? `JSON.stringify(${this.enc(a.type, a.name, name, q(a.name), 0).code})`
        : a.name;
      lines.push(`  const $o${i} = $put(${value});`);
      lines.push(`  const $n${i} = $last;`);
      call.push(`$n${i} === 0 ? null : $scratch + $o${i}`, `$n${i}`);
    });
    if (buffers > 0) {
      this.used.add('$put');
      lines.push('  const $scratch = $base();');
    }
    call.push('$outPtr');
    // Timed around the symbol call alone: a call blocks the thread, so a slow
    // one is counted and logged (it cannot be interrupted), before any error.
    lines.push('  const $t0 = performance.now();');
    lines.push(`  const $st = $lib.${f.symbol}(${call.join(', ')});`);
    lines.push('  const $ms = performance.now() - $t0;');
    lines.push(`  if ($ms > $slowMs) $slow(${name}, $ms);`);
    lines.push(`  if ($st !== 0) $fail(${name}, $st);`);

    // 3. Read the return.
    const rt = f.ret.type;
    if (rt.t === 'unit') {
      // nothing written
    } else if (rt.t === 'string') {
      lines.push('  return $takeString();');
    } else if (rt.t === 'bytes') {
      this.used.add('$takeBytes');
      lines.push('  return $takeBytes();');
    } else if (isJson(rt)) {
      lines.push('  const $r: unknown = JSON.parse($takeString());');
      lines.push(`  return ${this.dec(rt, '$r', name, q('result'), 0).code};`);
    } else {
      lines.push(`  return ${READ[rt.t]};`);
    }
    lines.push('}');
    return lines.join('\n');
  }
}

function docBlock(doc: string, extra: string[]): string {
  const body: string[] = [];
  if (doc.trim() !== '') body.push(...noClose(doc.trim()).split('\n'), '');
  body.push(...extra);
  while (body.at(-1) === '') body.pop();
  return ['/**', ...body.map((l) => (l === '' ? ' *' : ` * ${l}`)), ' */'].join('\n');
}

/** `a`, `a or b`, `a, b or c`. */
function orList(items: string[]): string {
  return items.length < 2
    ? (items[0] ?? '')
    : `${items.slice(0, -1).join(', ')} or ${items.at(-1)}`;
}

function fnDoc(f: FnRecord, e: Emitter): string {
  const sig = `${f.name}(${f.args.map((a) => `${a.name}: ${a.rust}`).join(', ')}) -> ${f.ret.rust}`;
  const extra = [`Rust: \`${noClose(sig)}\``, ''];
  if (f.err) {
    extra.push(
      `@throws {RustError} when the Rust function returns \`Err\` (\`${noClose(f.err.rust)}\`).`,
    );
  }
  // Scalars, strings and bytes are checked before the call; JSON arguments are
  // not, so a value Rust cannot decode comes back as status 3 ("invalid input").
  const checked = f.args.filter((a) => !isJson(a.type)).map((a) => `\`${a.name}\``);
  const unchecked = f.args.filter((a) => isJson(a.type)).map((a) => `\`${a.name}\``);
  if (checked.length > 0) {
    extra.push(
      `@throws {TypeError} when ${orList(checked)} has the wrong type or is out of range.`,
    );
  }
  if (unchecked.length > 0) {
    extra.push(
      `@throws {RustError} ("invalid input: …") when ${orList(unchecked)} is a value Rust cannot decode: record, enum, Option and Vec arguments are not checked in JavaScript.`,
    );
  }
  const floaty = f.args
    .filter((a) => isJson(a.type) && e.floaty(a.type))
    .map((a) => `\`${a.name}\``);
  if (floaty.length > 0) {
    extra.push(
      `@throws {TypeError} when a number inside ${orList(floaty)} is NaN or Infinity (JSON cannot carry them).`,
    );
  }
  // Rust refuses to encode a non-finite float inside a JSON return; the shim
  // reports that as status 3, so the message carries the "invalid input" prefix.
  if (isJson(f.ret.type) && e.floaty(f.ret.type)) {
    extra.push(
      '@throws {RustError} ("invalid input: knext-ffi: the return value cannot cross as JSON: …") when a number inside the returned value is NaN or Infinity (JSON cannot carry them): a fault in the return value, despite the "invalid input" prefix.',
    );
  }
  extra.push(
    '@throws {RustPanicError} when the Rust function panics.',
    '@throws {FfiLoadError} when the Rust library cannot be loaded.',
  );
  return docBlock(f.doc, extra);
}

function typeDoc(doc: string): string {
  const d = noClose(doc.trim());
  if (d === '') return '';
  return d.includes('\n') ? `${docBlock(doc, [])}\n` : `/** ${d} */\n`;
}

// @upstream-shim bun-ffi-experimental
// The Beta label every generated module carries: `bun:ffi` is experimental
// upstream (Bun's own docs: "Do not rely on it in production"). It goes when
// that notice goes (ADR-0069 D19) — the upstream-retirement registry watches it.
export const BETA_LINE =
  'In-process Rust (Beta): calls go through bun:ffi, which Bun marks experimental, so this module runs only on Bun.';

const ERROR_CLASSES = `/** The Rust function returned \`Err\`, or rejected input it could not decode. */
export class RustError extends Error {
  /** The Rust export that failed. */
  readonly fn: string;
  constructor(fn: string, message: string) {
    super(message);
    this.name = 'RustError';
    this.fn = fn;
  }
}

/** The Rust function panicked. The process keeps running and the next call works. */
export class RustPanicError extends Error {
  /** The Rust export that panicked. */
  readonly fn: string;
  constructor(fn: string, message: string) {
    super(message);
    this.name = 'RustPanicError';
    this.fn = fn;
  }
}

/** The Rust library could not be loaded. Every later call throws this same error. */
export class FfiLoadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FfiLoadError';
  }
}`;

const PRERENDER = [
  'In-process Rust runs only at request time.',
  'This call happened while `next build` was prerendering: Rust functions cannot be called during prerendering, from generateStaticParams, or from generateMetadata of a static route.',
  "Make the route dynamic: add `export const dynamic = 'force-dynamic'` to the route segment, or `await connection()` (from 'next/server') before the call.",
].join(' ');

/** The loader and the call helpers every module needs. */
function runtime(e: Emitter, schemas: string, scratch: boolean): string {
  const parts: string[] = [];
  parts.push(`type $Arg = number | bigint | boolean | null;
type $Native = (...args: $Arg[]) => unknown;
interface $BunFfi {
  dlopen(
    path: string,
    symbols: Record<string, { readonly args: readonly string[]; readonly returns: string }>,
  ): { symbols: Record<string, $Native> };
  ptr(buffer: ArrayBuffer): number;
  CString: new (ptr: number, byteOffset: number, byteLength: number) => { toString(): string };
  toArrayBuffer(ptr: number, byteOffset: number, byteLength: number): ArrayBuffer;
}

let $ready = false;
let $failed: FfiLoadError | undefined;
let $ffi = undefined as unknown as $BunFfi;
let $lib = undefined as unknown as $Symbols;
let $view = undefined as unknown as DataView;
let $outPtr = 0;
/** Calls slower than this many milliseconds are counted and logged. Set on the first call (unreachable until then). */
let $slowMs = Infinity;
${
  scratch
    ? `let $buf = undefined as unknown as ArrayBuffer;
let $mem = new Uint8Array(0);
let $used = 0;
let $last = 0;
const $te = new TextEncoder();
`
    : ''
}
/** The first call loads the library; a failure is cached and rethrown on every later call. */
function $load(): void {
  if ($failed) throw $failed;
  const $t0 = performance.now();
  try {
    $open();
    $ready = true;
  } catch (err) {
    $failed =
      err instanceof FfiLoadError
        ? err
        : new FfiLoadError(
            \`knext ffi: could not load the Rust library: \${$show(err instanceof Error ? err.message : String(err))}\`,
          );
    throw $failed;
  }
  $slowMs = $threshold(process.env['KNEXT_FFI_SLOW_CALL_MS']);
  $loaded((performance.now() - $t0) / 1000);
}

/** The slow-call threshold in milliseconds: default 50; 0 turns counting off. */
function $threshold(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === '') return 50;
  const ms = Number(raw);
  if (ms === 0) return Infinity;
  if (Number.isFinite(ms) && ms > 0) return ms;
  console.warn(
    \`knext ffi: ignoring KNEXT_FFI_SLOW_CALL_MS="\${$show(raw)}": it must be a number of milliseconds (0 turns slow-call counting off). Using 50.\`,
  );
  return 50;
}

/**
 * The slow-call counts and load times, one registry per process. It lives on
 * globalThis because Next can load this module more than once (one copy per
 * bundler layer), and every copy must count into the same place. A Bun Worker
 * has its own globalThis, so a Worker's calls are logged but not served.
 */
interface $Registry {
  readonly slow: Map<string, number>;
  readonly logged: Map<string, number>;
  readonly load: Map<string, number>;
}

function $registry(): $Registry {
  const g = globalThis as unknown as Record<symbol, $Registry | undefined>;
  const key = Symbol.for('knext.ffi.metrics');
  let r = g[key];
  if (r === undefined) {
    r = { slow: new Map(), logged: new Map(), load: new Map() };
    g[key] = r;
  }
  return r;
}

/**
 * After the first successful load: list every function at 0, record how long
 * the load took (path resolution, the integrity hash, dlopen), and publish the
 * render function the app's metrics port appends.
 */
function $loaded(seconds: number): void {
  const r = $registry();
  for (const [fn] of $SCHEMAS) if (!r.slow.has(fn)) r.slow.set(fn, 0);
  if (!r.load.has($LIB)) r.load.set($LIB, seconds);
  (globalThis as unknown as Record<symbol, unknown>)[Symbol.for('knext.ffi.renderMetrics')] = $renderMetrics;
}

/** A call took longer than the threshold: count it, and log the first one per function. */
function $slow(fn: string, ms: number): void {
  const r = $registry();
  r.slow.set(fn, (r.slow.get(fn) ?? 0) + 1);
  if (r.logged.has(fn)) return;
  r.logged.set(fn, ms);
  console.warn(
    \`knext ffi: \${fn}() took \${ms.toFixed(1)} ms, over the \${$slowMs} ms slow-call threshold (KNEXT_FFI_SLOW_CALL_MS). A Rust call blocks this process for its whole duration: no other request is served and a shutdown cannot drain until it returns. Move long work to a zone function. Later slow calls to \${fn}() are counted in knext_ffi_slow_calls_total, not logged.\`,
  );
}

/** Prometheus text for the app's metrics port. */
function $renderMetrics(): string {
  const r = $registry();
  const out = [
    '# HELP knext_ffi_slow_calls_total In-process Rust calls slower than KNEXT_FFI_SLOW_CALL_MS (default 50 ms), by function. Each one blocked the process for its whole duration.',
    '# TYPE knext_ffi_slow_calls_total counter',
  ];
  for (const [fn, n] of [...r.slow].sort(([a], [b]) => (a < b ? -1 : 1))) {
    out.push(\`knext_ffi_slow_calls_total{fn="\${fn}"} \${n}\`);
  }
  out.push(
    '# HELP knext_ffi_load_seconds Seconds the first in-process Rust call spent loading the library (finding it, checking its sha256, opening it), by library.',
    '# TYPE knext_ffi_load_seconds gauge',
  );
  for (const [lib, s] of r.load) out.push(\`knext_ffi_load_seconds{lib="\${lib}"} \${s}\`);
  return \`\${out.join('\\n')}\\n\`;
}

function $open(): void {
  if (process.env['NEXT_PHASE'] === 'phase-production-build') {
    throw new FfiLoadError($PRERENDER);
  }
  if (!process.versions['bun']) {
    throw new FfiLoadError(
      \`In-process Rust (bun:ffi) runs only on Bun; this process is Node \${process.version}. Run the app with Bun (bun --bun next dev), or call this code through a zone function.\`,
    );
  }
  const ffi = process.getBuiltinModule('bun:ffi') as unknown as $BunFfi | undefined;
  if (!ffi) throw new FfiLoadError('knext ffi: this Bun has no bun:ffi module.');
  const [path, load] = $resolve();
  let symbols: Record<string, $Native>;
  try {
    symbols = ffi.dlopen(load, $SPEC).symbols;
  } catch (err) {
    // A descriptor handed to dlopen is never closed on success; on failure it is.
    const fd = /^\\/(?:proc\\/self|dev)\\/fd\\/(\\d+)$/.exec(load)?.[1];
    if (fd !== undefined) $closeSync(Number(fd));
    const via =
      load === path
        ? ''
        : \` (opened as \${$show(load)}\${load.startsWith('/proc/') ? ', which needs /proc mounted' : ''})\`;
    throw new FfiLoadError(
      \`knext ffi: could not load \${$show(path)}\${via}: \${$show(err instanceof Error ? err.message : String(err))}\\n\` +
        'If the library does not export a function this module calls, the module is stale: run \`knext ffi generate\` and commit the result.',
    );
  }
  // The symbol names carry each function's own signature; the records and
  // enums it uses are covered by its _schema value, checked once here.
  for (const [fn, symbol, expected] of $SCHEMAS) {
    const schema = symbols[\`\${symbol}_schema\`];
    const actual = schema ? String(schema()) : 'missing';
    if (actual !== expected) {
      throw new FfiLoadError(
        \`knext ffi: \${$show(path)} does not match this module: the records or enums \${fn}() uses have changed since it was generated (schema \${actual}, expected \${expected}). \` +
          'The module is stale: run \`knext ffi generate\` and commit the result.',
      );
    }
  }
  // The ArrayBuffer is created first and the pointer is taken of IT: the
  // pointer of a small typed array whose .buffer is read later can dangle
  // (JavaScriptCore moves that storage).
  const buf = new ArrayBuffer(16);
  $outPtr = ffi.ptr(buf);
  $view = new DataView(buf);
${
  scratch
    ? `  $buf = new ArrayBuffer(4096);
  $mem = new Uint8Array($buf);
`
    : ''
}  $ffi = ffi;
  $lib = symbols as unknown as $Symbols;
}

/** This process's Rust target triple. */
function $triple(): string {
  const arch = process.arch === 'x64' ? 'x86_64' : process.arch === 'arm64' ? 'aarch64' : '';
  if (arch !== '' && process.platform === 'darwin') return \`\${arch}-apple-darwin\`;
  if (arch !== '' && process.platform === 'linux') {
    return \`\${arch}-unknown-linux-\${$musl() ? 'musl' : 'gnu'}\`;
  }
  throw new FfiLoadError(\`knext ffi: no Rust library is built for \${process.platform}-\${process.arch}.\`);
}

/** musl or glibc: a glibc runtime reports its version; otherwise look for musl's loader. */
function $musl(): boolean {
  try {
    const report = process.report.getReport() as { header?: { glibcVersionRuntime?: unknown } };
    if (typeof report.header?.glibcVersionRuntime === 'string') return false;
  } catch {
    // fall through to the file-system probe
  }
  try {
    if ($readdirSync('/lib').some((f) => f.startsWith('ld-musl-'))) return true;
  } catch {
    // no /lib
  }
  return $existsSync('/etc/alpine-release');
}

/** [the library's path, for messages; the name to dlopen]. */
function $resolve(): readonly [string, string] {
  const triple = $triple();
  const file = \`lib\${$LIB}.\${process.platform === 'darwin' ? 'dylib' : 'so'}\`;
  const native = $join($dirname(process.execPath), 'native');
  const staged = $join(native, 'ffi', triple, file);
  const tried = [staged];
  // lstat, not existsSync: existsSync follows a link and says no to a dangling one, which would
  // read as "nothing staged" and fall through to the unchecked development build.
  if ($lstatSync(staged, { bigint: true, throwIfNoEntry: false }) !== undefined) {
    return [staged, $verify(native, $join('ffi', triple, file), staged)];
  }
  let others: string[] = [];
  try {
    others = $readdirSync($join(native, 'ffi')).filter((d) => d !== triple);
  } catch {
    // no native/ffi beside the executable
  }
  if (others.length > 0) {
    throw new FfiLoadError(
      \`knext ffi: \${$show($join(native, 'ffi'))} holds Rust libraries for \${$show(others.join(', '))}, but this process runs on \${triple}. Build the image for the platform it runs on.\`,
    );
  }
  if (process.env['NODE_ENV'] !== 'production') {
    const dev = ['release', 'debug'].map((p) => $join(process.cwd(), $CRATE, 'target', p, file));
    tried.push(...dev);
    const found = dev
      .filter((p) => $existsSync(p))
      .sort((a, b) => $statSync(b).mtimeMs - $statSync(a).mtimeMs);
    if (found[0] !== undefined) {
      console.warn(
        \`knext ffi: loading the development build \${$show(found[0])} without an integrity check (NODE_ENV is not "production").\`,
      );
      return [found[0], found[0]];
    }
  }
  throw new FfiLoadError(
    \`knext ffi: cannot find the Rust library \${$show(file)} for \${triple}. Tried:\\n\${tried.map((p) => \`  \${$show(p)}\`).join('\\n')}\\n\` +
      'The Dockerfile that \`knext build\`, \`knext deploy\` and \`knext preview\` stage puts it beside the server (knext ffi build builds it); in development, run \`knext ffi generate\`.',
  );
}

/** The part of a stat the checks read; fs.Stats and fs.BigIntStats both fit. */
type $Stat = {
  readonly dev: number | bigint;
  readonly ino: number | bigint;
  readonly uid: number | bigint;
  readonly mode: number | bigint;
};

/**
 * What is wrong with a stat'ed object, or '' when it is root's and group and other cannot write it.
 * Judged by owner and mode, never access(), which answers yes to root for everything. The user this
 * process runs as is NOT trusted: it can chmod what it owns, so a tree it owns protects nothing from
 * a bug that writes files. The mode is printed whole (the sticky, setuid and setgid bits included),
 * so a 1777 directory reads as 1777.
 */
function $why(st: $Stat): string {
  const bits = Number(st.mode);
  const mode = (bits & 0o7777).toString(8).padStart(4, '0');
  if (Number(st.uid) !== 0) return \`is owned by uid \${st.uid}, but only root may own it\`;
  if ((bits & 0o022) !== 0) return \`is writable by its group or by everyone (mode \${mode})\`;
  return '';
}

/**
 * Fail closed unless root owns the file and group and other cannot write it. p is the file judged,
 * path the library the refusal is about. (A directory is judged by $sealed, which lists every one
 * that fails: the fix for a directory is not the fix for a file.)
 */
function $judge(path: string, p: string, st: $Stat): void {
  const why = $why(st);
  if (why !== '') {
    throw new FfiLoadError(
      \`knext ffi: refusing to load \${$show(path)}: \${$show(p)} \${why}, so its bytes could change after they were checked. The library and its integrity manifest must be owned by root and not writable by group or other (the Dockerfile that \\\`knext build\\\`, \\\`knext deploy\\\` and \\\`knext preview\\\` stage copies native/ with \\\`COPY --chown=0:0 --chmod=a-w\\\`), and the app should run as a non-root user; every directory from the library up to / must also be owned by root and not writable by group or other.\`,
    );
  }
}

/** What a stat says an object is: its type bits (S_IFREG, S_IFDIR, S_IFLNK, ...). */
function $type(st: $Stat): number {
  return Number(st.mode) & $constants.S_IFMT;
}

/** Which object a stat describes. An object keeps it through a rename; a replacement has another. */
function $id(st: $Stat): string {
  return \`\${st.dev}:\${st.ino}\`;
}

/** A directory the check relied on, and which object it was: [path, $id]. */
type $Pin = readonly [string, string];

/** Every directory from dir up to the root, dir first. */
function $upTo(dir: string): string[] {
  const out: string[] = [];
  for (let d = dir; ; d = $dirname(d)) {
    out.push(d);
    if ($dirname(d) === d) return out;
  }
}

/**
 * A path, a value read from a file or the environment, or a system error that quotes one, as a
 * refusal prints it. A control character (a newline above all) in a directory name would start a
 * line of its own in the list of directories, which is read as one directory a line, and a
 * bidirectional control would reorder the text around it. So the output is made unambiguous. A C0
 * control or DEL is shown in caret notation (a newline as ^J). A backslash is doubled and a caret
 * gets a backslash before it, so a name that really holds ^J, or the text of a unicode escape, can
 * never be read as a control character. A C1 control, a line or paragraph separator (U+2028,
 * U+2029: a line end to many terminals and log readers) and a bidirectional control (U+061C,
 * U+200E, U+200F, U+202A to U+202E, U+2066 to U+2069) are shown as a unicode escape (a backslash,
 * u and four hex digits). None is ever printed as itself, and it never throws.
 */
function $show(p: string): string {
  let out = '';
  for (const ch of String(p)) {
    const n = ch.codePointAt(0) as number;
    if (n < 0x20 || n === 0x7f) out += \`^\${String.fromCharCode(n ^ 0x40)}\`;
    else if (ch === '\\\\' || ch === '^') out += \`\\\\\${ch}\`;
    else if (
      (n >= 0x80 && n <= 0x9f) ||
      n === 0x61c ||
      n === 0x200e ||
      n === 0x200f ||
      n === 0x2028 ||
      n === 0x2029 ||
      (n >= 0x202a && n <= 0x202e) ||
      (n >= 0x2066 && n <= 0x2069)
    ) {
      out += \`\\\\u\${n.toString(16).padStart(4, '0')}\`;
    } else out += ch;
  }
  return out;
}

/**
 * Judge, and pin, every directory the check relies on: the library's, from the one it sits in up
 * to native/ itself, then the directory native/ sits in (beside the executable), then every
 * directory above that up to the root. Each is looked at with lstat (a link is never followed),
 * must be a real directory, owned by root and not writable by group or other. They are judged here,
 * BEFORE the manifest or the library is opened, and $unchanged looks at the same names again once
 * the bytes are hashed, so a tree renamed over them in between is refused. Every directory that
 * fails is listed in the one refusal.
 *
 * The directory beside the executable must be its own real path. Bun reports process.execPath
 * already resolved, so an install behind a link (current -> releases/N, /tmp -> /private/tmp) gets
 * here as the real path and its directories are judged as they are. The comparison is a fail-closed
 * assertion on that: a path that is not its own real path (a relative one, or one through a link)
 * is refused, never followed, because the lookups would go through it and the directories judged
 * would be somebody else's.
 *
 * Why every ancestor: a directory a user can write is one that user can rename the tree out of, and
 * put another in its place. With every directory from native/ up to the root owned by root and
 * closed to group and other, nobody but root can rename or replace any of them, so looking them up
 * by path is sound (Bun has no openat, and macOS has no descriptor-relative path, so a lookup cannot
 * be anchored to a directory descriptor). The pins and the file checks below are defence in depth:
 * what remains is code running as root (or with a capability equivalent to root: CAP_DAC_OVERRIDE,
 * CAP_FOWNER, CAP_CHOWN, CAP_SETUID, CAP_SYS_ADMIN, CAP_SYS_PTRACE, CAP_MKNOD, CAP_SYS_MODULE,
 * CAP_SYS_RAWIO, CAP_BPF), a second writable mount of the same files, an ACL, or a write to
 * /proc/self/mem, and none of that can be told apart from the real tree by any lookup.
 *
 * The advice follows the situation, not the position, because a directory at or above the
 * executable's can be the app's own (the prefix directories of a nested image, /app/.next, a
 * chmod 777 /app) or shared (a /tmp, a root:staff /usr/local, a home directory) and the loader
 * cannot tell which. A directory inside native/ is always the app's: it is told how to fix it in
 * place. A STICKY directory at the executable's level or above it is a shared one (a /tmp):
 * changing its owner or mode would break what else uses it, so it is told only to move the install.
 * Any other failing directory (a world-writable one that is not sticky, one owned by the wrong
 * user, a group-writable one) is told both, each with its condition (part of the app's install: fix
 * it; shared, or a home directory: move it, and never give a home directory to root), and that the
 * executable needs a directory of its own.
 */
function $sealed(native: string, rel: string, path: string): $Pin[] {
  const home = $dirname(native);
  let real: string;
  try {
    real = $realpathSync(home);
  } catch (err) {
    throw new FfiLoadError(
      \`knext ffi: refusing to load \${$show(path)}: cannot resolve the directory \${$show(home)} (\${$show(err instanceof Error ? err.message : String(err))}).\`,
    );
  }
  if (real !== home) {
    throw new FfiLoadError(
      \`knext ffi: refusing to load \${$show(path)}: \${$show(home)} is not the real path of its directory (it resolves to \${$show(real)}), \${home.startsWith('/') ? "so the executable's path goes through a symbolic link at or above its directory. A link is never followed, whatever it points at, because the lookups would not go where the judgement did: run the executable by its real path." : "because the executable's path is relative. What is judged must be the directory the lookups reach: run the executable by its absolute path."}\`,
    );
  }
  const parts = rel.split('/');
  const dirs: string[] = [];
  for (let i = parts.length - 1; i >= 0; i--) dirs.push($join(native, ...parts.slice(0, i)));
  // The directories inside native/ (native/ itself too) come first, then the executable's own
  // directory (at index \`inside\`), then each one above it.
  const inside = dirs.length;
  const up = $upTo(home);
  dirs.push(...up);
  const pins: $Pin[] = [];
  const bad: string[] = [];
  let fix = false;
  let either = false;
  let move = false;
  let link = false;
  let other = false;
  for (const [i, dir] of dirs.entries()) {
    const st = $lstatSync(dir, { bigint: true });
    const type = $type(st);
    if (type !== $constants.S_IFDIR) {
      if (type === $constants.S_IFLNK) link = true;
      else other = true;
      bad.push(
        \`\${$show(dir)} \${type === $constants.S_IFLNK ? 'is a symbolic link' : type === $constants.S_IFREG ? 'is a regular file, not a directory' : 'is not a directory'}\`,
      );
      continue;
    }
    const why = $why(st);
    if (why !== '') {
      bad.push(\`\${$show(dir)} \${why}\`);
      if (i < inside) fix = true;
      else if ((Number(st.mode) & 0o1000) !== 0) move = true;
      else either = true;
    }
    pins.push([dir, $id(st)]);
  }
  if (bad.length > 0) {
    throw new FfiLoadError(
      \`knext ffi: refusing to load \${$show(path)}: \${bad.length === 1 ? '1 directory' : \`\${bad.length} directories\`} on the way to it cannot be trusted, so what is under \${bad.length === 1 ? 'it' : 'them'} could be renamed or replaced after it was checked:\\n\${bad.map((b) => \`  \${b}\`).join('\\n')}\\nEvery directory from the library up to / must be a real directory, owned by root and not writable by group or other.\${fix ? " To fix a directory inside native/: run \`chmod go-w <dir>\` (and \`chown root <dir>\` if root does not own it), as root; or, in a Dockerfile, \`RUN chmod go-w <dir>\` after the COPY that brought it in (a directory inside a copied tree keeps the build host's mode)." : ''}\${either ? " A directory that holds the executable or sits above it: if it is part of your app's install, run \`chmod go-w <dir>\` (and \`chown root <dir>\` if root does not own it), as root, or, in a Dockerfile, \`RUN chmod go-w <dir>\` after the COPY that brought it in. If it is shared with other software, or is a home directory such as /home/<user>, do not change its owner or mode (never give a home directory to root): move the install instead. The executable needs a directory of its own, owned by root and closed to group and other, such as /opt/<app>." : ''}\${move ? " A sticky directory (a shared one such as /tmp) that holds the executable or sits above it is shared with other software, so do not change its owner or mode: move the install under a root-owned, closed directory such as /opt/<app> instead." : ''}\${link ? ' A link is never followed, whatever it points at: replace it with the directory itself.' : ''}\${other ? ' Something that is not a directory is where a directory must be: replace it with the directory.' : ''}\`,
    );
  }
  return pins;
}

/** Every pinned directory must still be the object that was judged; fail closed if one is not. */
function $unchanged(path: string, pins: readonly $Pin[]): void {
  for (const [dir, id] of pins) {
    const now = $lstatSync(dir, { bigint: true, throwIfNoEntry: false });
    if (now === undefined || $id(now) !== id) {
      throw new FfiLoadError(
        \`knext ffi: refusing to load \${$show(path)}: \${$show(dir)} changed while it was being checked (it was renamed, replaced or removed, so it is not the directory that was judged), and the manifest or the library may have come from another tree.\`,
      );
    }
  }
}

/** A file that was read must still be what its path names; fail closed if it is not. */
function $same(path: string, file: string, id: string): void {
  const now = $lstatSync(file, { bigint: true, throwIfNoEntry: false });
  if (now === undefined || $id(now) !== id) {
    throw new FfiLoadError(
      \`knext ffi: refusing to load \${$show(path)}: \${$show(file)} is no longer the file that was read (it was renamed, replaced or removed while it was being checked), so what was judged may not be what is at that path now.\`,
    );
  }
}

/** A file opened for reading, and what it is. */
interface $Opened {
  readonly fd: number;
  readonly st: $Stat;
}

/**
 * Open a regular file read-only WITHOUT following a symlink at the end of its path (O_NOFOLLOW)
 * and WITHOUT waiting on it (O_NONBLOCK: a FIFO opened for reading blocks until a writer
 * appears, which would hang the first call for ever). A link is refused, never followed to
 * whatever it points at; anything that is not a regular file (a pipe, a device, a directory) is
 * refused. missing is the refusal for a file that is not there.
 */
function $openFile(path: string, what: string, lib: string, missing: string): $Opened {
  const nofollow = $constants.O_NOFOLLOW;
  const nonblock = $constants.O_NONBLOCK;
  if (!(nofollow > 0) || !(nonblock > 0)) {
    throw new FfiLoadError(\`knext ffi: refusing to load \${$show(lib)}: this platform cannot open \${what} without following links or blocking (it needs O_NOFOLLOW and O_NONBLOCK).\`);
  }
  let fd: number;
  try {
    fd = $openSync(path, $constants.O_RDONLY | nofollow | nonblock);
  } catch (err) {
    const code = (err as { code?: unknown }).code;
    if (code === 'ENOENT') throw new FfiLoadError(missing);
    throw new FfiLoadError(
      code === 'ELOOP'
        ? \`knext ffi: refusing to load \${$show(lib)}: \${$show(path)} is a symbolic link. \${what} must be the file itself: a link is never followed, whatever it points at.\`
        : \`knext ffi: refusing to load \${$show(lib)}: cannot open \${$show(path)} (\${$show(err instanceof Error ? err.message : String(err))}).\`,
    );
  }
  const st = $fstatSync(fd, { bigint: true });
  if ($type(st) !== $constants.S_IFREG) {
    $closeSync(fd);
    throw new FfiLoadError(\`knext ffi: refusing to load \${$show(lib)}: \${$show(path)} is not a regular file. \${what} must be a plain file: a pipe, a device or a directory is never read.\`);
  }
  return { fd, st };
}

/**
 * Fail closed: the library must be listed in native/.integrity.json with a matching sha256, and
 * only root may be able to write the manifest, the library or the way to them (see $sealed and
 * $judge). Each of the two files is opened without following a link, judged on the descriptor it
 * was opened as, and read through that descriptor: nothing renamed over its path afterwards can
 * change what was judged, and after the hash each path is looked at again and must still name the
 * file that was read. The manifest is judged because it is what authorises a file: one anyone
 * else could write would let any file root owns pass.
 * Returns the name to dlopen: the descriptor the hashed bytes were read through
 * (/proc/self/fd/<n> on Linux, /dev/fd/<n> on macOS), so a file renamed or linked
 * over the path after the check is not the one loaded.
 */
function $verify(native: string, rel: string, path: string): string {
  const pins = $sealed(native, rel, path);
  const manifest = $join(native, '.integrity.json');
  const m = $openFile(
    manifest,
    'the integrity manifest',
    path,
    \`knext ffi: refusing to load \${$show(path)}: there is no integrity manifest at \${$show(manifest)}. The Dockerfile that \\\`knext build\\\`, \\\`knext deploy\\\` and \\\`knext preview\\\` stage copies a native/ that carries one.\`,
  );
  let text: string;
  try {
    $judge(path, manifest, m.st);
    text = $readFileSync(m.fd, 'utf8');
  } finally {
    $closeSync(m.fd);
  }
  let version: unknown;
  let files: unknown;
  try {
    const parsed = JSON.parse(text) as { version?: unknown; files?: unknown };
    version = parsed.version;
    files = parsed.files;
  } catch (err) {
    throw new FfiLoadError(
      \`knext ffi: refusing to load \${$show(path)}: cannot read \${$show(manifest)} (\${$show(err instanceof Error ? err.message : String(err))}).\`,
    );
  }
  if (version !== 1) {
    throw new FfiLoadError(
      \`knext ffi: refusing to load \${$show(path)}: cannot read \${$show(manifest)} (unsupported version \${typeof version === 'string' ? \`"\${$show(version)}"\` : $show(String(JSON.stringify(version)))}).\`,
    );
  }
  const expected =
    typeof files === 'object' && files !== null ? (files as Record<string, unknown>)[rel] : undefined;
  if (typeof expected !== 'string') {
    throw new FfiLoadError(\`knext ffi: refusing to load \${$show(path)}: \${$show(rel)} is not listed in \${$show(manifest)}.\`);
  }
  // The digest is compared as text and printed on a mismatch, so it must BE a digest first.
  if (!/^[0-9a-f]{64}$/.test(expected)) {
    throw new FfiLoadError(
      \`knext ffi: refusing to load \${$show(path)}: \${$show(manifest)} lists \${$show(rel)} as "\${$show(expected)}", which is not a sha256 digest (64 lowercase hexadecimal digits).\`,
    );
  }
  const lib = $openFile(path, 'the library', path, \`knext ffi: refusing to load \${$show(path)}: it is gone.\`);
  let actual: string;
  try {
    $judge(path, path, lib.st);
    actual = $createHash('sha256').update($readFileSync(lib.fd)).digest('hex');
    $unchanged(path, pins);
    $same(path, manifest, $id(m.st));
    $same(path, path, $id(lib.st));
  } catch (err) {
    $closeSync(lib.fd);
    throw err;
  }
  if (actual !== expected) {
    $closeSync(lib.fd);
    throw new FfiLoadError(
      \`knext ffi: refusing to load \${$show(path)}: sha256 mismatch\\n  expected \${expected}\\n  actual   \${actual}\`,
    );
  }
  if (process.platform !== 'linux' && process.platform !== 'darwin') {
    $closeSync(lib.fd);
    throw new FfiLoadError(
      \`knext ffi: refusing to load \${$show(path)}: \${process.platform} has no descriptor path to load the checked bytes through (only linux and darwin do).\`,
    );
  }
  // Never closed once dlopen has seen its name: glibc finds an already-loaded
  // library by that name, and the next open would reuse the number.
  return process.platform === 'darwin' ? \`/dev/fd/\${lib.fd}\` : \`/proc/self/fd/\${lib.fd}\`;
}

/** A Rust-owned (ptr, len) pair from the out slot, read as two u32 halves (no BigInt per call). */
function $takeString(): string {
  const len = $view.getUint32(8, true) + $view.getUint32(12, true) * 4294967296;
  if (len === 0) return '';
  const p = $view.getUint32(0, true) + $view.getUint32(4, true) * 4294967296;
  try {
    return new $ffi.CString(p, 0, len).toString();
  } finally {
    $lib.knext_ffi_v1_free(p, len);
  }
}

function $fail(fn: string, status: number): never {
  if (status === 1 || status === 2 || status === 3) {
    const message = $takeString();
    if (status === 2) throw new RustPanicError(fn, message);
    throw new RustError(fn, status === 3 ? \`invalid input: \${message}\` : message);
  }
  throw new Error(
    \`knext ffi: \${fn}() returned status \${status}, which ABI v1 does not define; this is a bug in the generated module or the knext-ffi crate.\`,
  );
}`);

  if (e.used.has('$takeBytes')) {
    parts.push(`function $takeBytes(): Uint8Array {
  const len = $view.getUint32(8, true) + $view.getUint32(12, true) * 4294967296;
  if (len === 0) return new Uint8Array(0);
  const p = $view.getUint32(0, true) + $view.getUint32(4, true) * 4294967296;
  try {
    return new Uint8Array($ffi.toArrayBuffer(p, 0, len)).slice();
  } finally {
    $lib.knext_ffi_v1_free(p, len);
  }
}`);
  }
  if (scratch) {
    parts.push(`/**
 * Phase 1 of a call: copy one (ptr, len) argument into the scratch buffer at
 * the next 8-byte-aligned offset, growing it as needed. Returns the OFFSET (the
 * length is left in $last); no pointer is taken here.
 */
function $put(v: string | Uint8Array): number {
  const at = Math.ceil($used / 8) * 8;
  const max = typeof v === 'string' ? v.length * 3 : v.byteLength;
  $last = 0;
  if (max === 0) return at;
  if (at + max > $mem.length) $grow(at + max);
  if (typeof v === 'string') {
    $last = $te.encodeInto(v, $mem.subarray(at)).written;
  } else {
    $mem.set(v, at);
    $last = v.byteLength;
  }
  $used = at + $last;
  return at;
}

/** A larger buffer with the bytes so far copied over. The old one is zeroed, so a pointer into it can never read a stale argument. */
function $grow(need: number): void {
  const next = new ArrayBuffer(Math.max(need, $mem.length * 2));
  const mem = new Uint8Array(next);
  mem.set($mem.subarray(0, $used));
  $mem.fill(0);
  $buf = next;
  $mem = mem;
}

/** Phase 2: the pointer of the FINAL scratch buffer, taken after every argument is in it; resets it for the next call. */
function $base(): number {
  $used = 0;
  return $ffi.ptr($buf);
}`);
  }

  const checks: Record<string, string> = {
    $shown: `/** A number or bigint for an error message: bounded (a huge bigint is a bit count, never its digits), and the only values ever echoed. */
function $shown(v: number | bigint): string {
  if (typeof v === 'number') return v === 0 && 1 / v < 0 ? '-0' : String(v);
  const hex = v.toString(16).length;
  return hex > 24 ? \`about \${hex * 4} bits\` : String(v);
}`,
    $int: `function $int(fn: string, arg: string, v: unknown, min: number, max: number): void {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < min || v > max) {
    throw new TypeError(\`\${fn}(): argument "\${arg}" must be an integer from \${min} to \${max}, got \${typeof v === 'number' ? $shown(v) : typeof v}\`);
  }
}`,
    $big: `function $big(fn: string, arg: string, v: unknown, min: bigint, max: bigint): void {
  if (typeof v !== 'bigint' || v < min || v > max) {
    const got = typeof v === 'number' || typeof v === 'bigint' ? \`\${typeof v} \${$shown(v)}\` : typeof v;
    throw new TypeError(\`\${fn}(): argument "\${arg}" must be a bigint from \${min} to \${max}, got \${got}\`);
  }
}`,
    $num: `function $num(fn: string, arg: string, v: unknown): void {
  if (typeof v !== 'number') throw new TypeError(\`\${fn}(): argument "\${arg}" must be a number, got \${typeof v}\`);
}`,
    $bool: `function $bool(fn: string, arg: string, v: unknown): void {
  if (typeof v !== 'boolean') throw new TypeError(\`\${fn}(): argument "\${arg}" must be a boolean, got \${typeof v}\`);
}`,
    $str: `function $str(fn: string, arg: string, v: unknown): void {
  if (typeof v !== 'string') throw new TypeError(\`\${fn}(): argument "\${arg}" must be a string, got \${typeof v}\`);
}`,
    $bytes: `function $bytes(fn: string, arg: string, v: unknown): void {
  if (!(v instanceof Uint8Array)) throw new TypeError(\`\${fn}(): argument "\${arg}" must be a Uint8Array\`);
}`,
    $s64: `/** A 64-bit integer crosses JSON as a decimal string. */
function $s64(v: bigint): string {
  return v.toString();
}`,
    $d64: `function $d64(fn: string, at: string, v: unknown): bigint {
  if (typeof v !== 'string' || !/^-?[0-9]+$/.test(v)) {
    throw new RustError(fn, \`\${at}: expected a 64-bit integer as a decimal string, got \${JSON.stringify(v)}\`);
  }
  return BigInt(v);
}`,
    $fin: `function $fin(fn: string, at: string, v: unknown): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new RustError(
      fn,
      \`\${at}: expected a finite number, got \${v === null ? 'null (NaN and Infinity cannot cross as JSON)' : JSON.stringify(v)}\`,
    );
  }
  return v;
}`,
    $efin: `/** Called only for a value that is not a finite number: a NaN or Infinity cannot cross as JSON. */
function $efin(fn: string, at: string, v: unknown): unknown {
  if (typeof v === 'number') {
    throw new TypeError(\`\${fn}(): argument "\${at}" must be a finite number (JSON has no NaN or Infinity), got \${String(v)}\`);
  }
  return v;
}`,
    $opt: `function $opt<T, U>(v: T | null | undefined, f: (x: T) => U): U | null {
  return v === null || v === undefined ? null : f(v);
}`,
    $vec: `function $vec<U>(v: unknown, at: string, f: (x: unknown, at: string) => U): U[] {
  return (v as unknown[]).map((x, i) => f(x, \`\${at}[\${i}]\`));
}`,
  };
  if (e.used.has('$I64')) {
    parts.push(
      "const $I64_MIN = BigInt('-9223372036854775808');\nconst $I64_MAX = BigInt('9223372036854775807');",
    );
  }
  if (e.used.has('$U64')) {
    parts.push("const $U64_MIN = BigInt('0');\nconst $U64_MAX = BigInt('18446744073709551615');");
  }
  if (e.used.has('$int') || e.used.has('$big')) e.used.add('$shown');
  for (const [name, text] of Object.entries(checks)) if (e.used.has(name)) parts.push(text);
  parts.push(schemas);
  return parts.join('\n\n');
}

/**
 * Render the module for `manifest` (ADR-0069 D13). Pure: the same manifest and
 * options give the same text, whatever the order of records in the library.
 */
export function renderModule(manifest: Manifest, options: RenderOptions): string {
  if (!/^[A-Za-z0-9_]+$/.test(options.libName)) {
    throw new Error(`renderModule: "${options.libName}" is not a library name`);
  }
  const records = new Map(manifest.records.map((r) => [r.name, r]));
  const e = new Emitter(records);

  const fnBlocks = manifest.fns.map((f) => `${fnDoc(f, e)}\n${e.fn(f)}`);
  // Record codecs, in name order (the encoder/decoder sets grow transitively while emitting).
  const codecs: string[] = [];
  for (const r of manifest.records) {
    if (e.encoders.has(r.name)) codecs.push(e.encoder(r));
    if (e.decoders.has(r.name)) codecs.push(e.decoder(r));
  }
  const scratch = e.used.has('$put');

  const types = [
    ...manifest.records.map(
      (r) =>
        `${typeDoc(r.doc)}export interface ${r.name} {\n${r.fields
          .map((f) => `  ${key(f.name)}: ${tsType(f.type, true)};\n`)
          .join('')}}`,
    ),
    ...manifest.enums.map(
      (en) =>
        `${typeDoc(en.doc)}export type ${en.name} = ${
          en.variants.length === 0 ? 'never' : en.variants.map(q).join(' | ')
        };`,
    ),
  ];

  const spec = [
    "  knext_ffi_v1_free: { args: ['ptr', 'usize'], returns: 'void' },",
    ...manifest.fns.flatMap((f) => {
      const args = [
        ...f.args.flatMap((a) =>
          byValue(a.type) ? [q(FFI_TYPE[a.type.t] as string)] : ["'ptr'", "'usize'"],
        ),
        "'ptr'",
      ];
      return [
        `  ${f.symbol}: { args: [${args.join(', ')}], returns: 'i32' },`,
        `  ${f.symbol}_schema: { args: [], returns: 'u64' },`,
      ];
    }),
  ];
  const symbolsIface = [
    'interface $Symbols {',
    '  knext_ffi_v1_free(ptr: number, len: number): void;',
    ...manifest.fns.map((f) => `  ${f.symbol}(...args: $Arg[]): number;`),
    '}',
  ];
  const schemas = [
    '/** [export, symbol, expected FNV-1a 64 of its transitive schema]. */',
    'const $SCHEMAS: readonly (readonly [string, string, string])[] = [',
    ...manifest.fns.map(
      (f) =>
        `  [${q(f.name)}, ${q(f.symbol)}, ${q(fnv1a64(schemaString(f, manifest)).toString())}],`,
    ),
    '];',
  ].join('\n');

  const out = [
    '// Generated by `knext ffi generate`. Do not edit: change the Rust crate, then run `knext ffi generate`.',
    `// ${BETA_LINE}`,
    `// ABI: knext_ffi v1. Library: lib${options.libName} (crate ${options.crate}). From manifest sha256 ${manifestDigest(manifest)}.`,
    "import 'server-only';",
    "import { createHash as $createHash } from 'node:crypto';",
    'import {',
    '  closeSync as $closeSync,',
    '  constants as $constants,',
    '  existsSync as $existsSync,',
    '  fstatSync as $fstatSync,',
    '  lstatSync as $lstatSync,',
    '  openSync as $openSync,',
    '  readdirSync as $readdirSync,',
    '  readFileSync as $readFileSync,',
    '  realpathSync as $realpathSync,',
    '  statSync as $statSync,',
    "} from 'node:fs';",
    "import { dirname as $dirname, join as $join } from 'node:path';",
    '',
    ERROR_CLASSES,
    '',
    ...types.flatMap((t) => [t, '']),
    ...fnBlocks.flatMap((b) => [b, '']),
    '// ---------------------------------------------------------------------------',
    '// Internals. Nothing below runs at import time: the first call loads the library.',
    '// ---------------------------------------------------------------------------',
    '',
    `const $LIB = ${q(options.libName)};`,
    `const $CRATE = ${q(options.crate)};`,
    `const $PRERENDER = ${q(PRERENDER)};`,
    '',
    'const $SPEC = {',
    ...spec,
    '};',
    '',
    symbolsIface.join('\n'),
    '',
    runtime(e, schemas, scratch),
    ...codecs.flatMap((c) => ['', c]),
  ];
  return `${out.join('\n')}\n`;
}
