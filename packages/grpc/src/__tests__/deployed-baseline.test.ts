import { afterAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createDeployedBaselineSource, type ServedVersionReader } from '../baseline';
import { parseConfig, serializeConfig } from '../config';
import { runGenerate } from '../generate';
import { capture, copyFixtureZone, emptyDir, removeScratchDirs } from './helpers';

afterAll(removeScratchDirs);

function git(cwd: string, ...args: string[]): void {
  // Isolated from the user's git config: no signing, no hooks, no prompts.
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...args], {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
}

/** Commit everything in `repo` and tag it. */
function commitAndTag(repo: string, tag: string): void {
  git(repo, 'init', '-q');
  git(repo, 'add', '-A');
  git(repo, 'commit', '-qm', 'contract');
  git(repo, 'tag', tag);
}

/** A zone that is its own git repo, its current contract tagged `tag`. */
function taggedZone(label: string, tag: string): string {
  const zone = copyFixtureZone(label);
  commitAndTag(zone, tag);
  return zone;
}

/** A repo holding the zone two levels down (apps/web), tagged `tag`. */
function nestedZone(label: string, tag: string): { repo: string; zone: string } {
  const repo = emptyDir(label);
  const zone = join(repo, 'apps', 'web');
  mkdirSync(join(repo, 'apps'), { recursive: true });
  cpSync(copyFixtureZone(`${label}-src`), zone, { recursive: true });
  writeFileSync(join(repo, 'README.md'), 'repo root\n');
  commitAndTag(repo, tag);
  return { repo, zone };
}

function removeTotalCents(zone: string): void {
  const proto = join(zone, 'proto/orders/v1/orders.proto');
  const before = readFileSync(proto, 'utf8');
  const after = before.replace('  int64 total_cents = 3;\n', '');
  expect(after).not.toBe(before);
  writeFileSync(proto, after);
}

/** A reader that answers with `version` and records what it was asked. */
function reader(version: string): ServedVersionReader & { asked: unknown[] } {
  const asked: unknown[] = [];
  return {
    asked,
    readServedProtoVersion(args) {
      asked.push(args);
      return version;
    },
  };
}

function gitDirOf(repo: string): string {
  return join(realpathSync(repo), '.git');
}

