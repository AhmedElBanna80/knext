#!/usr/bin/env node
/**
 * compat-bun-base — the dispatch-only patched Bun base for the compat bun lane (#2804, ADR-0072
 * item 3).
 *
 *   node scripts/compat-bun-base.mjs fetch --run-id <id> --repo <owner/name> --dir <dir> \
 *     [--expect-sha256 <hex>]
 *
 * WHAT. `infra/bun-base` builds a CI-only Bun base executable carrying unreleased upstream fixes;
 * `.github/workflows/bun-base-build.yml` checks the Cloud Build digests, signs SHA256SUMS keyless
 * and stores the result as a workflow artifact. A `test-e2e-deploy.yml` dispatch with
 * `bunBaseRunId` uses this script to fetch that artifact and hand its base executable to the
 * standalone compile (`KNEXT_BUN_BASE_EXE`, read by `packages/kn-next/src/adapters/bun-base-exe.mjs`).
 *
 * EVIDENCE, NEVER CREDIT. A run on a patched base is not a stock-Bun run, so it must never pass for
 * one: the base's sha256 is folded into the compat-window fingerprint (`--bun-base-sha256`), the lane
 * Bun id becomes `<stock version>+bun-base.<sha256[:12]>` (the shard summaries' `runtimeVersion`,
 * and the `--bun-version` the upstream-runtime-defect ledger is scoped with), and the seam refuses
 * any event but `workflow_dispatch` and any credential-mode run.
 *
 * FAIL CLOSED, in this order — each failure exits non-zero before anything is written:
 *   1. the seam is allowed here (dispatch only, not credential mode, bun lane, numeric run id);
 *   2. the source run is a completed, successful run of bun-base-build.yml on main;
 *   3. exactly one `bun-base-*` artifact was downloaded from it;
 *   4. `cosign verify-blob` accepts SHA256SUMS.sigstore.json for SHA256SUMS under the
 *      bun-base-build.yml@refs/heads/main identity (keyless, GitHub OIDC);
 *   5. every SHA256SUMS line matches its file, the base executable is one of them, and its own
 *      `.sha256` (the file the seam reads) is the same line;
 *   6. `--expect-sha256`, when given, equals the base's sha256 (the shards re-fetch and must get the
 *      bytes the fingerprint folded);
 *   7. the base's `--revision` is the compiler's version: the compiler is the stock Bun on PATH and a
 *      `--bytecode` compile is only valid on a base from the same JSC. The base runs inside the
 *      pinned musl image the lane boots the compiled exec in (scripts/e2e-deploy.sh).
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { appendFileSync, chmodSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const SOURCE_WORKFLOW_PATH = '.github/workflows/bun-base-build.yml';
export const OIDC_ISSUER = 'https://token.actions.githubusercontent.com';
export const BASE_FILE = 'bun-linux-x64-musl';
export const SUMS_FILE = 'SHA256SUMS';
export const SIGNATURE_FILE = 'SHA256SUMS.sigstore.json';
const SHA256 = /^[0-9a-f]{64}$/;

export class BunBaseError extends Error {}

/** The keyless identity bun-base-build.yml signs with (its OIDC token on main). */
export function signerIdentity(repo) {
  return `https://github.com/${repo}/${SOURCE_WORKFLOW_PATH}@refs/heads/main`;
}

/** Step 1. */
export function assertSeamAllowed({ runId, runtime, compatMode, eventName }) {
  if (eventName !== 'workflow_dispatch') {
    throw new BunBaseError(
      `the patched Bun base is dispatch-only; refusing it on a '${eventName}' event`,
    );
  }
  if (compatMode === 'credential') {
    throw new BunBaseError(
      'a patched-base run is evidence only and never a credential night; refusing it in credential mode',
    );
  }
  if (runtime !== 'bun') {
    throw new BunBaseError(`the patched Bun base needs runtime=bun, got '${runtime}'`);
  }
  if (typeof runId !== 'string' || !/^[0-9]+$/.test(runId)) {
    throw new BunBaseError(`bunBaseRunId must be a numeric run id, got ${JSON.stringify(runId)}`);
  }
}

