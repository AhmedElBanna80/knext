import { afterAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createDeployedBaselineSource, type ServedVersionReader } from '../baseline';
import { parseConfig, serializeConfig } from '../config';
import { runGenerate } from '../generate';
import { capture, copyFixtureZone, removeScratchDirs } from './helpers';

afterAll(removeScratchDirs);

function git(cwd: string, ...args: string[]): void {
  // Isolated from the user's git config: no signing, no hooks, no prompts.
  const r = spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' },
  });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
}

/** A zone in its own git repo whose current contract is tagged `tag`. */
function taggedZone(label: string, tag: string): string {
  const zone = copyFixtureZone(label);
  git(zone, 'init', '-q');
  git(zone, 'add', '-A');
  git(zone, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'contract');
  git(zone, 'tag', tag);
  return zone;
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

describe('deployed:<namespace>/<name> reads the served version from the live BackendService', () => {
  it('a breaking change against the served contract fails generate', async () => {
    const zone = taggedZone('dep-break', 'proto/v1.4.0');
    removeTotalCents(zone);
    const r = reader('1.4.0');
    const c = capture();
    const code = await runGenerate({
      cwd: zone,
      check: true,
      against: 'deployed:shop/orders',
      deployedBaseline: createDeployedBaselineSource({
        cwd: zone,
        protoDir: 'proto',
        reader: r,
        context: 'ctx-a',
      }),
      io: c.io,
    });
    expect(code).toBe(1);
    expect(c.err()).toContain('break the contract against deployed:shop/orders');
    expect(r.asked).toEqual([{ namespace: 'shop', name: 'orders', context: 'ctx-a' }]);
  });

  it('an unchanged contract passes against the served version', async () => {
    const zone = taggedZone('dep-same', 'proto/v1.4.0');
    const c = capture();
    const code = await runGenerate({
      cwd: zone,
      check: true,
      against: 'deployed:shop/orders',
      deployedBaseline: createDeployedBaselineSource({
        cwd: zone,
        protoDir: 'proto',
        reader: reader('1.4.0'),
      }),
      io: c.io,
    });
    expect(c.err()).toBe('');
    expect(code).toBe(0);
  });

  it('resolves to the tagged contract in the repository', async () => {
    const zone = taggedZone('dep-input', 'proto/v2.0.1');
    const source = createDeployedBaselineSource({
      cwd: zone,
      protoDir: 'proto',
      reader: reader('2.0.1'),
    });
    expect(await source.resolve({ namespace: 'shop', name: 'orders' })).toBe(
      '.git#tag=proto/v2.0.1,subdir=proto',
    );
  });

  it('honours a custom tag template', async () => {
    const zone = taggedZone('dep-template', 'orders-contract-3.1.0');
    const source = createDeployedBaselineSource({
      cwd: zone,
      protoDir: 'proto',
      reader: reader('3.1.0'),
      tagTemplate: 'orders-contract-{version}',
    });
    expect(await source.resolve({ namespace: 'shop', name: 'orders' })).toBe(
      '.git#tag=orders-contract-3.1.0,subdir=proto',
    );
  });

  it('fails loudly when the function has no served version yet', async () => {
    const zone = taggedZone('dep-empty', 'proto/v1.4.0');
    const source = createDeployedBaselineSource({
      cwd: zone,
      protoDir: 'proto',
      reader: reader(''),
    });
    await expect(source.resolve({ namespace: 'shop', name: 'orders' })).rejects.toThrow(
      /shop\/orders has no served contract version yet/,
    );
  });

  it('refuses a served version that is not a semantic version', async () => {
    const zone = taggedZone('dep-bad', 'proto/v1.4.0');
    const source = createDeployedBaselineSource({
      cwd: zone,
      protoDir: 'proto',
      reader: reader('1.4.0,subdir=..'),
    });
    await expect(source.resolve({ namespace: 'shop', name: 'orders' })).rejects.toThrow(
      /not a semantic version/,
    );
  });

  it('fails loudly when the tag for the served version does not exist', async () => {
    const zone = taggedZone('dep-notag', 'proto/v1.4.0');
    const source = createDeployedBaselineSource({
      cwd: zone,
      protoDir: 'proto',
      reader: reader('1.5.0'),
    });
    await expect(source.resolve({ namespace: 'shop', name: 'orders' })).rejects.toThrow(
      /serves contract 1\.5\.0, but this repository has no tag proto\/v1\.5\.0/,
    );
  });

  it('a reader failure is reported, never a silent pass', async () => {
    const zone = taggedZone('dep-readfail', 'proto/v1.4.0');
    const source = createDeployedBaselineSource({
      cwd: zone,
      protoDir: 'proto',
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
    const config = parseConfig({ deployedTagTemplate: 'contract-{version}' });
    expect(config.deployedTagTemplate).toBe('contract-{version}');
    expect(parseConfig(JSON.parse(serializeConfig(config))).deployedTagTemplate).toBe(
      'contract-{version}',
    );
  });

  it('refuses a template without {version}, or one that would break the buf input', () => {
    expect(() => parseConfig({ deployedTagTemplate: 'proto/latest' })).toThrow(
      /no \{version\} placeholder/,
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
    git(zone, 'init', '-q');
    git(zone, 'add', '-A');
    git(zone, '-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'contract');
    git(zone, 'tag', 'c-1.0.0');
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
    expect(c.err()).toContain('break the contract against deployed:shop/orders');
  });
});
