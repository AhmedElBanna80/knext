/**
 * The GENERATED module, run against a REAL shared library (ADR-0069 D13, D15
 * step 2, D20): every path-resolution branch, the fail-closed integrity check,
 * the development fallback, the wrong-platform and stale-wrapper refusals, the
 * prerender refusal, the Node guard, and the calls themselves (marshalling,
 * 64-bit values above 2^53, JSON records, errors, panics, frees).
 *
 * The library is fixtures/abi-v1/fixture.c — ABI v1 implemented in C and
 * built with the system `cc` — carrying the kitchen-sink manifest. The same
 * generated code is scanned from and called against a REAL Rust library (the
 * crates/knext-ffi-fixture cdylib, and the crate `knext ffi init` writes) by
 * crates/harness/ffi-generated.ts, in the Rust crates CI lane: that half needs
 * cargo, which this suite's checkout does not provide.
 *
 * Each scenario runs in a fresh process — `bun --conditions=react-server`
 * (Next's server condition, so `import 'server-only'` resolves), or `node`
 * for the Node guard — because the module caches its first load.
 */

import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { fnv1a64, type Manifest, scanManifest, schemaString } from '../manifest';
import { renderModule } from '../render';
import {
  blob,
  D,
  emptyDir,
  fn,
  KITCHEN_SINK,
  makeWritable,
  PKG_DIR,
  removeScratchDirs,
} from './helpers';
import { integerMatrix } from './integer-matrix';

const FIXTURE_C = join(PKG_DIR, 'fixtures', 'abi-v1', 'fixture.c');
const EXT = process.platform === 'darwin' ? 'dylib' : 'so';
const LIB = `libfixture.${EXT}`;

/** The triple the generated module computes for this host (same rule as its $triple). */
function hostTriple(): string {
  const arch = process.arch === 'x64' ? 'x86_64' : 'aarch64';
  if (process.platform === 'darwin') return `${arch}-apple-darwin`;
  let musl = false;
  try {
    musl = readdirSync('/lib').some((f) => f.startsWith('ld-musl-'));
  } catch {}
  return `${arch}-unknown-linux-${musl || existsSync('/etc/alpine-release') ? 'musl' : 'gnu'}`;
}
const TRIPLE = hostTriple();

/** How long the slow fixture's `add` blocks: well past the 50 ms default threshold. */
const SLOW_ADD_MS = 80;
/** Core's tracing-off loopback metrics listener, which serves the seam the module publishes. */
const CORE_DEEP_HEALTH_LITE = join(
  PKG_DIR,
  '..',
  'kn-next',
  'src',
  'adapters',
  'deep-health-lite.ts',
);

let work: string;
let app: string;
let manifest: Manifest;
const libs: Record<string, string> = {};

function header(m: Manifest): string {
  const out: string[] = ['#pragma once', '#include <stdint.h>'];
  for (const f of m.fns) {
    out.push(`#define SYM_${f.name} ${f.symbol}`);
    out.push(
      `uint64_t ${f.symbol}_schema(void) { return ${fnv1a64(schemaString(f, m)).toString()}ULL` +
        '\n#ifdef BAD_SCHEMA\n + 1\n#endif\n; }',
    );
  }
  KITCHEN_SINK.forEach((r, i) => {
    const c = JSON.stringify(`KNEXTFFI1${JSON.stringify(r)}`);
    out.push(`__attribute__((used)) const char knext_manifest_${i}[] = ${c};`);
  });
  return `${out.join('\n')}\n`;
}

function cc(name: string, flags: string[]): string {
  const dir = join(work, 'build', name);
  mkdirSync(dir, { recursive: true });
  const out = join(dir, LIB);
  const r = spawnSync(
    'cc',
    ['-shared', '-fPIC', '-O1', '-I', work, ...flags, '-o', out, FIXTURE_C],
    { encoding: 'utf8' },
  );
  if (r.status !== 0) throw new Error(`cc ${name} failed: ${r.error?.message ?? ''}${r.stderr}`);
  return out;
}

const sha256 = (p: string) => createHash('sha256').update(readFileSync(p)).digest('hex');

/** `dev:ino` of a path: the key FAKE_OWNER_INO answers to (an object keeps it through a rename). */
function idOf(p: string): string {
  const st = statSync(p, { bigint: true });
  return `${st.dev}:${st.ino}`;
}

/**
 * Make a staged tree what the image carries (`COPY --chown=0:0 --chmod=a-w`):
 * the integrity manifest, every library and every directory above it, up to
 * native/, read-only. The loader judges the manifest by owner and mode like the
 * library: a swapped-in manifest is what lets any root-owned file pass.
 */
function sealImage(exe: string): void {
  const native = join(exe, '..', 'native');
  const readOnly = (p: string) => chmodSync(p, statSync(p).mode & ~0o222); // a-w
  if (existsSync(join(native, '.integrity.json'))) readOnly(join(native, '.integrity.json'));
  for (const triple of readdirSync(join(native, 'ffi'))) {
    for (const f of readdirSync(join(native, 'ffi', triple))) {
      readOnly(join(native, 'ffi', triple, f));
    }
    readOnly(join(native, 'ffi', triple));
  }
  readOnly(join(native, 'ffi'));
  readOnly(native);
}

/**
 * A fresh "image": <dir>/server (the fake execPath) with native/ffi/<triple>/libfixture beside it,
 * read-only like the image's (`seal: false` leaves it writable, for a test that edits it first).
 */
function image(
  opts: {
    lib?: string;
    triple?: string;
    integrity?: 'ok' | 'mismatch' | 'unlisted' | 'absent' | 'v2';
    seal?: boolean;
  } = {},
): string {
  const dir = emptyDir('image');
  const native = join(dir, 'native');
  const triple = opts.triple ?? TRIPLE;
  const rel = `ffi/${triple}/${LIB}`;
  mkdirSync(join(native, 'ffi', triple), { recursive: true });
  copyFileSync(opts.lib ?? (libs.good as string), join(native, rel));
  const integrity = opts.integrity ?? 'ok';
  const files: Record<string, string> = {};
  if (integrity === 'ok' || integrity === 'v2') files[rel] = sha256(join(native, rel));
  if (integrity === 'mismatch') files[rel] = '0'.repeat(64);
  if (integrity === 'unlisted') files['ffi/other.so'] = '0'.repeat(64);
  if (integrity !== 'absent') {
    writeFileSync(
      join(native, '.integrity.json'),
      JSON.stringify({
        version: integrity === 'v2' ? 2 : 1,
        algorithm: 'sha256',
        packages: {},
        files,
      }),
    );
  }
  const exe = join(dir, 'server');
  if (opts.seal !== false) sealImage(exe);
  return exe;
}

/**
 * The directories ABOVE the one an executable sits in, nearest first, up to /, by their real
 * paths: the way the loader walks them. (The executable's own directory is judged for real.)
 */
function ancestorsAbove(exe: string): string[] {
  let home = dirname(exe);
  try {
    home = realpathSync(home);
  } catch {}
  const out: string[] = [];
  for (let d = dirname(home); ; d = dirname(d)) {
    out.push(d);
    if (dirname(d) === d) return out;
  }
}

interface Run {
  status: number | null;
  result: unknown;
  stdout: string;
  stderr: string;
}

/**
 * BEFORE: make the module see the ids a scenario names, whatever uid this test runs as. A staged
 * tree is only ever owned by the test's own user, and the loader accepts nothing but root's.
 *   FAKE_OWNER     the uid every stat reports as the owner (unset: the real one)
 *   FAKE_OWNER_AT  JSON, path -> uid: an override for a directory stat-ed by that path
 *   FAKE_EUID      what process.geteuid() returns (the loader must not care)
 *   FAKE_OWNER_INO JSON, "dev:ino" -> uid: an owner that survives a rename
 *   FAKE_MODE_AT   JSON, path -> permission bits (with the sticky bit): what a directory above
 *                  the staged tree answers (a host's /tmp is 1777; the test is not about it)
 * Modes are the real ones on disk, except where FAKE_MODE_AT names a path. Every path stat-ed is
 * kept in globalThis.statted, and every stat that did not ask for bigint in globalThis.notBigint.
 */
const FAKE_IDS = () => {
  const fs = process.getBuiltinModule('node:fs');
  const mod = process.getBuiltinModule('node:module') as unknown as {
    syncBuiltinESMExports: () => void;
  };
  const {
    FAKE_EUID: euid,
    FAKE_OWNER: owner,
    FAKE_OWNER_AT: at,
    FAKE_OWNER_INO: ino,
    FAKE_MODE_AT: modeAt,
  } = process.env;
  const overrides = at ? (JSON.parse(at) as Record<string, number>) : {};
  const modeOverrides = modeAt ? (JSON.parse(modeAt) as Record<string, number>) : {};
  const notBigint: string[] = [];
  (globalThis as unknown as { notBigint: string[] }).notBigint = notBigint;
  // uid by "dev:ino": an object keeps its owner wherever a rename puts it, which a by-path
  // override cannot say (a swapped-in tree answers to the same path as the one it replaced).
  const byInode = ino ? (JSON.parse(ino) as Record<string, number>) : {};
  const statted: string[] = [];
  (globalThis as unknown as { statted: string[] }).statted = statted;
  if (euid !== undefined)
    (process as unknown as { geteuid: () => number }).geteuid = () => Number(euid);
  for (const k of ['fstatSync', 'statSync', 'lstatSync'] as const) {
    const real = fs[k] as (...x: unknown[]) => object | undefined;
    (fs as unknown as Record<string, unknown>)[k] = function (this: unknown, ...a: unknown[]) {
      const st = real.apply(this, a) as
        | {
            dev: number | bigint;
            ino: number | bigint;
            uid: number | bigint;
            mode: number | bigint;
          }
        | undefined;
      if (st === undefined) return st;
      statted.push(k === 'fstatSync' ? 'fd' : String(a[0]));
      if ((a[1] as { bigint?: boolean } | undefined)?.bigint !== true) {
        notBigint.push(k === 'fstatSync' ? 'fd' : String(a[0]));
      }
      const uid =
        byInode[`${st.dev}:${st.ino}`] ??
        overrides[String(a[0])] ??
        (owner === undefined ? undefined : Number(owner));
      const bits = k === 'fstatSync' ? undefined : modeOverrides[String(a[0])];
      if (uid === undefined && bits === undefined) return st;
      const mode =
        bits === undefined ? Number(st.mode) : (Number(st.mode) & ~0o7777) | (bits & 0o7777);
      return Object.assign(Object.create(Object.getPrototypeOf(st)), st, {
        uid: uid === undefined ? st.uid : typeof st.uid === 'bigint' ? BigInt(uid) : uid,
        mode: typeof st.mode === 'bigint' ? BigInt(mode) : mode,
      });
    };
  }
  mod.syncBuiltinESMExports();
};

/**
 * Run `body(m, c, fixture)` in a fresh Bun process with the generated module
 * imported as `m`. An env `BEFORE` (a function's source) runs before that import,
 * after {@link FAKE_IDS}, whose `FAKE_OWNER` defaults to root here.
 */
function inBun(
  // biome-ignore lint/suspicious/noExplicitAny: the body runs in another process, untyped.
  body: (m: any, c: (f: () => unknown) => unknown, fixture: any) => unknown,
  env: Record<string, string | undefined> = {},
  args: string[] = ['--conditions=react-server'],
): Run {
  const r = spawnSync(process.execPath, [...args, 'harness.ts'], {
    cwd: app,
    encoding: 'utf8',
    env: {
      ...process.env,
      NODE_ENV: 'production',
      NEXT_PHASE: '',
      BODY: body.toString(),
      FAKE_OWNER: '0',
      ...env,
      // Every directory above the staged tree answers like a root-owned 0755 one unless a scenario
      // says otherwise: a host's own /tmp (1777) is not what these tests are about.
      ...(env.FAKE_EXEC === undefined
        ? {}
        : {
            FAKE_MODE_AT: JSON.stringify({
              ...Object.fromEntries(ancestorsAbove(env.FAKE_EXEC).map((d) => [d, 0o755])),
              ...JSON.parse(env.FAKE_MODE_AT ?? '{}'),
            }),
          }),
      // A scenario that stages a tree (FAKE_EXEC) is told its owner; one that does not touches nothing.
      ...(env.FAKE_EXEC === undefined && env.BEFORE === undefined
        ? {}
        : {
            BEFORE: `async () => { ${env.FAKE_EXEC === undefined ? '' : `(${FAKE_IDS})();`} ${env.BEFORE === undefined ? '' : `await (${env.BEFORE})();`} }`,
          }),
    },
    timeout: Number(env.TIMEOUT_MS ?? 60_000),
  });
  const line = r.stdout.split('\n').find((l) => l.startsWith('RESULT '));
  return {
    status: r.status,
    result: line ? JSON.parse(line.slice(7)) : undefined,
    stdout: r.stdout,
    stderr: r.stderr,
  };
}

