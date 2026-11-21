// The @getknext/ffi generator against REAL Rust libraries built from these
// crates: the half of the generator's tests that needs cargo, so it runs in the
// Rust crates lane, not in the bun suite (whose checkout has no pinned Rust
// toolchain). The bun suite proves the same generated code against a C
// stand-in (packages/ffi/fixtures/abi-v1/fixture.c); this proves it against
// what the macros actually emit.
//
//   bun crates/harness/ffi-generated.ts wrapper <path-to-fixture-lib>
//   bun crates/harness/ffi-generated.ts init
//
// Modes (exit 0 = pass, 1 = a check failed, 10 = the harness could not run):
//   wrapper  scan the release-profile fixture library with the generator's own
//            scanner (every #[export] and #[record] in the fixture source is
//            there), render the module, stage the library the way an image does
//            (native/ffi/<triple>/ + a sha256 integrity manifest, owned by root
//            under a root-owned path whose every ancestor is root's and closed,
//            NODE_ENV=production: the loader judges the real owners and modes,
//            so this mode needs root or passwordless sudo), with four controls
//            that show the loader's walk is live:
//              1. the same tree made as the running user, under the sticky /tmp,
//                 is refused, /tmp itself is listed with its mode (1777), and
//                 the temp directory this run made is listed as owned by the
//                 running user (when that is not root), so a walk that judged
//                 modes alone would still go red;
//              2. the root-owned tree reached through a link is refused for the
//                 link;
//              3. the root-owned tree with the directory above the one native/
//                 sits in made group-writable by root is refused, and that one
//                 directory is the only one listed (mode 0775);
//              4. the same tree with the root directory alone answering 0775 is
//                 refused, with / the only one listed.
//            Then call through the generated module: scalars, strings, bytes,
//            records with 64-bit fields, enums, Option/Vec, Err, a panic, and
//            the non-finite float rule in every JSON position (refused by the
//            wrapper on the way out, by Rust on the way back).
//            With KNEXT_FFI_HARNESS_MUTATE=W01|W02|W03|W04|W05 the rendered loader
//            is weakened in memory (the walk above the executable's directory, its
//            last step to /, the real-path assertion, the sticky exemption, the
//            owner check), only the four controls run, and the run must fail;
//            ffi-generated-red.ts requires exactly that and the controls each
//            weakening turns red.
//   init     `knext ffi init` with the knext-ffi revision this @getknext/ffi
//            records, the written Cargo.toml checked for the exact git+rev
//            line, then `knext ffi generate` builds that crate AS WRITTEN (cargo
//            fetches knext-ffi from GitHub at that revision), `knext ffi check`
//            passes, sees a drifted wrapper, and the generated module calls the
//            development build.

