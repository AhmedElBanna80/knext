/**
 * `knext ffi init` (ADR-0069 D3, D11, D12): writes `knext.ffi.json` and the
 * `rust/` crate from the package's templates, pinning `knext-ffi` to the git
 * revision this @getknext/ffi records; refuses to overwrite anything.
 */

import { afterAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { CRATE_GIT, recordedCrateRev, runInit, TEMPLATE_DIR } from '../init';
import { capture, emptyDir, PKG_DIR, readTree, removeScratchDirs } from './helpers';

afterAll(removeScratchDirs);

const REV = 'a'.repeat(40);

function files(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(d, e.name));
      else out.push(relative(dir, join(d, e.name)));
    }
  };
  walk(dir);
  return out.sort();
}

describe('knext ffi init', () => {
  it('writes knext.ffi.json and the rust/ crate, the knext-ffi dependency pinned by full rev', () => {
    const cwd = emptyDir('init');
    const c = capture();
    expect(runInit({ cwd, io: c.io, crateRev: REV }), c.err()).toBe(0);
    expect(readFileSync(join(cwd, 'knext.ffi.json'), 'utf8')).toBe(
      '{\n  "version": 1,\n  "crate": "rust",\n  "out": "src/generated/ffi"\n}\n',
    );
    const cargo = readFileSync(join(cwd, 'rust', 'Cargo.toml'), 'utf8');
    expect(cargo).toContain(`knext-ffi = { git = "${CRATE_GIT}", rev = "${REV}" }`);
    expect(cargo).toContain('crate-type = ["cdylib"]');
    expect(cargo).not.toMatch(/panic\s*=\s*"abort"/);
    expect(cargo).not.toContain('{{');
    const lib = readFileSync(join(cwd, 'rust', 'src', 'lib.rs'), 'utf8');
    expect(lib).toContain('#[knext_ffi::export]');
    expect(lib).toContain('pub fn greet(');
    expect(readFileSync(join(cwd, 'rust', 'rust-toolchain.toml'), 'utf8')).toMatch(
      /channel = "\d+\.\d+\.\d+"/,
    );
    expect(c.out()).toContain('knext.ffi.json');
    expect(c.out()).toContain('knext ffi generate');
  });

  it('writes every template file (so a template added later ships with no code change)', () => {
    const cwd = emptyDir('init-all');
    expect(runInit({ cwd, io: capture().io, crateRev: REV })).toBe(0);
    const expected = files(TEMPLATE_DIR).map((f) => f.replace(/\.tmpl$/, ''));
    expect(files(cwd).filter((f) => f !== 'knext.ffi.json')).toEqual(expected);
    expect(expected).toContain(join('rust', 'Cargo.toml'));
  });

  for (const existing of ['knext.ffi.json', 'rust']) {
    it(`refuses to overwrite: ${existing} already exists, and nothing is written`, () => {
      const cwd = emptyDir('init-exists');
      if (existing === 'rust') mkdirSync(join(cwd, 'rust'));
      else writeFileSync(join(cwd, existing), '{}');
      const before = readTree(cwd);
      const c = capture();
      expect(runInit({ cwd, io: c.io, crateRev: REV })).toBe(1);
      expect(c.err()).toContain(`${existing} already exists`);
      expect(c.err()).toContain('nothing was written');
      expect(readTree(cwd)).toEqual(before);
    });
  }

  it('refuses when this build records no knext-ffi revision, writing nothing', () => {
    const cwd = emptyDir('init-norev');
    const c = capture();
    expect(runInit({ cwd, io: c.io, crateRev: null })).toBe(1);
    expect(c.err()).toContain('records no knext-ffi crate revision');
    expect(existsSync(join(cwd, 'knext.ffi.json'))).toBe(false);
  });

  it('refuses a revision that is not a full 40-hex commit (a tag or branch is a movable ref)', () => {
    for (const rev of ['v1.0.0', 'main', 'abc123']) {
      const c = capture();
      expect(runInit({ cwd: emptyDir('init-badrev'), io: c.io, crateRev: rev })).toBe(1);
      expect(c.err()).toContain('full 40-hex commit');
    }
  });
});

