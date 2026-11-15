/**
 * The `knext deploy function` flags for the function container's environment,
 * volumes and registry pull Secrets, parsed into the `BackendService` CRD's
 * shapes (`packages/kn-next-operator/api/v1alpha1/backendservice_types.go`).
 *
 * Secrets go by REFERENCE only: a flag names a Secret (and a key), never a
 * value, so no secret ever lands in shell history, a process list or a CI log.
 * `--env NAME=VALUE` carries a plain value and is meant for non-secret settings.
 *
 * The checks mirror the CRD's limits (item counts, reserved names and paths) so
 * a bad flag fails here, before the server-side dry run, with a message that
 * names the flag. The operator still enforces its Secret allowlist (a Secret
 * must be the zone's database Secret or marked as the zone's); that is decided
 * against the cluster and cannot be checked here.
 *
 * Pure: no I/O.
 */
import { GrpcUsageError } from './config';

export interface FunctionEnvVar {
  readonly name: string;
  readonly value?: string;
  readonly valueFrom?: {
    readonly secretKeyRef?: { readonly name: string; readonly key: string };
    readonly configMapKeyRef?: { readonly name: string; readonly key: string };
  };
}

export interface FunctionEnvFromSource {
  readonly secretRef?: { readonly name: string };
  readonly configMapRef?: { readonly name: string };
}

export interface FunctionVolumeInput {
  readonly name: string;
  readonly mountPath: string;
  readonly secret?: { readonly secretName: string };
  readonly configMap?: { readonly name: string };
  readonly emptyDir?: Record<string, never>;
}

export interface FunctionEnvFlags {
  readonly env?: readonly string[];
  readonly envSecret?: readonly string[];
  readonly envConfigMap?: readonly string[];
  readonly envFrom?: readonly string[];
  readonly volume?: readonly string[];
  readonly imagePullSecret?: readonly string[];
}

export interface FunctionEnvSpec {
  readonly env?: readonly FunctionEnvVar[];
  readonly envFrom?: readonly FunctionEnvFromSource[];
  readonly volumes?: readonly FunctionVolumeInput[];
  readonly imagePullSecrets?: readonly { readonly name: string }[];
}

/** The CRD's MaxItems for each list (backendservice_types.go). */
export const FUNCTION_ENV_LIMITS = {
  env: 128,
  envFrom: 16,
  volumes: 16,
  imagePullSecrets: 8,
} as const;

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const DNS_LABEL = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?$/;
// A DNS subdomain (RFC 1123), the shape Kubernetes requires of Secret and ConfigMap names.
const DNS_SUBDOMAIN = /^[a-z0-9]([-a-z0-9]*[a-z0-9])?(\.[a-z0-9]([-a-z0-9]*[a-z0-9])?)*$/;
// A Secret or ConfigMap data key.
const DATA_KEY = /^[-._a-zA-Z0-9]+$/;
const RESERVED_ENV_PREFIX = 'KNEXT_TOKEN_';
// A plain `--env` value whose name says it is a secret is refused: the value
// would sit in shell history and the process list. `--env-secret` takes a
// reference instead.
//
// A GUARD, not a guarantee: it catches the common names, and it over-blocks
// harmless ones (TOKEN_TTL, MAX_TOKENS, AUTH_URL, TLS_CERT_FILE,
// CACHE_KEY_PREFIX, SECRET_NAME), which `--env-configmap` sets instead. A name
// is refused when it CONTAINS one of the words, or has one of the short
// segments as a whole `_`-separated part.
const SECRET_WORDS =
  /SECRET|PASSWORD|PASSWD|PASSPHRASE|TOKEN|CREDENTIAL|APIKEY|API_KEY|PRIVATE_KEY|PRIVATEKEY|ACCESS_KEY|ACCESSKEY/i;
const SECRET_SEGMENTS = new Set(['PASS', 'PWD', 'AUTH', 'KEY', 'DSN', 'CERT']);
function secretLike(name: string): boolean {
  return (
    SECRET_WORDS.test(name) ||
    name
      .toUpperCase()
      .split('_')
      .some((seg) => SECRET_SEGMENTS.has(seg))
  );
}
// A URL that carries a password in its userinfo (`scheme://user:pass@host`),
// whatever the variable is called (DATABASE_URL, REDIS_URL).
// Deliberately wide: a ':' after the scheme followed later by an '@' counts, so a
// password holding '/' or ':' is caught too. It can also refuse a URL with a port
// and an '@' in its path; set such a value with --env-configmap.
const URL_WITH_PASSWORD = /^[a-z][a-z0-9+.-]*:\/\/[^\s@:/]*:\S*@/i;
const RESERVED_MOUNT = '/var/run/knext';