const HARNESS = `// Runs one scenario: BODY is a function (m, c, fixture) => result.
const fake = process.env.FAKE_EXEC;
if (fake) process.execPath = fake;
// BEFORE runs ahead of the import: a node:fs patch it makes reaches the module's bindings.
if (process.env.BEFORE) await (0, eval)('(' + process.env.BEFORE + ')')();
const m = await import('./src/generated/ffi/index.ts');
const c = (f) => {
  try {
    return { ok: f() };
  } catch (e) {
    const cls = e instanceof m.FfiLoadError ? 'FfiLoadError'
      : e instanceof m.RustPanicError ? 'RustPanicError'
      : e instanceof m.RustError ? 'RustError'
      : e instanceof TypeError ? 'TypeError' : 'other';
    return { cls, message: e.message, fn: e.fn };
  }
};
let fixture;
if (process.env.LIBPATH) {
  const ffi = process.getBuiltinModule('bun:ffi');
  // dyld keeps a library opened by path apart from the same file opened through
  // /dev/fd/<n> (which the module uses on macOS), but shares one instance among
  // /dev/fd names; so on macOS the fixture is opened the way the module opens it.
  const name = process.platform === 'darwin'
    ? '/dev/fd/' + process.getBuiltinModule('node:fs').openSync(process.env.LIBPATH, 'r')
    : process.env.LIBPATH;
  fixture = ffi.dlopen(name, {
    fixture_live: { args: [], returns: 'i64' },
    fixture_last_null: { args: [], returns: 'i32' },
  }).symbols;
}
const result = await (0, eval)('(' + process.env.BODY + ')')(m, c, fixture);
const replacer = (_k, v) => (typeof v === 'bigint' ? v.toString() + 'n' : v instanceof Uint8Array ? { bytes: Array.from(v) } : v === undefined ? '<undefined>' : v);
console.log('RESULT ' + JSON.stringify(result, replacer));
`;

const NODE_HARNESS = `// The Node guard: import (no fs, no bun:ffi), then call.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const touched = [];
for (const k of ['readFileSync', 'existsSync', 'statSync', 'lstatSync', 'readdirSync', 'openSync', 'accessSync', 'realpathSync']) {
  const orig = fs[k];
  fs[k] = function (...a) { touched.push(k + ' ' + String(a[0])); return orig.apply(this, a); };
}
syncBuiltinESMExports();
const getBuiltin = process.getBuiltinModule;
const asked = [];
process.getBuiltinModule = (id) => { asked.push(id); return getBuiltin.call(process, id); };
const m = await import('./src/generated/ffi/index.ts');
const atImport = { touched: [...touched], asked: [...asked], exports: Object.keys(m).sort() };
let call;
try { m.greet('x'); call = { ok: true }; } catch (e) { call = { cls: e instanceof m.FfiLoadError ? 'FfiLoadError' : e.name, message: e.message }; }
let again;
try { m.add(1, 2); } catch (e) { again = e.message === call.message; }
console.log('RESULT ' + JSON.stringify({ atImport, call, again }));
`;

beforeAll(() => {
  work = emptyDir('loader');
  manifest = scanManifest(blob(KITCHEN_SINK));
  writeFileSync(join(work, 'manifest.h'), header(manifest));
  libs.good = cc('good', []);
  libs.debug = cc('debug', ['-DGREETING="Debug"']);
  libs.omit = cc('omit', ['-DOMIT_GREET']);
  libs.badSchema = cc('bad-schema', ['-DBAD_SCHEMA']);
  libs.slow = cc('slow', [`-DSLOW_ADD_MS=${SLOW_ADD_MS}`]);

  app = emptyDir('app');
  writeFileSync(join(app, 'package.json'), '{"type":"module","private":true}\n');
  // Next.js's own `server-only`: throws unless resolved under the react-server condition.
  const so = join(app, 'node_modules', 'server-only');
  mkdirSync(so, { recursive: true });
  writeFileSync(
    join(so, 'package.json'),
    JSON.stringify({
      name: 'server-only',
      exports: { '.': { 'react-server': './empty.js', default: './index.js' } },
    }),
  );
  writeFileSync(join(so, 'empty.js'), '');
  writeFileSync(
    join(so, 'index.js'),
    'throw new Error("This module cannot be imported from a Client Component module. It should only be used from a Server Component.");\n',
  );
  mkdirSync(join(app, 'src', 'generated', 'ffi'), { recursive: true });
  writeFileSync(
    join(app, 'src', 'generated', 'ffi', 'index.ts'),
    renderModule(manifest, { libName: 'fixture', crate: 'rust' }),
  );
  writeFileSync(join(app, 'harness.ts'), HARNESS);
  writeFileSync(join(app, 'harness-node.mjs'), NODE_HARNESS);
  writeFileSync(
    join(app, 'count-builtins.ts'),
    'const seen: string[] = [];\n' +
      '(globalThis as unknown as { __knextBuiltins: string[] }).__knextBuiltins = seen;\n' +
      'const orig = process.getBuiltinModule.bind(process);\n' +
      '(process as unknown as { getBuiltinModule: (id: string) => unknown }).getBuiltinModule = (id: string) => {\n' +
      '  seen.push(id);\n' +
      '  return orig(id as never);\n' +
      '};\n',
  );
}, 120_000);

afterAll(removeScratchDirs);

describe('the fixture library is a faithful stand-in', () => {
  it('the scanner reads the manifest out of the built library, as it would a Rust one', () => {
    const scanned = scanManifest(readFileSync(libs.good as string));
    expect(scanned).toEqual(manifest);
  });
});

/** One `echo_<width>` export per integer width the macros support, with its C type. */
const INT_WIDTHS: [string, string][] = [
  ['i8', 'int8_t'],
  ['i16', 'int16_t'],
  ['i32', 'int32_t'],
  ['u8', 'uint8_t'],
  ['u16', 'uint16_t'],
  ['u32', 'uint32_t'],
  ['i64', 'int64_t'],
  ['u64', 'uint64_t'],
  ['isize', 'int64_t'],
  ['usize', 'uint64_t'],
];

describe('integer arguments, every width, through a real library (the same matrix the Rust crates harness runs)', () => {
  it('each width refuses fractions, NaN, infinities, out-of-range and low-32-bit-alias values, wrong types and a throwing toString; accepts both boundaries and -0', () => {
    const records = INT_WIDTHS.map(([w]) => fn(`echo_${w}`, [['v', D.t(w)]], D.t(w)));
    const m = scanManifest(blob(records));
    const dir = emptyDir('ints');
    const lines = ['#include <stdint.h>', '#include <string.h>'];
    for (const f of m.fns) {
      lines.push(`#define SYM_${f.name} ${f.symbol}`);
      lines.push(
        `uint64_t ${f.symbol}_schema(void) { return ${fnv1a64(schemaString(f, m)).toString()}ULL; }`,
      );
    }
    records.forEach((r, i) => {
      const c = JSON.stringify(`KNEXTFFI1${JSON.stringify(r)}`);
      lines.push(`__attribute__((used)) const char knext_manifest_${i}[] = ${c};`);
    });
    for (const [w, ctype] of INT_WIDTHS) {
      lines.push(
        `int32_t SYM_echo_${w}(${ctype} v, uint64_t *out) { memcpy(out, &v, sizeof v); return 0; }`,
      );
    }
    lines.push('void knext_ffi_v1_free(uint8_t *p, size_t n) { (void)p; (void)n; }');
    const source = join(dir, 'ints.c');
    writeFileSync(source, `${lines.join('\n')}\n`);
    const built = join(dir, LIB);
    const cc1 = spawnSync('cc', ['-shared', '-fPIC', '-O1', '-o', built, source], {
      encoding: 'utf8',
    });
    expect(cc1.status, cc1.stderr).toBe(0);

    const intApp = join(dir, 'app');
    mkdirSync(join(intApp, 'src', 'generated', 'ffi'), { recursive: true });
    cpSync(join(app, 'node_modules'), join(intApp, 'node_modules'), { recursive: true });
    writeFileSync(join(intApp, 'package.json'), '{"type":"module","private":true}\n');
    writeFileSync(
      join(intApp, 'src', 'generated', 'ffi', 'index.ts'),
      renderModule(m, { libName: 'fixture', crate: 'rust' }),
    );
    writeFileSync(join(intApp, 'harness.ts'), HARNESS);
    const exe = image({ lib: built });
    const r = spawnSync(process.execPath, ['--conditions=react-server', 'harness.ts'], {
      cwd: intApp,
      encoding: 'utf8',
      env: {
        ...process.env,
        NODE_ENV: 'production',
        NEXT_PHASE: '',
        BODY: integerMatrix.toString(),
        FAKE_EXEC: exe,
        FAKE_OWNER: '0',
        // A host's own /tmp (1777 on Linux) is not what this test is about: every directory above
        // the staged tree answers like a root-owned 0755 one, as inBun arranges.
        FAKE_MODE_AT: JSON.stringify(
          Object.fromEntries(ancestorsAbove(exe).map((d) => [d, 0o755])),
        ),
        BEFORE: FAKE_IDS.toString(),
      },
      timeout: 60_000,
    });
    const line = r.stdout.split('\n').find((l) => l.startsWith('RESULT '));
    expect(line, `${r.stdout}${r.stderr}`).toBeDefined();
    const result = JSON.parse((line as string).slice(7)) as { cases: number; problems: string[] };
    expect(result.problems).toEqual([]);
    expect(result.cases).toBeGreaterThan(150);
  });
});

