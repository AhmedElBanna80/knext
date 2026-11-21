/**
 * `knext ffi init` (ADR-0069 D3, D11, D12): writes `knext.ffi.json` and the
 * `rust/` crate from the package's templates, pinning `knext-ffi` to the git
 * revision this @getknext/ffi records; refuses to overwrite anything.
 */

import { afterAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { run } from '../cli';
import {
  appBuild,
  CRATE_GIT,
  dockerfileHint,
  recordedCrateRev,
  runInit,
  TEMPLATE_DIR,
} from '../init';
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

  const init = (dockerfile?: string, build?: string) => {
    const cwd = emptyDir('init-vinext');
    if (dockerfile !== undefined) writeFileSync(join(cwd, 'Dockerfile'), dockerfile);
    const c = capture();
    expect(
      runInit({ cwd, io: c.io, crateRev: REV, ...(build === undefined ? {} : { build }) }),
      c.err(),
    ).toBe(0);
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
  const addLine = (dockerfile: string) => init(dockerfile).out.includes('add this one line');
  const reopened = (dockerfile: string) =>
    init(dockerfile).out.includes('a RUN after that COPY opens');
  /** Some advice about the line is printed: to add it, or to close the directories again after a RUN that opens them. */
  const hinted = (dockerfile: string) => addLine(dockerfile) || reopened(dockerfile);
  const slower = (dockerfile: string) => init(dockerfile).out.includes('slower');
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
      // Closed, so nothing to add; but only the one line directly after the COPY is what deploy
      // recognises, so any other way of closing them is a warning about the slower path.
      expect(slower(FINAL(COPY, closes)), closes).toBe(closes !== LINE);
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

  const COPY_LINE = 'COPY --chown=0:0 --chmod=a-w native /app/native';
  const CLOSE_RUN = 'RUN chmod go-w /app /app/native';

  it('a mode with no who-letter closes nothing: it is subject to the umask, so it is not what the loader needs', () => {
    for (const closes of [
      'RUN chmod -w /app /app/native',
      'RUN chmod =rx /app /app/native',
      'RUN chmod -R -w /app',
      'RUN chmod -w,=rx /app /app/native',
      'RUN chmod -w /app && chmod =rx /app/native',
    ]) {
      expect(hinted(FINAL(COPY_LINE, closes)), closes).toBe(true);
    }
    // The same with a who-letter is a close.
    for (const closes of [
      'RUN chmod a-w /app /app/native',
      'RUN chmod ugo=rx /app /app/native',
      'RUN chmod go=rx /app /app/native',
      'RUN chmod og-w /app /app/native',
    ]) {
      expect(hinted(FINAL(COPY_LINE, closes)), closes).toBe(false);
    }
  });

  it('a later chmod that gives group or other write, or a chown to somebody else, undoes the close; a close after it closes again', () => {
    for (const after of [
      'RUN chmod g+w /app',
      'RUN chmod o+w /app/native',
      'RUN chmod a+w /app /app/native',
      'RUN chmod +w /app',
      'RUN chmod 775 /app',
      'RUN chmod -R 777 /app',
      'RUN chmod -R g+w /app',
      'RUN chmod go=rwx /app/native',
      'RUN chown app /app',
      'RUN chown -R app:app /app',
      'RUN chown 65532 /app/native',
      'RUN chmod go-w /app /app/native && chown -R app /app',
    ]) {
      expect(hinted(FINAL(COPY_LINE, CLOSE_RUN, after)), after).toBe(true);
    }
    for (const after of [
      'RUN chmod g+w /app/server', // another path
      'RUN chmod u+w /app', // the owner is root and may write
      'RUN chown root:root /app',
      'RUN chown -R 0:0 /app',
      'RUN chown app /srv/data',
      'RUN chown -R app /app/server', // a path inside /app, not /app itself
    ]) {
      expect(hinted(FINAL(COPY_LINE, CLOSE_RUN, after)), after).toBe(false);
    }
    expect(hinted(FINAL(COPY_LINE, 'RUN chmod g+w /app', CLOSE_RUN))).toBe(false);
    expect(hinted(FINAL(COPY_LINE, 'RUN chown -R app /app && chmod go-w /app /app/native'))).toBe(
      false,
    );
    expect(hinted(FINAL(COPY_LINE, 'RUN chmod -R go-w /app', 'RUN chown app /app/native'))).toBe(
      true,
    );
  });

  it('a heredoc body is not read as Dockerfile instructions; the body of a RUN is read as the commands it holds, and a COPY or ADD body is data', () => {
    const heredoc = (head: string, marker: string, ...body: string[]) =>
      [head, ...body, marker].join('\n');
    // A body line that looks like a COPY of native/ is not the copy: with no real one, nothing to say.
    expect(hinted(FINAL(heredoc('RUN <<EOT', 'EOT', 'COPY native /app/native')))).toBe(false);
    // A body line that looks like a FROM does not start a new stage, so the real copy still stands.
    expect(hinted(FINAL(COPY_LINE, heredoc('RUN <<EOT', 'EOT', 'FROM scratch')))).toBe(true);
    // A body line that looks like the close INSTRUCTION is not one (a shell is not told to run `RUN`), ...
    expect(hinted(FINAL(COPY_LINE, heredoc('RUN <<EOT', 'EOT', CLOSE_RUN)))).toBe(true);
    // ... but the chmod a RUN's body runs is a chmod, ...
    expect(
      hinted(FINAL(COPY_LINE, heredoc('RUN <<EOT', 'EOT', 'chmod go-w /app /app/native'))),
    ).toBe(false);
    // ... and the body of a COPY is the file it writes, not a command.
    expect(hinted(FINAL(COPY_LINE, heredoc('COPY <<EOT /app/note', 'EOT', CLOSE_RUN)))).toBe(true);
    // Every spelling of the marker, a blank line and a comment inside the body, and what follows it is read again.
    for (const head of [
      "RUN <<'EOT'",
      'RUN <<"EOT"',
      'RUN <<-EOT',
      'RUN <<EOT',
      'RUN sh -e <<EOT',
    ]) {
      const closed = FINAL(
        COPY_LINE,
        heredoc(head, 'EOT', '', '# not a comment', 'FROM scratch'),
        CLOSE_RUN,
      );
      expect(hinted(closed), head).toBe(false);
      expect(hinted(FINAL(COPY_LINE, heredoc(head, 'EOT', '', 'FROM scratch'))), head).toBe(true);
    }
    // Two heredocs on one instruction, and a tab-indented terminator for <<-.
    expect(
      hinted(FINAL(COPY_LINE, ['RUN cat <<A <<B', 'x', 'A', 'FROM scratch', 'B'].join('\n'))),
    ).toBe(true);
    expect(hinted(FINAL(COPY_LINE, 'RUN <<-EOT\n\tFROM scratch\n\tEOT'))).toBe(true);
    // <<- ends at a terminator the tabs come before, so the close after it is read; a plain << does not
    // end there (the tab is part of the line), so everything after it is still the body.
    expect(hinted(FINAL(COPY_LINE, 'RUN <<-EOT\n\techo hi\n\tEOT', CLOSE_RUN))).toBe(false);
    expect(hinted(FINAL(COPY_LINE, 'RUN <<EOT\n\techo hi\n\tEOT', CLOSE_RUN))).toBe(true);
  });

  it('a close that is not the one line directly after the scaffolded COPY is a warning that deploy takes the slower, image-sourced path, not a request to add a line', () => {
    const scaffolded = readFileSync(VINEXT_DOCKERFILE, 'utf8');
    const placed = (insert: string) =>
      scaffolded.replace(COPY_LINE, () => `${COPY_LINE}\n${insert}`);
    for (const elsewhere of [
      FINAL(COPY_LINE, 'RUN echo hi', CLOSE_RUN),
      FINAL(COPY_LINE, '', CLOSE_RUN), // a blank line between them
      FINAL(COPY_LINE, '# close them', CLOSE_RUN),
      FINAL(COPY_LINE, 'RUN chmod go-w /app/native /app'),
      FINAL(COPY_LINE, 'RUN chmod go-w /app && chmod go-w /app/native'),
    ]) {
      const out = init(elsewhere).out;
      expect(out, elsewhere).toContain('slower');
      expect(out).toContain('close /app and /app/native');
      expect(out).toContain('directly after the `COPY` that brings native/ in');
      expect(out).toContain(`  ${CLOSE_RUN}\n`);
      expect(out).not.toContain('add this one line');
    }
    // The one line directly after: silent. Nothing is said for a Dockerfile that is not the
    // scaffolded one either (a different spelling of the COPY): it was never on that path.
    expect(init(FINAL(COPY_LINE, CLOSE_RUN)).out).not.toContain('slower');
    expect(init(placed(CLOSE_RUN)).out).not.toContain('slower');
    expect(init(FINAL('COPY native /app/native', 'RUN echo hi', CLOSE_RUN)).out).not.toContain(
      'slower',
    );
  });

  it('reads a chmod the way a shell does: quoted words, any path to the tool, sudo and its relatives, a path with a dot in it, the working directory, the exec form, sh -c, cd', () => {
    // Every one of these closes both directories, and is a close the hint accepts (it then warns
    // about the slower path, because none is the one line directly after the COPY).
    for (const closes of [
      'RUN chmod go-w "/app" "/app/native"',
      "RUN chmod 'go-w' '/app' /app/native",
      'RUN chmod "go-w" /app /app/native',
      'RUN /bin/chmod go-w /app /app/native',
      'RUN /usr/bin/chmod go-w /app /app/native',
      'RUN busybox chmod go-w /app /app/native',
      'RUN sudo chmod go-w /app /app/native',
      'RUN sudo -u root chmod go-w /app /app/native',
      'RUN env FOO=1 chmod go-w /app /app/native',
      'RUN FOO=1 chmod go-w /app /app/native',
      'RUN command chmod go-w /app /app/native',
      'RUN chmod go-w /app/. /app/native/.',
      'RUN chmod go-w /app//native /app/',
      'RUN chmod go-w /app/./native /app/../app',
      'RUN chmod go-w /app /app/native/',
      'RUN ["chmod", "go-w", "/app", "/app/native"]',
      'RUN ["/bin/chmod", "go-w", "/app", "/app/native"]',
      'RUN sh -c "chmod go-w /app /app/native"',
      "RUN sh -c 'chmod go-w /app && chmod go-w /app/native'",
      'RUN cd /app && chmod go-w . native',
      'RUN cd /app && chmod -R go-w .',
      'RUN (cd /app && chmod -R go-w .)',
      'RUN chmod -R go-w /',
      'RUN chmod -Rf go-w /app',
      'RUN chmod go-w /app /app/native && echo "a; chmod g+w /app"',
    ]) {
      expect(hinted(FINAL(COPY_LINE, closes)), closes).toBe(false);
      expect(slower(FINAL(COPY_LINE, closes)), closes).toBe(true);
    }
    // After WORKDIR /app, a relative path is under it. FINAL() already says WORKDIR /app.
    for (const closes of [
      'RUN chmod go-w . native',
      'RUN chmod go-w ./ ./native/',
      'RUN chmod -R go-w .',
      'RUN chmod go-w /app native',
    ]) {
      expect(hinted(FINAL(COPY_LINE, closes)), closes).toBe(false);
    }
    // With no working directory known, a relative path names nothing: it closes nothing, so the hint stays.
    for (const df of [
      ['FROM alpine', COPY_LINE, 'RUN chmod go-w . native', ''].join('\n'),
      ['FROM alpine', 'WORKDIR $APP', COPY_LINE, 'RUN chmod go-w . native', ''].join('\n'),
      ['FROM alpine', 'WORKDIR /srv', COPY_LINE, 'RUN chmod go-w . native', ''].join('\n'),
    ]) {
      expect(hinted(df), df).toBe(true);
    }
    // `cd` moves the working directory a relative path is under, with a WORKDIR set or not: a `.` after a
    // cd to somewhere else is not /app, and one after a cd to /app is, whatever the WORKDIR was.
    expect(
      hinted(['FROM alpine', COPY_LINE, 'RUN cd /app && chmod go-w . native', ''].join('\n')),
    ).toBe(false);
    expect(hinted(FINAL(COPY_LINE, 'RUN cd /srv && chmod go-w . native'))).toBe(true);
    expect(hinted(FINAL(COPY_LINE, 'RUN cd /srv && cd /app && chmod go-w . native'))).toBe(false);
    expect(
      reopened(
        ['FROM alpine', COPY_LINE, CLOSE_RUN, 'RUN cd /app && chmod g+w native', ''].join('\n'),
      ),
    ).toBe(true);
    // WORKDIR may be relative to the one before it, and may be quoted.
    expect(
      hinted(
        ['FROM alpine', 'WORKDIR /', 'WORKDIR app', COPY_LINE, 'RUN chmod go-w . native', ''].join(
          '\n',
        ),
      ),
    ).toBe(false);
    expect(
      hinted(
        ['FROM alpine', 'WORKDIR "/app"', COPY_LINE, 'RUN chmod go-w . native', ''].join('\n'),
      ),
    ).toBe(false);
  });

  it('a chmod that opens the directories is never taken for a close, however it is spelled: quotes, a path to the tool, sudo, a dot, the working directory, the exec form, sh -c, cd, find -exec, xargs, a glob or a variable', () => {
    for (const opens of [
      'RUN chmod g+w "/app"',
      "RUN chmod 'g+w' /app",
      'RUN /bin/chmod g+w /app',
      'RUN sudo chmod g+w /app',
      'RUN sudo -u root chmod g+w /app/native',
      'RUN busybox chmod -R 777 /app',
      'RUN chmod g+w .',
      'RUN chmod g+w ./',
      'RUN chmod o+w /app/.',
      'RUN chmod o+w /app//native',
      'RUN chmod -R 777 "/app/"',
      'RUN chmod 777 /app/native/.',
      'RUN ["chmod", "-R", "777", "/app"]',
      'RUN ["/bin/chmod", "g+w", "/app/native"]',
      'RUN sh -c "chmod -R g+w /app"',
      'RUN bash -ec "chmod -R g+w /app"',
      'RUN cd /app && chmod -R g+w .',
      'RUN (cd /app && chmod g+w native)',
      'RUN chmod -R 777 /',
      'RUN find /app -type d -exec chmod 775 {} +',
      'RUN find /app -exec chmod g+w {} \\;',
      'RUN find /app -type d | xargs chmod g+w',
      'RUN chmod -R g+w /app/*',
      'RUN chmod g+w $APP_DIR',
      'RUN chmod g+w $(echo /app)',
      'RUN chown -R app:app "/app"',
      'RUN /bin/chown -R app /app',
      'RUN sudo chown app /app/native',
      'RUN chown -R app .',
      'RUN ["chown", "-R", "app", "/app"]',
      'RUN find /app -exec chown app {} +',
      // A command this does not know that runs a chmod or a chown: not knowing is a reason to say so.
      'RUN su-exec app chmod g+w /app',
      'RUN gosu app chmod -R 777 /app',
      'RUN runuser -u app -- chmod g+w /app/native',
    ]) {
      // Closed first, so a close that is not undone would be silent: what is under test is that the
      // open is seen, and the message says it is an open, not that the line is missing.
      const df = FINAL(COPY_LINE, CLOSE_RUN, opens);
      expect(hinted(df), opens).toBe(true);
      expect(reopened(df), opens).toBe(true);
      expect(addLine(df), opens).toBe(false);
    }
    // Opened and never closed: the same message, since adding the line right after the COPY would
    // not help while a later RUN opens them again.
    expect(reopened(FINAL(COPY_LINE, 'RUN chmod -R 777 /app'))).toBe(true);
    // A RUN that opens nothing it names is not one: other paths, a variable assignment, an echo.
    for (const fine of [
      'RUN chmod g+w /srv/data',
      'RUN chmod g+w /app/server',
      'RUN chmod g+w ./server',
      'RUN echo "chmod -R 777 /app"',
      'RUN echo chmod -R 777 /app',
      'RUN printf "%s" "chmod 777 /app"',
      'RUN ls -l /app',
      'RUN chmod go-w /app /app/native',
    ]) {
      expect(reopened(FINAL(COPY_LINE, CLOSE_RUN, fine)), fine).toBe(false);
      expect(hinted(FINAL(COPY_LINE, CLOSE_RUN, fine)), fine).toBe(false);
    }
  });

  it('a RUN heredoc is read as commands, the way a shell would run it: a chmod in the body closes the directories, or opens them again', () => {
    expect(hinted(FINAL(COPY_LINE, 'RUN <<EOT\nchmod go-w /app /app/native\nEOT'))).toBe(false);
    expect(
      hinted(FINAL(COPY_LINE, 'RUN <<EOT\nset -e\nchmod go-w /app\nchmod go-w /app/native\nEOT')),
    ).toBe(false);
    expect(reopened(FINAL(COPY_LINE, CLOSE_RUN, 'RUN <<EOT\nchmod -R 777 /app\nEOT'))).toBe(true);
    expect(reopened(FINAL(COPY_LINE, CLOSE_RUN, "RUN <<'EOT'\nchown -R app /app\nEOT"))).toBe(true);
    // A body that is not a RUN's is data: it is skipped as before.
    expect(
      hinted(FINAL(COPY_LINE, CLOSE_RUN, 'COPY <<EOT /app/note\nchmod -R 777 /app\nEOT')),
    ).toBe(false);
  });

  it('a heredoc is only started by RUN, COPY and ADD: the text of a LABEL, ENV or ARG that holds << is not one, so what follows it is still read', () => {
    for (const line of [
      'LABEL x="<<EOF"',
      "LABEL x='<<EOF'",
      'ENV BANNER="<<EOF"',
      'ARG X=<<EOF',
      'EXPOSE 80 # <<EOF',
      'USER 65532 <<EOF',
    ]) {
      // If the line opened a heredoc, the close below would be its body and the hint would stay.
      expect(hinted(FINAL(COPY_LINE, line, CLOSE_RUN)), line).toBe(false);
      expect(hinted(FINAL(line, COPY_LINE, CLOSE_RUN)), line).toBe(false);
    }
    // The three that do start one.
    for (const head of ['RUN <<EOF', 'COPY <<EOF /app/x', 'ADD <<EOF /app/x']) {
      expect(hinted(FINAL(COPY_LINE, `${head}\nx\nEOF`, CLOSE_RUN)), head).toBe(false);
      // The close inside the body counts when the body is a RUN's (a script the shell runs), and not
      // when it is the file a COPY or an ADD writes.
      expect(hinted(FINAL(COPY_LINE, `${head}\nchmod go-w /app /app/native\nEOF`)), head).toBe(
        !head.startsWith('RUN'),
      );
    }
  });

  it('says a later RUN opens them, not "add this one line", when the line is there and something after it undoes it, and never claims the loader accepts a Dockerfile it could not read all the way', () => {
    const out = init(FINAL(COPY_LINE, CLOSE_RUN, 'RUN chown -R app:app /app')).out;
    expect(out).toContain('a RUN after that COPY opens');
    expect(out).toContain('/app');
    expect(out).toContain(`  ${CLOSE_RUN}\n`);
    expect(out).toContain('after the last such RUN');
    expect(out).not.toContain('add this one line');
    expect(out).not.toContain('so the loader accepts');
    // Names exactly the directories that were opened, not both.
    const one = init(FINAL(COPY_LINE, CLOSE_RUN, 'RUN chmod g+w /app/native')).out;
    expect(one).toMatch(/opens \/app\/native /);
    expect(one).not.toMatch(/opens \/app and/);
    // A path it cannot read is one that may open them: the hint stays, and says so.
    const unknown = init(FINAL(COPY_LINE, CLOSE_RUN, 'RUN chmod g+w $APP_DIR')).out;
    expect(unknown).toContain('a RUN after that COPY opens');
    expect(unknown).toContain('or may open');
    // The same Dockerfile with the close after the last RUN that opens is silent.
    expect(init(FINAL(COPY_LINE, 'RUN chown -R app:app /app', CLOSE_RUN)).out).not.toContain(
      'a RUN after that COPY opens',
    );
  });

  it('the copy of native/ is found whatever way a Dockerfile spells the destination: a relative one under WORKDIR /app, a quoted one', () => {
    for (const copy of [
      'COPY native native',
      'COPY native ./native',
      'COPY native ./native/',
      'COPY native "/app/native"',
      "COPY native '/app/native'",
      'COPY native /app/./native',
      'COPY ["native", "native"]',
    ]) {
      expect(addLine(FINAL(copy)), copy).toBe(true);
    }
    // Under another working directory, or one that cannot be read, a relative destination is not /app/native.
    expect(addLine(['FROM alpine', 'WORKDIR /srv', 'COPY native native', ''].join('\n'))).toBe(
      false,
    );
    expect(addLine(['FROM alpine', 'WORKDIR $APP', 'COPY native native', ''].join('\n'))).toBe(
      false,
    );
    expect(addLine(['FROM alpine', 'COPY native native', ''].join('\n'))).toBe(false);
  });

  it('the hint is for a vinext build only: a standalone build stages its own Dockerfile, so an app on turbopack or webpack is told nothing, and an unknown build is told as before', () => {
    const text = readFileSync(VINEXT_DOCKERFILE, 'utf8');
    for (const build of ['turbopack', 'webpack']) {
      expect(init(text, build).out, build).not.toContain('chmod go-w');
      const cwd = emptyDir('hint-build');
      writeFileSync(join(cwd, 'Dockerfile'), text);
      expect(dockerfileHint(cwd, build)).toBe('');
    }
    expect(init(text, 'vinext').out).toContain(LINE);
    expect(init(text, undefined).out).toContain(LINE);
    // The warning is for a vinext build too.
    const closedElsewhere = FINAL(COPY_LINE, 'RUN echo hi', CLOSE_RUN);
    expect(init(closedElsewhere, 'turbopack').out).not.toContain('slower');
    expect(init(closedElsewhere, 'vinext').out).toContain('slower');
  });
});