describe('deployed:<namespace>/<name> reads the served version from the live BackendService', () => {
  it('a breaking change against the served contract fails generate, naming the removed field', async () => {
    const zone = taggedZone('dep-break', 'proto/v1.4.0');
    removeTotalCents(zone);
    const r = reader('1.4.0');
    const c = capture();
    const code = await runGenerate({
      cwd: zone,
      check: true,
      against: 'deployed:shop/orders',
      deployedBaseline: createDeployedBaselineSource({ cwd: zone, reader: r, context: 'ctx-a' }),
      io: c.io,
    });
    expect(code).toBe(1);
    expect(c.err()).toContain('break the contract against deployed:shop/orders');
    // buf's own finding, so a baseline that failed to resolve cannot pass for a contract break.
    expect(c.err()).toContain('total_cents');
    expect(r.asked).toEqual([{ namespace: 'shop', name: 'orders', context: 'ctx-a' }]);
  });

  it('an unchanged contract passes against the served version', async () => {
    const zone = taggedZone('dep-same', 'proto/v1.4.0');
    const c = capture();
    const code = await runGenerate({
      cwd: zone,
      check: true,
      against: 'deployed:shop/orders',
      deployedBaseline: createDeployedBaselineSource({ cwd: zone, reader: reader('1.4.0') }),
      io: c.io,
    });
    expect(c.err()).toBe('');
    expect(code).toBe(0);
  });

  it('resolves to the tagged contract through an absolute git directory', async () => {
    const zone = taggedZone('dep-input', 'proto/v2.0.1');
    const source = createDeployedBaselineSource({ cwd: zone, reader: reader('2.0.1') });
    expect(await source.resolve({ namespace: 'shop', name: 'orders' })).toBe(
      `${gitDirOf(zone)}#format=git,tag=proto/v2.0.1`,
    );
  });

  it('a zone below the repository root compares the same workspace, as subdir', async () => {
    const { repo, zone } = nestedZone('dep-nested', 'proto/v1.4.0');
    const source = createDeployedBaselineSource({ cwd: zone, reader: reader('1.4.0') });
    expect(await source.resolve({ namespace: 'shop', name: 'orders' })).toBe(
      `${gitDirOf(repo)}#format=git,tag=proto/v1.4.0,subdir=apps/web`,
    );
    removeTotalCents(zone);
    const c = capture();
    expect(
      await runGenerate({
        cwd: zone,
        check: true,
        against: 'deployed:shop/orders',
        servedVersionReader: reader('1.4.0'),
        io: c.io,
      }),
    ).toBe(1);
    expect(c.err()).toContain('total_cents');
  });

  it('works from a git worktree (the .git there is a file)', async () => {
    const zone = taggedZone('dep-wt', 'proto/v1.4.0');
    const wt = join(emptyDir('dep-wt-tree'), 'tree');
    git(zone, 'worktree', 'add', '-q', '--detach', wt);
    const source = createDeployedBaselineSource({ cwd: wt, reader: reader('1.4.0') });
    expect(await source.resolve({ namespace: 'shop', name: 'orders' })).toBe(
      `${gitDirOf(zone)}#format=git,tag=proto/v1.4.0`,
    );
    removeTotalCents(wt);
    const c = capture();
    expect(
      await runGenerate({
        cwd: wt,
        check: true,
        against: 'deployed:shop/orders',
        servedVersionReader: reader('1.4.0'),
        io: c.io,
      }),
    ).toBe(1);
    expect(c.err()).toContain('total_cents');
  });

  it('works with a git dir that does not end in .git (--separate-git-dir)', async () => {
    const zone = copyFixtureZone('dep-sep');
    const gitDir = join(emptyDir('dep-sep-git'), 'store');
    git(zone, 'init', '-q', `--separate-git-dir=${gitDir}`);
    git(zone, 'add', '-A');
    git(zone, 'commit', '-qm', 'contract');
    git(zone, 'tag', 'proto/v1.4.0');
    const source = createDeployedBaselineSource({ cwd: zone, reader: reader('1.4.0') });
    expect(await source.resolve({ namespace: 'shop', name: 'orders' })).toBe(
      `${realpathSync(gitDir)}#format=git,tag=proto/v1.4.0`,
    );
    removeTotalCents(zone);
    const c = capture();
    expect(
      await runGenerate({
        cwd: zone,
        check: true,
        against: 'deployed:shop/orders',
        servedVersionReader: reader('1.4.0'),
        io: c.io,
      }),
    ).toBe(1);
    expect(c.err()).toContain('total_cents');
  });

  it('refuses a function name that would carry buf options into the tag', async () => {
    const zone = taggedZone('dep-nameinject', 'proto/v1.4.0');
    const source = createDeployedBaselineSource({
      cwd: zone,
      reader: reader('1.4.0'),
      tagTemplate: '{name}-{version}',
    });
    await expect(source.resolve({ namespace: 'shop', name: 'x,format=dir' })).rejects.toThrow(
      /tag "x,format=dir-1\.4\.0" contains a comma/,
    );
  });

  it('honours a custom tag template, with the function name', async () => {
    const zone = taggedZone('dep-template', 'orders-contract-3.1.0');
    const source = createDeployedBaselineSource({
      cwd: zone,
      reader: reader('3.1.0'),
      tagTemplate: '{name}-contract-{version}',
    });
    expect(await source.resolve({ namespace: 'shop', name: 'orders' })).toBe(
      `${gitDirOf(zone)}#format=git,tag=orders-contract-3.1.0`,
    );
  });

  it('refuses a rendered tag that is not a valid git ref name', async () => {
    const zone = taggedZone('dep-badref', 'proto/v1.4.0');
    const source = createDeployedBaselineSource({
      cwd: zone,
      reader: reader('1.4.0'),
      tagTemplate: 'proto..v{version}',
    });
    await expect(source.resolve({ namespace: 'shop', name: 'orders' })).rejects.toThrow(
      /"proto\.\.v1\.4\.0" .* is not a valid git tag name/,
    );
  });

  it('fails loudly when the function has no served version, naming every cause', async () => {
    const zone = taggedZone('dep-empty', 'proto/v1.4.0');
    const source = createDeployedBaselineSource({ cwd: zone, reader: reader('') });
    const err = (await source
      .resolve({ namespace: 'shop', name: 'orders' })
      .catch((e: unknown) => e)) as Error;
    expect(err.message).toContain('shop/orders reports no served contract version');
    expect(err.message).toContain('--proto-version');
    expect(err.message).toContain('refused');
    expect(err.message).toContain('predates the field');
  });

  it('refuses a served version that is not a semantic version', async () => {
    const zone = taggedZone('dep-bad', 'proto/v1.4.0');
    const source = createDeployedBaselineSource({ cwd: zone, reader: reader('1.4.0,subdir=..') });
    await expect(source.resolve({ namespace: 'shop', name: 'orders' })).rejects.toThrow(
      /not a semantic version/,
    );
  });

  it('fails loudly when the tag for the served version does not exist', async () => {
    const zone = taggedZone('dep-notag', 'proto/v1.4.0');
    const source = createDeployedBaselineSource({ cwd: zone, reader: reader('1.5.0') });
    await expect(source.resolve({ namespace: 'shop', name: 'orders' })).rejects.toThrow(
      /serves contract 1\.5\.0, but this repository has no tag proto\/v1\.5\.0/,
    );
  });

  it('fails loudly outside a git repository', async () => {
    const zone = copyFixtureZone('dep-nogit');
    const source = createDeployedBaselineSource({ cwd: zone, reader: reader('1.4.0') });
    await expect(source.resolve({ namespace: 'shop', name: 'orders' })).rejects.toThrow(
      /is not inside a git repository/,
    );
  });

  it('refuses a workspace path buf cannot carry', async () => {
    const { zone } = nestedZone('dep-comma', 'proto/v1.4.0');
    const odd = join(zone, '..', 'we,b');
    cpSync(zone, odd, { recursive: true });
    const source = createDeployedBaselineSource({ cwd: odd, reader: reader('1.4.0') });
    await expect(source.resolve({ namespace: 'shop', name: 'orders' })).rejects.toThrow(
      /workspace path "apps\/we,b" contains a comma/,
    );
  });

  it('reports a missing git as such', async () => {
    const zone = taggedZone('dep-nogitbin', 'proto/v1.4.0');
    const source = createDeployedBaselineSource({ cwd: zone, reader: reader('1.4.0') });
    const prev = process.env.PATH;
    process.env.PATH = emptyDir('dep-emptypath');
    try {
      await expect(source.resolve({ namespace: 'shop', name: 'orders' })).rejects.toThrow(
        /needs git, which could not be run/,
      );
    } finally {
      process.env.PATH = prev;
    }
  });

  it('reports a git too old for --path-format as such', async () => {
    const zone = taggedZone('dep-oldgit', 'proto/v1.4.0');
    const realGit = spawnSync('which', ['git'], { encoding: 'utf8' }).stdout.trim();
    const bin = emptyDir('dep-oldgit-bin');
    // git before 2.31 echoes the unknown --path-format option back and exits 0.
    writeFileSync(
      join(bin, 'git'),
      `#!/bin/sh\ncase "$*" in *--path-format=absolute*) echo --path-format=absolute; echo .git; exit 0;; esac\nexec ${realGit} "$@"\n`,
    );
    chmodSync(join(bin, 'git'), 0o755);
    const source = createDeployedBaselineSource({ cwd: zone, reader: reader('1.4.0') });
    const prev = process.env.PATH;
    process.env.PATH = `${bin}:${prev}`;
    try {
      await expect(source.resolve({ namespace: 'shop', name: 'orders' })).rejects.toThrow(
        /needs git 2\.31 or newer/,
      );
    } finally {
      process.env.PATH = prev;
    }
  });

  it('a reader failure is reported, never a silent pass', async () => {
    const zone = taggedZone('dep-readfail', 'proto/v1.4.0');
    const source = createDeployedBaselineSource({
      cwd: zone,
      reader: {
        readServedProtoVersion() {
          throw new Error('backendservices.apps.kn-next.dev "orders" not found');
        },
      },
    });
    await expect(source.resolve({ namespace: 'shop', name: 'orders' })).rejects.toThrow(
      /could not read the served contract version of shop\/orders: .*not found/,
    );
  });
});

