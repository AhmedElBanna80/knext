/**
 * `knext ffi generate` / `knext ffi check` (ADR-0069 D12, D13): build the host
 * library, scan it, write `<out>/index.ts` + `.knext-generated.json`, or with
 * `check` compare and exit 1 on drift. The cargo build is injected here (a
 * synthetic library file); cargo.test.ts covers the real invocation.
 */

import { afterAll, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { serializeConfig } from '../config';
import { MANIFEST, runGenerate } from '../generate';
import { scanManifest } from '../manifest';
import { renderModule } from '../render';
import {
  blob,
  capture,
  D,
  emptyDir,
  fn,
  KITCHEN_SINK,
  PKG_DIR,
  readTree,
  removeScratchDirs,
} from './helpers';

afterAll(removeScratchDirs);

/** An app with knext.ffi.json, a rust/ crate dir, and a fake built library. */
function app(records: Record<string, unknown>[] = KITCHEN_SINK, libFile = 'libzone.so') {
  const cwd = emptyDir('gen');
  writeFileSync(
    join(cwd, 'knext.ffi.json'),
    serializeConfig({ version: 1, crate: 'rust', out: 'src/generated/ffi' }),
  );
  mkdirSync(join(cwd, 'rust', 'target', 'release'), { recursive: true });
  writeFileSync(join(cwd, 'rust', 'Cargo.toml'), '[package]\nname = "zone"\n');
  const lib = join(cwd, 'rust', 'target', 'release', libFile);
  const setLib = (r: Record<string, unknown>[]) => writeFileSync(lib, blob(r));
  setLib(records);
  const calls: string[] = [];
  const deps = {
    buildLibrary: (crateDir: string) => {
      calls.push(crateDir);
      return lib;
    },
  };
  const gen = async (check = false, build?: string) => {
    const c = capture();
    const code = await runGenerate({
      cwd,
      check,
      io: c.io,
      deps,
      ...(build === undefined ? {} : { build }),
    });
    return { code, out: c.out(), err: c.err() };
  };
  return { cwd, lib, setLib, gen, calls, outDir: join(cwd, 'src', 'generated', 'ffi') };
}

describe('knext ffi generate', () => {
  it('builds the crate, scans the library and writes index.ts + .knext-generated.json', async () => {
    const a = app();
    const r = await a.gen();
    expect(r.code, r.err).toBe(0);
    expect(a.calls).toEqual([join(a.cwd, 'rust')]);
    expect(r.out).toContain('wrote src/generated/ffi (2 files changed)');
    const tree = readTree(a.outDir);
    expect([...tree.keys()]).toEqual(['.knext-generated.json', 'index.ts']);
    expect(tree.get('index.ts')).toBe(
      renderModule(scanManifest(blob(KITCHEN_SINK)), { libName: 'zone', crate: 'rust' }),
    );
    expect(JSON.parse(tree.get(MANIFEST) as string)).toEqual({
      generatedBy: 'knext ffi generate',
      files: ['index.ts'],
    });
  });

  it('a second run changes nothing', async () => {
    const a = app();
    await a.gen();
    const r = await a.gen();
    expect(r.code).toBe(0);
    expect(r.out).toContain('already up to date');
  });

  it('the library name comes from the built file (lib<name>.so / .dylib)', async () => {
    const a = app(KITCHEN_SINK, 'libmy_zone.dylib');
    expect((await a.gen()).code).toBe(0);
    expect(readFileSync(join(a.outDir, 'index.ts'), 'utf8')).toContain("const $LIB = 'my_zone';");
  });

  it('leaves files it does not own alone, and removes only files a previous run recorded', async () => {
    const a = app();
    await a.gen();
    writeFileSync(join(a.outDir, 'notes.md'), 'mine');
    writeFileSync(join(a.outDir, 'old.ts'), '// stale');
    writeFileSync(
      join(a.outDir, MANIFEST),
      JSON.stringify({
        generatedBy: 'knext ffi generate',
        files: ['index.ts', 'old.ts', '../escape.ts'],
      }),
    );
    writeFileSync(join(a.cwd, 'escape.ts'), 'outside');
    const r = await a.gen();
    expect(r.code, r.err).toBe(0);
    expect(existsSync(join(a.outDir, 'old.ts'))).toBe(false);
    expect(readFileSync(join(a.outDir, 'notes.md'), 'utf8')).toBe('mine');
    expect(readFileSync(join(a.cwd, 'escape.ts'), 'utf8')).toBe('outside');
  });

  it('refuses to write through an output directory that is a symlink out of the app', async () => {
    const a = app();
    const outside = emptyDir('outside');
    mkdirSync(join(a.cwd, 'src', 'generated'), { recursive: true });
    symlinkSync(outside, a.outDir);
    const r = await a.gen();
    expect(r.code).toBe(1);
    expect(r.err).toContain('outside the app');
    expect(existsSync(join(outside, 'index.ts'))).toBe(false);
  });

  it('without knext.ffi.json: exit 1, says to run knext ffi init', async () => {
    const c = capture();
    const code = await runGenerate({
      cwd: emptyDir('nocfg'),
      io: c.io,
      deps: { buildLibrary: () => '' },
    });
    expect(code).toBe(1);
    expect(c.err()).toContain('Run `knext ffi init` first.');
  });

  it('without the crate directory: exit 1, names it', async () => {
    const cwd = emptyDir('nocrate');
    writeFileSync(join(cwd, 'knext.ffi.json'), '{"version":1}');
    const c = capture();
    const code = await runGenerate({ cwd, io: c.io, deps: { buildLibrary: () => '' } });
    expect(code).toBe(1);
    expect(c.err()).toContain('no Rust crate at rust/Cargo.toml');
  });

  it('a library without a manifest: exit 1 with the scanner message', async () => {
    const a = app([]);
    const r = await a.gen();
    expect(r.code).toBe(1);
    expect(r.err).toContain('no exported functions found; is this the right library?');
  });

  it('a built file that is not lib<name>.so/.dylib: exit 1', async () => {
    const a = app(KITCHEN_SINK, 'zone.dll');
    const r = await a.gen();
    expect(r.code).toBe(1);
    expect(r.err).toContain('is not a lib<name>.so or lib<name>.dylib');
  });
});

describe('knext ffi check', () => {
  it('exits 0 when the committed module matches the library', async () => {
    const a = app();
    await a.gen();
    const r = await a.gen(true);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain('generated code in src/generated/ffi is up to date (2 files)');
  });

  it('exits 1 on a stale committed wrapper (the Rust signature changed), and writes nothing', async () => {
    const a = app();
    await a.gen();
    const before = readFileSync(join(a.outDir, 'index.ts'), 'utf8');
    a.setLib([...KITCHEN_SINK, fn('extra', [['n', D.t('u32')]], D.t('u32'))]);
    const r = await a.gen(true);
    expect(r.code).toBe(1);
    expect(r.err).toContain('generated code in src/generated/ffi is out of date:');
    expect(r.err).toMatch(/changed\s+index\.ts/);
    expect(r.err).toContain('Run `knext ffi generate` and commit the result.');
    expect(readFileSync(join(a.outDir, 'index.ts'), 'utf8')).toBe(before);
  });

  it('exits 1 on a hand-edited module', async () => {
    const a = app();
    await a.gen();
    writeFileSync(join(a.outDir, 'index.ts'), '// edited\n');
    expect((await a.gen(true)).code).toBe(1);
  });

  it('exits 1 when nothing was generated yet, naming the missing files', async () => {
    const a = app();
    const r = await a.gen(true);
    expect(r.code).toBe(1);
    expect(r.err).toMatch(/missing\s+index\.ts/);
    expect(r.err).toMatch(/missing\s+\.knext-generated\.json/);
    expect(existsSync(a.outDir)).toBe(false);
  });
});

describe('knext ffi generate and check say what a vinext app still has to add to its own Dockerfile', () => {
  // An app that already has knext.ffi.json never runs `knext ffi init` again, so the line that closes
  // /app and /app/native (ADR-0069 Amendment 1) has to reach it from the commands it does run.
  const VINEXT_DOCKERFILE = join(PKG_DIR, '..', 'kn-next', 'templates', 'app', 'Dockerfile.hbs');
  const LINE = 'RUN chmod go-w /app /app/native';
  const withDockerfile = (text: string) => {
    const a = app();
    writeFileSync(join(a.cwd, 'Dockerfile'), text);
    return a;
  };
  const scaffolded = () => readFileSync(VINEXT_DOCKERFILE, 'utf8');
  const closed = () =>
    scaffolded().replace(/^COPY --chown=0:0 --chmod=a-w native \/app\/native$/m, `$&\n${LINE}`);

  it('generate prints it after what it wrote, and again on a run that changed nothing', async () => {
    const a = withDockerfile(scaffolded());
    const first = await a.gen();
    expect(first.code, first.err).toBe(0);
    expect(first.out).toContain('wrote src/generated/ffi (2 files changed)');
    expect(first.out).toContain(LINE);
    expect(first.out.indexOf(LINE)).toBeGreaterThan(first.out.indexOf('wrote src/generated/ffi'));
    const second = await a.gen();
    expect(second.out).toContain('already up to date');
    expect(second.out).toContain(LINE);
  });

  it('check prints it when the module is up to date', async () => {
    const a = withDockerfile(scaffolded());
    await a.gen();
    const r = await a.gen(true);
    expect(r.code, r.err).toBe(0);
    expect(r.out).toContain('generated code in src/generated/ffi is up to date (2 files)');
    expect(r.out).toContain(LINE);
  });

  it('check on a stale module prints its failure and nothing about the Dockerfile', async () => {
    const a = withDockerfile(scaffolded());
    const r = await a.gen(true);
    expect(r.code).toBe(1);
    expect(r.out).toBe('');
    expect(r.err).not.toContain(LINE);
  });

  it('say nothing for an app whose build is not vinext (a standalone build stages its own Dockerfile), and say it for a vinext one', async () => {
    for (const build of ['turbopack', 'webpack']) {
      const a = withDockerfile(scaffolded());
      for (const check of [false, true]) {
        const r = await a.gen(check, build);
        expect(r.out, `${build} check=${check}`).not.toContain('chmod go-w');
      }
    }
    const a = withDockerfile(scaffolded());
    expect((await a.gen(false, 'vinext')).out).toContain(LINE);
    expect((await a.gen(true, 'vinext')).out).toContain(LINE);
  });

  it('say nothing when the Dockerfile already closes both directories, when there is none, or when it is not a vinext one', async () => {
    for (const dockerfile of [closed(), undefined, 'FROM scratch\nCOPY server /app/server\n']) {
      const a = dockerfile === undefined ? app() : withDockerfile(dockerfile);
      for (const check of [false, true]) {
        const r = await a.gen(check);
        if (check) expect(r.code, r.err).toBe(0);
        expect(r.out).not.toContain('chmod go-w');
      }
    }
  });
});
