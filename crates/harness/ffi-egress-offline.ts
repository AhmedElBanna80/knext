/**
 * CI only: the egress proof (S9-4). `.github/workflows/rust-crates.yml` runs it
 * in the `crates` job, after the init step, where the pinned Rust toolchain is.
 *
 *   bun harness/ffi-egress-offline.ts      (cwd: crates/)
 *   env: KNEXT_FFI_LOCAL_REPO (the checkout), KNEXT_FFI_LOCAL_BASE_REF (the base)
 *
 * Exit 0: cargo fetched the recorded knext-ffi revision from this checkout with
 * github.com routed to a refused proxy, and a control with the local rewrite
 * removed was refused by that route. Exit 1: either half failed. Exit 2: the
 * proof could not run.
 *
 * NOT PROVEN HERE: that the recorded revision is published on CRATE_GIT, where
 * users fetch it. See the NOT VERIFIED note in local-crates-source.ts.
 */

import { CRATE_GIT, recordedCrateRev } from '../../packages/ffi/src/init';
import { assertRevOnBase, cargoEgressProbe } from './local-crates-source';

const repo = process.env.KNEXT_FFI_LOCAL_REPO;
if (!repo) {
  console.error('egress: KNEXT_FFI_LOCAL_REPO is unset; the proof needs the checkout');
  process.exit(2);
}
const rev = recordedCrateRev();
if (!rev) {
  console.error('egress: packages/ffi knextFfi.crateRev is not set; there is no revision to prove');
  process.exit(2);
}
assertRevOnBase(repo, rev, process.env.KNEXT_FFI_LOCAL_BASE_REF);

const problems = cargoEgressProbe({ repoDir: repo, gitUrl: CRATE_GIT, rev });
if (problems.length > 0) {
  for (const p of problems) console.error(`egress: ${p}`);
  process.exit(1);
}
console.log(
  `egress: cargo fetched ${rev} from ${repo} with github.com routed to a refused proxy; the control was refused.`,
);
