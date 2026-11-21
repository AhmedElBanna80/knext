/**
 * The two recipes the in-process Rust docs page gives a user for a root-owned `native/` tree: a
 * Dockerfile, and the commands for a compiled binary run outside a container. The e2e lane
 * (`.github/workflows/ffi-e2e.yml`) builds and runs them VERBATIM, through
 * `packages/ffi/scripts/doc-recipe.ts`, so a recipe that stops working is a red lane and not a
 * page that is quietly wrong. This file pins what the extractor takes and what the recipes say.
 */

import { afterAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DOCS_PAGE, extractRecipe, RECIPES } from '../../scripts/doc-recipe';
import { emptyDir, removeScratchDirs } from './helpers';

afterAll(removeScratchDirs);

const page = readFileSync(DOCS_PAGE, 'utf8');
const fence = (info: string, body: string, indent = '') =>
  `${indent}\`\`\`${info}\n${body
    .split('\n')
    .map((l) => (l === '' ? l : indent + l))
    .join('\n')}\n${indent}\`\`\`\n`;

describe('extractRecipe takes exactly one block, verbatim, and refuses anything else', () => {
  it('returns the body of the block with that title, without the fence or its indentation', () => {
    const mdx = `# t\n\n1. step\n\n${fence('dockerfile title="Dockerfile"', 'FROM x\nRUN y\n\nUSER 1', '   ')}\nafter\n`;
    expect(extractRecipe(mdx, 'Dockerfile')).toBe('FROM x\nRUN y\n\nUSER 1\n');
  });

  it('ignores blocks with another title', () => {
    const mdx =
      fence('bash title="shell"', 'echo no') + fence('bash title="own-binary.sh"', 'echo yes');
    expect(extractRecipe(mdx, 'own-binary.sh')).toBe('echo yes\n');
  });

  it('throws when the page has none, so a renamed block cannot turn the lane step into a no-op', () => {
    expect(() => extractRecipe(fence('bash title="shell"', 'echo no'), 'Dockerfile')).toThrow(
      /found 0/,
    );
  });

  it('throws when the page has two, so the lane cannot run the wrong one', () => {
    const two =
      fence('dockerfile title="Dockerfile"', 'FROM a') +
      fence('dockerfile title="Dockerfile"', 'FROM b');
    expect(() => extractRecipe(two, 'Dockerfile')).toThrow(/found 2/);
  });

  it('throws on a block that is never closed', () => {
    expect(() => extractRecipe('```dockerfile title="Dockerfile"\nFROM a\n', 'Dockerfile')).toThrow(
      /never closed/,
    );
  });
});

describe('the Dockerfile recipe on the docs page', () => {
  const lines = extractRecipe(page, RECIPES.dockerfile)
    .split('\n')
    .filter((l) => l.trim() !== '' && !l.trim().startsWith('#'));
  const at = (re: RegExp) => lines.findIndex((l) => re.test(l));

  it('takes its base image as a build argument, so the lane can build it with the pinned one unchanged', () => {
    expect(lines[0]).toBe('ARG BASE_IMAGE');
    expect(lines[1]).toBe('FROM ${BASE_IMAGE}');
  });

  it('creates the directory that holds native/ before anything is copied into it, as root', () => {
    expect(at(/^WORKDIR \/app$/)).toBe(2);
    expect(at(/^COPY server \/app\/server$/)).toBeGreaterThan(2);
  });

  it('copies native/ root-owned and read-only, beside the executable', () => {
    expect(lines).toContain('COPY --chown=0:0 --chmod=a-w native /app/native');
  });

  it('runs as 65532 only after every copy, and never chowns anything to the app user', () => {
    const user = at(/^USER 65532:65532$/);
    expect(user).toBeGreaterThan(at(/^COPY --chown=0:0 --chmod=a-w native /));
    expect(user).toBeGreaterThan(at(/^COPY server /));
    expect(lines.filter((l) => /\bchown\b/.test(l) && !l.startsWith('COPY --chown=0:0 '))).toEqual(
      [],
    );
    expect(lines.filter((l) => /^COPY /.test(l) && !/--chown=0:0|^COPY server /.test(l))).toEqual(
      [],
    );
  });

  it('starts the executable the loader anchors on', () => {
    expect(lines).toContain('ENTRYPOINT ["/app/server"]');
  });
});

