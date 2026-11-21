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
  rmSync,
  statSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { fnv1a64, type Manifest, scanManifest, schemaString } from '../manifest';
import { renderModule } from '../render';
import { blob, D, emptyDir, fn, KITCHEN_SINK, PKG_DIR, removeScratchDirs } from './helpers';
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

/**
 * Make a staged tree what the image carries (`COPY --chown=0:0 --chmod=a-w`):
 * every library and every directory above it, up to native/, read-only. The
 * integrity manifest is left as it is: the loader does not check its mode.
 */
function sealImage(exe: string): void {
  const native = join(exe, '..', 'native');
  const readOnly = (p: string) => chmodSync(p, statSync(p).mode & ~0o222); // a-w
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
 * Modes are the real ones on disk. Every path stat-ed is kept in globalThis.statted.
 */
const FAKE_IDS = () => {
  const fs = process.getBuiltinModule('node:fs');
  const mod = process.getBuiltinModule('node:module') as unknown as {
    syncBuiltinESMExports: () => void;
  };
  const { FAKE_EUID: euid, FAKE_OWNER: owner, FAKE_OWNER_AT: at } = process.env;
  const overrides = at ? (JSON.parse(at) as Record<string, number>) : {};
  const statted: string[] = [];
  (globalThis as unknown as { statted: string[] }).statted = statted;
  if (euid !== undefined)
    (process as unknown as { geteuid: () => number }).geteuid = () => Number(euid);
  for (const k of ['fstatSync', 'statSync'] as const) {
    const real = fs[k] as (...x: unknown[]) => object;
    (fs as unknown as Record<string, unknown>)[k] = function (this: unknown, ...a: unknown[]) {
      const st = real.apply(this, a);
      statted.push(k === 'fstatSync' ? 'fd' : String(a[0]));
      const uid = overrides[String(a[0])] ?? (owner === undefined ? undefined : Number(owner));
      if (uid === undefined) return st;
      return Object.assign(Object.create(Object.getPrototypeOf(st)), st, { uid });
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
      // A scenario that stages a tree (FAKE_EXEC) is told its owner; one that does not touches nothing.
      ...(env.FAKE_EXEC === undefined && env.BEFORE === undefined
        ? {}
        : {
            BEFORE: `async () => { ${env.FAKE_EXEC === undefined ? '' : `(${FAKE_IDS})();`} ${env.BEFORE === undefined ? '' : `await (${env.BEFORE})();`} }`,
          }),
    },
    timeout: 60_000,
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
        // The library's bytes, not the manifest's (read by path as UTF-8).
        if (typeof a[0] === 'number' || String(a[0]) === staged) swap('read');
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
    it(`a library ${how === 'rename' ? 'renamed over' : 'symlinked at'} the staged path at ${when} is not the one loaded`, () => {
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
      // ...and the library loaded is still the one whose bytes were hashed, on
      // Linux (/proc/self/fd/<n>) and macOS (/dev/fd/<n>) alike.
      expect(out.greet).toEqual({ ok: 'Hello, World!' });
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
        if (String(a[0]).endsWith('.integrity.json')) flipped = true;
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
  const reEscape = (t: string) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

  /** Two calls, so a refusal's being cached shows too. */
  const load = (
    exe: string,
    ids: { euid?: number; owner?: number; at?: Record<string, number> } = {},
  ) =>
    inBun((m, c) => [c(() => m.greet('World')), c(() => m.add(1, 2))], {
      FAKE_EXEC: exe,
      ...(ids.euid === undefined ? {} : { FAKE_EUID: String(ids.euid) }),
      ...(ids.owner === undefined ? {} : { FAKE_OWNER: String(ids.owner) }),
      ...(ids.at === undefined ? {} : { FAKE_OWNER_AT: JSON.stringify(ids.at) }),
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
            `: ${reEscape(target)} is writable by its group or by everyone \\(mode 0${mode.toString(8)}\\)`,
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
        new RegExp(`: ${reEscape(dir)} is owned by uid 1000, but only root may own it`),
      );
    }
  });

  it('the walk is bounded: the library, its three directories and the one native/ sits in, and nothing above', () => {
    const exe = image();
    const r = inBun(
      (m, c) => [c(() => m.greet('World')), (globalThis as { statted?: string[] }).statted],
      {
        FAKE_EXEC: exe,
      },
    );
    const [greet, statted] = r.result as [unknown, string[]];
    expect(greet, r.stderr).toEqual({ ok: 'Hello, World!' });
    expect([...statted].sort()).toEqual(['fd', ...dirsOf(exe)].sort());
    expect(statted).not.toContain(join(exe, '..', '..'));
  });

  it('the refusal tells the reader what the image does and that the directory holding native/ counts too', () => {
    const exe = image();
    chmodSync(libOf(exe), 0o464);
    refused(load(exe), /COPY --chown=0:0 --chmod=a-w/);
    refused(load(exe), /the directory that holds native\/ /);
  });

  it('a symlink at the staged path is judged by the file it points at, the one that is hashed and loaded', () => {
    const exe = image({ seal: false });
    const away = emptyDir('away');
    const target = join(away, LIB);
    copyFileSync(libOf(exe), target);
    chmodSync(target, 0o666);
    rmSync(libOf(exe));
    symlinkSync(target, libOf(exe));
    for (const d of dirsOf(exe).slice(0, 3)) chmodSync(d, 0o555);
    // The manifest's hash is right (same bytes): only the writable target is wrong.
    refused(
      load(exe),
      new RegExp(`: ${reEscape(libOf(exe))} is writable by its group or by everyone`),
    );
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

  it.skipIf(process.getuid?.() === 0)(
    'with no faked owner, a tree owned by the user running the tests is refused: the module reads the real owner',
    () => {
      const exe = image();
      const r = inBun((m, c) => [c(() => m.greet('World')), c(() => m.add(1, 2))], {
        FAKE_EXEC: exe,
        FAKE_OWNER: undefined,
      });
      refused(r, new RegExp(`is owned by uid ${process.getuid?.()}, but only root may own it`));
    },
  );
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