import { type ChildProcess, spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { integerMatrix } from '../../packages/ffi/src/__tests__/integer-matrix';
import { runGenerate } from '../../packages/ffi/src/generate';
import { CRATE_GIT, recordedCrateRev, runInit } from '../../packages/ffi/src/init';
import { scanManifest } from '../../packages/ffi/src/manifest';
import { libNameOf, renderModule } from '../../packages/ffi/src/render';
import { weaken } from './loader-weakenings';
import { assertRevOnBase, localCrateSourceEnv } from './local-crates-source';

const HARNESS_ERROR = 10;
const FIXTURE_SRC = resolve(import.meta.dir, '..', 'knext-ffi-fixture', 'src', 'lib.rs');
const scratch: string[] = [];
let failures = 0;

function die(msg: string): never {
  console.error(`ffi-generated: cannot run: ${msg}`);
  cleanup();
  process.exit(HARNESS_ERROR);
}
function check(cond: unknown, msg: string): void {
  if (cond) return;
  failures++;
  console.error(`ffi-generated: FAIL: ${msg}`);
}
function same(actual: unknown, expected: unknown, what: string): void {
  check(
    isDeepStrictEqual(actual, expected),
    `${what}\n  expected ${JSON.stringify(expected)}\n  actual   ${JSON.stringify(actual)}`,
  );
}
function tempDir(prefix: string): string {
  // The temp directory by its real path: the loader refuses a path that is not its own real path
  // (a link at or above the executable's directory), and a temp directory that is a link (macOS's
  // /var) would be refused for that, not for what a control here is about.
  const d = mkdtempSync(join(realpathSync(tmpdir()), `knext-ffi-gen-${prefix}-`));
  scratch.push(d);
  return d;
}
/** Give the owner write access to a tree again: a staged native/ is read-only, like the image's. */
function makeWritable(path: string): void {
  const st = lstatSync(path, { throwIfNoEntry: false });
  if (!st || st.isSymbolicLink()) return;
  if (st.isDirectory()) {
    chmodSync(path, st.mode | 0o700);
    for (const name of readdirSync(path)) makeWritable(join(path, name));
  } else {
    chmodSync(path, st.mode | 0o600);
  }
}
function cleanup(): void {
  // Best effort, and never through die(): a failure here must not recurse into cleanup().
  // The trees root staged go first: they live outside the temp directory, so a failure removing
  // this user's scratch must not leave one behind under the staging parent. Each removal is
  // tried on its own.
  for (const d of rootScratch) {
    try {
      if (basename(d).startsWith(ROOT_STAGE_PREFIX) && ROOT_STAGE_PARENTS.includes(dirname(d))) {
        const r = runAsRoot(['rm', '-r', '-f', d]);
        if (!r.ok) console.error(`ffi-generated: could not remove ${d}: ${r.detail}`);
      }
    } catch (e) {
      console.error(`ffi-generated: could not remove ${d}: ${e instanceof Error ? e.message : e}`);
    }
  }
  for (const d of scratch) {
    try {
      makeWritable(d);
      rmSync(d, { recursive: true, force: true });
    } catch (e) {
      console.error(`ffi-generated: could not remove ${d}: ${e instanceof Error ? e.message : e}`);
    }
  }
}

// ---- a root-owned staging tree -------------------------------------------------------
//
// The loader loads only from a tree that root owns, and it checks every directory from the
// library up to / (owned by root, not writable by group or other): a user who can write one of
// them can rename the tree out of it. A tree this lane makes as itself, under the temp
// directory (a sticky, world-writable /tmp), is refused, as it should be. So the image's
// native/ is staged the way the image has it, owned by root, under a root-owned path, and the
// loader's checks run for real. That needs root: a CI runner has passwordless sudo.
//
// Which parent is a fact about the host, not a constant: /opt is 0777 on GitHub's ubuntu-latest
// runner (and 0755 in most images), and the loader is right to refuse a tree under it. So the
// parent is chosen by walking its ancestry first, and nothing on the host is ever chmod-ed to
// make it pass.

/** Where the staged image may go, in order: a directory under each must be root's all the way up. */
const ROOT_STAGE_PARENTS = ['/var/lib', '/'];
const ROOT_STAGE_PREFIX = 'knext-ffi-gen-';
const rootScratch: string[] = [];

/**
 * Why a directory is not a place the loader would accept a tree under: itself and every directory
 * above it must be a real directory, owned by root and not writable by group or other (the loader's
 * rule, applied here BEFORE staging so a host that fails it is reported as that, not as a loader
 * refusal with the walk looking broken). [] when it is fit.
 */
function ancestryProblems(dir: string): string[] {
  const problems: string[] = [];
  let real = dir;
  try {
    real = realpathSync(dir);
  } catch (e) {
    problems.push(`${dir} cannot be resolved: ${e instanceof Error ? e.message : e}`);
  }
  if (real !== dir) problems.push(`${dir} is not its own real path (it resolves to ${real})`);
  for (let d = dir; ; d = dirname(d)) {
    const st = lstatSync(d, { throwIfNoEntry: false });
    if (st === undefined) problems.push(`${d} does not exist`);
    else if (!st.isDirectory()) problems.push(`${d} is not a directory`);
    else if (st.uid !== 0) problems.push(`${d} is owned by uid ${st.uid}, not root`);
    else if ((st.mode & 0o022) !== 0) {
      problems.push(
        `${d} is writable by its group or by everyone (mode ${(st.mode & 0o7777).toString(8).padStart(4, '0')})`,
      );
    }
    if (dirname(d) === d) return problems;
  }
}

let rootStageParent: string | undefined;
/** The first of {@link ROOT_STAGE_PARENTS} whose whole ancestry is root's and closed; else a clear stop. */
function stageParent(): string {
  if (rootStageParent !== undefined) return rootStageParent;
  const tried: string[] = [];
  for (const parent of ROOT_STAGE_PARENTS) {
    const problems = ancestryProblems(parent);
    if (problems.length === 0) {
      rootStageParent = parent;
      return parent;
    }
    tried.push(`${parent}:\n    ${problems.join('\n    ')}`);
  }
  die(
    `no directory on this host can hold the staged image: the loader accepts a tree only under directories that root owns and group and other cannot write, all the way up to /, and none of ${ROOT_STAGE_PARENTS.join(', ')} is one:\n  ${tried.join('\n  ')}\n  (this lane does not change the mode of a system directory to make one fit)`,
  );
}

/** Run argv as root: directly when this process is root, else through non-interactive sudo. */
function runAsRoot(argv: string[]): { ok: boolean; detail: string } {
  const full = process.getuid?.() === 0 ? argv : ['sudo', '-n', ...argv];
  const r = spawnSync(full[0] as string, full.slice(1), { encoding: 'utf8' });
  return {
    ok: r.status === 0,
    detail: `${full.join(' ')} (exit ${r.status}): ${r.stderr}${r.stdout}`,
  };
}
function asRoot(argv: string[]): void {
  const r = runAsRoot(argv);
  if (!r.ok) {
    die(
      `${r.detail}\n  this lane stages the image's native/ as root, because the loader accepts only a root-owned tree: it needs root or passwordless sudo`,
    );
  }
}

/** A fresh root-owned, 0755 directory under {@link stageParent}; removed by cleanup(). */
function rootStageDir(): string {
  const dir = join(stageParent(), `${ROOT_STAGE_PREFIX}${randomBytes(6).toString('hex')}`);
  rootScratch.push(dir); // before it is made, so a half-made one is still removed
  asRoot(['install', '-d', '-o', 'root', '-g', 'root', '-m', '0755', dir]);
  return dir;
}

/**
 * Copy `native` (made here, as this user) to `<stage>/image/native` as the image carries it:
 * every file and directory root's, read-only, and the two directories above it (`image`, the
 * one native/ sits in, and the stage root) root's and closed to group and other. Returns the
 * `image` directory.
 */
function stageAsRoot(native: string): string {
  const stage = rootStageDir();
  const image = join(stage, 'image');
  asRoot(['install', '-d', '-o', 'root', '-m', '0755', image]);
  asRoot(['cp', '-R', native, join(image, 'native')]);
  asRoot(['chown', '-R', 'root', image]);
  asRoot(['chmod', '-R', 'a-w', image]);
  return image;
}

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

/** An app directory with Next's `server-only` (resolvable under react-server only). */
function app(dir: string): void {
  writeFileSync(join(dir, 'package.json'), '{"type":"module","private":true}\n');
  const so = join(dir, 'node_modules', 'server-only');
  mkdirSync(so, { recursive: true });
  writeFileSync(
    join(so, 'package.json'),
    JSON.stringify({
      name: 'server-only',
      exports: { '.': { 'react-server': './empty.js', default: './index.js' } },
    }),
  );
  writeFileSync(join(so, 'empty.js'), '');
  writeFileSync(join(so, 'index.js'), 'throw new Error("server-only");\n');
}

const CHILD = `// Runs BODY(m, c) against the generated module; prints RESULT <json>.
// Nothing is faked: the loader judges the real owners and modes of the tree it loads from, and
// FAKE_EXEC only says where the executable (so native/) is. The one probe: FAKE_ROOT_MODE makes
// an lstat of / (and nothing else) answer that mode, because the harness cannot make / writable
// on a real machine; it shows the loader's walk reaches the root directory and judges it.
const fake = process.env.FAKE_EXEC;
if (fake) process.execPath = fake;
if (process.env.FAKE_ROOT_MODE) {
  const fs = process.getBuiltinModule('node:fs');
  const real = fs.lstatSync;
  fs.lstatSync = function (...a) {
    const st = real.apply(this, a);
    if (st === undefined || String(a[0]) !== '/') return st;
    const mode = (Number(st.mode) & ~0o7777) | Number(process.env.FAKE_ROOT_MODE);
    return Object.assign(Object.create(Object.getPrototypeOf(st)), st, {
      mode: typeof st.mode === 'bigint' ? BigInt(mode) : mode,
    });
  };
  process.getBuiltinModule('node:module').syncBuiltinESMExports();
}
const m = await import('./src/generated/ffi/index.ts');
const c = (f) => {
  try {
    return { ok: f() };
  } catch (e) {
    const cls = e instanceof m.FfiLoadError ? 'FfiLoadError'
      : e instanceof m.RustPanicError ? 'RustPanicError'
      : e instanceof m.RustError ? 'RustError'
      : e instanceof TypeError ? 'TypeError' : 'other';
    return { cls, message: e.message };
  }
};
const result = await (0, eval)('(' + process.env.BODY + ')')(m, c);
const replacer = (_k, v) => (typeof v === 'bigint' ? v.toString() + 'n' : v instanceof Uint8Array ? { bytes: Array.from(v) } : v === undefined ? '<undefined>' : v);
console.log('RESULT ' + JSON.stringify(result, replacer));
`;

/** The Bun children running now, so an interrupt can stop them before it cleans up. */
const children = new Set<ChildProcess>();

/**
 * Run `body` in a fresh Bun process (the module caches its first load) under react-server.
 * Asynchronous on purpose: a synchronous spawn blocks the event loop, so SIGINT and SIGTERM would
 * wait for the child (up to two minutes) before the handler below could clean up.
 */
function inBun(
  dir: string,
  // biome-ignore lint/suspicious/noExplicitAny: the body runs in another process, untyped.
  body: (m: any, c: (f: () => unknown) => unknown) => unknown,
  env: Record<string, string>,
): Promise<unknown> {
  writeFileSync(join(dir, 'child.ts'), CHILD);
  return new Promise((settle) => {
    const child = spawn(process.execPath, ['--conditions=react-server', 'child.ts'], {
      cwd: dir,
      env: { ...process.env, NEXT_PHASE: '', BODY: body.toString(), ...env },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    children.add(child);
    let stdout = '';
    let stderr = '';
    child.stdout?.setEncoding('utf8').on('data', (d: string) => {
      stdout += d;
    });
    child.stderr?.setEncoding('utf8').on('data', (d: string) => {
      stderr += d;
    });
    const timer = setTimeout(() => child.kill('SIGKILL'), 120_000);
    const done = (status: number | null, why: string) => {
      clearTimeout(timer);
      children.delete(child);
      const line = stdout.split('\n').find((l) => l.startsWith('RESULT '));
      if (status !== 0 || line === undefined) {
        check(false, `the child process failed (${why}):\n${stdout}\n${stderr}`);
        settle(undefined);
        return;
      }
      settle(JSON.parse(line.slice(7)));
    };
    child.on('error', (e) => done(null, `could not start: ${e.message}`));
    child.on('close', (status, signal) =>
      done(status, `exit ${status}${signal ? `, ${signal}` : ''}`),
    );
  });
}

// ---- the weakened loaders the red check applies -----------------------------------

/**
 * KNEXT_FFI_HARNESS_MUTATE=<id>: weaken the rendered loader in memory (loader-weakenings.ts), so the
 * controls below can be shown to go red when the loader's walk is weakened
 * (ffi-generated-red.ts). The anchor must occur exactly once in the rendered text, or the run stops:
 * an edit that silently changed nothing would prove nothing.
 */
const mutating = process.env.KNEXT_FFI_HARNESS_MUTATE;

function renderLoader(manifest: ReturnType<typeof scanManifest>, libName: string): string {
  const text = renderModule(manifest, { libName, crate: 'rust' });
  if (mutating === undefined) return text;
  try {
    return weaken(text, mutating);
  } catch (e) {
    return die(e instanceof Error ? e.message : String(e));
  }
}

// ---- wrapper: the fixture library ---------------------------------------------------

async function wrapper(libPath: string): Promise<void> {
  if (!existsSync(libPath)) die(`${libPath} does not exist (build the fixture first)`);
  const libName = libNameOf(basename(libPath));
  if (libName === undefined) die(`${basename(libPath)} is not lib<name>.so/.dylib`);

  // The scanner reads every record the macros embedded, from the bytes alone.
  const manifest = scanManifest(readFileSync(libPath));
  const src = readFileSync(FIXTURE_SRC, 'utf8');
  const exports = [...src.matchAll(/#\[export\]\s*(?:\/\/\/[^\n]*\n\s*)*pub fn (\w+)/g)].map(
    (x) => x[1] as string,
  );
  check(exports.length > 30, `only ${exports.length} #[export]s found in ${FIXTURE_SRC}`);
  same(
    manifest.fns.map((f) => f.name),
    [...exports].sort(),
    'the scanned functions are exactly the fixture source #[export]s',
  );
  same(
    manifest.records.map((r) => r.name),
    ['Child', 'Point', 'Reading'],
    'records',
  );
  same(
    manifest.enums.map((e) => e.name),
    ['Color'],
    'enums',
  );

  // Stage it the way an image does: production, integrity-checked.
  const dir = tempDir('wrapper');
  app(dir);
  mkdirSync(join(dir, 'src', 'generated', 'ffi'), { recursive: true });
  writeFileSync(join(dir, 'src', 'generated', 'ffi', 'index.ts'), renderLoader(manifest, libName));
  const image = join(dir, 'image');
  const triple = hostTriple();
  const rel = `ffi/${triple}/${basename(libPath)}`;
  mkdirSync(join(image, 'native', 'ffi', triple), { recursive: true });
  copyFileSync(libPath, join(image, 'native', rel));
  writeFileSync(
    join(image, 'native', '.integrity.json'),
    JSON.stringify({
      version: 1,
      algorithm: 'sha256',
      packages: {},
      files: {
        [rel]: createHash('sha256')
          .update(readFileSync(join(image, 'native', rel)))
          .digest('hex'),
      },
    }),
  );
  // As the image carries it: read-only.
  for (const part of [
    join(image, 'native', rel),
    join(image, 'native', 'ffi', triple),
    join(image, 'native', 'ffi'),
    join(image, 'native'),
    image, // the directory native/ sits in
  ]) {
    chmodSync(part, statSync(part).mode & ~0o222);
  }

  // Control 1. The tree above is this user's, under the temp directory (a sticky, world-writable
  // /tmp on every Linux runner): the loader must refuse it, and the refusal must name the temp
  // directory itself with its mode. Which directories fail below it depends on who runs this (as
  // a user they are all this user's; as root none is), but the temp directory is group- and
  // world-writable either way, and only a walk that goes ABOVE the executable's directory, all
  // the way up and with the sticky bit no excuse, can name it. Accepting any directory refusal
  // here would stay green with that walk removed.
  const tmp = realpathSync(tmpdir());
  const tmpBits = statSync(tmp).mode & 0o7777;
  if ((tmpBits & 0o022) === 0) {
    die(
      `${tmp} is not writable by group or other (mode ${tmpBits.toString(8).padStart(4, '0')}), so this lane cannot show that the loader refuses a shared directory above the executable's: run it with a temp directory like /tmp (set TMPDIR)`,
    );
  }
  const tmpLine = `\n  ${tmp} is writable by its group or by everyone (mode ${tmpBits.toString(8).padStart(4, '0')})`;
  // As a user that is not root, the temp directory this run made is also this user's, which a walk
  // that judged modes alone (it is 0700) would not list. As root it is root's, and is not listed.
  const uid = process.getuid?.();
  const ownLine = `\n  ${dir} is owned by uid ${uid}, but only root may own it`;
  const refused = (await inBun(dir, (m, c) => c(() => m.echo_opt_f64(0.25)), {
    FAKE_EXEC: join(image, 'server'),
    NODE_ENV: 'production',
  })) as { cls?: string; message?: string } | undefined;
  if (refused !== undefined) {
    same(
      refused.cls,
      'FfiLoadError',
      'control 1: a native/ this user owns, under the temp directory, is refused',
    );
    check(
      (refused.message ?? '').includes(tmpLine),
      `control 1: the refusal names the temp directory ${tmp} with its mode (the sticky bit is no excuse), so the walk reaches above the executable's directory: ${refused.message}`,
    );
    if (uid !== undefined && uid !== 0) {
      check(
        (refused.message ?? '').includes(ownLine),
        `control 1: the refusal names ${dir} as owned by uid ${uid}, so the walk judges the owner as well as the mode: ${refused.message}`,
      );
    }
    check(
      (refused.message ?? '').includes(
        'move the install under a root-owned, closed directory such as /opt/<app> instead',
      ),
      `control 1: the refusal tells the reader to move the install, since the temp directory is shared: ${refused.message}`,
    );
  }

  // The image as the image has it: root's, closed, under a root-owned path. The loader judges the
  // real owners and modes of this tree; nothing in the child is faked.
  const rootImage = stageAsRoot(join(image, 'native'));

  // Control 2. The same good tree, reached through a link root made at its parent: the loader never follows a
  // link at or above the executable's directory, whatever it points at, even a tree it would load
  // by its real path (the load below).
  const link = join(dirname(rootImage), 'image-link');
  asRoot(['ln', '-s', rootImage, link]);
  const viaLink = (await inBun(dir, (m, c) => c(() => m.echo_opt_f64(0.25)), {
    FAKE_EXEC: join(link, 'server'),
    NODE_ENV: 'production',
  })) as { cls?: string; message?: string } | undefined;
  if (viaLink !== undefined) {
    same(viaLink.cls, 'FfiLoadError', 'control 2: a good tree reached through a link is refused');
    check(
      /is not the real path of its directory/.test(viaLink.message ?? ''),
      `control 2: the refusal says the link is the problem: ${viaLink.message}`,
    );
  }

  // Control 3. The good tree, with the directory above the one native/ sits in made
  // group-writable by root: refused, and that one directory is the only one listed, with its mode.
  // The loader's walk is what finds it (it is above the executable's directory), and it must find
  // nothing else in an image whose every other directory is root's and closed. Restored at once.
  const stage = dirname(rootImage);
  asRoot(['chmod', 'g+w', stage]);
  const open = (await inBun(dir, (m, c) => c(() => m.echo_opt_f64(0.25)), {
    FAKE_EXEC: join(rootImage, 'server'),
    NODE_ENV: 'production',
  })) as { cls?: string; message?: string } | undefined;
  asRoot(['chmod', 'g-w', stage]);
  if (open !== undefined) {
    same(
      open.cls,
      'FfiLoadError',
      'control 3: a group-writable directory above native/ is refused',
    );
    const message = open.message ?? '';
    same(
      message.split('\n').filter((l) => l.startsWith('  ')),
      [`  ${stage} is writable by its group or by everyone (mode 0775)`],
      'control 3: exactly one directory is listed: the group-writable one above the executable, with its mode',
    );
    check(
      message.includes('1 directory on the way to it cannot be trusted'),
      `control 3: the refusal counts one directory: ${message}`,
    );
    // Not sticky and not world-writable, so it may be the app's own (a prefix directory of the
    // image) or shared: it is told both, each with its condition, never the move alone.
    check(
      message.includes("if it is part of your app's install, run `chmod go-w <dir>`") &&
        message.includes(
          'If it is shared with other software, or is a home directory such as /home/<user>, do not change its owner or mode (never give a home directory to root): move the install instead.',
        ) &&
        message.includes('The executable needs a directory of its own') &&
        !message.includes('A sticky directory (a shared one such as /tmp)'),
      `control 3: the advice for a group-writable directory above the executable is both pieces, each with its condition: ${message}`,
    );
  }

  // Control 4. The same tree with the root directory alone answering 0775: refused, with / the
  // only directory listed. Every real directory above native/ is root's and closed, so only a walk
  // that goes all the way up and judges the root directory itself can name it.
  const atRoot = (await inBun(dir, (m, c) => c(() => m.echo_opt_f64(0.25)), {
    FAKE_EXEC: join(rootImage, 'server'),
    FAKE_ROOT_MODE: String(0o775),
    NODE_ENV: 'production',
  })) as { cls?: string; message?: string } | undefined;
  if (atRoot !== undefined) {
    same(atRoot.cls, 'FfiLoadError', 'control 4: a group-writable root directory is refused');
    same(
      (atRoot.message ?? '').split('\n').filter((l) => l.startsWith('  ')),
      ['  / is writable by its group or by everyone (mode 0775)'],
      'control 4: exactly one directory is listed: the root directory, with its mode',
    );
  }

  // A weakened loader (KNEXT_FFI_HARNESS_MUTATE) is judged by the four controls alone.
  if (mutating !== undefined) return;

  const result = (await inBun(
    dir,
    (m, c) => {
      const two = (n: number) => BigInt(2) ** BigInt(n);
      const point = {
        id: two(64) - BigInt(1),
        delta: -two(62),
        size: two(53) + BigInt(1),
        offset: BigInt(-5),
        x: 1.25,
        y: 0.5,
        small: 255,
        label: 'héllo 🌍',
        tags: ['a', ''],
        maybe: null,
        color: 'Blue',
        raw: [0, 255],
        child: { name: 'kid', flag: true },
        ids: [two(60), BigInt(0)],
        count: two(63),
        deltas: [BigInt(-1), null],
      };
      return {
        greet: [m.greet('World'), m.greet_ref(''), m.concat('a', 'é'.repeat(3000)).length],
        add: m.add(2, 3),
        u64: m.echo_u64(two(64) - BigInt(1)),
        f64: m.echo_f64(Number.NaN),
        not: m.not(false),
        bytes: [m.echo_bytes(new Uint8Array([0, 255, 7])), m.sum_bytes(new Uint8Array(0))],
        noop: m.noop(),
        point: m.echo_point(point),
        mid: m.mid(point, { ...point, x: 3.25 }).x,
        color: m.next_color('Blue'),
        opt: [m.echo_opt_u64(two(64) - BigInt(1)), m.echo_opt_u64(null)],
        vec: [m.echo_vec_i64([-two(63), two(53) + BigInt(1)]), m.echo_vec_string(['', 'x'])],
        parse: [m.parse_i32(' 42 '), c(() => m.parse_i32('x'))],
        fallible: c(() => m.fallible_unit(true)),
        boom: c(() => m.boom('kaboom')),
        afterBoom: m.add(1, 1),
        // Floats inside JSON: finite ones cross, in every position.
        optF64: [m.echo_opt_f64(1.5), m.echo_opt_f64(null)],
        reading: m.echo_reading({ value: 2.5, samples: [0.5, null, -3] }),
        // Refused by the wrapper before the call: never sent as null.
        wrapNaN: c(() => m.echo_opt_f64(Number.NaN)),
        wrapInf: c(() => m.echo_reading({ value: null, samples: [1, Number.NEGATIVE_INFINITY] })),
        wrapField: c(() => m.echo_point({ ...point, x: Number.POSITIVE_INFINITY })),
        // Refused by Rust: a number that does not fit a finite f32, and a
        // non-finite float Rust returns inside an Option or a record.
        f32Overflow: c(() => m.echo_reading({ value: null, samples: [1e300] })),
        rustNaN: c(() => m.non_finite_opt(0)),
        rustInf: c(() => m.non_finite_opt(1)),
        rustReading: c(() => m.non_finite_reading()),
        afterRefusals: m.echo_opt_f64(0.25),
      };
    },
    { FAKE_EXEC: join(rootImage, 'server'), NODE_ENV: 'production' },
  )) as Record<string, unknown> | undefined;
  if (result === undefined) return;

  // Integer arguments (bun:ffi corrupts some: a double to an i32 arrives as 0,
  // and only the low 32 bits cross): every width, through the real library.
  const integers = (await inBun(dir, integerMatrix, {
    FAKE_EXEC: join(rootImage, 'server'),
    NODE_ENV: 'production',
  })) as { cases: number; problems: string[] } | undefined;
  if (integers !== undefined) {
    check(integers.cases > 150, `the integer matrix ran only ${integers.cases} case(s)`);
    same(integers.problems, [], 'every integer argument is validated before the native call');
  }

  const refusedJs = (fn: string, at: string, got: string) => ({
    cls: 'TypeError',
    message: `${fn}(): argument "${at}" must be a finite number (JSON has no NaN or Infinity), got ${got}`,
  });
  const refusedRust = (fn: string, path: string, t: string, shown: string) => ({
    cls: 'RustError',
    message: `invalid input: knext-ffi: the return value cannot cross as JSON: ${path}: ${t} ${shown} is not finite (JSON has no NaN or Infinity)`,
  });
  const f32Overflow = result.f32Overflow as { cls: string; message: string };
  delete result.f32Overflow;
  same(f32Overflow.cls, 'RustError', 'a number that does not fit an f32 is a RustError');
  check(
    f32Overflow.message.startsWith(
      'invalid input: knext-ffi: argument `r` could not be decoded: the number does not fit a finite f32',
    ),
    `f32 overflow message: ${f32Overflow.message}`,
  );
  same(
    result,
    {
      greet: ['Hello, World!', 'Hello, !', 3001],
      add: 5,
      u64: '18446744073709551615n',
      f64: null, // NaN, through JSON.stringify of the RESULT line: a raw f64 crosses intact
      not: true,
      bytes: [{ bytes: [0, 255, 7] }, '0n'],
      noop: '<undefined>',
      point: {
        id: '18446744073709551615n',
        delta: '-4611686018427387904n',
        size: '9007199254740993n',
        offset: '-5n',
        x: 1.25,
        y: 0.5,
        small: 255,
        label: 'héllo 🌍',
        tags: ['a', ''],
        maybe: null,
        color: 'Blue',
        raw: [0, 255],
        child: { name: 'kid', flag: true },
        ids: ['1152921504606846976n', '0n'],
        count: '9223372036854775808n',
        deltas: ['-1n', null],
      },
      mid: 2.25,
      color: 'Red',
      opt: ['18446744073709551615n', null],
      vec: [
        ['-9223372036854775808n', '9007199254740993n'],
        ['', 'x'],
      ],
      parse: [42, { cls: 'RustError', message: 'invalid digit found in string' }],
      fallible: { cls: 'RustError', message: 'failed on purpose' },
      boom: { cls: 'RustPanicError', message: 'kaboom' },
      afterBoom: 2,
      optF64: [1.5, null],
      reading: { value: 2.5, samples: [0.5, null, -3] },
      wrapNaN: refusedJs('echo_opt_f64', 'v', 'NaN'),
      wrapInf: refusedJs('echo_reading', 'r.samples[1]', '-Infinity'),
      wrapField: refusedJs('echo_point', 'p.x', 'Infinity'),
      rustNaN: refusedRust('non_finite_opt', 'result', 'f64', 'NaN'),
      rustInf: refusedRust('non_finite_opt', 'result', 'f64', 'Infinity'),
      rustReading: refusedRust('non_finite_reading', 'result.samples[2]', 'f32', 'NaN'),
      afterRefusals: 0.25,
    },
    'calls through the generated module against the real fixture library',
  );
}

// ---- init: the crate `knext ffi init` writes, built as written ----------------------

async function init(): Promise<void> {
  const rev = recordedCrateRev();
  if (rev === null || !/^[0-9a-f]{40}$/.test(rev)) {
    check(false, `@getknext/ffi records no full knext-ffi revision (got ${String(rev)})`);
    return;
  }
  const dir = tempDir('init');
  let err = '';
  const io = {
    stdout: (s: string) => {
      process.stdout.write(s);
    },
    stderr: (s: string) => {
      err += s;
      process.stderr.write(s);
    },
  };
  same(runInit({ cwd: dir, io }), 0, 'knext ffi init exits 0');
  const cargoToml = readFileSync(join(dir, 'rust', 'Cargo.toml'), 'utf8');
  check(
    cargoToml.includes(`knext-ffi = { git = "${CRATE_GIT}", rev = "${rev}" }`),
    `rust/Cargo.toml does not pin knext-ffi to ${rev}:\n${cargoToml}`,
  );
  app(dir);

  // CI only (KNEXT_FFI_LOCAL_REPO=<checkout root>): getknext-dev may be
  // unreachable, so git serves CRATE_GIT from this checkout. The user-facing
  // Cargo.toml asserted above is untouched; see local-crates-source.ts.
  const localRepo = process.env.KNEXT_FFI_LOCAL_REPO;
  if (localRepo) {
    // Fail closed: the recorded rev must already be on the PR's base, i.e. published.
    assertRevOnBase(localRepo, recordedCrateRev(), process.env.KNEXT_FFI_LOCAL_BASE_REF);
    Object.assign(process.env, localCrateSourceEnv(localRepo, CRATE_GIT));
  }

  // generate: cargo builds the crate exactly as written (no patch, no path
  // override), fetching knext-ffi at the recorded revision (from the local
  // clone when KNEXT_FFI_LOCAL_REPO is set).
  const generated = await runGenerate({ cwd: dir, io });
  same(generated, 0, 'knext ffi generate exits 0 (cargo built the crate as written)');
  if (generated !== 0) return; // nothing below can run without the library
  const index = join(dir, 'src', 'generated', 'ffi', 'index.ts');
  check(existsSync(index), 'knext ffi generate wrote src/generated/ffi/index.ts');
  same(await runGenerate({ cwd: dir, io, check: true }), 0, 'knext ffi check passes');
  appendFileSync(index, '// drift\n');
  err = '';
  same(await runGenerate({ cwd: dir, io, check: true }), 1, 'knext ffi check sees a drift');
  check(err.includes('out of date'), `knext ffi check names the drift: ${err}`);
  same(await runGenerate({ cwd: dir, io }), 0, 'knext ffi generate repairs it');

  const greeting = await inBun(dir, (m) => m.greet('World'), { NODE_ENV: 'development' });
  same(greeting, 'Hello, World!', 'the starter greet() through the generated module');
}

function finish(): never {
  cleanup();
  if (failures > 0) {
    console.error(`ffi-generated: ${failures} check(s) failed`);
    process.exit(1);
  }
  console.log('ffi-generated: ok');
  process.exit(0);
}

// An interrupted run stops its children and still removes what it staged as root (cleanup() never
// throws). The children are spawned asynchronously (inBun), so the event loop is free and these
// handlers run at once while one is working. They cannot run inside the short synchronous commands
// (the `sudo` that stages the tree, cargo in `init`): there the signal is handled when the call
// returns.
for (const [sig, code] of [
  ['SIGINT', 130],
  ['SIGTERM', 143],
] as const) {
  process.on(sig, () => {
    for (const child of children) child.kill('SIGKILL');
    cleanup();
    process.exit(code);
  });
}

const [mode, arg] = process.argv.slice(2);
try {
  if (mode === 'wrapper' && arg !== undefined) await wrapper(resolve(arg));
  else if (mode === 'init') await init();
  else die('usage: bun crates/harness/ffi-generated.ts wrapper <lib> | init');
} catch (e) {
  die(e instanceof Error ? (e.stack ?? e.message) : String(e));
}
finish();
