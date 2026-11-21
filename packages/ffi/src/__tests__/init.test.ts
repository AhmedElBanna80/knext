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
  const cannotConfirm = (dockerfile: string) => init(dockerfile).out.includes('cannot confirm');
  /** Something is said about the line: to add it, or that knext cannot confirm the file it is in. */
  const hinted = (dockerfile: string) => addLine(dockerfile) || cannotConfirm(dockerfile);
  /** What no message may say unless the one confirmed form held: that the loader will take the directories. */
  const CLAIM = /should accept|will accept|accepts them|loader accepts/;
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

  const COPY_LINE = 'COPY --chown=0:0 --chmod=a-w native /app/native';
  const CLOSE_RUN = LINE;
  const CHECK_RUN = 'RUN test -f /app/native/.integrity.json || { echo "missing" >&2; exit 1; }';

  it('says nothing for exactly one form: the scaffolded COPY, the line as the very next line, and after it only what cannot change a mode', () => {
    const template = readFileSync(VINEXT_DOCKERFILE, 'utf8');
    const placed = template.replace(COPY_LINE, () => `${COPY_LINE}\n${CLOSE_RUN}`);
    expect(placed).not.toBe(template);
    expect(hinted(placed)).toBe(false); // the scaffolded file with the line, its own check included
    expect(hinted(placed.replace(/\n/g, '\r\n'))).toBe(false);
    for (const after of [
      'ENV A=b',
      'env lower=case',
      'ENV A=b \\\n    C=d',
      'ARG X',
      'LABEL a=b',
      'EXPOSE 80',
      'USER 65532:65532',
      'WORKDIR /srv',
      'ENTRYPOINT ["/app/server"]',
      'CMD ["x"]',
      'HEALTHCHECK NONE',
      'STOPSIGNAL SIGTERM',
      CHECK_RUN,
      'RUN test -d /srv || { echo "no srv here" >&2; exit 1; }',
    ]) {
      expect(hinted(FINAL(COPY_LINE, CLOSE_RUN, after)), after).toBe(false);
    }
  });

  it('asks for the line when it is not the next instruction after the COPY, whatever else the file does to the directories: no line, another way of closing them, the line before the COPY or in another stage', () => {
    for (const dockerfile of [
      FINAL(COPY_LINE),
      FINAL(COPY_LINE, 'RUN echo hi', CLOSE_RUN),
      FINAL(COPY_LINE, 'RUN chmod go-w /app/native /app'),
      FINAL(COPY_LINE, 'RUN chmod -R go-w /app'),
      FINAL(COPY_LINE, 'RUN chmod 755 /app /app/native'),
      FINAL(COPY_LINE, 'RUN chmod go-w /app && chmod go-w /app/native'),
      FINAL(COPY_LINE, `# ${CLOSE_RUN}`),
      // a line that is not the one, though it starts as it does or is it in another case
      FINAL(COPY_LINE, `${CLOSE_RUN} && chmod -R 777 /app`),
      FINAL(COPY_LINE, `${CLOSE_RUN} /etc`),
      FINAL(COPY_LINE, `${CLOSE_RUN}x`),
      FINAL(COPY_LINE, CLOSE_RUN.toLowerCase()),
      FINAL(CLOSE_RUN, COPY_LINE),
      `FROM alpine AS build\n${CLOSE_RUN}\n${FINAL(COPY_LINE)}`,
      `FROM alpine AS build\n${COPY_LINE}\n${CLOSE_RUN}\nFROM alpine\n${COPY_LINE}\nUSER 65532:65532\n`,
    ]) {
      const out = init(dockerfile).out;
      expect(out, dockerfile).toContain('add this one line');
      expect(out, dockerfile).toContain(`  ${CLOSE_RUN}\n`);
      expect(out, dockerfile).toContain('slower');
      expect(out, dockerfile).not.toContain('cannot confirm');
      expect(out, dockerfile).not.toMatch(CLAIM);
    }
  });

  it('does not read what a command does: with the line in place, anything after it that is not on the short list is not confirmed, however it is written', () => {
    for (const after of [
      // the ways a command is dressed that a reader of the shell has to know
      'RUN sudo -n chmod -R 777 /app',
      'RUN find /app | xargs -r chmod g+w',
      'RUN ./fix-perms.sh',
      'RUN sh /fix.sh',
      'RUN install -d -m 0777 /app',
      'RUN install -m 0666 x /app/native/x',
      'RUN mkdir -m 777 /app/data',
      'RUN --mount=type=bind,source=.,target=/src chmod -R 777 /app',
      'RUN cd -P /app && chmod g+w .',
      // the plain ones
      'RUN chmod g+w /app',
      'RUN chown -R app /app',
      'RUN ["chmod", "777", "/app"]',
      'RUN setfacl -m u::rwx /app',
      'RUN umask 000 && mkdir /app/x',
      'RUN python3 -c "import os; os.chmod(\'/app\', 0o777)"',
      "RUN node -e \"require('fs').chmodSync('/app', 0o777)\"",
      'RUN perl -e "chmod 0777, q(/app)"',
      'RUN true',
      'RUN echo hi',
      // the one check that is on the list, made into something else
      'RUN test -f /app/native/.integrity.json || { echo "$(chmod -R 777 /app)" >&2; exit 1; }',
      'RUN test -f /app/native/.integrity.json || { echo "`chmod -R 777 /app`" >&2; exit 1; }',
      'RUN test -f /app/native/.integrity.json || { echo "a \\" >&2; exit 1; }',
      `${CHECK_RUN}; chmod -R 777 /app`,
      `${CHECK_RUN} && chmod -R 777 /app`,
      `${CHECK_RUN}\nRUN chmod -R 777 /app`,
      'RUN test -f $X || { echo "missing" >&2; exit 1; }',
      `RUN chmod -R 777 /app; ${CHECK_RUN.slice('RUN '.length)}`,
      // copies and adds, with or without an owner or a mode
      'COPY --chmod=777 x /app/',
      'COPY --chown=1000 x /app/',
      'COPY x /app/',
      'ADD x /app/',
      'ADD --chmod=777 x /app/',
      // instructions knext does not read
      'ONBUILD RUN chmod -R 777 /app',
      'SHELL ["/bin/bash", "-c"]',
      'VOLUME /app',
    ]) {
      const dockerfile = FINAL(COPY_LINE, CLOSE_RUN, after);
      const out = init(dockerfile).out;
      expect(out, after).toContain('cannot confirm');
      expect(out, after).not.toContain('add this one line');
      expect(out, after).not.toMatch(CLAIM);
      expect(out, after).toContain('slower');
    }
  });

  it('does not confirm a Dockerfile with a heredoc anywhere in it: a body is not Dockerfile text, and what it does is not read', () => {
    for (const dockerfile of [
      FINAL(COPY_LINE, CLOSE_RUN, "RUN cat > /entry.sh <<'EOF'\nchmod go-w /app /app/native\nEOF"),
      FINAL(COPY_LINE, CLOSE_RUN, 'RUN cat > /e.sh <<EOF\nchmod -R 777 /app\nEOF'),
      FINAL(COPY_LINE, CLOSE_RUN, 'RUN <<-EOF\n\tchmod -R 777 /app\nEOF'),
      FINAL(COPY_LINE, CLOSE_RUN, 'RUN <<"EOF" sh\nchmod -R 777 /app\nEOF'),
      FINAL(COPY_LINE, CLOSE_RUN, 'RUN cat <<\\EOF > /x\nhi\nEOF'),
      FINAL(COPY_LINE, CLOSE_RUN, "RUN cat <<'EOF'\nline one \\\nchmod -R 777 /app\nEOF"),
      FINAL(COPY_LINE, CLOSE_RUN, 'COPY <<EOF /srv/x\nhello\nEOF'),
      // Before the COPY, the body is the confirmed form and its terminator is an instruction knext
      // allows, so every instruction it reads comes out fine: only the heredoc itself says otherwise.
      ...[
        "cat > /entry.sh <<'ENV'",
        'cat > /e.sh <<ENV',
        'cat <<-ENV',
        'cat <<"ENV"',
        'cat <<\\ENV',
        'cat << ENV',
      ].map((start) =>
        [
          'FROM alpine',
          'WORKDIR /app',
          `RUN ${start}`,
          COPY_LINE,
          CLOSE_RUN,
          'ENV',
          'USER 1',
          '',
        ].join('\n'),
      ),
    ]) {
      const out = init(dockerfile).out;
      expect(out, dockerfile).toContain('cannot confirm');
      expect(out, dockerfile).not.toMatch(CLAIM);
    }
  });

  it('does not confirm a file that changes how it is read or what a RUN runs: an escape directive moves the continuation character, a SHELL replaces the shell of every RUN (the read-only check included)', () => {
    for (const dockerfile of [
      // Under escape=` a trailing backslash continues nothing: the RUN is an instruction of its own,
      // where a reader that joins it to the ENV above sees only an ENV.
      `# escape=\`\nFROM alpine\nWORKDIR /app\n${COPY_LINE}\n${CLOSE_RUN}\nENV A=b \\\nRUN chmod -R 777 /app\n`,
      `# ESCAPE = \`\n${FINAL(COPY_LINE, CLOSE_RUN)}`,
      FINAL(COPY_LINE, CLOSE_RUN, 'SHELL ["/bin/sh", "-c", "chmod -R 777 /app; true"]', CHECK_RUN),
      // before the COPY: the check after the line then runs under it
      `FROM alpine\nSHELL ["/bin/sh", "-c", "chmod -R 777 /app; true"]\nWORKDIR /app\n${COPY_LINE}\n${CLOSE_RUN}\n${CHECK_RUN}\n`,
    ]) {
      const out = init(dockerfile).out;
      expect(out, dockerfile).toContain('cannot confirm');
      expect(out, dockerfile).not.toMatch(CLAIM);
    }
    // The control: the same text with neither is the confirmed form.
    expect(hinted(FINAL(COPY_LINE, CLOSE_RUN, CHECK_RUN))).toBe(false);
  });

  // Silence needs a file that is clean AS A WHOLE, and that is judged before the final stage is cut
  // out of it, before the COPY is looked for and before any line is trimmed: otherwise the thing a
  // check is there to find can hide inside what it cuts out or trims away.
  const PINNED = readFileSync(VINEXT_DOCKERFILE, 'utf8').split('\n')[0] as string;
  const BODY = FINAL(COPY_LINE, CLOSE_RUN, CHECK_RUN);
  const SHELL_ARG = 'SHELL ["/bin/sh", "-c", "chmod -R 777 /app; true"]';

  it('does not confirm a Dockerfile with a heredoc anywhere in it, in any stage: a body that holds a FROM line cannot move the final stage', () => {
    for (const dockerfile of [
      // the body's `FROM t;` is read as the last FROM, so the stage after it is empty and no COPY is found
      FINAL(COPY_LINE, CLOSE_RUN, 'RUN psql <<EOF\nFROM t;\nEOF'),
      `FROM alpine AS build\nRUN psql <<EOF\nFROM t;\nEOF\n${BODY}`,
      `# a comment with << in it\n${BODY}`,
    ]) {
      const out = init(dockerfile).out;
      expect(out, dockerfile).toContain('cannot confirm');
      expect(out, dockerfile).toContain('heredoc');
      expect(out, dockerfile).not.toMatch(CLAIM);
    }
  });

  it('does not confirm a file with a SHELL instruction in any stage: one in a stage the last builds on (`FROM base`) changes what its RUNs run', () => {
    for (const dockerfile of [
      `FROM alpine AS base\n${SHELL_ARG}\nFROM base\nWORKDIR /app\n${COPY_LINE}\n${CLOSE_RUN}\n${CHECK_RUN}\n`,
      `FROM alpine AS base\nshell ["/bin/sh", "-c"]\nFROM base\nWORKDIR /app\n${COPY_LINE}\n${CLOSE_RUN}\n`,
      `FROM alpine AS base\n${SHELL_ARG}\nFROM alpine\nWORKDIR /app\n${COPY_LINE}\n${CLOSE_RUN}\n`,
    ]) {
      const out = init(dockerfile).out;
      expect(out, dockerfile).toContain('cannot confirm');
      expect(out, dockerfile).toContain('SHELL');
      expect(out, dockerfile).not.toMatch(CLAIM);
    }
  });

  it("does not confirm a file with an escape or syntax directive on any line, a byte-order mark, an indent or a different case notwithstanding; the scaffolded file's own pinned syntax line, first and byte for byte, is the one that passes", () => {
    expect(PINNED).toMatch(/^# syntax=docker\/dockerfile:\S+@sha256:[0-9a-f]{64}$/);
    expect(hinted(`${PINNED}\n${BODY}`)).toBe(false);
    for (const head of [
      '# escape=`',
      '\ufeff# escape=`',
      '  # escape=`',
      '\t# escape=`',
      '# ESCAPE = `',
      '#escape=`',
      '# syntax=example.com/frontend:1',
      '# syntax = docker/dockerfile:1',
      '\ufeff# syntax=docker/dockerfile:1',
      `${PINNED} `, // not byte for byte
      PINNED.replace('1.28', '1.29'),
      `${PINNED}\n# syntax=example.com/frontend:1`, // the pinned line does not cover a second one
      `# a comment first\n${PINNED}`, // and is the pinned line only as the first line
    ]) {
      const out = init(`${head}\n${BODY}`).out;
      expect(out, JSON.stringify(head)).toContain('cannot confirm');
      expect(out, JSON.stringify(head)).not.toMatch(CLAIM);
    }
  });

  it('does not confirm a file with a character a reader may take for something else, wherever it sits, a comment included, and says which line without printing it', () => {
    for (const ch of [
      '\ufeff', // byte-order mark
      '\u00a0', // no-break space
      '\f',
      '\v',
      '\u2028',
      '\u2029',
      '\u3000', // ideographic space
      '\u0085', // next line
      '\u200b', // zero-width space
      '\u00ad', // soft hyphen
      '\u0000',
      '\u001b',
      '\ufffd', // an invalid byte read as text
      '\r', // one that does not end a line
    ]) {
      const dockerfile = FINAL(COPY_LINE, CLOSE_RUN, `# a note${ch}about it`);
      const out = init(dockerfile).out;
      expect(out, JSON.stringify(ch)).toContain('cannot confirm');
      expect(out, JSON.stringify(ch)).toContain('not plain text');
      expect(out, JSON.stringify(ch)).toContain('line 5 '); // FROM, WORKDIR, COPY, CLOSE, then the comment
      expect(out, JSON.stringify(ch)).not.toContain(ch === '\r' ? 'a note\r' : ch);
      expect(out, JSON.stringify(ch)).not.toMatch(CLAIM);
    }
    // Visible non-ASCII is not one of them: the scaffolded file's own comments and check use an em dash.
    expect(hinted(FINAL(COPY_LINE, CLOSE_RUN, '# a note — here', 'LABEL d="café"'))).toBe(false);
  });

  it('does not let a no-break space after a backslash join the next line to the one above it: it is not a continuation for BuildKit, so the next line is an instruction, and the file is not confirmed either way', () => {
    const nbsp = '\u00a0';
    for (const dockerfile of [
      // after the line: a CMD that looks continued, then a chmod of its own
      FINAL(COPY_LINE, CLOSE_RUN, `CMD /app/server \\${nbsp}`, 'RUN chmod -R 777 /app'),
      // before the COPY: the COPY would otherwise be read as part of the CMD, and no COPY would be found
      [
        'FROM alpine',
        'WORKDIR /app',
        `CMD /app/server \\${nbsp}`,
        COPY_LINE,
        CLOSE_RUN,
        'USER 1',
        '',
      ].join('\n'),
    ]) {
      const out = init(dockerfile).out;
      expect(out, JSON.stringify(dockerfile)).toContain('cannot confirm');
      expect(out, JSON.stringify(dockerfile)).toContain('not plain text');
    }
  });

  it('reads a continuation that runs into the end of the file as the instruction it is', () => {
    for (const end of ['RUN chmod -R 777 /app \\', 'RUN chmod -R 777 /app \\\n']) {
      const dockerfile = ['FROM alpine', 'WORKDIR /app', COPY_LINE, CLOSE_RUN, end].join('\n');
      const out = init(dockerfile).out;
      expect(out, JSON.stringify(dockerfile)).toContain('cannot confirm');
      expect(out, JSON.stringify(dockerfile)).toContain('line 5 comes after it');
    }
  });

  it('says nothing about a file it cannot read that does not mention native/ at all, and prints for one that does, a stage that is not the last one included', () => {
    expect(hinted('FROM alpine\nRUN cat <<EOF\nx\nEOF\n')).toBe(false);
    expect(hinted('\ufeffFROM alpine\nCOPY server /app/server\n')).toBe(false);
    expect(
      cannotConfirm(
        'FROM alpine AS b\nCOPY native /app/native\nFROM alpine\nRUN cat <<EOF\nx\nEOF\n',
      ),
    ).toBe(true);
    expect(cannotConfirm('\ufeffFROM alpine\nCOPY native /srv/native\n')).toBe(true);
  });
  it('does not confirm a COPY that is another spelling of the scaffolded one, or a line that is not the very next line of the file, and says which', () => {
    for (const copy of [
      'COPY native /app/native',
      'COPY --chown=0:0 native /app/native',
      'COPY --chown=0:0 --chmod=a-w native/ /app/native/',
      'COPY --chown=0:0 --chmod=a-w ./native /app/native',
      'COPY ["native", "/app/native"]',
    ]) {
      const out = init(FINAL(copy, CLOSE_RUN)).out;
      expect(out, copy).toContain('cannot confirm');
      expect(out, copy).toContain('the COPY is not the scaffolded');
      expect(out, copy).not.toMatch(CLAIM);
    }
    // The same text with a space around it is not the same bytes, so deploy does not recognise it.
    for (const dockerfile of [
      FINAL(COPY_LINE, `${CLOSE_RUN} `),
      FINAL(COPY_LINE, `  ${CLOSE_RUN}`),
      FINAL(COPY_LINE, `${CLOSE_RUN}\t`),
      FINAL(`${COPY_LINE} `, CLOSE_RUN),
      FINAL(`  ${COPY_LINE}`, CLOSE_RUN),
    ]) {
      const out = init(dockerfile).out;
      expect(out, JSON.stringify(dockerfile)).toContain('cannot confirm');
      expect(out, JSON.stringify(dockerfile)).not.toMatch(CLAIM);
    }
    for (const between of ['', '# close them', '\n# a\n']) {
      const out = init(FINAL(COPY_LINE, between, CLOSE_RUN)).out;
      expect(out, JSON.stringify(between)).toContain('cannot confirm');
      expect(out, JSON.stringify(between)).toContain('a blank line or a comment sits between');
      expect(out, JSON.stringify(between)).not.toMatch(CLAIM);
    }
  });

  it('never prints what the Dockerfile says: a control character in an instruction after the line does not reach the terminal', () => {
    const out = init(FINAL(COPY_LINE, CLOSE_RUN, '\u001b[31mRUN chmod -R 777 /app\u0007')).out;
    expect(out).toContain('cannot confirm');
    expect(out).not.toContain('\u001b');
    expect(out).not.toContain('\u0007');
    expect(out).not.toContain('chmod -R 777');
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
