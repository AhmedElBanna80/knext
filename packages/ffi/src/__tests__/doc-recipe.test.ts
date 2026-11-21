/**
 * The two recipes the in-process Rust docs page gives a user for a root-owned `native/` tree: a
 * Dockerfile, and the commands for a compiled binary run outside a container. The e2e lane
 * (`.github/workflows/ffi-e2e.yml`) builds and runs them VERBATIM, through
 * `packages/ffi/scripts/doc-recipe.ts`, so a recipe that stops working is a red lane and not a
 * page that is quietly wrong. This file pins what the extractor takes and what the recipes say.
 */

import { afterAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
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
  const runScript = (appDir: string, extra: Record<string, string> = {}, text = script) => {
    const sudo = fakeSudo('record');
    const r = spawnSync('bash', ['-euo', 'pipefail', '-c', text], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${sudo.bin}:${process.env.PATH}`, APP_DIR: appDir, ...extra },
    });
    const calls = existsSync(sudo.log) ? readFileSync(sudo.log, 'utf8').trim().split('\n') : [];
    return { r, calls };
  };

  it('hands the executable, its directory and native/ to root, then removes group and other write', () => {
    expect(script).toContain('sudo chown -R root:root "$APP_DIR"');
    expect(script).toContain('sudo chmod -R go-w "$APP_DIR"');
    expect(script.indexOf('chown')).toBeLessThan(script.indexOf('chmod'));
  });

  it('is a script bash accepts as written (the lane runs it as written)', () => {
    const r = spawnSync('bash', ['-n', '/dev/stdin'], { input: script, encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
  });

  it('says that APP_DIR must hold only this app, in the script and on the page', () => {
    expect(script.replace(/\s*\n#\s*/g, ' ')).toContain('and nothing else');
    expect(script).toContain('a directory that holds anything else');
    const flat = page.replace(/\s+/g, ' ');
    expect(flat).toContain('so it must hold only this app (`/opt/<app>`)');
    expect(flat).toContain('and they refuse those');
  });

  it('hands over a directory that holds only an app, and nothing else is ever run', () => {
    for (const dir of [
      '/opt/myapp',
      '/opt/knext-ffi-caller',
      '/srv/app',
      '/var/lib/myapp',
      '/opt/a/b',
    ]) {
      const { r, calls } = runScript(dir);
      expect(r.status, `${dir}: ${r.stderr}`).toBe(0);
      expect(calls, dir).toEqual([`chown -R root:root ${dir}`, `chmod -R go-w ${dir}`]);
    }
  });

  it('refuses a directory that can hold other things, before sudo is ever called: the root, a home directory, /tmp, /opt itself, a system directory, a relative path, nothing at all, a path with a dot component', () => {
    const refused = [
      '/',
      '/opt',
      '/opt/',
      '/root',
      '/tmp',
      '/tmp/x',
      '/tmpfoo',
      '/var/tmp',
      '/var/tmp/app',
      '/var',
      '/srv',
      '/mnt',
      '/media',
      '/home',
      '/home/',
      '/home/me',
      '/home/me/app',
      '/usr',
      '/usr/local/app',
      '/etc',
      '/etc/app',
      '',
      'relative/dir',
      '.',
      './app',
      '/opt/..',
      '/opt/app/..',
      '/opt/../etc',
      '/opt/./app',
      '/opt/.hidden',
    ];
    for (const dir of refused) {
      const { r, calls } = runScript(dir);
      expect(r.status, `${JSON.stringify(dir)} was handed over`).not.toBe(0);
      expect(r.stderr, dir).toContain('refusing');
      expect(calls, `sudo ran for ${JSON.stringify(dir)}`).toEqual([]);
    }
    // $HOME itself, wherever it is (a home directory that is not under /home too).
    const { r, calls } = runScript('/srv/me', { HOME: '/srv/me' });
    expect(r.status).not.toBe(0);
    expect(calls).toEqual([]);
  });

  it('does what it says on a directory this user owns, apart from the sudo and the refusal of temp directories (the lane runs the real one)', () => {
    // The guard refuses /tmp and /home, where a test directory lives on Linux: lift the refusal of
    // them (keeping the one for an empty or relative path), and let sudo run everything but the chown.
    const lifted = script.replace(/^ {2}"" \| .*\)\n/m, '  "" | [!/]*)\n');
    expect(lifted).not.toBe(script);
    const dir = emptyDir('recipe');
    const sudo = fakeSudo('run');
    const r = spawnSync('bash', ['-euo', 'pipefail', '-c', `chmod 775 "$APP_DIR"\n${lifted}`], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${sudo.bin}:${process.env.PATH}`, APP_DIR: dir },
    });
    expect(r.status, r.stderr).toBe(0);
    const mode = Number.parseInt(
      spawnSync(
        'stat',
        [
          process.platform === 'darwin' ? '-f' : '-c',
          process.platform === 'darwin' ? '%Lp' : '%a',
          dir,
        ],
        {
          encoding: 'utf8',
        },
      ).stdout.trim(),
      8,
    );
    expect(mode & 0o022).toBe(0);
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