describe('the knext-ffi revision this package records (package.json knextFfi.crateRev)', () => {
  it('is recorded, as a full 40-hex commit, so `knext ffi init` writes a crate instead of refusing', () => {
    // That cargo resolves knext-ffi at this commit and the written crate
    // builds is proven in the Rust crates CI lane (crates/harness/ffi-generated.ts
    // `init`), which builds the crate exactly as written, fetching the git
    // dependency. Not here: this suite runs on a shallow checkout, which does
    // not hold the commit.
    const rev = recordedCrateRev();
    expect(rev).not.toBeNull();
    expect(rev).toMatch(/^[0-9a-f]{40}$/);
    const c = capture();
    const cwd = emptyDir('init-recorded');
    expect(runInit({ cwd, io: c.io }), c.err()).toBe(0);
    expect(readFileSync(join(cwd, 'rust', 'Cargo.toml'), 'utf8')).toContain(
      `knext-ffi = { git = "${CRATE_GIT}", rev = "${rev}" }`,
    );
  });

  it('is a commit that contains crates/knext-ffi, when this checkout holds it', () => {
    // A full clone (a developer machine, the Rust crates lane) holds the
    // commit; a shallow CI checkout may not, and then the lane's real build is
    // the proof. Never a silent pass on a full clone: a missing object there
    // fails.
    const rev = recordedCrateRev() as string;
    const repo = resolve(PKG_DIR, '..', '..');
    const shallow = spawnSync('git', ['rev-parse', '--is-shallow-repository'], {
      cwd: repo,
      encoding: 'utf8',
    }).stdout.trim();
    const r = spawnSync('git', ['cat-file', '-e', `${rev}:crates/knext-ffi/Cargo.toml`], {
      cwd: repo,
    });
    if (shallow === 'true' && r.status !== 0) return;
    expect(r.status, `${rev} has no crates/knext-ffi/Cargo.toml`).toBe(0);
  });
});

