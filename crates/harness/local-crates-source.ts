import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// CI-only: build a `knext ffi init` crate without fetching the knext crates
// from GitHub, and without changing what the crate says.
//
// The generated Cargo.toml keeps its user-facing `git = CRATE_GIT, rev = <pin>`.
// A cargo `[patch]` pointing at ./crates does NOT work for this: cargo still
// resolves the patched git source first, so the remote is still contacted.
// Instead git itself is told, for this process tree only, to serve CRATE_GIT
// from the checkout's own object database. Cargo then fetches the recorded
// revision from the local clone: still "the crate as written, at the recorded
// revision", with zero network access for the knext crates. (The revision must
// exist locally, so the CI job checks out full history; scripts/
// check-ffi-crate-rev.mjs keeps crates/knext-ffi* at that revision equal to
// the tree.)
//
// Integrity: before this rewrite, CI implicitly proved the recorded revision was
// published to CRATE_GIT (where users fetch from). A local clone also holds the
// PR's own unmerged commits, so `assertRevOnBase` requires the revision to be an
// ancestor of the PR's base (already merged). A PR can never pin its own merge
// commit (see scripts/check-ffi-crate-rev.mjs), so every legitimate bump pins a
// commit already on the base; nothing legitimate is rejected.
//
// NOT VERIFIED (founder decision, while getknext-dev is restricted): that the
// recorded revision is published on CRATE_GIT, where users fetch it. The check
// above asks the PERSONAL fork's history only; nothing here asks CRATE_GIT.
// Whether users keep fetching from CRATE_GIT, or from another source, is the
// founder's call. This rewrite does not change CRATE_GIT or the supply-chain
// policy. The egress proof below shows that CRATE_GIT is served from this clone
// with github.com closed; it does not show that CRATE_GIT has the revision.
//
// `insteadOf` is a PREFIX match and cannot be made exact (cargo fetches the URL
// without a `.git`/`/` suffix). Harmless: the only git dependency of this one
// step is CRATE_GIT, and a sibling `<CRATE_GIT>-x` would map to a nonexistent
// `file://<repo>-x` and fail closed.
//
// TODO(getknext-dev restored): delete this local rewrite (and the workflow env),
// or replace assertRevOnBase with a remote-reachability check on CRATE_GIT.

/** Env that makes git rewrite `gitUrl` to the local repository, and cargo use the git CLI. */
export function localCrateSourceEnv(repoDir: string, gitUrl: string): Record<string, string> {
  return {
    // cargo's built-in libgit2 ignores some git config; the CLI honours it.
    CARGO_NET_GIT_FETCH_WITH_CLI: 'true',
    // Scoped to this process tree: no ~/.gitconfig or repo config is written.
    GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: `url.file://${repoDir}.insteadOf`,
    GIT_CONFIG_VALUE_0: gitUrl,
  };
}

/**
 * Fail closed unless `rev` is a full SHA that is an ancestor of `baseRef`
 * (a ref name or SHA) in the repo at `repoDir`, i.e. already merged.
 * Throws on any doubt: empty input, non-SHA rev, unresolvable base, not ancestor.
 */
export function assertRevOnBase(repoDir: string, rev: string, baseRef: string | undefined): void {
  if (!/^[0-9a-f]{40}$/.test(rev)) throw new Error(`crateRev is not a full 40-hex SHA: ${rev}`);
  if (!baseRef)
    throw new Error('KNEXT_FFI_LOCAL_BASE_REF is unset: cannot prove the rev is merged');
  const git = (...args: string[]) =>
    spawnSync('git', ['-C', repoDir, ...args], { encoding: 'utf8' });
  if (git('rev-parse', '--verify', '--quiet', `${baseRef}^{commit}`).status !== 0) {
    throw new Error(`base ref does not resolve in the clone: ${baseRef}`);
  }
  if (git('merge-base', '--is-ancestor', rev, baseRef).status !== 0) {
    throw new Error(
      `crateRev ${rev} is not an ancestor of ${baseRef}: it is unmerged or unpublished, so users could not fetch it`,
    );
  }
}

// ── Egress proof (S9-4) ────────────────────────────────────────────────────
// The rewrite above is only worth trusting if nothing else reaches github.com.
// The proof routes github.com to a proxy that refuses every connection, then
// shows (a) cargo still fetches the recorded rev through the rewrite, and (b)
// with the rewrite removed, the same fetch is refused by that route.

/**
 * Where a connection through the denied route goes. Nothing listens on port 9
 * (discard) in CI, so every connect is refused before any bytes leave the job.
 */
export const DENIED_PROXY = 'http://127.0.0.1:9';

/**
 * A git config FILE (for `GIT_CONFIG_GLOBAL`) that sends every github.com
 * connection through `DENIED_PROXY`. Scoped to github.com, NOT `HTTPS_PROXY`, on
 * purpose: knext-ffi also pulls serde and serde_json from crates.io, so a global
 * denial would fail the very resolution the proof is about.
 */
export function githubDenialGitConfig(): string {
  return `[http "https://github.com/"]\n\tproxy = ${DENIED_PROXY}\n`;
}