describe('path 1 — native/ffi/<triple> beside the executable, integrity required', () => {
  it('every call crosses correctly, every buffer is freed exactly once', () => {
    const exe = image();
    const r = inBun(
      (m, c, fixture) => {
        const two = (n: number) => BigInt(2) ** BigInt(n);
        const out: Record<string, unknown> = {};
        out.greet = [m.greet('World'), m.greet(''), m.greet('héllo 🌍 👩‍💻'), m.greet('a\u0000b')];
        out.add = m.add(2, 3);
        m.add(-1, 0); // leaves 0xFF in bytes 1..3 of the out slot
        out.tiny = [m.tiny(5), m.tiny(-5)];
        m.add(-1, 0);
        out.flag = [m.flag(true), m.flag(false)];
        out.big = [m.big(two(60) + BigInt(7)), m.big(-two(63))];
        out.half = m.half(3);
        out.sum = m.sum(new Uint8Array([1, 2, 3]));
        out.sumEmpty = [m.sum(new Uint8Array(0)), fixture.fixture_last_null()];
        out.bytes = [m.echo_bytes(new Uint8Array([0, 255, 7]))];
        out.bytesEmpty = [m.echo_bytes(new Uint8Array(0)), fixture.fixture_last_null()];
        const a = 'x'.repeat(1000);
        const b = 'é'.repeat(3000); // its worst case does not fit the 4 KiB buffer: grows between the two
        out.concat = m.concat(a, b) === a + b;
        out.concatAgain = m.concat('left', '') === 'left';
        const p = {
          id: two(64) - BigInt(1),
          x: 1.25,
          label: 'p',
          tags: [two(53) + BigInt(1), BigInt(0)],
          inner: { n: -two(62), when: two(60) },
          color: 'Green',
        };
        out.point = m.echo_point(p);
        out.pointNull = m.echo_point({ ...p, inner: null }).inner;
        out.maybe = [m.maybe(two(60)), m.maybe(null)];
        out.ids = m.ids([-two(62), two(53) + BigInt(1)]);
        out.color = m.color('Green');
        out.parse = [m.parse('42'), c(() => m.parse('x'))];
        out.boom = c(() => m.boom());
        out.afterBoom = m.add(1, 1);
        out.strict = [c(() => m.strict('bad')), m.strict('ok')];
        out.badPoint = c(() => m.bad_point());
        out.nop = m.nop();
        out.typeErrors = [
          c(() => m.add(1.5, 0)),
          c(() => m.add(2 ** 31, 0)),
          c(() => m.tiny(200)),
          c(() => m.big(two(70))),
          c(() => m.big(5)),
          c(() => m.flag(1)),
          c(() => m.greet(5)),
          c(() => m.sum([1, 2])),
        ];
        out.live = fixture.fixture_live();
        return out;
      },
      { FAKE_EXEC: exe, LIBPATH: join(exe, '..', 'native', 'ffi', TRIPLE, LIB) },
    );
    expect(r.stderr).not.toContain('development build');
    expect(r.result, r.stderr).toEqual({
      greet: ['Hello, World!', 'Hello, !', 'Hello, héllo 🌍 👩‍💻!', 'Hello, a\u0000b!'],
      add: 5,
      tiny: [5, -5],
      flag: [false, true],
      big: ['1152921504606846983n', '-9223372036854775808n'],
      half: 1.5,
      sum: '6n',
      sumEmpty: ['0n', 1],
      bytes: [{ bytes: [0, 255, 7] }],
      bytesEmpty: [{ bytes: [] }, 1],
      concat: true,
      concatAgain: true,
      point: {
        id: '18446744073709551615n',
        x: 1.25,
        label: 'p',
        tags: ['9007199254740993n', '0n'],
        inner: { n: '-4611686018427387904n', when: '1152921504606846976n' },
        color: 'Green',
      },
      pointNull: null,
      maybe: ['1152921504606846976n', null],
      ids: ['-4611686018427387904n', '9007199254740993n'],
      color: 'Green',
      parse: [42, { cls: 'RustError', message: 'invalid digit found in string', fn: 'parse' }],
      boom: { cls: 'RustPanicError', message: 'boom from c', fn: 'boom' },
      afterBoom: 2,
      strict: [
        { cls: 'RustError', message: 'invalid input: s: invalid UTF-8', fn: 'strict' },
        'ok',
      ],
      badPoint: {
        cls: 'RustError',
        message:
          'result.x: expected a finite number, got null (NaN and Infinity cannot cross as JSON)',
        fn: 'bad_point',
      },
      nop: '<undefined>',
      typeErrors: [
        {
          cls: 'TypeError',
          message: 'add(): argument "a" must be an integer from -2147483648 to 2147483647, got 1.5',
          fn: '<undefined>',
        },
        {
          cls: 'TypeError',
          message:
            'add(): argument "a" must be an integer from -2147483648 to 2147483647, got 2147483648',
          fn: '<undefined>',
        },
        {
          cls: 'TypeError',
          message: 'tiny(): argument "x" must be an integer from -128 to 127, got 200',
          fn: '<undefined>',
        },
        {
          cls: 'TypeError',
          message:
            'big(): argument "x" must be a bigint from -9223372036854775808 to 9223372036854775807, got bigint 1180591620717411303424',
          fn: '<undefined>',
        },
        {
          cls: 'TypeError',
          message:
            'big(): argument "x" must be a bigint from -9223372036854775808 to 9223372036854775807, got number 5',
          fn: '<undefined>',
        },
        {
          cls: 'TypeError',
          message: 'flag(): argument "b" must be a boolean, got number',
          fn: '<undefined>',
        },
        {
          cls: 'TypeError',
          message: 'greet(): argument "name" must be a string, got number',
          fn: '<undefined>',
        },
        {
          cls: 'TypeError',
          message: 'sum(): argument "data" must be a Uint8Array',
          fn: '<undefined>',
        },
      ],
      live: '0n',
    });
    expect(r.status).toBe(0);
  });

  it('integer arguments: the wrapper refuses what bun:ffi would corrupt (fractions, NaN, infinities, out of range, the low-32-bit alias, wrong types) and accepts both boundaries and -0', () => {
    const exe = image();
    const r = inBun(
      (m, c) => {
        const two = (n: number) => BigInt(2) ** BigInt(n);
        const refused = (f: () => unknown) => {
          const x = c(f) as { cls?: string; message?: string };
          return x.cls === 'TypeError' ? x.message : x;
        };
        return {
          ok: [
            m.add(-2147483648, 2147483647),
            m.add(-0, -0),
            m.tiny(-128),
            m.tiny(127),
            m.tiny(-0),
            m.big(-two(63)),
            m.big(two(63) - BigInt(1)),
          ],
          i32: [
            m.add(2147483647, 0),
            refused(() => m.add(0.5, 0)),
            refused(() => m.add(Number.NaN, 0)),
            refused(() => m.add(0, Number.POSITIVE_INFINITY)),
            refused(() => m.add(0, Number.NEGATIVE_INFINITY)),
            refused(() => m.add(-2147483649, 0)),
            refused(() => m.add(2 ** 32 + 1, 0)),
            refused(() => m.add(2 ** 53, 0)),
            refused(() => m.add('1', 0)),
            refused(() => m.add(BigInt(1), 0)),
            refused(() => m.add(null, 0)),
          ],
          i8: [
            refused(() => m.tiny(-129)),
            refused(() => m.tiny(128)),
            refused(() => m.tiny(127.5)),
            refused(() => m.tiny(Number.NaN)),
            refused(() => m.tiny(-Infinity)),
          ],
          i64: [
            refused(() => m.big(-two(63) - BigInt(1))),
            refused(() => m.big(two(63))),
            refused(() => m.big(0)),
            refused(() => m.big(-0)),
            refused(() => m.big(Number.NaN)),
            refused(() => m.big('1')),
          ],
          hostile: refused(() =>
            m.add(
              {
                toString() {
                  throw new Error('toString ran');
                },
              },
              0,
            ),
          ),
          huge: String(refused(() => m.big(two(200000)))).length < 200,
          negZero: [refused(() => m.tiny(-0.5)), refused(() => m.add(-0.5, 0))],
          after: m.add(20, 22),
        };
      },
      { FAKE_EXEC: exe },
    );
    const i32 = 'add(): argument "a" must be an integer from -2147483648 to 2147483647, got';
    const i32b = 'add(): argument "b" must be an integer from -2147483648 to 2147483647, got';
    const i8 = 'tiny(): argument "x" must be an integer from -128 to 127, got';
    const i64 =
      'big(): argument "x" must be a bigint from -9223372036854775808 to 9223372036854775807, got';
    expect(r.result, r.stderr).toEqual({
      ok: [-1, 0, -128, 127, 0, '-9223372036854775808n', '9223372036854775807n'],
      i32: [
        2147483647,
        `${i32} 0.5`,
        `${i32} NaN`,
        `${i32b} Infinity`,
        `${i32b} -Infinity`,
        `${i32} -2147483649`,
        `${i32} 4294967297`,
        `${i32} 9007199254740992`,
        `${i32} string`,
        `${i32} bigint`,
        `${i32} object`,
      ],
      i8: [`${i8} -129`, `${i8} 128`, `${i8} 127.5`, `${i8} NaN`, `${i8} -Infinity`],
      i64: [
        `${i64} bigint -9223372036854775809`,
        `${i64} bigint 9223372036854775808`,
        `${i64} number 0`,
        `${i64} number -0`,
        `${i64} number NaN`,
        `${i64} string`,
      ],
      hostile: `${i32} object`,
      huge: true,
      negZero: [`${i8} -0.5`, `${i32} -0.5`],
      after: 42,
    });
    expect(r.status).toBe(0);
  });

  it('Rust argument names never collide with what the generated body declares (r, st, base, o0, n0), nor an export with an import (join)', () => {
    const exe = image();
    const r = inBun(
      (m, _c, fixture) => ({
        scale: m.scale(1.25),
        join: m.join('a', 'bb', 'ccc', '', 'd-é'),
        joinAgain: m.join('', '', '', '', ''),
        live: fixture.fixture_live(),
      }),
      { FAKE_EXEC: exe, LIBPATH: join(exe, '..', 'native', 'ffi', TRIPLE, LIB) },
    );
    expect(r.stderr).not.toContain('SyntaxError');
    expect(r.result, r.stderr).toEqual({
      scale: { id: '7n', x: 2.5, label: 'scaled', tags: [], inner: null, color: 'Red' },
      join: ['a', 'bb', 'ccc', '', 'd-é'],
      joinAgain: ['', '', '', '', ''],
      live: '0n',
    });
    expect(r.status).toBe(0);
  });

  it('record fields named like Object.prototype members or keywords (constructor, toString, prototype, new, type) cross as own properties, both ways', () => {
    const exe = image();
    const r = inBun(
      (m, _c, fixture) => {
        const odd = {
          constructor: BigInt(2) ** BigInt(60),
          toString: 'ts',
          valueOf: 1.5,
          hasOwnProperty: null,
          prototype: [BigInt(1), BigInt(2)],
          new: true,
          type: 'Green',
          __defineGetter__: 'dg',
        };
        const back = m.echo_odd(odd);
        return {
          back,
          own: Object.keys(back),
          proto: Object.getPrototypeOf(back) === Object.prototype,
          some: m.echo_odd({ ...odd, hasOwnProperty: BigInt(-7) }).hasOwnProperty,
          live: fixture.fixture_live(),
        };
      },
      { FAKE_EXEC: exe, LIBPATH: join(exe, '..', 'native', 'ffi', TRIPLE, LIB) },
    );
    expect(r.result, r.stderr).toEqual({
      back: {
        constructor: '1152921504606846976n',
        toString: 'ts',
        valueOf: 1.5,
        hasOwnProperty: null,
        prototype: ['1n', '2n'],
        new: true,
        type: 'Green',
        __defineGetter__: 'dg',
      },
      own: [
        'constructor',
        'toString',
        'valueOf',
        'hasOwnProperty',
        'prototype',
        'new',
        'type',
        '__defineGetter__',
      ],
      proto: true,
      some: '-7n',
      live: '0n',
    });
    expect(r.status).toBe(0);
  });

  it('a NaN or ±Infinity in ANY JSON argument position (Option, Vec, record field) is a TypeError naming its path, never a silent null', () => {
    const exe = image();
    const r = inBun(
      (m, c, fixture) => {
        const p = {
          id: BigInt(1),
          x: 1.5,
          label: 'p',
          tags: [],
          inner: null,
          color: 'Red',
        };
        return {
          ok: [m.opt_f(1.5), m.opt_f(null), m.floats([0.5, null, -2])],
          optNaN: c(() => m.opt_f(Number.NaN)),
          optInf: c(() => m.opt_f(Number.POSITIVE_INFINITY)),
          vecNegInf: c(() => m.floats([1, null, Number.NEGATIVE_INFINITY])),
          field: c(() => m.echo_point({ ...p, x: Number.POSITIVE_INFINITY })),
          afterRefusals: m.opt_f(2.5),
          live: fixture.fixture_live(),
        };
      },
      { FAKE_EXEC: exe, LIBPATH: join(exe, '..', 'native', 'ffi', TRIPLE, LIB) },
    );
    const refused = (fn: string, at: string, got: string) => ({
      cls: 'TypeError',
      message: `${fn}(): argument "${at}" must be a finite number (JSON has no NaN or Infinity), got ${got}`,
      fn: '<undefined>',
    });
    expect(r.result, r.stderr).toEqual({
      ok: [1.5, null, [0.5, null, -2]],
      optNaN: refused('opt_f', 'x', 'NaN'),
      optInf: refused('opt_f', 'x', 'Infinity'),
      vecNegInf: refused('floats', 'xs[2]', '-Infinity'),
      field: refused('echo_point', 'p.x', 'Infinity'),
      afterRefusals: 2.5,
      live: '0n',
    });
    expect(r.status).toBe(0);
  });

  it('a 64-bit integer that arrives as a JSON number is a RustError naming its path, and the buffer is still freed', () => {
    const exe = image();
    const r = inBun(
      (m, c, fixture) => ({
        id: c(() => m.bad_id()),
        tag: c(() => m.bad_tag()),
        live: fixture.fixture_live(),
      }),
      { FAKE_EXEC: exe, LIBPATH: join(exe, '..', 'native', 'ffi', TRIPLE, LIB) },
    );
    expect(r.result, r.stderr).toEqual({
      id: {
        cls: 'RustError',
        message: 'result.id: expected a 64-bit integer as a decimal string, got 1',
        fn: 'bad_id',
      },
      tag: {
        cls: 'RustError',
        message: 'result.tags[1]: expected a 64-bit integer as a decimal string, got 3',
        fn: 'bad_tag',
      },
      live: '0n',
    });
    expect(r.status).toBe(0);
  });

  const refused = (integrity: 'mismatch' | 'unlisted' | 'absent' | 'v2', expected: RegExp) => {
    for (const nodeEnv of ['production', 'development']) {
      const r = inBun((m, c) => [c(() => m.greet('x')), c(() => m.add(1, 2))], {
        FAKE_EXEC: image({ integrity }),
        NODE_ENV: nodeEnv,
      });
      const [first, second] = r.result as { cls: string; message: string }[];
      expect(first?.cls, r.stderr).toBe('FfiLoadError');
      expect(first?.message).toMatch(expected);
      // Cached: the second call fails the same way, without retrying.
      expect(second).toEqual(first as { cls: string; message: string });
    }
  };

  it('a sha256 mismatch is fatal, in production and in development', () => {
    refused(
      'mismatch',
      /refusing to load .*libfixture\.\w+: sha256 mismatch\n {2}expected 0{64}\n {2}actual {3}[0-9a-f]{64}/,
    );
  });
  it('a library not listed in native/.integrity.json is fatal', () => {
    refused('unlisted', /is not listed in .*\.integrity\.json/);
  });
  it('an absent integrity manifest is fatal (no warn-and-load exception)', () => {
    refused('absent', /there is no integrity manifest at .*\.integrity\.json/);
  });
  it('an integrity manifest of an unknown schema version is fatal', () => {
    refused('v2', /cannot read .*\.integrity\.json \(unsupported version 2\)/);
  });

  it('a failed load is cached: fixing the cause does not make a later call in the same process retry', () => {
    const exe = image({ integrity: 'mismatch' });
    const r = inBun(
      (m, c) => {
        const first = c(() => m.greet('x'));
        const fs = process.getBuiltinModule('node:fs');
        const path = process.getBuiltinModule('node:path');
        const native = path.join(path.dirname(process.execPath), 'native');
        const manifest = JSON.parse(fs.readFileSync(path.join(native, '.integrity.json'), 'utf8'));
        const rel = Object.keys(manifest.files)[0];
        const hash = process
          .getBuiltinModule('node:crypto')
          .createHash('sha256')
          .update(fs.readFileSync(path.join(native, rel)))
          .digest('hex');
        manifest.files[rel] = hash;
        // The staged manifest is read-only, like the image's: the fix is made as its owner.
        fs.chmodSync(path.join(native, '.integrity.json'), 0o644);
        fs.writeFileSync(path.join(native, '.integrity.json'), JSON.stringify(manifest));
        return [first, c(() => m.greet('x'))];
      },
      { FAKE_EXEC: exe },
    );
    const [first, second] = r.result as { cls: string }[];
    expect(first?.cls, r.stderr).toBe('FfiLoadError');
    expect(second).toEqual(first as { cls: string });
  });

  it('a wrong-platform directory is refused by name', () => {
    const r = inBun((m, c) => c(() => m.greet('x')), {
      FAKE_EXEC: image({ triple: 'riscv64gc-unknown-linux-musl' }),
      NODE_ENV: 'development',
    });
    const out = r.result as { cls: string; message: string };
    expect(out.cls, r.stderr).toBe('FfiLoadError');
    expect(out.message).toContain('holds Rust libraries for riscv64gc-unknown-linux-musl');
    expect(out.message).toContain(`this process runs on ${TRIPLE}`);
  });

  it('a library missing a symbol the wrapper binds (a stale wrapper) is an FfiLoadError naming knext ffi generate', () => {
    const r = inBun((m, c) => c(() => m.add(1, 2)), { FAKE_EXEC: image({ lib: libs.omit }) });
    const out = r.result as { cls: string; message: string };
    expect(out.cls, r.stderr).toBe('FfiLoadError');
    expect(out.message).toContain('could not load');
    expect(out.message).toContain('the module is stale: run `knext ffi generate`');
  });

  it('a _schema mismatch (a record changed under an unchanged signature) is the stale-wrapper FfiLoadError', () => {
    const r = inBun((m, c) => c(() => m.add(1, 2)), { FAKE_EXEC: image({ lib: libs.badSchema }) });
    const out = r.result as { cls: string; message: string };
    expect(out.cls, r.stderr).toBe('FfiLoadError');
    expect(out.message).toMatch(
      /the records or enums \w+\(\) uses have changed since it was generated/,
    );
    expect(out.message).toContain('The module is stale: run `knext ffi generate`');
  });
});