describe('knext ffi init: a vinext app carries its own Dockerfile, which init does not edit, so it says what to add', () => {
  // The scaffolded vinext x bun Dockerfile is the app's own file, not one the build stages, so the
  // line that closes /app and /app/native has to be added by the app's owner.
  const VINEXT_DOCKERFILE = join(PKG_DIR, '..', 'kn-next', 'templates', 'app', 'Dockerfile.hbs');
  const LINE = 'RUN chmod go-w /app /app/native';

  const init = (dockerfile?: string) => {
    const cwd = emptyDir('init-vinext');
    if (dockerfile !== undefined) writeFileSync(join(cwd, 'Dockerfile'), dockerfile);
    const c = capture();
    expect(runInit({ cwd, io: c.io, crateRev: REV }), c.err()).toBe(0);
    return { cwd, out: c.out() };
  };

  it('prints the line, and where it goes, for the Dockerfile a vinext app is scaffolded with, and leaves the file alone', () => {
    const text = readFileSync(VINEXT_DOCKERFILE, 'utf8');
    expect(text).not.toContain(LINE); // the template does not carry it: that is why init says so
    const { cwd, out } = init(text);
    expect(out).toContain(LINE);
    expect(out).toContain('directly after the `COPY` that brings native/ in');
    expect(out).toContain('before `USER`');
    // Why it matters: the Dockerfile must stay the one knext recognises, or deploy takes another path.
    expect(out).toContain('change nothing else');
    expect(out).toContain('knext ffi generate'); // the rest of the output is still there
    expect(readFileSync(join(cwd, 'Dockerfile'), 'utf8')).toBe(text);
  });

  it('names the directories it closes and why, so the line is not cargo-culted', () => {
    const { out } = init(readFileSync(VINEXT_DOCKERFILE, 'utf8'));
    expect(out).toContain('every directory above the library is owned by root');
    expect(out).toContain('/app and /app/native');
  });

  it('says nothing about it when the Dockerfile already has the line', () => {
    const text = readFileSync(VINEXT_DOCKERFILE, 'utf8').replace(
      /^COPY --chown=0:0 --chmod=a-w native \/app\/native$/m,
      `$&\n${LINE}`,
    );
    expect(text).toContain(LINE);
    expect(init(text).out).not.toContain('chmod go-w');
  });

  it('says nothing about it for an app with no Dockerfile (a standalone app is built from a Dockerfile knext stages, with the line in it)', () => {
    expect(init().out).not.toContain('chmod go-w');
  });

  it('says nothing about it for a Dockerfile that does not copy native/ to /app/native', () => {
    expect(init('FROM scratch\nCOPY server /app/server\nUSER 65532:65532\n').out).not.toContain(
      'chmod go-w',
    );
  });

  // The hint has to be right about which Dockerfile it is looking at.
  const hinted = (dockerfile: string) => init(dockerfile).out.includes(LINE);
  const FINAL = (...lines: string[]) =>
    ['FROM alpine', 'WORKDIR /app', ...lines, 'USER 65532:65532', ''].join('\n');

  it('recognises every way a Dockerfile writes the copy of native/ to /app/native', () => {
    for (const copy of [
      'COPY native /app/native',
      'COPY native/ /app/native/',
      'COPY ./native /app/native',
      'COPY ./native/ /app/native/',
      'copy --chown=0:0 --chmod=a-w native /app/native',
      'Copy native /app/native',
      'COPY ["native", "/app/native"]',
      'COPY --chown=0:0 ["native/", "/app/native/"]',
      'COPY --chown=0:0 --chmod=a-w \\\n    native \\\n    /app/native',
      'COPY --from=build /out/native /app/native',
      'COPY --from=build --chown=0:0 --chmod=a-w /out/native/ /app/native/',
      'COPY   native   /app/native   ',
    ]) {
      expect(hinted(FINAL(copy)), copy).toBe(true);
    }
  });

  it('does not take other copies for it: another destination, the JSON form of one, a build stage that is not the image', () => {
    for (const copy of [
      'COPY native /srv/native',
      'COPY native /app/natives',
      'COPY native /app',
      'COPY ["native", "/srv/native"]',
      'COPY native',
      '# COPY native /app/native',
    ]) {
      expect(hinted(FINAL(copy)), copy).toBe(false);
    }
    // The copy is in an earlier stage: the image the app ships is the last one.
    expect(
      hinted(
        'FROM alpine AS build\nCOPY native /app/native\nFROM alpine\nCOPY server /app/server\nUSER 65532:65532\n',
      ),
    ).toBe(false);
  });

  it('needs BOTH /app and /app/native closed, after the copy, in the final stage, before it says nothing', () => {
    const COPY = 'COPY --chown=0:0 --chmod=a-w native /app/native';
    for (const closes of [
      'RUN chmod go-w /app /app/native',
      'RUN chmod go-w /app/native /app',
      'RUN chmod go-w /app/ /app/native/',
      'RUN chmod og-w /app /app/native',
      'RUN chmod a-w /app /app/native',
      'RUN chmod g-w,o-w /app /app/native',
      'RUN chmod 755 /app /app/native',
      'RUN chmod 0755 /app /app/native',
      'RUN chmod go-w /app && chmod go-w /app/native',
      'RUN set -e; chmod go-w /app /app/native; echo done',
      'RUN chmod go-w /app \\\n    /app/native',
      'RUN chmod -R go-w /app',
      'RUN chmod --recursive go-w /app',
    ]) {
      expect(hinted(FINAL(COPY, closes)), closes).toBe(false);
    }
    for (const closes of [
      'RUN chmod go-w /app/native', // /app is left as the builder made it
      'RUN chmod go-w /app', // /app/native is left as the builder made it
      'RUN chmod go-w /app/server /app/native',
      'RUN chmod go+w /app /app/native',
      'RUN chmod u-w /app /app/native',
      'RUN chmod g-w /app /app/native',
      'RUN chmod 775 /app /app/native',
      'RUN chmod 777 /app /app/native',
      'RUN chown 0:0 /app /app/native',
      'RUN echo chmod go-w /app /app/native',
      '# RUN chmod go-w /app /app/native',
      'RUN chmod go-w /app || true; chmod go-w /app/server',
    ]) {
      expect(hinted(FINAL(COPY, closes)), closes).toBe(true);
    }
    // Before the copy it closes nothing the copy then makes.
    expect(hinted(FINAL('RUN chmod go-w /app /app/native', COPY))).toBe(true);
    // In an earlier stage it closes nothing in the image.
    expect(hinted(`FROM alpine AS build\nRUN chmod go-w /app /app/native\n${FINAL(COPY)}`)).toBe(
      true,
    );
    // Closed in the final stage after a copy in an earlier stage too.
    expect(
      hinted(
        `FROM alpine AS build\n${COPY}\nFROM alpine\n${COPY}\nRUN chmod go-w /app /app/native\n`,
      ),
    ).toBe(false);
  });

  it('the line the hint prints, put directly after the copy of the scaffolded Dockerfile, is what silences it', () => {
    const text = readFileSync(VINEXT_DOCKERFILE, 'utf8');
    const line = /^ {2}(RUN chmod go-w .*)$/m.exec(init(text).out)?.[1];
    expect(line).toBe(LINE);
    const followed = text.replace(
      /^COPY --chown=0:0 --chmod=a-w native \/app\/native$/m,
      `$&\n${line}`,
    );
    expect(followed).not.toBe(text);
    expect(init(followed).out).not.toContain('chmod go-w');
  });
});
