/**
 * Where `buf breaking` gets the contract to compare against.
 *
 * Two kinds of baseline:
 *
 * - **A buf input** — a directory, an image file, or a git reference such as
 *   `.git#branch=main,subdir=proto`. Passed to buf unchanged. This is what CI
 *   and local runs use today.
 * - **The deployed contract** — `deployed:<namespace>/<name>`, the contract a
 *   running function serves, as recorded in its `BackendService` status. That
 *   status field does not exist yet, so this kind goes through the
 *   {@link DeployedBaselineSource} seam, and with no source wired in it fails
 *   loudly instead of quietly passing. {@link createDeployedBaselineSource}
 *   is the source `knext generate` wires: it reads the function's
 *   `status.servedProtoVersion` (read-only, through core's kubectl seam) and
 *   compares against the git tag that version was released under.
 */

import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { parseVersion } from './semver';

export interface DeployedRef {
  readonly namespace: string;
  readonly name: string;
}

/** Turns a deployed function into a buf input holding the contract it serves. */
export interface DeployedBaselineSource {
  resolve(ref: DeployedRef): Promise<string>;
}

export class BaselineUnavailableError extends Error {
  override name = 'BaselineUnavailableError';
}

const DEPLOYED_PREFIX = 'deployed:';
const K8S_NAME = /^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/;

/** Resolve a `--against` value to the buf input `buf breaking` compares with. */
export async function resolveBaseline(
  spec: string,
  deployed?: DeployedBaselineSource,
): Promise<string> {
  if (!spec.startsWith(DEPLOYED_PREFIX)) return spec;
  const [namespace, name, ...rest] = spec.slice(DEPLOYED_PREFIX.length).split('/');
  if (!namespace || !name || rest.length > 0 || !K8S_NAME.test(namespace) || !K8S_NAME.test(name)) {
    throw new BaselineUnavailableError(
      `"${spec}" is not a deployed baseline: use deployed:<namespace>/<name>`,
    );
  }
  if (!deployed) {
    throw new BaselineUnavailableError(
      `reading the deployed contract of ${namespace}/${name} is not available: this ` +
        '@getknext/core does not provide the read-only cluster reader. Upgrade @getknext/core ' +
        'and @getknext/grpc together, or compare against a directory or a git reference, for example ' +
        '--against ".git#branch=main,subdir=proto".',
    );
  }
  return deployed.resolve({ namespace, name });
}

/** Reads a function's `status.servedProtoVersion`. Core supplies it; it never writes. */
export interface ServedVersionReader {
  readServedProtoVersion(args: {
    readonly namespace: string;
    readonly name: string;
    readonly context?: string;
  }): string | Promise<string>;
}

/** The default git tag a served contract version is released under. */
export const DEFAULT_DEPLOYED_TAG_TEMPLATE = 'proto/v{version}';

export interface DeployedBaselineOptions {
  /** The app root `knext generate` runs in. */
  readonly cwd: string;
  /** The proto directory, relative to `cwd` (the config's `proto`). */
  readonly protoDir: string;
  readonly reader: ServedVersionReader;
  /** The kubectl context to read from; omitted means kubectl's current one. */
  readonly context?: string;
  /** Tag name with a `{version}` placeholder; default `proto/v{version}`. */
  readonly tagTemplate?: string;
}

function gitOut(cwd: string, args: readonly string[]): { ok: boolean; out: string } {
  const r = spawnSync('git', [...args], { cwd, encoding: 'utf8' });
  return { ok: r.status === 0, out: (r.stdout ?? '').trim() };
}

/** Check a tag template before anything reads the cluster. */
export function checkTagTemplate(template: string): string | undefined {
  if (!template.includes('{version}'))
    return `tag template "${template}" has no {version} placeholder`;
  // A comma or # would end the buf input's tag value and open another option.
  if (/[,#\s]/.test(template))
    return `tag template "${template}" may not contain a comma, # or whitespace`;
  return undefined;
}

/**
 * A {@link DeployedBaselineSource} that reads the served contract version
 * from the live `BackendService` and returns the buf input for the git tag
 * that version was released under (`.git#tag=proto/v1.4.0,subdir=proto`).
 *
 * Every gap fails loudly: an unreadable status, a function that serves no
 * stamped version yet, a version that is not semver, a missing tag. None of
 * them falls back to comparing against nothing.
 */
export function createDeployedBaselineSource(
  opts: DeployedBaselineOptions,
): DeployedBaselineSource {
  const template = opts.tagTemplate ?? DEFAULT_DEPLOYED_TAG_TEMPLATE;
  return {
    async resolve(ref) {
      const bad = checkTagTemplate(template);
      if (bad) throw new BaselineUnavailableError(bad);
      const where = `${ref.namespace}/${ref.name}`;
      let served: string;
      try {
        served = (
          await opts.reader.readServedProtoVersion({
            namespace: ref.namespace,
            name: ref.name,
            ...(opts.context === undefined ? {} : { context: opts.context }),
          })
        ).trim();
      } catch (err) {
        throw new BaselineUnavailableError(
          `could not read the served contract version of ${where}: ${(err as Error)?.message ?? String(err)}`,
        );
      }
      if (served === '') {
        throw new BaselineUnavailableError(
          `${where} has no served contract version yet (status.servedProtoVersion is empty: ` +
            'no Ready revision carries a protoVersion). Deploy it with --proto-version, or compare ' +
            'against a directory or a git reference instead.',
        );
      }
      if (!parseVersion(served)) {
        throw new BaselineUnavailableError(
          `${where} reports served contract version "${served}", which is not a semantic version`,
        );
      }
      const tag = template.replace('{version}', served);
      const cwd = realpathSync(opts.cwd);
      const top = gitOut(cwd, ['rev-parse', '--show-toplevel']);
      if (!top.ok || top.out === '') {
        throw new BaselineUnavailableError(
          `${where} serves contract ${served}, but ${opts.cwd} is not inside a git repository to read tag ${tag} from`,
        );
      }
      const root = realpathSync(top.out);
      if (!gitOut(cwd, ['rev-parse', '--verify', '--quiet', `refs/tags/${tag}^{commit}`]).ok) {
        throw new BaselineUnavailableError(
          `${where} serves contract ${served}, but this repository has no tag ${tag}. ` +
            'Tag the commit that contract was released from, or fetch tags (git fetch --tags).',
        );
      }
      const toRoot = relative(cwd, root);
      const gitDir = toRoot === '' ? '.git' : join(toRoot, '.git');
      const subdir = relative(root, resolve(cwd, opts.protoDir)).split(sep).join('/');
      return `${gitDir}#tag=${tag},subdir=${subdir}`;
    },
  };
}
