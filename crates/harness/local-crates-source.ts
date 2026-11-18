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
