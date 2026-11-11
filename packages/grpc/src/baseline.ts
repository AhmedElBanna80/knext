/**
 * Where `buf breaking` gets the contract to compare against.
 *
 * Two kinds of baseline:
 *
 * - **A buf input** — a directory, an image file, or a git reference such as
 *   `.git#branch=main,subdir=proto`. Passed to buf unchanged. This is what CI
 *   and local runs use today.
 * - **The deployed contract** — `deployed:<namespace>/<name>`, the contract a
 *   running function serves. It goes through the {@link DeployedBaselineSource}
 *   seam; with no source wired in it fails loudly instead of quietly passing.
 *   {@link createDeployedBaselineSource} is the source `knext generate` wires:
 *   it reads the function's `status.servedProtoVersion` (read-only, through
 *   core's kubectl seam) and compares against the git tag that version was
 *   released under.
 *
 *   The tag is a locator, not a verifier: nothing checks that the tagged tree
 *   is byte-for-byte what the running image serves, so a tag placed on the
 *   wrong commit, or moved, compares against the wrong contract.
 */

import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { isAbsolute, relative, sep } from 'node:path';
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
  /** The buf workspace `knext generate` runs in (holds buf.yaml). */
  readonly cwd: string;
  readonly reader: ServedVersionReader;
  /** The kubectl context to read from; omitted means kubectl's current one. */
  readonly context?: string;
  /**
   * Tag name with exactly one `{version}` and, optionally, `{name}` (the
   * function's name). Default `proto/v{version}`.
   */
  readonly tagTemplate?: string;
}

function gitOut(cwd: string, args: readonly string[]): { ok: boolean; out: string } {
  const r = spawnSync('git', [...args], { cwd, encoding: 'utf8' });
  if (r.error) {
    throw new BaselineUnavailableError(
      `a deployed: baseline needs git, which could not be run: ${r.error.message}`,
    );
  }
  return { ok: r.status === 0, out: (r.stdout ?? '').trim() };
}

/** A comma or # would end a buf input option and open another; whitespace splits it. */
const BUF_INPUT_UNSAFE = /[,#\s]/;

/** Check a tag template before anything reads the cluster. */
export function checkTagTemplate(template: string): string | undefined {
  const versions = template.split('{version}').length - 1;
  if (versions !== 1) {
    return `tag template "${template}" must contain {version} exactly once`;
  }
  if (BUF_INPUT_UNSAFE.test(template)) {
    return `tag template "${template}" may not contain a comma, # or whitespace`;
  }
  const leftover = template.replaceAll('{version}', '').replaceAll('{name}', '');
  if (/[{}]/.test(leftover)) {
    return `tag template "${template}" may use only the {version} and {name} placeholders`;
  }
  return undefined;
}

/**
 * A {@link DeployedBaselineSource} that reads the served contract version
 * from the live `BackendService` and returns the buf input for the git tag
 * that version was released under:
 * `<absolute git dir>#format=git,tag=proto/v1.4.0[,subdir=<workspace path in the repo>]`.
 *
 * The git directory is absolute (the repository's common git dir, so a
 * worktree works), and the subdirectory is the buf workspace `generate` lints,
 * so the baseline is always the same module buf checks. Every gap fails
 * loudly: an unreadable status, no served version, a version that is not
 * semver, a cwd outside git, a tag that is not a valid ref or does not exist,
 * a path buf cannot take. None of them falls back to comparing against nothing.
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
          `${where} reports no served contract version (status.servedProtoVersion is empty). ` +
            'Either no Ready revision carries a protoVersion (deploy it with --proto-version), the ' +
            'function is refused (see kubectl describe backendservice), or the operator on this ' +
            'cluster predates the field. Compare against a directory or a git reference instead.',
        );
      }
      if (!parseVersion(served)) {
        throw new BaselineUnavailableError(
          `${where} reports served contract version "${served}", which is not a semantic version`,
        );
      }
      const tag = template.replaceAll('{name}', ref.name).replace('{version}', served);
      if (BUF_INPUT_UNSAFE.test(tag)) {
        throw new BaselineUnavailableError(
          `the tag "${tag}" contains a comma, # or whitespace, which a buf git input cannot carry`,
        );
      }
      const cwd = realpathSync(opts.cwd);
      if (!gitOut(cwd, ['check-ref-format', `refs/tags/${tag}`]).ok) {
        throw new BaselineUnavailableError(
          `tag "${tag}" (from the tag template "${template}") is not a valid git tag name`,
        );
      }
      const top = gitOut(cwd, ['rev-parse', '--show-toplevel']);
      const common = gitOut(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
      if (!top.ok || top.out === '' || !common.ok || common.out === '') {
        throw new BaselineUnavailableError(
          `${where} serves contract ${served}, but ${opts.cwd} is not inside a git repository to read tag ${tag} from`,
        );
      }
      if (!gitOut(cwd, ['rev-parse', '--verify', '--quiet', `refs/tags/${tag}^{commit}`]).ok) {
        throw new BaselineUnavailableError(
          `${where} serves contract ${served}, but this repository has no tag ${tag}. ` +
            'Tag the commit that contract was released from, or fetch tags (git fetch --tags).',
        );
      }
      if (!isAbsolute(common.out)) {
        // git older than 2.31 echoes --path-format back instead of a path.
        throw new BaselineUnavailableError(
          `a deployed: baseline needs git 2.31 or newer (git rev-parse --path-format), got "${common.out}"`,
        );
      }
      const gitDir = realpathSync(common.out);
      const subdir = relative(realpathSync(top.out), cwd).split(sep).join('/');
      for (const [what, value] of [
        ['git directory', gitDir],
        ['workspace path', subdir],
      ] as const) {
        if (BUF_INPUT_UNSAFE.test(value)) {
          throw new BaselineUnavailableError(
            `the ${what} "${value}" contains a comma, # or whitespace, which a buf git input cannot carry`,
          );
        }
      }
      // format=git explicitly: buf only infers a git input from a path ending in .git,
      // and the common git dir of a submodule or a --separate-git-dir repo does not.
      return `${gitDir}#format=git,tag=${tag}${subdir === '' ? '' : `,subdir=${subdir}`}`;
    },
  };
}