describe('the library loaded is the library hashed (nothing swapped in between the integrity check and dlopen)', () => {
  /**
   * BEFORE: replace the staged library with libs.debug (its greet says "Debug")
   * once, at WHEN — `read`, as soon as the loader has read the library's bytes
   * to hash them (by path or through a descriptor), or `dlopen`, as the loader
   * calls bun:ffi's dlopen — by HOW: another file renamed over the path, or the
   * path replaced with a symlink. The moment is recorded in globalThis.swaps.
   */
  const SWAP = () => {
    const fs = process.getBuiltinModule('node:fs');
    const mod = process.getBuiltinModule('node:module') as unknown as {
      syncBuiltinESMExports: () => void;
    };
    const {
      STAGED: staged,
      EVIL: evil,
      WHEN: when,
      HOW: how,
    } = process.env as Record<string, string>;
    const swaps: string[] = [];
    (globalThis as unknown as { swaps: string[] }).swaps = swaps;
    const swap = (at: string) => {
      if (swaps.length > 0) return;
      // The staged tree is read-only, and the loader has already accepted it as such: the
      // swapper stands for a principal that CAN write the directory, so give it that.
      const dir = process.getBuiltinModule('node:path').dirname(staged);
      fs.chmodSync(dir, 0o755);
      if (how === 'rename') {
        fs.copyFileSync(evil, `${staged}.new`);
        fs.renameSync(`${staged}.new`, staged);
      } else {
        fs.rmSync(staged);
        fs.symlinkSync(evil, staged);
      }
      swaps.push(at);
    };
    if (when === 'read') {
      const read = fs.readFileSync;
      (fs as { readFileSync: unknown }).readFileSync = function (this: unknown, ...a: unknown[]) {
        const out = (read as (...x: unknown[]) => unknown).apply(this, a);
        // The library's bytes (through a descriptor, with no encoding), not the manifest's (UTF-8).
        if ((typeof a[0] === 'number' && a[1] === undefined) || String(a[0]) === staged) {
          swap('read');
        }
        return out;
      };
      mod.syncBuiltinESMExports();
    } else {
      const get = process.getBuiltinModule.bind(process);
      (process as unknown as { getBuiltinModule: (id: string) => unknown }).getBuiltinModule = (
        id: string,
      ) => {
        const builtin = get(id as never) as Record<string, unknown>;
        if (id !== 'bun:ffi') return builtin;
        const dlopen = builtin.dlopen as (...x: unknown[]) => unknown;
        return {
          ...builtin,
          dlopen: (...a: unknown[]) => {
            swap('dlopen');
            return dlopen(...a);
          },
        };
      };
    }
  };

  for (const [when, how] of [
    ['read', 'rename'],
    ['dlopen', 'rename'],
    ['dlopen', 'symlink'],
  ] as const) {
    it(`a library ${how === 'rename' ? 'renamed over' : 'symlinked at'} the staged path at ${when} is not the one loaded${when === 'read' ? ' (the path no longer names the file that was read: refused)' : ''}`, () => {
      const exe = image();
      const staged = join(exe, '..', 'native', 'ffi', TRIPLE, LIB);
      const r = inBun(
        (m, c) => {
          const greet = c(() => m.greet('World'));
          const swaps = [...(globalThis as unknown as { swaps: string[] }).swaps];
          const fs = process.getBuiltinModule('node:fs');
          const crypto = process.getBuiltinModule('node:crypto');
          const atPath = crypto
            .createHash('sha256')
            .update(fs.readFileSync(process.env.STAGED as string))
            .digest('hex');
          return { greet, swaps, atPath };
        },
        {
          FAKE_EXEC: exe,
          BEFORE: SWAP.toString(),
          STAGED: staged,
          EVIL: libs.debug,
          WHEN: when,
          HOW: how,
        },
      );
      const out = r.result as { greet: unknown; swaps: string[]; atPath: string };
      // The swap really happened, at that moment: the path now holds the other library.
      expect(out?.swaps, r.stderr).toEqual([when]);
      expect(out.atPath).toBe(sha256(libs.debug as string));
      if (when === 'read') {
        // Between the hash and the second look at the path: the path no longer names the file
        // that was read, so nothing loads (stronger than loading the hashed bytes).
        expect(out.greet).toMatchObject({ cls: 'FfiLoadError' });
        expect((out.greet as { message: string }).message).toMatch(
          /is no longer the file that was read/,
        );
      } else {
        // ...and the library loaded is still the one whose bytes were hashed, on
        // Linux (/proc/self/fd/<n>) and macOS (/dev/fd/<n>) alike.
        expect(out.greet).toEqual({ ok: 'Hello, World!' });
      }
      expect(r.status).toBe(0);
    });
  }

  it('a platform with no descriptor name to load through is refused, never loaded by path', () => {
    // $triple() already refuses such a platform, so the check is reached here by
    // reporting the real platform until the integrity manifest has been read.
    const FLIP = () => {
      const fs = process.getBuiltinModule('node:fs');
      const mod = process.getBuiltinModule('node:module') as unknown as {
        syncBuiltinESMExports: () => void;
      };
      const real = process.platform;
      let flipped = false;
      Object.defineProperty(process, 'platform', { get: () => (flipped ? 'freebsd' : real) });
      const read = fs.readFileSync;
      (fs as { readFileSync: unknown }).readFileSync = function (this: unknown, ...a: unknown[]) {
        const out = (read as (...x: unknown[]) => unknown).apply(this, a);
        // The manifest is the one file read as UTF-8, through the descriptor it was opened as.
        if (typeof a[0] === 'number' && a[1] === 'utf8') flipped = true;
        return out;
      };
      mod.syncBuiltinESMExports();
    };
    const r = inBun((m, c) => c(() => m.greet('World')), {
      FAKE_EXEC: image(),
      BEFORE: FLIP.toString(),
    });
    const out = r.result as { cls?: string; message?: string };
    expect(out?.cls, r.stderr).toBe('FfiLoadError');
    expect(out.message).toContain('refusing to load');
    expect(out.message).toContain('freebsd');
  });

  it('two copies of the module (one per bundler layer) still bind ONE instance of the library', () => {
    const exe = image();
    const r = inBun(
      async (m, _c, fixture) => {
        const copy = await import(`${process.env.MODULE_PATH}?copy=3`);
        const seen: number[] = [];
        m.sum(new Uint8Array(0));
        seen.push(fixture.fixture_last_null());
        copy.sum(new Uint8Array([1]));
        seen.push(fixture.fixture_last_null());
        copy.sum(new Uint8Array(0));
        seen.push(fixture.fixture_last_null());
        return { same: copy === m, seen };
      },
      {
        FAKE_EXEC: exe,
        LIBPATH: join(exe, '..', 'native', 'ffi', TRIPLE, LIB),
        MODULE_PATH: join(app, 'src', 'generated', 'ffi', 'index.ts'),
      },
    );
    // Both copies' calls land in the one library the harness opened by path.
    expect(r.result, r.stderr).toEqual({ same: false, seen: [1, 0, 1] });
  });

  it('a second library loaded later in the same process gets its own handle, not the first one’s', () => {
    // glibc finds an already-loaded library by the name it was opened under, so
    // a loaded library's descriptor must never be closed: a later open would
    // reuse its number, and that name would return the first library.
    const records = [fn('twice', [['v', D.t('u32')]], D.t('u32'))];
    const m2 = scanManifest(blob(records));
    const dir = emptyDir('second-lib');
    const lines = ['#include <stdint.h>', '#include <stddef.h>', '#include <string.h>'];
    for (const f of m2.fns) {
      lines.push(`#define SYM_${f.name} ${f.symbol}`);
      lines.push(
        `uint64_t ${f.symbol}_schema(void) { return ${fnv1a64(schemaString(f, m2)).toString()}ULL; }`,
      );
    }
    records.forEach((r, i) => {
      const c = JSON.stringify(`KNEXTFFI1${JSON.stringify(r)}`);
      lines.push(`__attribute__((used)) const char knext_manifest_${i}[] = ${c};`);
    });
    lines.push(
      'int32_t SYM_twice(uint32_t v, uint64_t *out) { uint32_t r = v * 2; memcpy(out, &r, sizeof r); return 0; }',
      'void knext_ffi_v1_free(uint8_t *p, size_t n) { (void)p; (void)n; }',
    );
    const source = join(dir, 'other.c');
    writeFileSync(source, `${lines.join('\n')}\n`);
    const other = `libother.${EXT}`;
    const built = join(dir, other);
    const cc2 = spawnSync('cc', ['-shared', '-fPIC', '-O1', '-o', built, source], {
      encoding: 'utf8',
    });
    expect(cc2.status, cc2.stderr).toBe(0);
    mkdirSync(join(app, 'src', 'generated', 'other'), { recursive: true });
    writeFileSync(
      join(app, 'src', 'generated', 'other', 'index.ts'),
      renderModule(m2, { libName: 'other', crate: 'rust' }),
    );

    const exe = image({ seal: false });
    const native = join(exe, '..', 'native');
    copyFileSync(built, join(native, 'ffi', TRIPLE, other));
    const integrity = JSON.parse(readFileSync(join(native, '.integrity.json'), 'utf8'));
    integrity.files[`ffi/${TRIPLE}/${other}`] = sha256(built);
    writeFileSync(join(native, '.integrity.json'), JSON.stringify(integrity));
    sealImage(exe);

    const r = inBun(
      async (m, c) => {
        const first = c(() => m.greet('World'));
        const second = await import(`${process.cwd()}/src/generated/other/index.ts`);
        return { first, second: c(() => second.twice(21)), again: c(() => m.add(2, 3)) };
      },
      { FAKE_EXEC: exe },
    );
    expect(r.result, r.stderr).toEqual({
      first: { ok: 'Hello, World!' },
      second: { ok: 42 },
      again: { ok: 5 },
    });
  });
});

