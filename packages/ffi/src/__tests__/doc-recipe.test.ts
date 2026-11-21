/**
 * The two recipes the in-process Rust docs page gives a user for a root-owned `native/` tree: a
 * Dockerfile, and the commands for a compiled binary run outside a container. The e2e lane
 * (`.github/workflows/ffi-e2e.yml`) builds and runs them VERBATIM, through
 * `packages/ffi/scripts/doc-recipe.ts`, so a recipe that stops working is a red lane and not a
 * page that is quietly wrong. This file pins what the extractor takes and what the recipes say.
 */

import { afterAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
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

  it('hands the executable, its directory and native/ to root, then removes group and other write', () => {
    expect(script).toContain('sudo chown -R root:root "$APP_DIR"');
    expect(script).toContain('sudo chmod -R go-w "$APP_DIR"');
    expect(script.indexOf('chown')).toBeLessThan(script.indexOf('chmod'));
  });

  it('is a script bash accepts as written (the lane runs it as written)', () => {
    const r = spawnSync('bash', ['-n', '/dev/stdin'], { input: script, encoding: 'utf8' });
    expect(r.status, r.stderr).toBe(0);
  });

  it('does what it says on a directory this user owns, apart from the sudo (the lane runs the real one)', () => {
    // The same two commands without sudo and without root: chmod is the part a plain user can run.
    const dir = emptyDir('recipe');
    const run = script.replace(/sudo chown -R root:root "\$APP_DIR"\n/, '').replace(/sudo /g, '');
    const r = spawnSync('bash', ['-euo', 'pipefail', '-c', `chmod 775 "$APP_DIR"\n${run}`], {
      encoding: 'utf8',
      env: { ...process.env, APP_DIR: dir },
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