/** Step 2. `run` is the REST `actions/runs/{id}` object. */
export function assertSourceRun(run) {
  const got = `${run?.path} ${run?.status} ${run?.conclusion} ${run?.head_branch}`;
  const want = `${SOURCE_WORKFLOW_PATH} completed success main`;
  if (got !== want) {
    throw new BunBaseError(`source run is '${got}', want '${want}'`);
  }
}

/** Parses a sha256sum-format file into Map<name, hex>; any malformed line throws. */
export function parseSums(text) {
  const out = new Map();
  for (const line of text.split('\n')) {
    if (line === '') continue;
    const m = /^([0-9a-f]{64}) {2}(\S+)$/.exec(line);
    if (!m) throw new BunBaseError(`malformed sha256sum line: ${JSON.stringify(line)}`);
    if (out.has(m[2])) throw new BunBaseError(`${m[2]} is listed twice`);
    out.set(m[2], m[1]);
  }
  return out;
}

const fileSha256 = (path) => createHash('sha256').update(readFileSync(path)).digest('hex');

/** Step 5 (and 6). Returns the base executable's sha256. */
export function verifySums(dir, expectSha256) {
  const sums = parseSums(readFileSync(join(dir, SUMS_FILE), 'utf8'));
  if (sums.size === 0) throw new BunBaseError(`${SUMS_FILE} lists no files`);
  for (const [name, want] of sums) {
    const got = fileSha256(join(dir, name));
    if (got !== want) throw new BunBaseError(`${name}: sha256 ${got}, ${SUMS_FILE} says ${want}`);
  }
  const base = sums.get(BASE_FILE);
  if (base === undefined) throw new BunBaseError(`${SUMS_FILE} does not list ${BASE_FILE}`);
  const own = parseSums(readFileSync(join(dir, `${BASE_FILE}.sha256`), 'utf8'));
  if (own.size !== 1 || own.get(BASE_FILE) !== base) {
    throw new BunBaseError(`${BASE_FILE}.sha256 is not the single ${SUMS_FILE} line for it`);
  }
  if (expectSha256 !== undefined && expectSha256 !== base) {
    throw new BunBaseError(
      `the base is ${base}, but this run's fingerprint folded ${JSON.stringify(expectSha256)}`,
    );
  }
  return base;
}

/** Step 7. `X.Y.Z+<sha>` revisions; the base's version must be the compiler's. */
export function assertBaseMatchesCompiler({ compilerVersion, baseRevision }) {
  const m = /^(\d+\.\d+\.\d+)\+[0-9a-f]{7,40}$/.exec(String(baseRevision ?? '').trim());
  if (!m) throw new BunBaseError(`unreadable base --revision ${JSON.stringify(baseRevision)}`);
  if (m[1] !== String(compilerVersion ?? '').trim()) {
    throw new BunBaseError(
      `the base is Bun ${m[1]} but the compiler on PATH is ${JSON.stringify(compilerVersion)}: a --bytecode compile needs both from the same release`,
    );
  }
}

/** The lane Bun id a patched-base run is recorded under. Never a bare X.Y.Z. */
export function laneBunId(compilerVersion, sha256) {
  if (!SHA256.test(sha256)) throw new BunBaseError(`not a sha256: ${JSON.stringify(sha256)}`);
  return `${compilerVersion}+bun-base.${sha256.slice(0, 12)}`;
}