describe('a whole-tree swap between the checks cannot change what passes (an attacker who can write a directory above native/)', () => {
  /**
   * BEFORE: the attacker renames the whole tree. At the loader's first touch of the integrity
   * manifest by path, the real directory HOME is renamed to AWAY and EVIL is renamed to HOME.
   * With BACK=1 the real one is put back at the first directory stat after that: the old order
   * of checks judged the directories last, so they saw the real tree while the manifest and the
   * library had come from the attacker's. globalThis.swaps records what happened.
   */
  const TREE = () => {
    const fs = process.getBuiltinModule('node:fs');
    const mod = process.getBuiltinModule('node:module') as unknown as {
      syncBuiltinESMExports: () => void;
    };
    const {
      HOME: home,
      EVIL: evil,
      AWAY: away,
      BACK: back,
    } = process.env as Record<string, string>;
    const swaps: string[] = [];
    (globalThis as unknown as { swaps: string[] }).swaps = swaps;
    for (const k of ['existsSync', 'openSync', 'readFileSync', 'statSync', 'lstatSync'] as const) {
      const real = fs[k] as (...x: unknown[]) => unknown;
      (fs as unknown as Record<string, unknown>)[k] = function (this: unknown, ...a: unknown[]) {
        const p = typeof a[0] === 'string' ? a[0] : '';
        if (swaps.length === 0 && p.endsWith('/.integrity.json')) {
          fs.renameSync(home, away);
          fs.renameSync(evil, home);
          swaps.push('in');
        } else if (swaps.length === 1 && back === '1' && (k === 'statSync' || k === 'lstatSync')) {
          fs.renameSync(home, evil);
          fs.renameSync(away, home);
          swaps.push('back');
        }
        return real.apply(this, a);
      };
    }
    mod.syncBuiltinESMExports();
  };

  type Swap = {
    greet: { ok?: unknown; cls?: string; message?: string };
    swaps: string[];
  };

  /**
   * Run the real tree with the attacker's tree ready beside it. The attacker's is a complete,
   * sealed image of its own whose manifest lists its own library (libs.debug: its greet says
   * "Debug"). Who owns what is told by inode, so it survives the renames:
   *   link       the manifest and every directory are the attacker's (uid 1000); the library is a
   *              symlink to a root-owned file that already exists (the attacker cannot write one);
   *   file       the same, but the library is a regular file that passes as root's: a hard link
   *              where fs.protected_hardlinks is off;
   *   root-tree  nothing is the attacker's: a tree that passes every file check (root wrote it),
   *              as an older release left on the host would.
   * `owns` names the directory above native/ the attacker can write (the one that lets them
   * rename the tree): the executable's directory's parent, or the one above that.
   */
  function attack(
    kind: 'link' | 'file' | 'root-tree',
    back: boolean,
    owns?: 'parent' | 'grandparent',
  ): { run: Run; ancestor: string } {
    const exe = image();
    const home = join(exe, '..');
    const evilHome = join(image({ lib: libs.debug }), '..');
    const native = join(evilHome, 'native');
    const evilTriple = join(native, 'ffi', TRIPLE);
    const evilLib = join(evilTriple, LIB);
    if (kind === 'link') {
      const rootLib = join(emptyDir('root-owned'), LIB);
      copyFileSync(libs.debug as string, rootLib);
      chmodSync(rootLib, 0o444);
      chmodSync(evilTriple, 0o755);
      rmSync(evilLib);
      symlinkSync(rootLib, evilLib);
      chmodSync(evilTriple, 0o555);
    }
    const attacker =
      kind === 'root-tree'
        ? []
        : [evilHome, native, join(native, 'ffi'), evilTriple, join(native, '.integrity.json')];
    const away = `${home}.away`;
    const above = ancestorsAbove(exe);
    const ancestor = (owns === 'grandparent' ? above[1] : above[0]) as string;
    const run = inBun(
      (m, c) => ({
        greet: c(() => m.greet('World')),
        swaps: [...(globalThis as unknown as { swaps: string[] }).swaps],
      }),
      {
        FAKE_EXEC: exe,
        FAKE_OWNER_INO: JSON.stringify(Object.fromEntries(attacker.map((p) => [idOf(p), 1000]))),
        ...(owns === undefined ? {} : { FAKE_OWNER_AT: JSON.stringify({ [ancestor]: 1000 }) }),
        BEFORE: TREE.toString(),
        HOME: home,
        EVIL: evilHome,
        AWAY: away,
        BACK: back ? '1' : '0',
      },
    );
    // Whichever tree the swap left at AWAY is not a registered scratch directory.
    makeWritable(away);
    rmSync(away, { recursive: true, force: true });
    return { run, ancestor };
  }

  const reEscape = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  describe('the way to native/ is root-owned all the way up to /: a user who is not root cannot rename any of it, so there is nothing to swap', () => {
    const cases = [
      ['parent', 'link', true], // the reported attack
      ['parent', 'root-tree', true], // an older release root wrote, put back before the second look
      ['parent', 'root-tree', false],
      ['grandparent', 'root-tree', true],
    ] as const;
    for (const [owns, kind, back] of cases) {
      it(`the ${owns} of the executable's directory is the attacker's (${kind}, ${back ? 'put back' : 'left in place'}): refused at the walk, before the manifest is touched`, () => {
        const { run, ancestor } = attack(kind, back, owns);
        const out = run.result as Swap;
        // The loader never reached for the manifest, so the attacker never got to act.
        expect(out?.swaps, run.stderr).toEqual([]);
        expect(out.greet).not.toEqual({ ok: 'Debug, World!' });
        expect(out.greet.cls).toBe('FfiLoadError');
        expect(out.greet.message).toMatch(
          new RegExp(`${reEscape(ancestor)} is owned by uid 1000, but only root may own it`),
        );
        expect(run.status).toBe(0);
      });
    }
  });

  describe('defence in depth: were a directory above swapped anyway (root-owned, so the walk accepts it: a root-equivalent actor, a mount), the files and directories read are still the ones judged', () => {
    const defeated = (r: Run, why: RegExp): Swap => {
      const out = r.result as Swap;
      // The attacker really acted, at the moment the loader reached for the manifest...
      expect(out?.swaps[0], r.stderr).toBe('in');
      // ...and what they put there did not load.
      expect(out.greet).not.toEqual({ ok: 'Debug, World!' });
      expect(out.greet.cls).toBe('FfiLoadError');
      expect(out.greet.message).toMatch(why);
      expect(r.status).toBe(0);
      return out;
    };

    const MANIFEST_OWNER = /\.integrity\.json is owned by uid 1000, but only root may own it/;

    it("the reported attack: the attacker's manifest and a symlink to any root-owned library, the real tree put back before the directories are judged", () => {
      defeated(attack('link', true).run, MANIFEST_OWNER);
    });

    it('the same with a root-owned library that is a regular file (a hard link): only the manifest gives it away', () => {
      defeated(attack('file', true).run, MANIFEST_OWNER);
    });

    it('a tree that passes every file check, swapped in and left (root wrote all of it): the directories are no longer the ones that were judged', () => {
      defeated(attack('root-tree', false).run, /changed while it was being checked/);
    });

    it('a tree root wrote, swapped in and put back before the second look (an older release): the files read are not the ones the paths name now', () => {
      const out = defeated(
        attack('root-tree', true).run,
        /is no longer the file that was read \(it was renamed, replaced or removed/,
      );
      // The put-back really happened: the directories all matched, and only the files gave it away.
      expect(out.swaps).toEqual(['in', 'back']);
    });

    /**
     * BEFORE: once the loader has read the library's bytes to hash them (through a descriptor,
     * with no encoding), do one thing to the tree, once. KIND=manifest: another file is renamed
     * over the integrity manifest's path (a writable directory, for a principal that can write
     * it). KIND=self-link: the executable's directory is moved aside and a link to it is left in
     * its place: the same directory, by the same dev:ino, reached through a link.
     */
    const AFTER_HASH = () => {
      const fs = process.getBuiltinModule('node:fs');
      const mod = process.getBuiltinModule('node:module') as unknown as {
        syncBuiltinESMExports: () => void;
      };
      const { KIND: kind, TARGET: target } = process.env as Record<string, string>;
      let done = false;
      const read = fs.readFileSync as (...x: unknown[]) => unknown;
      (fs as unknown as Record<string, unknown>).readFileSync = function (
        this: unknown,
        ...a: unknown[]
      ) {
        const out = read.apply(this, a);
        if (!done && typeof a[0] === 'number' && a[1] === undefined) {
          done = true;
          if (kind === 'manifest') {
            fs.chmodSync(process.getBuiltinModule('node:path').dirname(target), 0o755);
            fs.copyFileSync(target, `${target}.new`);
            fs.renameSync(`${target}.new`, target);
          } else {
            fs.renameSync(target, `${target}.away`);
            fs.symlinkSync(`${target}.away`, target);
          }
        }
        return out;
      };
      mod.syncBuiltinESMExports();
    };

    const afterHash = (kind: 'manifest' | 'self-link') => {
      const exe = image();
      const home = join(exe, '..');
      const target = kind === 'manifest' ? join(home, 'native', '.integrity.json') : home;
      const run = inBun((m, c) => c(() => m.greet('World')), {
        FAKE_EXEC: exe,
        BEFORE: AFTER_HASH.toString(),
        KIND: kind,
        TARGET: target,
      });
      makeWritable(`${home}.away`);
      rmSync(`${home}.away`, { recursive: true, force: true });
      return run;
    };

    it('the manifest renamed over its own path after it was read: the path no longer names the file that was judged', () => {
      const r = afterHash('manifest');
      const out = r.result as { cls?: string; message?: string };
      expect(out?.cls, r.stderr).toBe('FfiLoadError');
      expect(out.message).toMatch(/\.integrity\.json is no longer the file that was read/);
    });

    it('a pinned directory replaced by a link to itself: the same dev:ino through a link is not the directory that was judged', () => {
      const r = afterHash('self-link');
      const out = r.result as { cls?: string; message?: string };
      expect(out?.cls, r.stderr).toBe('FfiLoadError');
      expect(out.message).toMatch(/changed while it was being checked/);
    });
  });
});
describe('the library is refused unless only root can write it and own the way to it (a hash of bytes someone else can still change binds nothing)', () => {
  const nativeOf = (exe: string) => join(exe, '..', 'native');
  /** The library's directories, deepest first, then the one native/ sits in (beside the executable). */
  const dirsOf = (exe: string) => [
    join(nativeOf(exe), 'ffi', TRIPLE),
    join(nativeOf(exe), 'ffi'),
    nativeOf(exe),
    join(exe, '..'),
  ];
  const libOf = (exe: string) => join(nativeOf(exe), 'ffi', TRIPLE, LIB);
  const aboveOf = (exe: string) => ancestorsAbove(exe);
  const reEscape = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  /** Two calls, so a refusal's being cached shows too. */
  const load = (
    exe: string,
    ids: {
      euid?: number;
      owner?: number;
      at?: Record<string, number>;
      modes?: Record<string, number>;
      timeoutMs?: number;
    } = {},
  ) =>
    inBun((m, c) => [c(() => m.greet('World')), c(() => m.add(1, 2))], {
      FAKE_EXEC: exe,
      ...(ids.euid === undefined ? {} : { FAKE_EUID: String(ids.euid) }),
      ...(ids.owner === undefined ? {} : { FAKE_OWNER: String(ids.owner) }),
      ...(ids.at === undefined ? {} : { FAKE_OWNER_AT: JSON.stringify(ids.at) }),
      ...(ids.modes === undefined ? {} : { FAKE_MODE_AT: JSON.stringify(ids.modes) }),
      ...(ids.timeoutMs === undefined ? {} : { TIMEOUT_MS: String(ids.timeoutMs) }),
    });

  const refused = (r: Run, expected: RegExp) => {
    const [first, second] = r.result as { cls: string; message: string }[];
    expect(first?.cls, r.stderr).toBe('FfiLoadError');
    expect(first?.message).toMatch(expected);
    // Nothing was loaded, and the refusal is cached like every other load failure.
    expect(first?.message).toContain('refusing to load');
    expect(second).toEqual(first as { cls: string; message: string });
  };

  const loaded = (r: Run) => {
    expect(r.result, r.stderr).toEqual([{ ok: 'Hello, World!' }, { ok: 3 }]);
  };

  it('a library its group can write is refused', () => {
    const exe = image();
    chmodSync(libOf(exe), 0o464);
    refused(load(exe), /is writable by its group or by everyone \(mode 0464\)/);
  });

  it('a library everyone can write is refused', () => {
    const exe = image();
    chmodSync(libOf(exe), 0o446);
    refused(load(exe), /is writable by its group or by everyone \(mode 0446\)/);
  });

  it('every directory from the library up to the one native/ sits in is checked for group and world write, and named', () => {
    for (const mode of [0o775, 0o757]) {
      for (const i of [0, 1, 2, 3]) {
        const exe = image();
        const target = dirsOf(exe)[i] as string;
        chmodSync(target, mode);
        refused(
          load(exe),
          new RegExp(
            `\\n  ${reEscape(target)} is writable by its group or by everyone \\(mode 0${mode.toString(8)}\\)`,
          ),
        );
      }
    }
  });

  it('a library owned by anyone but root is refused, the user the app runs as included, whoever runs the process', () => {
    for (const euid of [0, 1000, 65532]) {
      for (const owner of [1000, 12345, 65532]) {
        refused(
          load(image(), { euid, owner }),
          new RegExp(`is owned by uid ${owner}, but only root may own it`),
        );
      }
    }
  });

  it('a library its owner cannot write is still refused when the owner is not root: that user can chmod it back', () => {
    const exe = image(); // sealed: 0555 / 0444
    refused(
      load(exe, { euid: 1000, owner: 1000 }),
      /is owned by uid 1000, but only root may own it/,
    );
  });

  it('a directory owned by anyone but root is refused and named, the one native/ sits in included', () => {
    for (const i of [0, 1, 2, 3]) {
      const exe = image();
      const dir = dirsOf(exe)[i] as string;
      refused(
        load(exe, { at: { [dir]: 1000 } }),
        new RegExp(`\\n  ${reEscape(dir)} is owned by uid 1000, but only root may own it`),
      );
    }
  });

  it('the walk is exactly the library, its directories, the one native/ sits in, and every directory above it up to /: nothing else, and every stat is bigint', () => {
    const exe = image();
    const r = inBun(
      (m, c) => [
        c(() => m.greet('World')),
        (globalThis as { statted?: string[] }).statted,
        (globalThis as { notBigint?: string[] }).notBigint,
      ],
      { FAKE_EXEC: exe },
    );
    const [greet, statted, notBigint] = r.result as [unknown, string[], string[]];
    expect(greet, r.stderr).toEqual({ ok: 'Hello, World!' });
    // Each directory is stat-ed twice (before the manifest is read, and again after the library
    // is hashed), so judge the set of what was touched, not the count. The library's own path is
    // looked at too (an lstat: is anything staged?), as is the manifest's, and both once more
    // after the hash (is the path still the file that was read?).
    expect([...new Set(statted)].sort()).toEqual(
      [
        'fd',
        libOf(exe),
        join(nativeOf(exe), '.integrity.json'),
        ...dirsOf(exe),
        ...aboveOf(exe),
      ].sort(),
    );
    expect(aboveOf(exe).at(-1)).toBe('/');
    // dev:ino as Numbers collide above 2^53, so none of it may be asked for as a Number.
    expect(notBigint).toEqual([]);
  });

  it('a directory pinned by dev:ino is compared as a bigint: two inodes that differ only above 2^53 are two directories', () => {
    const COLLIDE = () => {
      const fs = process.getBuiltinModule('node:fs');
      const mod = process.getBuiltinModule('node:module') as unknown as {
        syncBuiltinESMExports: () => void;
      };
      const target = process.env.TARGET as string;
      let n = 0;
      const real = fs.lstatSync as (...x: unknown[]) => object | undefined;
      (fs as unknown as Record<string, unknown>).lstatSync = function (
        this: unknown,
        ...a: unknown[]
      ) {
        const st = real.apply(this, a);
        if (st === undefined || String(a[0]) !== target) return st;
        // 2^53 and 2^53 + 1: one Number, two bigints.
        const k = n++ === 0 ? 0 : 1;
        const ino =
          (a[1] as { bigint?: boolean } | undefined)?.bigint === true
            ? BigInt('9007199254740992') + BigInt(k)
            : 9007199254740992 + k;
        return Object.assign(Object.create(Object.getPrototypeOf(st)), st, { ino });
      };
      mod.syncBuiltinESMExports();
    };
    const exe = image();
    const r = inBun((m, c) => c(() => m.greet('World')), {
      FAKE_EXEC: exe,
      BEFORE: COLLIDE.toString(),
      TARGET: join(exe, '..'),
    });
    const out = r.result as { cls?: string; message?: string };
    expect(out?.cls, r.stderr).toBe('FfiLoadError');
    expect(out.message).toMatch(/changed while it was being checked/);
  });

  it('every directory above the one native/ sits in, up to /, must be owned by root: one owned by anyone else is refused and named', () => {
    const exe = image();
    for (const dir of aboveOf(exe)) {
      refused(
        load(exe, { at: { [dir]: 1000 } }),
        new RegExp(`\\n  ${reEscape(dir)} is owned by uid 1000, but only root may own it`),
      );
    }
  });

  it('and not writable by group or other, a sticky directory (a /tmp) included, as OpenSSH StrictModes refuses any group- or world-writable directory: the message prints the full mode, so the sticky and setgid bits show', () => {
    const exe = image();
    for (const dir of aboveOf(exe)) {
      for (const bits of [0o775, 0o757, 0o1777, 0o2775, 0o3777]) {
        refused(
          load(exe, { modes: { [dir]: bits } }),
          new RegExp(
            `\\n  ${reEscape(dir)} is writable by its group or by everyone \\(mode ${(bits & 0o7777).toString(8).padStart(4, '0')}\\)`,
          ),
        );
      }
    }
  });

  describe('a directory refusal lists every directory that fails, in one message, and tells the reader how to fix a directory (not a file)', () => {
    const message = (r: Run) => {
      refused(
        r,
        /directories on the way to it cannot be trusted|directory on the way to it cannot be trusted/,
      );
      return (r.result as { message: string }[])[0]?.message as string;
    };

    it('three bad directories, one message, each named once and nothing else', () => {
      const exe = image();
      const [libDir, nativeDir, home] = [
        dirsOf(exe)[0],
        dirsOf(exe)[2],
        dirsOf(exe)[3],
      ] as string[];
      const above = aboveOf(exe);
      const top = above[0] as string; // the directory above the one the executable is in
      chmodSync(libDir, 0o775);
      const text = message(load(exe, { at: { [nativeDir]: 1000 }, modes: { [top]: 0o1777 } }));
      expect(text).toContain('3 directories on the way to it cannot be trusted');
      const lines = text.split('\n').filter((l) => l.startsWith('  '));
      expect(lines.map((l) => l.trim().split(' ')[0]).sort()).toEqual(
        [libDir, nativeDir, top].sort(),
      );
      expect(text).toContain(`${libDir} is writable by its group or by everyone (mode 0775)`);
      expect(text).toContain(`${nativeDir} is owned by uid 1000, but only root may own it`);
      expect(text).toContain(`${top} is writable by its group or by everyone (mode 1777)`);
      // The executable's own directory passed, so it is not in the list.
      expect(lines.some((l) => l.trim().startsWith(`${home} `))).toBe(false);
    });

    it('one bad directory reads in the singular', () => {
      const exe = image();
      const text = message(load(exe, { modes: { [aboveOf(exe)[0] as string]: 0o775 } }));
      expect(text).toContain('1 directory on the way to it cannot be trusted');
    });

    it('the hint is for a directory: chmod go-w, a root-owned install directory, a Dockerfile RUN; never the file COPY flags', () => {
      const exe = image();
      const text = message(load(exe, { modes: { [aboveOf(exe)[0] as string]: 0o775 } }));
      expect(text).toContain('chmod go-w');
      expect(text).toContain('/opt/<app>');
      expect(text).toContain('RUN chmod go-w');
      expect(text).toContain('a directory inside a copied tree keeps the build host');
      expect(text).not.toContain('COPY --chown');
      expect(text).not.toContain('its bytes could change');
      expect(text).toContain('could be renamed or replaced after it was checked');
    });

    it('a file refusal keeps the file hint (COPY --chown=0:0 --chmod=a-w) and does not talk about directories', () => {
      const exe = image();
      chmodSync(libOf(exe), 0o464);
      const [first] = load(exe).result as { message: string }[];
      expect(first?.message).toContain('its bytes could change after they were checked');
      expect(first?.message).toContain('COPY --chown=0:0 --chmod=a-w');
      expect(first?.message).not.toContain('RUN chmod go-w');
    });

    it('a link on the way is listed with the others, and its fix is the directory itself', () => {
      const exe = image({ seal: false });
      const at = join(exe, '..', 'native', 'ffi');
      const away = join(emptyDir('away'), 'moved');
      renameSync(at, away);
      symlinkSync(away, at);
      sealImage(exe);
      const text = message(load(exe, { modes: { [aboveOf(exe)[0] as string]: 0o775 } }));
      expect(text).toContain('2 directories on the way to it cannot be trusted');
      expect(text).toContain(`${at} is a symbolic link`);
      expect(text).toContain('replace it with the directory itself');
    });
  });

  describe("a link at or above the executable's directory is refused, never followed (the real target is a good tree that loads by its real path)", () => {
    const refusedLink = (r: Run, via: string) => {
      refused(r, new RegExp(`${reEscape(via)} is not the real path of its directory`));
      const text = (r.result as { message: string }[])[0]?.message as string;
      expect(text).toContain('a symbolic link is in the way at or above it');
    };

    it("a link AT the executable's directory", () => {
      const exe = image();
      // The control: the same tree, by its real path, loads.
      loaded(load(exe));
      const via = join(emptyDir('via'), 'bin');
      symlinkSync(join(exe, '..'), via);
      refusedLink(load(join(via, 'server')), via);
    });

    it("a link ABOVE the executable's directory", () => {
      const exe = image();
      const home = join(exe, '..');
      const alias = join(emptyDir('alias'), 'up');
      symlinkSync(join(home, '..'), alias);
      const throughLink = join(alias, basename(home));
      refusedLink(load(join(throughLink, 'server')), throughLink);
    });

    it('nothing is judged or read once the link is seen: the refusal comes before every stat of the tree', () => {
      const exe = image();
      const via = join(emptyDir('via'), 'bin');
      symlinkSync(join(exe, '..'), via);
      const r = inBun(
        (m, c) => [c(() => m.greet('World')), (globalThis as { statted?: string[] }).statted],
        { FAKE_EXEC: join(via, 'server') },
      );
      const [refusal, statted] = r.result as [{ cls: string }, string[]];
      expect(refusal.cls, r.stderr).toBe('FfiLoadError');
      // Only the "is anything staged" look at the library's path: no directory, no manifest.
      expect(statted.filter((p) => p !== 'fd')).toEqual([join(via, 'native', 'ffi', TRIPLE, LIB)]);
    });

    it('with nothing staged a link in the executable\'s path is not a refusal of its own: the ordinary "cannot find" answer', () => {
      const empty = emptyDir('bare');
      const via = join(emptyDir('via'), 'bin');
      symlinkSync(empty, via);
      const r = inBun((m, c) => c(() => m.greet('World')), { FAKE_EXEC: join(via, 'server') });
      const out = r.result as { cls?: string; message?: string };
      expect(out?.cls, r.stderr).toBe('FfiLoadError');
      expect(out.message).toContain('cannot find the Rust library');
      expect(out.message).not.toContain('refusing to load');
    });
  });

  it('a link inside the checked tree is refused wherever it is, whatever it points at: native/ffi and native/ itself', () => {
    for (const rel of ['native/ffi', 'native']) {
      const exe = image({ seal: false });
      const at = join(exe, '..', rel);
      const away = join(emptyDir('away'), 'moved');
      renameSync(at, away);
      symlinkSync(away, at);
      sealImage(exe);
      refused(load(exe), new RegExp(`${reEscape(at)} is a symbolic link`));
    }
  });

  describe('a manifest or a library that is not a regular file is refused, and never waited for', () => {
    const manifestOf = (exe: string) => join(nativeOf(exe), '.integrity.json');
    const mkfifo = (p: string) => {
      const r = spawnSync('mkfifo', [p]);
      if (r.status !== 0) throw new Error(`mkfifo ${p}: ${r.stderr}`);
    };
    const notRegular = (r: Run, path: string) => {
      // A load that blocked on the pipe never answers: the harness would have killed it.
      expect(r.status, `the loader blocked on ${path}: ${r.stderr}`).toBe(0);
      refused(r, new RegExp(`${reEscape(path)} is not a regular file`));
    };

    it('a FIFO at the manifest', () => {
      const exe = image({ seal: false });
      rmSync(manifestOf(exe));
      mkfifo(manifestOf(exe));
      sealImage(exe);
      notRegular(load(exe, { timeoutMs: 20_000 }), manifestOf(exe));
    });

    it('a FIFO at the library', () => {
      const exe = image({ seal: false });
      rmSync(libOf(exe));
      mkfifo(libOf(exe));
      sealImage(exe);
      notRegular(load(exe, { timeoutMs: 20_000 }), libOf(exe));
    });

    it('a directory at the manifest (opening it works; reading it does not)', () => {
      const exe = image({ seal: false });
      rmSync(manifestOf(exe));
      mkdirSync(manifestOf(exe));
      sealImage(exe);
      notRegular(load(exe), manifestOf(exe));
    });
  });

  it('a platform that cannot open without following links or without blocking is refused: an absent or zero flag would OR in as 0 and quietly allow both', () => {
    const FLAG_GONE = () => {
      const fs = process.getBuiltinModule('node:fs');
      const value = process.env.FLAG_VALUE === 'zero' ? 0 : undefined;
      Object.defineProperty(fs.constants, process.env.FLAG as string, {
        value,
        configurable: true,
      });
    };
    for (const flag of ['O_NOFOLLOW', 'O_NONBLOCK']) {
      for (const value of ['undefined', 'zero']) {
        const r = inBun((m, c) => c(() => m.greet('World')), {
          FAKE_EXEC: image(),
          BEFORE: FLAG_GONE.toString(),
          FLAG: flag,
          FLAG_VALUE: value,
        });
        const out = r.result as { cls?: string; message?: string };
        expect(out?.cls, `${flag} ${value}: ${r.stderr}`).toBe('FfiLoadError');
        expect(out.message, `${flag} ${value}`).toContain(
          'this platform cannot open the integrity manifest without following links or blocking',
        );
      }
    }
  });

  it('the file refusal tells the reader what the images `knext deploy` and `knext preview` build do, and that the way up to / counts too', () => {
    const exe = image();
    chmodSync(libOf(exe), 0o464);
    refused(load(exe), /COPY --chown=0:0 --chmod=a-w/);
    refused(load(exe), /the images `knext deploy` and `knext preview` build copy native\//);
    refused(load(exe), /every directory from the library up to \/ must also be/);
    // `knext build` does not build the image this refers to.
    expect(
      ((load(exe).result as { message: string }[])[0] as { message: string }).message,
    ).not.toContain('knext build');
  });

  it('a symlink at the staged path is refused as a link, never followed: whatever it points at, root-owned and read-only included', () => {
    const exe = image({ seal: false });
    const target = join(emptyDir('away'), LIB);
    copyFileSync(libOf(exe), target);
    chmodSync(target, 0o444);
    rmSync(libOf(exe));
    symlinkSync(target, libOf(exe));
    sealImage(exe);
    // The manifest's hash is right (same bytes), and a 0444 target passes the owner and mode
    // rule: only the link itself is wrong. Following it is what let a swapped-in tree point
    // at any root-owned library.
    refused(load(exe), new RegExp(`${reEscape(libOf(exe))} is a symbolic link`));
  });

  it('a symlink at the integrity manifest is refused as a link, whatever it points at', () => {
    const exe = image({ seal: false });
    const manifest = join(nativeOf(exe), '.integrity.json');
    const target = join(emptyDir('away'), 'integrity.json');
    copyFileSync(manifest, target);
    chmodSync(target, 0o444);
    rmSync(manifest);
    symlinkSync(target, manifest);
    sealImage(exe);
    refused(load(exe), new RegExp(`${reEscape(manifest)} is a symbolic link`));
  });

  describe('the integrity manifest is judged like the library: whoever can write it chooses what loads', () => {
    const manifestOf = (exe: string) => join(nativeOf(exe), '.integrity.json');
    const loadWith = (exe: string, ino: Record<string, number>) =>
      inBun((m, c) => [c(() => m.greet('World')), c(() => m.add(1, 2))], {
        FAKE_EXEC: exe,
        FAKE_OWNER_INO: JSON.stringify(ino),
      });

    it('a manifest owned by anyone but root is refused, and the refusal names it', () => {
      const exe = image();
      refused(
        loadWith(exe, { [idOf(manifestOf(exe))]: 1000 }),
        new RegExp(`${reEscape(manifestOf(exe))} is owned by uid 1000, but only root may own it`),
      );
    });

    it('a manifest its group or everyone can write is refused', () => {
      for (const mode of [0o464, 0o446]) {
        const exe = image();
        chmodSync(manifestOf(exe), mode);
        refused(
          load(exe),
          new RegExp(
            `${reEscape(manifestOf(exe))} is writable by its group or by everyone \\(mode 0${mode.toString(8)}\\)`,
          ),
        );
      }
    });

    it('a root-owned manifest with the owner-write bit set still loads (a plain COPY leaves 0644)', () => {
      const exe = image();
      chmodSync(manifestOf(exe), 0o644);
      loaded(load(exe));
    });
  });

  it('the image layout loads: root-owned, read-only, run by a non-root user or by root', () => {
    for (const euid of [65532, 0]) loaded(load(image(), { euid }));
  });

  it('root-owned with the owner-write bit set loads (a plain COPY; BuildKit leaves the top native/ at 0755)', () => {
    for (const euid of [65532, 0]) {
      const exe = image();
      for (const d of dirsOf(exe).slice(0, 3)) chmodSync(d, 0o755);
      chmodSync(libOf(exe), 0o644);
      loaded(load(exe, { euid }));
    }
  });

  it('with no faked owner the module reads the real one: a tree owned by the user running the tests is refused, unless that user is root', () => {
    const exe = image();
    const r = inBun((m, c) => [c(() => m.greet('World')), c(() => m.add(1, 2))], {
      FAKE_EXEC: exe,
      FAKE_OWNER: undefined,
    });
    const uid = process.getuid?.() ?? -1;
    // Root running the tests owns the staged tree as uid 0, which is exactly what the rule accepts.
    if (uid === 0) loaded(r);
    else refused(r, new RegExp(`is owned by uid ${uid}, but only root may own it`));
  });
});

describe('path 2 — the development fallback, only when NODE_ENV !== production', () => {
  function devApp(): void {
    for (const p of ['release', 'debug']) {
      mkdirSync(join(app, 'rust', 'target', p), { recursive: true });
    }
    copyFileSync(libs.good as string, join(app, 'rust', 'target', 'release', LIB));
    copyFileSync(libs.debug as string, join(app, 'rust', 'target', 'debug', LIB));
  }
  const noImage = () => join(emptyDir('no-image'), 'server');

  it('loads the newest host build from <crate>/target/{release,debug}, with a one-line notice and no integrity check', () => {
    devApp();
    const old = new Date(Date.now() - 60_000);
    utimesSync(join(app, 'rust', 'target', 'release', LIB), old, old);
    const debugNewest = inBun((m) => m.greet('dev'), {
      FAKE_EXEC: noImage(),
      NODE_ENV: 'development',
    });
    expect(debugNewest.result, debugNewest.stderr).toBe('Debug, dev!');
    expect(debugNewest.stderr).toContain('knext ffi: loading the development build');
    expect(debugNewest.stderr).toContain('without an integrity check');

    utimesSync(join(app, 'rust', 'target', 'debug', LIB), old, old);
    const now = new Date();
    utimesSync(join(app, 'rust', 'target', 'release', LIB), now, now);
    const releaseNewest = inBun((m) => m.greet('dev'), {
      FAKE_EXEC: noImage(),
      NODE_ENV: 'development',
    });
    expect(releaseNewest.result, releaseNewest.stderr).toBe('Hello, dev!');
  });

  /**
   * A staged library that is refused must stop the load. In development the host build under
   * <crate>/target is accepted with no check at all, so a refusal that fell through to it would turn
   * every integrity and ownership rule into a warning on a machine that has both.
   */
  describe('a staged library that is refused never falls through to the development build', () => {
    const refusals: [string, () => string, Record<string, string>, RegExp][] = [
      [
        'a sha256 that does not match',
        () => image({ integrity: 'mismatch' }),
        {},
        /sha256 mismatch/,
      ],
      [
        'a library the manifest does not list',
        () => image({ integrity: 'unlisted' }),
        {},
        /not listed/,
      ],
      ['no integrity manifest', () => image({ integrity: 'absent' }), {}, /integrity/],
      [
        'a library its group can write',
        () => {
          const exe = image();
          chmodSync(join(exe, '..', 'native', 'ffi', TRIPLE, LIB), 0o464);
          return exe;
        },
        {},
        /is writable by its group or by everyone/,
      ],
      [
        'a library owned by the user the app runs as',
        () => image(),
        { FAKE_OWNER: '1000', FAKE_EUID: '1000' },
        /is owned by uid 1000, but only root may own it/,
      ],
      [
        // existsSync() follows a link and says no to a dangling one, which would read as "nothing
        // staged" and fall through to the unchecked development build.
        'a dangling symlink at the staged path',
        () => {
          const exe = image({ seal: false });
          const native = join(exe, '..', 'native');
          rmSync(join(native, 'ffi', TRIPLE, LIB));
          symlinkSync(join(emptyDir('gone'), 'missing.so'), join(native, 'ffi', TRIPLE, LIB));
          chmodSync(join(native, '.integrity.json'), 0o444);
          for (const d of [join(native, 'ffi', TRIPLE), join(native, 'ffi'), native]) {
            chmodSync(d, 0o555);
          }
          return exe;
        },
        {},
        /is a symbolic link/,
      ],
    ];

    for (const [name, make, env, expected] of refusals) {
      it(`${name}: the call throws the refusal, twice, and the development build is never loaded`, () => {
        devApp();
        const r = inBun((m, c) => [c(() => m.greet('x')), c(() => m.add(1, 2))], {
          FAKE_EXEC: make(),
          NODE_ENV: 'development',
          ...env,
        });
        const [first, second] = r.result as { cls?: string; message?: string; ok?: unknown }[];
        expect(first?.cls, r.stderr).toBe('FfiLoadError');
        expect(first?.message).toMatch(expected);
        expect(first?.message).not.toContain(join('rust', 'target'));
        expect(second).toEqual(first as object);
        // The notice that precedes a development load never printed.
        expect(r.stderr).not.toContain('loading the development build');
      });
    }

    it('a valid staged library still wins over a newer development build', () => {
      devApp();
      const now = new Date();
      utimesSync(join(app, 'rust', 'target', 'debug', LIB), now, now);
      const r = inBun((m) => m.greet('x'), { FAKE_EXEC: image(), NODE_ENV: 'development' });
      // The debug build would say "Debug, x!".
      expect(r.result, r.stderr).toBe('Hello, x!');
      expect(r.stderr).not.toContain('loading the development build');
    });
  });

  it('is never used in production: the error lists every path tried and names knext ffi build', () => {
    devApp();
    const exe = noImage();
    const r = inBun((m, c) => c(() => m.greet('x')), { FAKE_EXEC: exe, NODE_ENV: 'production' });
    const out = r.result as { cls: string; message: string };
    expect(out.cls, r.stderr).toBe('FfiLoadError');
    expect(out.message).toContain(join(exe, '..', 'native', 'ffi', TRIPLE, LIB));
    expect(out.message).not.toContain(join('rust', 'target'));
    expect(out.message).toContain('knext ffi build');
    // At request time the call is not prerendering: the message must not say it is.
    expect(out.message).not.toContain('prerender');
    expect(out.message).not.toContain('force-dynamic');
  });

  it('in development with no build at all, the error lists the staged path and both development paths', () => {
    rmSync(join(app, 'rust'), { recursive: true, force: true });
    const exe = noImage();
    const r = inBun((m, c) => c(() => m.greet('x')), { FAKE_EXEC: exe, NODE_ENV: 'development' });
    const out = r.result as { cls: string; message: string };
    expect(out.cls, r.stderr).toBe('FfiLoadError');
    expect(out.message).toContain(join(exe, '..', 'native', 'ffi', TRIPLE, LIB));
    expect(out.message).toContain(join(app, 'rust', 'target', 'release', LIB));
    expect(out.message).toContain(join(app, 'rust', 'target', 'debug', LIB));
  });
});

describe('prerendering (ADR-0069 round 2): calls work in dynamic contexts only', () => {
  it('during next build with no library anywhere, the error is the prerender one, not "cannot find the Rust library"', () => {
    const r = inBun((m, c) => c(() => m.greet('x')), {
      FAKE_EXEC: join(emptyDir('no-image'), 'server'),
      NEXT_PHASE: 'phase-production-build',
    });
    const out = r.result as { cls: string; message: string };
    expect(out.cls, r.stderr).toBe('FfiLoadError');
    expect(out.message).toContain('This call happened while `next build` was prerendering');
    expect(out.message).toContain('force-dynamic');
    expect(out.message).not.toContain('cannot find the Rust library');
  });

  it('NEXT_PHASE=phase-production-build wins over a perfectly good library', () => {
    const r = inBun((m, c) => c(() => m.greet('x')), {
      FAKE_EXEC: image(),
      NEXT_PHASE: 'phase-production-build',
    });
    const out = r.result as { cls: string; message: string };
    expect(out.cls, r.stderr).toBe('FfiLoadError');
    for (const s of [
      'prerendering',
      'generateStaticParams',
      'generateMetadata',
      "export const dynamic = 'force-dynamic'",
      'await connection()',
    ]) {
      expect(out.message).toContain(s);
    }
  });
});

describe('slow calls are made visible (counted, logged once), not preemptible', () => {
  /** The `fn` -> count samples of knext_ffi_slow_calls_total in an exposition. */
  const slowCounts = (text: string) =>
    Object.fromEntries(
      [...text.matchAll(/^knext_ffi_slow_calls_total\{fn="([^"]+)"\} (\d+)$/gm)].map((x) => [
        x[1],
        Number(x[2]),
      ]),
    );
  const slowLines = (stderr: string) =>
    stderr.split('\n').filter((l) => l.includes('slow-call threshold'));
  const allZero = () => Object.fromEntries(manifest.fns.map((f) => [f.name, 0]));
  it('a call over the threshold is counted once per call and logged once per function; its result is unchanged', () => {
    const r = inBun(
      (m) => {
        // What the module publishes for the metrics port: null before anything is published.
        const read = () => {
          const render = (globalThis as Record<symbol, unknown>)[
            Symbol.for('knext.ffi.renderMetrics')
          ];
          return typeof render === 'function' ? render() : null;
        };
        const before = read();
        const results = [m.add(2, 3), m.add(-1, 0), m.add(40, 2), m.greet('fast')];
        return { before, results, text: read() };
      },
      { FAKE_EXEC: image({ lib: libs.slow }), KNEXT_FFI_SLOW_CALL_MS: '' },
    );
    expect(r.status, r.stderr).toBe(0);
    const out = r.result as { before: unknown; results: unknown[]; text: string };
    // Nothing is published at import time: the first call publishes it.
    expect(out.before).toBeNull();
    expect(out.results).toEqual([5, -1, 42, 'Hello, fast!']);
    expect(slowCounts(out.text)).toEqual({ ...allZero(), add: 3 });
    expect(out.text.match(/^# TYPE knext_ffi_slow_calls_total counter$/gm)).toHaveLength(1);
    expect(out.text.match(/^# TYPE knext_ffi_load_seconds gauge$/gm)).toHaveLength(1);
    expect(out.text.endsWith('\n')).toBe(true);
    const lines = slowLines(r.stderr);
    expect(lines, r.stderr).toHaveLength(1);
    expect(lines[0]).toMatch(
      /^knext ffi: add\(\) took (\d+\.\d) ms, over the 50 ms slow-call threshold \(KNEXT_FFI_SLOW_CALL_MS\)\./,
    );
    const took = Number(/took (\d+\.\d) ms/.exec(lines[0] as string)?.[1]);
    expect(took).toBeGreaterThanOrEqual(SLOW_ADD_MS - 1);
  });

  it('the fast path counts nothing and logs nothing', () => {
    const r = inBun(
      (m) => {
        for (let i = 0; i < 1000; i++) m.add(i, 1);
        m.greet('x');
        m.sum(new Uint8Array([1, 2, 3]));
        const render = (globalThis as Record<symbol, () => string>)[
          Symbol.for('knext.ffi.renderMetrics')
        ];
        return render?.() ?? null;
      },
      { FAKE_EXEC: image(), KNEXT_FFI_SLOW_CALL_MS: '' },
    );
    expect(r.status, r.stderr).toBe(0);
    expect(slowCounts(r.result as string)).toEqual(allZero());
    expect(slowLines(r.stderr)).toEqual([]);
  });

  it('the first load (path resolution, integrity hash, dlopen) is reported once, in seconds, labelled by library', () => {
    const r = inBun(
      (m) => {
        m.add(1, 1);
        m.add(1, 1);
        const render = (globalThis as Record<symbol, () => string>)[
          Symbol.for('knext.ffi.renderMetrics')
        ];
        return render?.() ?? null;
      },
      { FAKE_EXEC: image() },
    );
    expect(r.status, r.stderr).toBe(0);
    const samples = [
      ...(r.result as string).matchAll(/^knext_ffi_load_seconds\{lib="([^"]+)"\} (\S+)$/gm),
    ];
    expect(samples.map((x) => x[1])).toEqual(['fixture']);
    const seconds = Number(samples[0]?.[2]);
    expect(seconds).toBeGreaterThan(0);
    expect(seconds).toBeLessThan(10);
  });

  it('KNEXT_FFI_SLOW_CALL_MS sets the threshold, 0 turns counting off, and an unusable value falls back to 50 with a warning', () => {
    const run = (value: string) =>
      inBun(
        (m) => {
          m.add(2, 3);
          const render = (globalThis as Record<symbol, () => string>)[
            Symbol.for('knext.ffi.renderMetrics')
          ];
          return render?.() ?? null;
        },
        { FAKE_EXEC: image({ lib: libs.slow }), KNEXT_FFI_SLOW_CALL_MS: value },
      );
    const raised = run('1000');
    expect(raised.status, raised.stderr).toBe(0);
    expect(slowCounts(raised.result as string).add).toBe(0);
    expect(slowLines(raised.stderr)).toEqual([]);

    const lowered = run('2.5');
    expect(slowCounts(lowered.result as string).add).toBe(1);
    expect(slowLines(lowered.stderr)[0]).toContain('over the 2.5 ms slow-call threshold');

    const off = run('0');
    expect(off.status, off.stderr).toBe(0);
    expect(slowCounts(off.result as string).add).toBe(0);
    expect(slowLines(off.stderr)).toEqual([]);

    for (const bad of ['fast', '-5', 'Infinity']) {
      const r = run(bad);
      expect(r.status, r.stderr).toBe(0);
      expect(r.stderr).toContain(
        `knext ffi: ignoring KNEXT_FFI_SLOW_CALL_MS=${JSON.stringify(bad)}: it must be a number of milliseconds (0 turns slow-call counting off). Using 50.`,
      );
      expect(slowCounts(r.result as string).add).toBe(1);
    }
  });

  it('two copies of the module in one process (Next loads one per bundler layer) count into one place', () => {
    const r = inBun(
      async (m) => {
        const copy = await import(`${process.env.MODULE_PATH}?copy=2`);
        const same = copy === m;
        m.add(1, 2);
        copy.add(3, 4);
        const render = (globalThis as Record<symbol, () => string>)[
          Symbol.for('knext.ffi.renderMetrics')
        ];
        return { same, text: render() };
      },
      {
        FAKE_EXEC: image({ lib: libs.slow }),
        MODULE_PATH: join(app, 'src', 'generated', 'ffi', 'index.ts'),
        KNEXT_FFI_SLOW_CALL_MS: '',
      },
    );
    expect(r.status, r.stderr).toBe(0);
    const out = r.result as { same: boolean; text: string };
    expect(out.same).toBe(false);
    expect(slowCounts(out.text).add).toBe(2);
    // Logged once per function per process, not once per copy.
    expect(slowLines(r.stderr)).toHaveLength(1);
  });

  it("core's metrics listener serves the counters over HTTP (the seam key matches end to end)", () => {
    const r = inBun(
      async (m) => {
        const { startDeepHealthLite } = await import(process.env.CORE_LITE as string);
        m.add(2, 3);
        const server = startDeepHealthLite({
          port: 0,
          env: {},
          app: 'a',
          readActivityAt: () => undefined,
          loadHealth: async () => {
            throw new Error('must not probe an idle app');
          },
        });
        if (!server.listening) await new Promise((ok) => server.once('listening', ok));
        const res = await fetch(`http://127.0.0.1:${server.address().port}/metrics`);
        const text = await res.text();
        server.close();
        return { status: res.status, text };
      },
      {
        FAKE_EXEC: image({ lib: libs.slow }),
        CORE_LITE: CORE_DEEP_HEALTH_LITE,
        KNEXT_FFI_SLOW_CALL_MS: '',
      },
    );
    expect(r.status, r.stderr).toBe(0);
    const out = r.result as { status: number; text: string };
    expect(out.status).toBe(200);
    expect(slowCounts(out.text)).toEqual({ ...allZero(), add: 1 });
    expect(out.text).toMatch(/^knext_ffi_load_seconds\{lib="fixture"\} \S+$/m);
  });
});

describe('the module is server-only and does nothing at import time', () => {
  it('without the react-server condition, importing it throws (server-only is real)', () => {
    const r = inBun((m) => m.greet('x'), { FAKE_EXEC: image() }, []);
    expect(r.result).toBeUndefined();
    expect(r.stderr).toContain('cannot be imported from a Client Component module');
  });

  it('under Bun, importing it never asks for bun:ffi', () => {
    const r = inBun(
      () => (globalThis as unknown as { __knextBuiltins: string[] }).__knextBuiltins,
      {},
      ['--conditions=react-server', '--preload', './count-builtins.ts'],
    );
    expect(r.status, r.stderr).toBe(0);
    expect(r.result).toEqual([]);
  });

  it('under Node: imports with no throw, no file-system access and no bun:ffi; the call is the D15 Node refusal', () => {
    const r = spawnSync('node', ['--conditions=react-server', 'harness-node.mjs'], {
      cwd: app,
      encoding: 'utf8',
      env: { ...process.env, NODE_ENV: 'production', NEXT_PHASE: '', NODE_OPTIONS: '' },
      timeout: 60_000,
    });
    const line = r.stdout.split('\n').find((l) => l.startsWith('RESULT '));
    expect(line, r.stderr).toBeDefined();
    const out = JSON.parse((line as string).slice(7));
    // Node's own ESM loader opens the two modules being imported; nothing else
    // (no native/, no .integrity.json, no crate, no /lib) is touched.
    for (const t of out.atImport.touched as string[]) {
      expect(t).toMatch(/(src\/generated\/ffi\/index\.ts|node_modules\/server-only\/empty\.js)$/);
    }
    expect(out.atImport.asked).toEqual([]);
    expect(out.atImport.exports).toContain('greet');
    expect(out.atImport.exports).toContain('FfiLoadError');
    expect(out.call.cls).toBe('FfiLoadError');
    expect(out.call.message).toBe(
      `In-process Rust (bun:ffi) runs only on Bun; this process is Node ${spawnSync('node', ['--version'], { encoding: 'utf8' }).stdout.trim()}. Run the app with Bun (bun --bun next dev), or call this code through a zone function.`,
    );
    expect(out.again).toBe(true);
  });

  it('under Node during next build, the prerender message wins over the Node refusal', () => {
    const r = spawnSync('node', ['--conditions=react-server', 'harness-node.mjs'], {
      cwd: app,
      encoding: 'utf8',
      env: { ...process.env, NEXT_PHASE: 'phase-production-build', NODE_OPTIONS: '' },
      timeout: 60_000,
    });
    const line = r.stdout.split('\n').find((l) => l.startsWith('RESULT '));
    const out = JSON.parse((line as string).slice(7));
    expect(out.call.message).toContain('prerendering');
    expect(out.call.message).not.toContain('runs only on Bun');
  });
});