/**
 * Appended to a refusal instead of the offending fragment: a malformed
 * `--env*` argument may hold a secret, so no unvalidated part of it is echoed.
 * A refusal may name the variable once its name has passed `ENV_NAME`, but
 * never repeats a value.
 */
const NOT_REPEATED = ' (the value is not repeated here, in case it holds a secret)';

function usage(flag: string, problem: string): never {
  throw new GrpcUsageError(`--${flag}: ${problem}`);
}

function envName(flag: string, name: string): string {
  if (!ENV_NAME.test(name)) usage(flag, `not a valid environment variable name${NOT_REPEATED}`);
  if (name.startsWith(RESERVED_ENV_PREFIX)) {
    usage(
      flag,
      `names starting with ${RESERVED_ENV_PREFIX} are reserved: the operator sets the function's token issuer and audience`,
    );
  }
  return name;
}

function objectName(flag: string, kind: string, name: string): string {
  if (name.length === 0 || name.length > 253 || !DNS_SUBDOMAIN.test(name)) {
    usage(
      flag,
      `not a valid ${kind} name: lowercase letters, digits, '-' and '.', at most 253 characters${NOT_REPEATED}`,
    );
  }
  return name;
}

/**
 * Split at the first `sep`. `echo` false never repeats the argument in the
 * message: an `--env` argument without its `=` may be a bare secret.
 */
function splitOnce(
  flag: string,
  raw: string,
  sep: string,
  shape: string,
  echo = true,
): [string, string] {
  const i = raw.indexOf(sep);
  if (i <= 0) {
    usage(
      flag,
      echo
        ? `expected ${shape}, got "${raw}"`
        : `expected ${shape} (the argument is not repeated here, in case it holds a secret)`,
    );
  }
  return [raw.slice(0, i), raw.slice(i + sep.length)];
}

/** `NAME=<object>/<key>` for a Secret or ConfigMap key reference. */
function keyRef(flag: string, kind: string, raw: string): [string, { name: string; key: string }] {
  const [name, ref] = splitOnce(flag, raw, '=', `NAME=<${kind}>/<key>`, false);
  const [obj, key] = splitOnce(flag, ref, '/', `NAME=<${kind}>/<key>`, false);
  if (!DATA_KEY.test(key)) usage(flag, `not a valid ${kind} key${NOT_REPEATED}`);
  return [envName(flag, name), { name: objectName(flag, kind, obj), key }];
}

function sourceRef(flag: string, raw: string): [string, string] {
  const [kind, name] = splitOnce(flag, raw, ':', 'secret:<name> or configmap:<name>', false);
  if (kind !== 'secret' && kind !== 'configmap')
    usage(
      flag,
      'expected secret:<name> or configmap:<name> (the argument is not repeated here, in case it holds a secret)',
    );
  return [kind, objectName(flag, kind === 'secret' ? 'Secret' : 'ConfigMap', name)];
}

function mountPath(flag: string, path: string): string {
  if (!path.startsWith('/') || path.length > 512)
    usage(flag, `mount path "${path}" must be absolute (at most 512 characters)`);
  // Only the canonical spelling is accepted (no '//', '.', '..' or trailing '/'),
  // so the reserved-path checks below compare what the kubelet will mount, and
  // `//var/run/knext` or `/a/../var/run/knext` cannot slip past them.
  const segs = path.split('/').slice(1);
  if (path !== '/' && segs.some((s) => s === '' || s === '.' || s === '..')) {
    usage(
      flag,
      `mount path "${path}" must be canonical: no '//', '.' or '..' segments and no trailing '/'`,
    );
  }
  if (path === RESERVED_MOUNT || path.startsWith(`${RESERVED_MOUNT}/`)) {
    usage(flag, `${RESERVED_MOUNT} is reserved for operator mounts`);
  }
  // Knative serving refuses these mount paths (its reservedPaths).
  const clean = path;
  if (clean === '/' || clean === '/dev' || clean === '/dev/log') {
    usage(
      flag,
      `mount path "${path}" is reserved by Knative serving (/, /dev and /dev/log cannot be mounted)`,
    );
  }
  return path;
}