describe('appBuild reads the build target the way the CLI does: knext.config.ts, build ?? "turbopack"', () => {
  const withConfig = (text?: string) => {
    const cwd = emptyDir('app-build');
    if (text !== undefined) writeFileSync(join(cwd, 'knext.config.ts'), text);
    return cwd;
  };

  it('is the build the config names, and turbopack when it names none (the default target)', async () => {
    expect(
      await appBuild(withConfig("export default { name: 'a', registry: 'r', build: 'vinext' };\n")),
    ).toBe('vinext');
    expect(
      await appBuild(
        withConfig("export default { name: 'a', registry: 'r', build: 'webpack' };\n"),
      ),
    ).toBe('webpack');
    expect(await appBuild(withConfig("export default { name: 'a', registry: 'r' };\n"))).toBe(
      'turbopack',
    );
  });

  it('is undefined when it cannot tell: no config, one that throws, one with no default export, one whose build is not a string', async () => {
    expect(await appBuild(withConfig())).toBeUndefined();
    expect(await appBuild(withConfig("throw new Error('no env');\n"))).toBeUndefined();
    expect(await appBuild(withConfig('export const x = 1;\n'))).toBeUndefined();
    expect(await appBuild(withConfig('export default { build: 5 };\n'))).toBeUndefined();
  });
});