/** What one spawned command reported. `status` is null when it was killed (timeout). */
export interface ProbeRun {
  status: number | null;
  stderr: string;
}

/** Runs `cmd args` with exactly `env`; the default spawns for real. */
export type ProbeSpawn = (cmd: string, args: string[], env: Record<string, string>) => ProbeRun;

const spawnForReal: ProbeSpawn = (cmd, args, env) => {
  const r = spawnSync(cmd, args, { env, encoding: 'utf8', timeout: 600_000 });
  return { status: r.status, stderr: `${r.stdout ?? ''}${r.stderr ?? ''}` };
};

/**
 * True when cargo's git db under `cargoHome` holds `rev` as a commit. This does
 * not read cargo's output (a `-q` fetch, or a ref already up to date, prints no
 * "From" line). github.com is denied, so the only source that can put the commit
 * in the db is the local clone.
 */
export function cargoDbHoldsRev(cargoHome: string, rev: string): boolean {
  const dbRoot = join(cargoHome, 'git', 'db');
  if (!existsSync(dbRoot)) return false;
  return readdirSync(dbRoot).some(
    (name) =>
      spawnSync('git', ['-C', join(dbRoot, name), 'cat-file', '-e', `${rev}^{commit}`], {
        encoding: 'utf8',
      }).status === 0,
  );
}

/**
 * The egress verdict over two cargo runs. `positive` must fetch, and its git db
 * must hold the recorded rev (`positiveHoldsRev`, from cargoDbHoldsRev); the
 * `control` runs with the local rewrite removed and must be refused by the
 * denied route. Returns one message per failed half, `[]` when both hold.
 */
export function egressVerdict(
  positive: ProbeRun,
  positiveHoldsRev: boolean,
  control: ProbeRun,
): string[] {
  const problems: string[] = [];
  if (positive.status !== 0) {
    problems.push(
      `cargo fetch from the local clone failed (status ${positive.status}): ${positive.stderr.trim()}`,
    );
  } else if (!positiveHoldsRev) {
    problems.push(
      "cargo's git db holds no commit for the recorded rev: nothing fetched it from the local clone",
    );
  }
  if (control.status === 0) {
    problems.push('control fetched with the local rewrite removed: the denied route does not hold');
  } else if (!/127\.0\.0\.1 port 9|Failed to connect/.test(control.stderr)) {
    problems.push(`control failed, but not at the denied route: ${control.stderr.trim()}`);
  }
  return problems;
}

/**
 * Runs the egress proof with cargo. A consumer crate depends on knext-ffi at
 * `rev` from `gitUrl`, and is fetched twice, each run with its own CARGO_HOME
 * (no cache can answer for the other) and under githubDenialGitConfig. The
 * positive run adds the local rewrite; the control does not. Returns egressVerdict.
 */
export function cargoEgressProbe(opts: {
  repoDir: string;
  gitUrl: string;
  rev: string;
  spawn?: ProbeSpawn;
}): string[] {
  if (!/^[0-9a-f]{40}$/.test(opts.rev))
    throw new Error(`rev is not a full 40-hex SHA: ${opts.rev}`);
  const spawn = opts.spawn ?? spawnForReal;
  const root = mkdtempSync(join(tmpdir(), 'knext-ffi-egress-'));
  try {
    const gitConfig = join(root, 'gitconfig');
    writeFileSync(gitConfig, githubDenialGitConfig());
    // A missing denial fails HERE, before cargo runs, so no run can reach github.com.
    if (!readFileSync(gitConfig, 'utf8').includes(`proxy = ${DENIED_PROXY}`)) {
      throw new Error(
        'the github.com denial is missing from the git config: refusing to run the proof',
      );
    }
    const run = (name: 'positive' | 'control'): ProbeRun => {
      const dir = join(root, name);
      mkdirSync(join(dir, 'src'), { recursive: true });
      const manifest = join(dir, 'Cargo.toml');
      writeFileSync(
        manifest,
        `[package]\nname = "egress-${name}"\nversion = "0.0.0"\nedition = "2021"\n\n` +
          `[dependencies]\nknext-ffi = { git = "${opts.gitUrl}", rev = "${opts.rev}" }\n`,
      );
      writeFileSync(join(dir, 'src', 'lib.rs'), '');
      const base: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) {
        if (v !== undefined && !k.startsWith('GIT_CONFIG_')) base[k] = v;
      }
      const env = {
        ...base,
        CARGO_HOME: join(root, `cargo-home-${name}`),
        GIT_CONFIG_GLOBAL: gitConfig,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_TERMINAL_PROMPT: '0',
        CARGO_NET_GIT_FETCH_WITH_CLI: 'true',
        ...(name === 'positive' ? localCrateSourceEnv(opts.repoDir, opts.gitUrl) : {}),
      };
      return spawn('cargo', ['fetch', '--manifest-path', manifest], env);
    };
    const positive = run('positive');
    const holds = cargoDbHoldsRev(join(root, 'cargo-home-positive'), opts.rev);
    return egressVerdict(positive, holds, run('control'));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}