/** The musl image the lane boots the compiled exec in — read from e2e-deploy.sh, never copied. */
export function laneMuslImage(repoRoot) {
  const text = readFileSync(join(repoRoot, 'scripts/e2e-deploy.sh'), 'utf8');
  const hits = [...text.matchAll(/^STANDALONE_BUN_IMAGE="([^"]+@sha256:[0-9a-f]{64})"$/gm)];
  if (hits.length !== 1) {
    throw new BunBaseError(
      `expected one STANDALONE_BUN_IMAGE pin in e2e-deploy.sh, found ${hits.length}`,
    );
  }
  return hits[0][1];
}

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  if (r.status !== 0) {
    throw new BunBaseError(
      `${cmd} ${args[0] ?? ''} failed (exit ${r.status}): ${String(
        r.stderr || r.stdout || r.error || '',
      )
        .trim()
        .slice(0, 400)}`,
    );
  }
  return String(r.stdout).trim();
}

function arg(argv, name) {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
}

export function fetchBase(argv, env = process.env) {
  const runId = arg(argv, 'run-id');
  const repo = arg(argv, 'repo');
  const dir = arg(argv, 'dir');
  const expectSha256 = arg(argv, 'expect-sha256');
  if (!repo || !dir) throw new BunBaseError('--repo and --dir are required');
  assertSeamAllowed({
    runId,
    runtime: env.KNEXT_RUNTIME,
    compatMode: env.KNEXT_COMPAT_MODE,
    eventName: env.GITHUB_EVENT_NAME,
  });
  assertSourceRun(JSON.parse(run('gh', ['api', `repos/${repo}/actions/runs/${runId}`])));
  run('gh', ['run', 'download', runId, '-R', repo, '-p', 'bun-base-*', '-D', dir]);
  const subdirs = readdirSync(dir).filter((f) => statSync(join(dir, f)).isDirectory());
  if (subdirs.length !== 1) {
    throw new BunBaseError(
      `expected exactly one bun-base-* artifact in run ${runId}, got ${subdirs.length}`,
    );
  }
  const art = resolve(dir, subdirs[0]);
  run(
    'cosign',
    [
      'verify-blob',
      '--bundle',
      SIGNATURE_FILE,
      '--certificate-identity',
      signerIdentity(repo),
      '--certificate-oidc-issuer',
      OIDC_ISSUER,
      SUMS_FILE,
    ],
    { cwd: art },
  );
  const sha256 = verifySums(art, expectSha256);
  const exe = join(art, BASE_FILE);
  chmodSync(exe, 0o755);
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const baseRevision = run('docker', [
    'run',
    '--rm',
    '-v',
    `${art}:/b:ro`,
    '--entrypoint',
    `/b/${BASE_FILE}`,
    laneMuslImage(repoRoot),
    '--revision',
  ]);
  const compilerVersion = run('bun', ['--version']);
  assertBaseMatchesCompiler({ compilerVersion, baseRevision });
  return { exe, sha256, id: laneBunId(compilerVersion, sha256), baseRevision };
}

function main(argv) {
  if (argv[0] !== 'fetch') {
    console.error(
      'usage: compat-bun-base.mjs fetch --run-id <id> --repo <owner/name> --dir <dir> [--expect-sha256 <hex>]',
    );
    return 2;
  }
  try {
    const r = fetchBase(argv.slice(1));
    if (process.env.GITHUB_ENV) {
      appendFileSync(
        process.env.GITHUB_ENV,
        `KNEXT_BUN_BASE_EXE=${r.exe}\nKNEXT_BUN_BASE_SHA256=${r.sha256}\nKNEXT_BUN_BASE_ID=${r.id}\n`,
      );
    }
    if (process.env.GITHUB_OUTPUT)
      appendFileSync(process.env.GITHUB_OUTPUT, `sha256=${r.sha256}\n`);
    console.log(`patched Bun base ${r.baseRevision}, sha256 ${r.sha256}; lane Bun id ${r.id}`);
    return 0;
  } catch (error) {
    console.error(
      `::error::compat-bun-base: ${error instanceof Error ? error.message : String(error)}`,
    );
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