describe('the hint reads the config of the app it runs in', () => {
  const VINEXT = readFileSync(
    join(PKG_DIR, '..', 'kn-next', 'templates', 'app', 'Dockerfile.hbs'),
    'utf8',
  );
  const out = async (build?: string) => {
    const cwd = emptyDir('cli-build');
    writeFileSync(join(cwd, 'Dockerfile'), VINEXT);
    if (build !== undefined) {
      writeFileSync(
        join(cwd, 'knext.config.ts'),
        `export default { name: 'a', registry: 'r', build: '${build}' };\n`,
      );
    }
    const c = capture();
    const code = await run('ffi', ['init'], { ...c.io, cwd, crateRev: REV });
    expect(code, c.err()).toBe(0);
    return c.out();
  };

  it('knext ffi init says nothing for a turbopack or webpack app, and prints the line for a vinext one, and for one with no readable config', async () => {
    expect(await out('turbopack')).not.toContain('chmod go-w');
    expect(await out('webpack')).not.toContain('chmod go-w');
    expect(await out('vinext')).toContain('RUN chmod go-w /app /app/native');
    expect(await out()).toContain('RUN chmod go-w /app /app/native');
  });
});

describe('the line the hint prints', () => {
  const VINEXT_DOCKERFILE = join(PKG_DIR, '..', 'kn-next', 'templates', 'app', 'Dockerfile.hbs');
  const LINE = 'RUN chmod go-w /app /app/native';
  const init = (dockerfile?: string) => {
    const cwd = emptyDir('init-vinext');
    if (dockerfile !== undefined) writeFileSync(join(cwd, 'Dockerfile'), dockerfile);
    const c = capture();
    expect(runInit({ cwd, io: c.io, crateRev: REV }), c.err()).toBe(0);
    return { cwd, out: c.out() };
  };

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