describe('the commands for a compiled binary run outside a container', () => {
  const script = extractRecipe(page, RECIPES.shell);

  /**
   * A `sudo` on the PATH that records what it was asked to run and runs nothing, or (`run`) runs
   * everything but the chown, which a user who is not root cannot do.
   */
  const fakeSudo = (mode: 'record' | 'run') => {
    const bin = emptyDir('fake-sudo');
    const log = join(bin, 'sudo.log');
    writeFileSync(
      join(bin, 'sudo'),
      `#!/bin/sh\necho "$@" >> "${log}"\n${mode === 'run' ? 'case "$1" in chown) exit 0 ;; esac\nexec "$@"\n' : 'exit 0\n'}`,
      { mode: 0o755 },
    );
    return { bin, log };
  };
  /** A HOME that is not a directory, so what is judged is the path and not where the test runs. */
  const NOHOME = join(emptyDir('recipe-home'), 'none');
  const runScript = (appDir: string, extra: Record<string, string> = {}, text = script) => {
    const sudo = fakeSudo('record');
    const r = spawnSync('bash', ['-euo', 'pipefail', '-c', text], {
      encoding: 'utf8',
      env: {
        ...process.env,
        PATH: `${sudo.bin}:${process.env.PATH}`,
        APP_DIR: appDir,
        HOME: NOHOME,
        ...extra,
      },
    });
    const calls = existsSync(sudo.log) ? readFileSync(sudo.log, 'utf8').trim().split('\n') : [];
    return { r, calls };
  };

  /** A directory that is exactly an app: native/ with its manifest, and one executable. */
  const stage = (mutate?: (dir: string) => void): string => {
    const dir = join(emptyDir('recipe-app'), 'app');
    mkdirSync(join(dir, 'native', 'ffi'), { recursive: true });
    writeFileSync(join(dir, 'native', '.integrity.json'), '{}');
    writeFileSync(join(dir, 'native', 'ffi', 'libx.so'), 'x');
    writeFileSync(join(dir, 'server'), 'x', { mode: 0o755 });
    mutate?.(dir);
    return dir;
  };
  /**
   * The script with the places that can hold other things taken off its list of them (the system
   * temporary directory is one, and so is the home directory the CI runner's checkout is under),
   * which is what a directory the test stages needs. One list, replaced once: the rest of the
   * script is the page's.
   */
  const LIST =
    'for d in /tmp /var/tmp /home /Users /root /private/tmp /private/var /private/etc; do';
  const lifted = () => {
    expect(script.split(LIST).length - 1, 'the list of places moved').toBe(1);
    return script.replace(LIST, 'for d in /nonexistent; do');
  };
  /** The functions the script defines, to be run on paths that do not exist here. */
  const definitions = () => {
    const at = script.indexOf('\nif ');
    expect(at, 'no if after the functions').toBeGreaterThan(0);
    return script.slice(0, at);
  };
  /** `unsafe_dir` on the path exactly as given: for a place that does not exist on this machine. */
  const unsafe = (path: string, home = '/') =>
    spawnSync('bash', ['-c', `${definitions()}\nunsafe_dir "$1" "$2"`, '_', path, home], {
      encoding: 'utf8',
    }).status === 0;
  /**
   * `unsafe_dir` on what the script judges: the path after `real_dir` has followed every link, as the
   * script does before it asks. On macOS `/tmp`, `/etc` and `$TMPDIR` come back under `/private`, and
   * a test that skips the resolution judges a path the script never sees.
   */
  const unsafeResolved = (path: string) =>
    spawnSync(
      'bash',
      ['-c', `${definitions()}\nr=$(real_dir "$1") || exit 9\nunsafe_dir "$r" /`, '_', path],
      { encoding: 'utf8' },
    );

  it('hands the real directory, its executable and native/ to root, then removes group and other write', () => {
    expect(script).toContain('sudo chown -R root:root "$R"');
    expect(script).toContain('sudo chmod -R go-w "$R"');
    expect(script.indexOf('chown')).toBeLessThan(script.indexOf('chmod'));
    // The path it changes is the resolved one, not what was typed: `chown -R` on a link changes the link.
    expect(script).not.toContain('"$APP_DIR"\n');
    expect(script).not.toMatch(/\$\{APP_DIR%/);
  });

  it('is a script bash accepts as written (the lane runs it as written)', () => {
    const r = spawnSync('bash', ['-n', '/dev/stdin'], { input: script, encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
  });

  it('says what it checks, in the script and on the page: a real directory holding native/ with its manifest and one executable, and nothing else, that is not a system, home or temporary directory', () => {
    const flat = script.replace(/\s*\n#\s*/g, ' ');
    expect(flat).toContain('and nothing else');
    expect(flat).toContain('after following any link to the real directory');
    expect(flat).toContain('native/ with its .integrity.json');
    expect(flat).toContain('a system, home or temporary directory');
    const pageText = page.replace(/\s+/g, ' ');
    expect(pageText).toContain(
      'they check it first and change nothing unless it is exactly an app: after following a link to the real directory',
    );
    expect(pageText).toContain(
      'it must hold `native/` (with its `.integrity.json`) and one other entry, your executable as a regular file, and nothing else',
    );
    expect(pageText).toContain(
      'and it must not be a system, home or temporary directory (`/`, `/opt` itself, `/tmp`, `/var/lib`, `/dev`, `/run`, `/etc`, a home directory or anything under one, and, on macOS, what `/tmp`, `/etc` and `$TMPDIR` really are under `/private`, and the like)',
    );
    expect(pageText).toContain('`/opt/<app>` and `/usr/local/<app>` pass');
    // It never claims a rule it does not apply.
    expect(pageText).not.toContain('and they refuse those');
  });

  it('hands over a directory that holds only an app, and nothing else is ever run: the path it changes is the real one, however it was written', () => {
    const dir = stage();
    const real = realpathSync(dir);
    const link = join(emptyDir('recipe-link'), 'current');
    symlinkSync(dir, link);
    for (const written of [
      dir,
      `${dir}/`,
      `${dir}//`,
      `${dir}/.`,
      `${dir}/../app`,
      `${dir}/native/..`,
      link,
      `${link}/`,
    ]) {
      const { r, calls } = runScript(written, {}, lifted());
      expect(r.status, `${written}: ${r.stderr}`).toBe(0);
      expect(calls, written).toEqual([`chown -R root:root ${real}`, `chmod -R go-w ${real}`]);
    }
  });

  it('does not judge a directory by where it is when it is not one of the places that can hold other things: the paths an app is installed at pass the list, /usr/local/<app> and /var/lib/<app> among them', () => {
    for (const dir of [
      '/opt/myapp',
      '/opt/knext-ffi-caller',
      '/opt/a/b',
      '/srv/app',
      '/var/lib/myapp',
      '/usr/local/app',
      '/usr/local/myapp',
      '/usr/local/opt/app',
      '/var/www/app',
      '/data/app',
    ]) {
      expect(unsafe(dir), dir).toBe(false);
    }
  });

  it('judges the places that can hold other things as unsafe, whatever is under them: the root, /opt itself, the temporary and home directories, the system directories, /var/lib itself, /dev, /run', () => {
    for (const dir of [
      '/',
      '/opt',
      '/srv',
      '/mnt',
      '/media',
      '/nix',
      '/snap',
      '/usr',
      '/usr/local',
      '/usr/local/bin',
      '/usr/local/lib',
      '/usr/local/sbin',
      '/usr/local/share',
      '/var',
      '/var/cache',
      '/var/lib',
      '/var/log',
      '/var/spool',
      '/var/www',
      '/dev',
      '/dev/shm',
      '/run',
      '/run/user/1000',
      '/proc',
      '/proc/self',
      '/sys',
      '/boot',
      '/etc',
      '/etc/app',
      '/bin',
      '/sbin',
      '/lib',
      '/lib64',
      '/usr/bin',
      '/usr/bin/app',
      '/usr/sbin',
      '/usr/lib',
      '/usr/lib/app',
      '/usr/libexec',
      '/usr/share',
      '/tmp',
      '/tmp/x',
      '/var/tmp',
      '/var/tmp/app',
      '/home',
      '/home/me',
      '/home/me/app',
      '/Users',
      '/Users/me/app',
      '/root',
      '/root/app',
      // What /tmp, /var/tmp, /etc and $TMPDIR are on macOS, once a link is followed.
      '/private/tmp',
      '/private/tmp/x',
      '/private/var',
      '/private/var/tmp',
      '/private/var/folders/g0/abc/T/app',
      '/private/var/db/app',
      '/private/etc',
      '/private/etc/app',
    ]) {
      expect(unsafe(dir), dir).toBe(true);
    }
    // $HOME itself, a directory under it, and every directory above it, wherever it is.
    expect(unsafe('/data/me', '/data/me')).toBe(true);
    expect(unsafe('/data/me/app', '/data/me')).toBe(true);
    expect(unsafe('/data', '/data/me')).toBe(true);
    expect(unsafe('/data/other', '/data/me')).toBe(false);
    expect(unsafe('/data/me2', '/data/me')).toBe(false);
  });

  it('judges a place by where it really is: /tmp, /var/tmp, /etc and the temporary directory are unsafe after the links are followed (macOS: under /private), and a directory staged in the temporary directory is refused for that', () => {
    for (const written of ['/tmp', '/var/tmp', '/etc', tmpdir(), process.env.TMPDIR ?? '/tmp']) {
      const r = unsafeResolved(written);
      expect(r.status, `${written} resolves to something the list lets through: ${r.stderr}`).toBe(
        0,
      );
    }
    // The whole script, nothing lifted: a real directory made in the temporary directory is an app
    // by every other test, and is refused here because of where it is.
    const dir = stage();
    const { r, calls } = runScript(dir);
    expect(r.status, `${dir} was handed over`).not.toBe(0);
    expect(r.stderr).toContain('system, home or temporary directory');
    expect(calls).toEqual([]);
  });

  it('resolves a path before it is judged, so what is written cannot hide where it goes: a doubled slash, a trailing one, a dot component, a link', () => {
    const real = (p: string) =>
      spawnSync('bash', ['-c', `${definitions()}\nreal_dir "$1"`, '_', p], { encoding: 'utf8' });
    const one = real('/tmp');
    expect(one.status, one.stderr).toBe(0);
    // Whatever the number of slashes at the front (a shell keeps `//` there), one comes out.
    for (const written of [
      '//tmp',
      '///tmp',
      '/tmp/',
      '/tmp//',
      '/tmp/.',
      '/tmp/../tmp',
      '/./tmp',
    ]) {
      const r = real(written);
      expect(r.stdout, written).toBe(one.stdout);
      expect(r.stdout.startsWith('//'), written).toBe(false);
    }
    expect(real('//').stdout).toBe('/\n');
    expect(real('///').stdout).toBe('/\n');
    // It fails for a path that is not a directory that exists.
    expect(real('/nonexistent-dir-for-test').status).not.toBe(0);
    expect(real(import.meta.path).status).not.toBe(0);
  });

  it('refuses a directory that can hold other things, before sudo is ever called, however it is spelled: the root, a home directory, /tmp, /opt itself (and /opt// and /opt/ with an empty name after it), a system directory, a link to one, a relative path, nothing at all', () => {
    const toRoot = join(emptyDir('recipe-toroot'), 'root');
    symlinkSync('/', toRoot);
    const toEtc = join(emptyDir('recipe-toetc'), 'etc');
    symlinkSync('/etc', toEtc);
    const refused = [
      '/',
      '//',
      '///',
      '/opt',
      '/opt/',
      '/opt//', // /opt/$NAME with NAME empty, and a doubled slash
      '/usr/local/', // /usr/local/$NAME with NAME empty
      '/root',
      '/tmp',
      '/tmp/x',
      '/tmpfoo',
      '/var/tmp',
      '/var/tmp/app',
      '/var',
      '/var/lib',
      '/var/lib/',
      '/var/www',
      '/run',
      '/dev',
      '/dev/shm',
      '/proc',
      '/sys',
      '/boot',
      '/nix',
      '/srv',
      '/mnt',
      '/media',
      '/home',
      '/home/',
      '/home/me',
      '//home/me',
      '/home/me/app',
      '//home/me/app',
      '/usr',
      '/usr/local',
      '/usr/bin',
      '/etc',
      '/etc/app',
      toRoot,
      `${toRoot}/`,
      toEtc,
      '',
      'relative/dir',
      '.',
      './app',
      '/opt/..',
      '/opt/app/..',
      '/opt/../etc',
      '/opt/./app',
      '/opt/.hidden',
      '/nonexistent/app',
    ];
    for (const dir of refused) {
      const { r, calls } = runScript(dir);
      expect(r.status, `${JSON.stringify(dir)} was handed over`).not.toBe(0);
      expect(r.stderr, dir).toContain('refusing');
      expect(calls, `sudo ran for ${JSON.stringify(dir)}`).toEqual([]);
    }
    // $HOME itself, wherever it is (a home directory that is not under /home too), a directory under
    // it and a directory above it.
    const app = stage();
    const home = realpathSync(app);
    for (const dir of [app, join(app, 'native'), join(app, '..')]) {
      const { r, calls } = runScript(dir, { HOME: home }, lifted());
      expect(r.status, dir).not.toBe(0);
      expect(r.stderr, dir).toContain('system, home or temporary directory');
      expect(calls).toEqual([]);
    }
  });

  it('says why it refuses, each time with the reason that applies: not absolute, not a directory that exists, a system, home or temporary directory, not exactly an app', () => {
    const reason = (dir: string, text = script) => {
      const { r, calls } = runScript(dir, {}, text);
      expect(r.status, dir).not.toBe(0);
      expect(calls, dir).toEqual([]);
      return r.stderr;
    };
    expect(reason('')).toContain('refusing: APP_DIR must be an absolute path, such as /opt/myapp');
    expect(reason('opt/myapp')).toContain('must be an absolute path');
    expect(reason('/nonexistent/app')).toContain(
      'refusing: /nonexistent/app is not a directory that exists',
    );
    expect(reason('/')).toMatch(/refusing: \/ is a system, home or temporary directory/);
    const stray = stage((d) => writeFileSync(join(d, 'notes.txt'), 'x'));
    expect(reason(stray, lifted())).toMatch(/refusing: .*\/app must hold only this app/);
  });

  it('refuses a directory that holds anything but native/ (with its manifest) and one executable, and says so: a stray file, a hidden one, a directory, a second executable, no executable, a link where native/, the manifest or the executable should be', () => {
    const cases: [string, (dir: string) => void][] = [
      ['a stray file', (d) => writeFileSync(join(d, 'notes.txt'), 'x')],
      ['a hidden file', (d) => writeFileSync(join(d, '.env'), 'x')],
      ['a file whose name starts with two dots', (d) => writeFileSync(join(d, '..x'), 'x')],
      [
        'a link that points nowhere',
        (d) => symlinkSync('/nonexistent-target', join(d, '.dangling')),
      ],
      ['a stray directory', (d) => mkdirSync(join(d, 'data'))],
      ['a second executable', (d) => writeFileSync(join(d, 'worker'), 'x', { mode: 0o755 })],
      ['no executable', (d) => rmSync(join(d, 'server'))],
      [
        'an empty directory',
        (d) => {
          rmSync(d, { recursive: true, force: true });
          mkdirSync(d);
        },
      ],
      ['no native/', (d) => rmSync(join(d, 'native'), { recursive: true })],
      ['no manifest', (d) => rmSync(join(d, 'native', '.integrity.json'))],
      [
        'a link for the manifest',
        (d) => {
          rmSync(join(d, 'native', '.integrity.json'));
          writeFileSync(join(d, 'elsewhere.json'), '{}');
          symlinkSync('../elsewhere.json', join(d, 'native', '.integrity.json'));
          rmSync(join(d, 'server'));
        },
      ],
      [
        'a link for native/',
        (d) => {
          const real = join(d, '..', 'real-native');
          renameSync(join(d, 'native'), real);
          symlinkSync(real, join(d, 'native'));
        },
      ],
      [
        'a link for the executable',
        (d) => {
          rmSync(join(d, 'server'));
          symlinkSync('/bin/sh', join(d, 'server'));
        },
      ],
      [
        'a directory for the executable',
        (d) => {
          rmSync(join(d, 'server'));
          mkdirSync(join(d, 'server'));
        },
      ],
      [
        'a manifest that is a directory',
        (d) => {
          rmSync(join(d, 'native', '.integrity.json'));
          mkdirSync(join(d, 'native', '.integrity.json'));
        },
      ],
    ];
    for (const [what, mutate] of cases) {
      const dir = stage(mutate);
      const { r, calls } = runScript(dir, {}, lifted());
      expect(r.status, `${what} was handed over`).not.toBe(0);
      expect(r.stderr, what).toContain('must hold only this app');
      expect(r.stderr, what).toContain(
        'native/ (with its .integrity.json) and your one executable',
      );
      expect(calls, `sudo ran for ${what}`).toEqual([]);
    }
    // The control: the same staging, with nothing wrong, is handed over.
    const ok = runScript(stage(), {}, lifted());
    expect(ok.r.status, ok.r.stderr).toBe(0);
    expect(ok.calls.length).toBe(2);
  });

  it('does what it says on a directory this user owns, apart from the sudo and the refusal of the places that can hold other things (the lane runs the real one)', () => {
    // The guard refuses the temp directory and /home, where a test directory lives on Linux: take
    // those off its list, and let sudo run everything but the chown.
    const dir = stage((d) => {
      chmodSync(d, 0o775);
      chmodSync(join(d, 'native'), 0o775);
      chmodSync(join(d, 'server'), 0o775);
    });
    const sudo = fakeSudo('run');
    const r = spawnSync('bash', ['-euo', 'pipefail', '-c', lifted()], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${sudo.bin}:${process.env.PATH}`, APP_DIR: dir, HOME: NOHOME },
    });
    expect(r.status, r.stderr).toBe(0);
    for (const path of [dir, join(dir, 'native'), join(dir, 'server')]) {
      const mode = Number.parseInt(
        spawnSync(
          'stat',
          [
            process.platform === 'darwin' ? '-f' : '-c',
            process.platform === 'darwin' ? '%Lp' : '%a',
            path,
          ],
          { encoding: 'utf8' },
        ).stdout.trim(),
        8,
      );
      expect(mode & 0o022, path).toBe(0);
    }
  });

  /** The shells on this machine that are not bash (a `sh` that is bash is not one), by the name they are run as. */
  const otherShells = () =>
    ['dash', 'zsh', 'ksh', 'ash', 'busybox'].filter(
      (sh) =>
        spawnSync(sh, ['-c', 'echo "${BASH_VERSION:-none}"'], {
          encoding: 'utf8',
        }).stdout?.trim() === 'none',
    );

  it('refuses under any shell that is not bash, before it looks at anything: a directory that holds a hidden file would otherwise pass for one that holds only the app', () => {
    const shells = otherShells();
    expect(shells.length, 'no shell but bash on this machine to try').toBeGreaterThan(0);
    // An app that is exactly one, plus a hidden .env: the one thing only a listing that sees dotfiles refuses.
    const dir = stage((d) => writeFileSync(join(d, '.env'), 'x'));
    for (const sh of shells) {
      const sudo = fakeSudo('record');
      const r = spawnSync(sh, ['-c', lifted()], {
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `${sudo.bin}:${process.env.PATH}`,
          APP_DIR: dir,
          HOME: NOHOME,
        },
      });
      expect(r.status, `${sh}: ${r.stderr}`).not.toBe(0);
      expect(r.stderr, sh).toContain('needs bash');
      expect(existsSync(sudo.log), `sudo ran under ${sh}`).toBe(false);
    }
  });

  it('lists every entry without a bash option: a hidden file is seen by the same script run by bash in posix mode, where shopt is no help', () => {
    const dir = stage((d) => writeFileSync(join(d, '.env'), 'x'));
    const sudo = fakeSudo('record');
    const r = spawnSync('bash', ['--posix', '-c', lifted()], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${sudo.bin}:${process.env.PATH}`, APP_DIR: dir, HOME: NOHOME },
    });
    expect(r.status, r.stderr).not.toBe(0);
    expect(r.stderr).toContain('must hold only this app');
    expect(existsSync(sudo.log)).toBe(false);
    expect(script).not.toContain('shopt');
  });

  it('says on the page that the commands need bash', () => {
    expect(page.replace(/\s+/g, ' ')).toContain(
      'The commands need bash: run under `sh`, `dash` or `zsh` they refuse before they look at anything.',
    );
    expect(script).toContain('${BASH_VERSION:-}');
  });

  it('does not rely on `set -e` to stop: pasted into a shell that has none, a refusal runs nothing after it, and no glob option is left on', () => {
    const r = spawnSync('bash', ['-c', `${script}\necho "after: $?"; shopt nullglob dotglob`], {
      encoding: 'utf8',
      env: {
        ...process.env,
        APP_DIR: '/',
        HOME: NOHOME,
        PATH: `${fakeSudo('record').bin}:${process.env.PATH}`,
      },
    });
    expect(r.stderr).toContain('refusing');
    expect(r.stdout).not.toContain('chown');
    expect(r.stdout).toMatch(/after: [1-9]/);
    expect(r.stdout).toMatch(/nullglob\s+off/);
    expect(r.stdout).toMatch(/dotglob\s+off/);
  });
});

describe('the CLI', () => {
  it('writes the block to a file, verbatim', () => {
    const dir = emptyDir('recipe-cli');
    const out = join(dir, 'Dockerfile');
    const r = spawnSync(
      process.execPath,
      [join(import.meta.dir, '..', '..', 'scripts', 'doc-recipe.ts'), 'dockerfile', out],
      { encoding: 'utf8' },
    );
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(out, 'utf8')).toBe(extractRecipe(page, RECIPES.dockerfile));
  });

  it('exits non-zero on an unknown recipe', () => {
    const r = spawnSync(
      process.execPath,
      [join(import.meta.dir, '..', '..', 'scripts', 'doc-recipe.ts'), 'nope', '/dev/null'],
      { encoding: 'utf8' },
    );
    expect(r.status).not.toBe(0);
  });
});