describe('knext.grpc.json "deployedTagTemplate"', () => {
  it('is optional and survives a rewrite', () => {
    expect(parseConfig({}).deployedTagTemplate).toBeUndefined();
    const config = parseConfig({ deployedTagTemplate: '{name}-{version}' });
    expect(config.deployedTagTemplate).toBe('{name}-{version}');
    expect(parseConfig(JSON.parse(serializeConfig(config))).deployedTagTemplate).toBe(
      '{name}-{version}',
    );
  });

  it('refuses a template without exactly one {version}, an unknown placeholder, or one that would break the buf input', () => {
    expect(() => parseConfig({ deployedTagTemplate: 'proto/latest' })).toThrow(
      /\{version\} exactly once/,
    );
    expect(() => parseConfig({ deployedTagTemplate: 'v{version}-{version}' })).toThrow(
      /\{version\} exactly once/,
    );
    expect(() => parseConfig({ deployedTagTemplate: '{zone}/v{version}' })).toThrow(
      /only the \{version\} and \{name\} placeholders/,
    );
    expect(() => parseConfig({ deployedTagTemplate: 'v{version},subdir=..' })).toThrow(
      /comma, # or whitespace/,
    );
    expect(() => parseConfig({ deployedTagTemplate: 3 })).toThrow(/must be a string/);
  });

  it('generate uses the configured template for a deployed: baseline', async () => {
    const zone = copyFixtureZone('dep-config');
    const cfg = join(zone, 'knext.grpc.json');
    writeFileSync(
      cfg,
      JSON.stringify({
        ...JSON.parse(readFileSync(cfg, 'utf8')),
        deployedTagTemplate: 'c-{version}',
      }),
    );
    commitAndTag(zone, 'c-1.0.0');
    removeTotalCents(zone);
    const c = capture();
    expect(
      await runGenerate({
        cwd: zone,
        check: true,
        against: 'deployed:shop/orders',
        servedVersionReader: reader('1.0.0'),
        io: c.io,
      }),
    ).toBe(1);
    expect(c.err()).toContain('total_cents');
  });
});
