import { spawnSync } from 'node:child_process';

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