/** `<name>:<mountPath>:secret:<secret>`, `...:configmap:<configmap>` or `...:emptydir`. */
function volume(flag: string, raw: string): FunctionVolumeInput {
  const shape =
    "<name>:<mountPath>:secret:<secret>, <name>:<mountPath>:configmap:<configmap> or <name>:<mountPath>:emptydir (a mount path cannot contain ':')";
  const parts = raw.split(':');
  if (parts.length < 3) usage(flag, `expected ${shape}, got "${raw}"`);
  const [name, path, kind, ...rest] = parts;
  if (!DNS_LABEL.test(name) || name.length > 63) {
    usage(
      flag,
      `volume name "${name}" must be a DNS label (lowercase letters, digits and '-', at most 63 characters)`,
    );
  }
  const at = mountPath(flag, path);
  const src = rest.join(':');
  if (kind === 'emptydir' && rest.length === 0) return { name, mountPath: at, emptyDir: {} };
  if (kind === 'secret' && src)
    return { name, mountPath: at, secret: { secretName: objectName(flag, 'Secret', src) } };
  if (kind === 'configmap' && src)
    return { name, mountPath: at, configMap: { name: objectName(flag, 'ConfigMap', src) } };
  return usage(flag, `expected ${shape}, got "${raw}"`);
}

function capped<T>(flag: string, list: T[], max: number): T[] | undefined {
  if (list.length > max) usage(flag, `at most ${max} allowed, got ${list.length}`);
  return list.length > 0 ? list : undefined;
}

/** Parse the flags into the CRD's shapes. Throws {@link GrpcUsageError} naming the flag. */
export function parseFunctionEnvFlags(flags: FunctionEnvFlags): FunctionEnvSpec {
  const env: FunctionEnvVar[] = [];
  const seenEnv = new Set<string>();
  const addEnv = (flag: string, v: FunctionEnvVar) => {
    if (seenEnv.has(v.name)) usage(flag, `${v.name} is set twice`);
    seenEnv.add(v.name);
    env.push(v);
  };
  for (const raw of flags.env ?? []) {
    const [name, value] = splitOnce('env', raw, '=', 'NAME=VALUE', false);
    const checked = envName('env', name);
    if (URL_WITH_PASSWORD.test(value)) {
      usage(
        'env',
        `${checked} is a URL with a password in it; put it in a Secret and pass --env-secret ${checked}=<secret>/<key>`,
      );
    }
    if (secretLike(checked)) {
      usage(
        'env',
        `${checked} looks like a secret; pass it by reference with --env-secret ${checked}=<secret>/<key>, never as a value on the command line`,
      );
    }
    addEnv('env', { name: checked, value });
  }
  for (const raw of flags.envSecret ?? []) {
    const [name, ref] = keyRef('env-secret', 'Secret', raw);
    addEnv('env-secret', { name, valueFrom: { secretKeyRef: ref } });
  }
  for (const raw of flags.envConfigMap ?? []) {
    const [name, ref] = keyRef('env-configmap', 'ConfigMap', raw);
    addEnv('env-configmap', { name, valueFrom: { configMapKeyRef: ref } });
  }

  const envFrom = (flags.envFrom ?? []).map((raw): FunctionEnvFromSource => {
    const [kind, name] = sourceRef('env-from', raw);
    return kind === 'secret' ? { secretRef: { name } } : { configMapRef: { name } };
  });

  const volumes = (flags.volume ?? []).map((raw) => volume('volume', raw));
  const seenVol = new Set<string>();
  for (const v of volumes) {
    if (seenVol.has(v.name)) usage('volume', `volume "${v.name}" is set twice`);
    seenVol.add(v.name);
  }

  const pull = (flags.imagePullSecret ?? []).map((n) => ({
    name: objectName('image-pull-secret', 'Secret', n),
  }));

  const out: {
    env?: FunctionEnvVar[];
    envFrom?: FunctionEnvFromSource[];
    volumes?: FunctionVolumeInput[];
    imagePullSecrets?: { name: string }[];
  } = {};
  const e = capped('env', env, FUNCTION_ENV_LIMITS.env);
  if (e) out.env = e;
  const f = capped('env-from', envFrom, FUNCTION_ENV_LIMITS.envFrom);
  if (f) out.envFrom = f;
  const v = capped('volume', volumes, FUNCTION_ENV_LIMITS.volumes);
  if (v) out.volumes = v;
  const p = capped('image-pull-secret', pull, FUNCTION_ENV_LIMITS.imagePullSecrets);
  if (p) out.imagePullSecrets = p;
  return out;
}
