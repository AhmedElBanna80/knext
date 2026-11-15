import { afterAll, describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { run } from '../cli';
import type { DeployHost, PreflightResult } from '../deploy-function';
import { FUNCTION_ENV_LIMITS, parseFunctionEnvFlags } from '../function-env-flags';
import { backendSpecDigest } from '../spec-digest';
import { capture, copyFixtureZone, removeScratchDirs } from './helpers';

/**
 * #2480: `knext deploy function` sets the function container's env, envFrom,
 * volumes and imagePullSecrets. Secrets go by reference only (a Secret name and
 * key), never as a value on the command line.
 */

afterAll(removeScratchDirs);

const IMAGE = `registry.example.com/shop/orders@sha256:${'b'.repeat(64)}`;
const ARGS = ['function', 'orders', '--zone', 'shop', '--image', IMAGE, '--namespace', 'prod'];
const OK: PreflightResult = { verdict: 'ok', reason: 'none', unknownFields: [], stderr: '' };

function host() {
  const crs: string[] = [];
  const h: DeployHost = {
    preflight: (a) => {
      crs.push(readFileSync(a.crPath, 'utf8'));
      return OK;
    },
    apply: () => {},
  };
  return { h, crs };
}

describe('parseFunctionEnvFlags: the CRD shapes', () => {
  it('maps every flag onto its CRD field, in flag order', () => {
    expect(
      parseFunctionEnvFlags({
        env: ['LOG_LEVEL=debug', 'GREETING=a=b'],
        envSecret: ['DATABASE_URL=shop-db/url'],
        envConfigMap: ['REGION=shop-config/region'],
        envFrom: ['secret:shop-extra', 'configmap:shop-flags'],
        volume: [
          'certs:/etc/certs:secret:shop-tls',
          'cfg:/etc/app:configmap:shop-config',
          'scratch:/tmp/work:emptydir',
        ],
        imagePullSecret: ['regcred'],
      }),
    ).toEqual({
      env: [
        { name: 'LOG_LEVEL', value: 'debug' },
        // Only the first '=' splits: the value may contain more.
        { name: 'GREETING', value: 'a=b' },
        { name: 'DATABASE_URL', valueFrom: { secretKeyRef: { name: 'shop-db', key: 'url' } } },
        { name: 'REGION', valueFrom: { configMapKeyRef: { name: 'shop-config', key: 'region' } } },
      ],
      envFrom: [{ secretRef: { name: 'shop-extra' } }, { configMapRef: { name: 'shop-flags' } }],
      volumes: [
        { name: 'certs', mountPath: '/etc/certs', secret: { secretName: 'shop-tls' } },
        { name: 'cfg', mountPath: '/etc/app', configMap: { name: 'shop-config' } },
        { name: 'scratch', mountPath: '/tmp/work', emptyDir: {} },
      ],
      imagePullSecrets: [{ name: 'regcred' }],
    });
  });

  it.each([
    ['--env with no =', { env: ['sk_live_hunter2'] }],
    ['--env with an empty name', { env: ['=hunter2'] }],
    ['--env-secret with no =', { envSecret: ['hunter2'] }],
    ['--env-configmap with no /', { envConfigMap: ['X=hunter2'] }],
  ])('never repeats a malformed %s argument (it may be a bare secret)', (_label, flags) => {
    expect(() => parseFunctionEnvFlags(flags)).toThrow(/not repeated here/);
    try {
      parseFunctionEnvFlags(flags);
    } catch (e) {
      expect((e as Error).message).not.toContain('hunter2');
    }
  });

  it('accepts a URL without a password, and a canonical path', () => {
    expect(
      parseFunctionEnvFlags({ env: ['API_BASE_URL=https://api.example.com/v1'] }).env,
    ).toHaveLength(1);
    expect(parseFunctionEnvFlags({ volume: ['v:/var/run/app:emptydir'] }).volumes).toHaveLength(1);
  });

  it('emits nothing for no flags (the CR stays as before)', () => {
    expect(parseFunctionEnvFlags({})).toEqual({});
  });

  it.each([
    [
      'a secret-looking plain value',
      { env: ['DB_PASSWORD=hunter2'] },
      /--env: DB_PASSWORD looks like a secret.*--env-secret/,
    ],
    ['an API key as a value', { env: ['STRIPE_API_KEY=sk_live_x'] }, /looks like a secret/],
    ['a token as a value', { env: ['GITHUB_TOKEN=ghp_x'] }, /looks like a secret/],
    [
      'a reserved KNEXT_TOKEN_ name',
      { envSecret: ['KNEXT_TOKEN_ISSUER=s/k'] },
      /KNEXT_TOKEN_ are reserved/,
    ],
    ['an invalid env name', { env: ['1BAD=x'] }, /not a valid environment variable name/],
    ['no = in --env', { env: ['LOG_LEVEL'] }, /expected NAME=VALUE/],
    [
      'a Secret ref with no key',
      { envSecret: ['DATABASE_URL=shop-db'] },
      /expected NAME=<Secret>\/<key>/,
    ],
    ['an uppercase Secret name', { envSecret: ['X=Shop/k'] }, /not a valid Secret name/],
    ['the same env name twice', { env: ['A=1'], envSecret: ['A=s/k'] }, /A is set twice/],
    ['an unknown env-from kind', { envFrom: ['vault:x'] }, /secret:<name> or configmap:<name>/],
    ['a relative mount path', { volume: ['v:etc:emptydir'] }, /must be absolute/],
    [
      'the operator mount path',
      { volume: ['v:/var/run/knext:emptydir'] },
      /reserved for operator mounts/,
    ],
    [
      'under the operator mount path',
      { volume: ['v:/var/run/knext/x:emptydir'] },
      /reserved for operator mounts/,
    ],
    ['a Knative-reserved path', { volume: ['v:/dev:emptydir'] }, /reserved by Knative serving/],
    ['a non-canonical path (//)', { volume: ['v://dev/./:emptydir'] }, /must be canonical/],
    [
      'the operator path with a double slash',
      { volume: ['v://var/run/knext:emptydir'] },
      /must be canonical/,
    ],
    [
      'the operator path through ..',
      { volume: ['v:/a/../var/run/knext:emptydir'] },
      /must be canonical/,
    ],
    [
      'the operator path through .',
      { volume: ['v:/./var/run/knext:emptydir'] },
      /must be canonical/,
    ],
    ['a trailing slash', { volume: ['v:/data/:emptydir'] }, /must be canonical/],
    [
      'a URL with a password',
      { env: ['DATABASE_URL=postgres://app:hunter2@db:5432/x'] },
      /URL with a password/,
    ],
    [
      'a URL whose password holds a slash',
      { env: ['DATABASE_URL=postgres://app:pa/ss@db/x'] },
      /URL with a password/,
    ],
    [
      'a URL whose password holds a colon',
      { env: ['DATABASE_URL=postgres://app:pa:ss@db/x'] },
      /URL with a password/,
    ],
    ['exactly /', { volume: ['v:/:emptydir'] }, /reserved by Knative serving/],
    [
      'a DSN as a value',
      { env: ['SENTRY_DSN=https://k@o.ingest.sentry.io/1'] },
      /looks like a secret/,
    ],
    ['an AUTH segment', { env: ['AUTH_HEADER=Bearer x'] }, /looks like a secret/],
    ['a passphrase', { env: ['GPG_PASSPHRASE=x'] }, /looks like a secret/],
    ['an access token run together', { env: ['GH_ACCESSTOKEN=x'] }, /looks like a secret/],
    ['an unknown volume kind', { volume: ['v:/data:hostpath:/x'] }, /expected <name>:<mountPath>/],
    ['emptydir with a source', { volume: ['v:/data:emptydir:x'] }, /expected <name>:<mountPath>/],
    ['a bad volume name', { volume: ['V:/data:emptydir'] }, /must be a DNS label/],
    [
      'the same volume twice',
      { volume: ['v:/a:emptydir', 'v:/b:emptydir'] },
      /volume "v" is set twice/,
    ],
  ])('refuses %s, naming the flag', (_label, flags, msg) => {
    expect(() => parseFunctionEnvFlags(flags)).toThrow(msg);
  });

  it.each([
    ['env', { env: Array.from({ length: FUNCTION_ENV_LIMITS.env + 1 }, (_, i) => `V${i}=x`) }],
    [
      'env-from',
      {
        envFrom: Array.from(
          { length: FUNCTION_ENV_LIMITS.envFrom + 1 },
          (_, i) => `configmap:c${i}`,
        ),
      },
    ],
    [
      'volume',
      {
        volume: Array.from(
          { length: FUNCTION_ENV_LIMITS.volumes + 1 },
          (_, i) => `v${i}:/d${i}:emptydir`,
        ),
      },
    ],
    [
      'image-pull-secret',
      {
        imagePullSecret: Array.from(
          { length: FUNCTION_ENV_LIMITS.imagePullSecrets + 1 },
          (_, i) => `r${i}`,
        ),
      },
    ],
  ])('caps --%s at the CRD limit', (flag, flags) => {
    expect(() => parseFunctionEnvFlags(flags)).toThrow(
      new RegExp(`--${flag}: at most \\d+ allowed`),
    );
  });

  it('accepts exactly the CRD limit (both halves of the bound)', () => {
    const env = Array.from({ length: FUNCTION_ENV_LIMITS.env }, (_, i) => `V${i}=x`);
    expect(parseFunctionEnvFlags({ env }).env).toHaveLength(FUNCTION_ENV_LIMITS.env);
  });
});

describe('knext deploy function: the flags reach the applied CR', () => {
  it('writes env, envFrom, volumes and imagePullSecrets into the BackendService spec', async () => {
    const dir = copyFixtureZone('deploy-env-flags');
    const { h, crs } = host();
    const c = capture();
    const code = await run(
      'deploy',
      [
        ...ARGS,
        '--env',
        'LOG_LEVEL=debug',
        '--env-secret',
        'DATABASE_URL=shop-db/url',
        '--env-from',
        'configmap:shop-flags',
        '--volume',
        'certs:/etc/certs:secret:shop-tls',
        '--image-pull-secret',
        'regcred',
      ],
      { ...c.io, cwd: dir, host: h },
    );
    expect(code, c.err()).toBe(0);
    const spec = JSON.parse(crs[0] as string).spec;
    expect(spec.env).toEqual([
      { name: 'LOG_LEVEL', value: 'debug' },
      { name: 'DATABASE_URL', valueFrom: { secretKeyRef: { name: 'shop-db', key: 'url' } } },
    ]);
    expect(spec.envFrom).toEqual([{ configMapRef: { name: 'shop-flags' } }]);
    expect(spec.volumes).toEqual([
      { name: 'certs', mountPath: '/etc/certs', secret: { secretName: 'shop-tls' } },
    ]);
    expect(spec.imagePullSecrets).toEqual([{ name: 'regcred' }]);
    // The printed spec pin is the digest of the spec that was applied, so it binds the env too.
    expect(c.out()).toContain(backendSpecDigest(spec));
  });

  it('the spec pin moves with --env, and ignores --image-pull-secret (not a hashed field)', async () => {
    const pin = async (extra: string[]) => {
      const { h, crs } = host();
      await run('deploy', [...ARGS, ...extra], {
        ...capture().io,
        cwd: copyFixtureZone('deploy-env-pin'),
        host: h,
      });
      return backendSpecDigest(JSON.parse(crs[0] as string).spec);
    };
    const base = await pin([]);
    expect(await pin(['--env', 'LOG_LEVEL=debug'])).not.toBe(base);
    expect(await pin(['--image-pull-secret', 'regcred'])).toBe(base);
  });

  it('refuses a secret value on the command line before any cluster call', async () => {
    const { h, crs } = host();
    const c = capture();
    const code = await run('deploy', [...ARGS, '--env', 'DB_PASSWORD=hunter2'], {
      ...c.io,
      cwd: copyFixtureZone('deploy-env-refuse'),
      host: h,
    });
    expect(code).toBe(1);
    expect(crs).toEqual([]);
    expect(c.err()).toContain('--env-secret DB_PASSWORD=<secret>/<key>');
    // The refused value is never echoed back.
    expect(c.err()).not.toContain('hunter2');
  });
});
