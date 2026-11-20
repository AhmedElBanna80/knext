#!/usr/bin/env node
/**
 * The unattributed-row ratchet, judged against the BASE branch.
 *
 * `scripts/lib/prover-wiring-lint.mjs` (`lintProvers`) holds the rules; this script owns the git
 * reads so that library never spawns a process. It reads the committed baseline
 * (`scripts/lib/prover-unattributed-baseline.json`) at the merge-base with the base ref, so a PR
 * cannot raise the limit it is judged by: a working-tree entry above the base's fails unless a
 * visible `Baseline-raise: <prover path> <reason>` line is in the PR body (CI: `PR_BODY`, the only
 * source) or, locally, in a commit message since the merge-base.
 *
 * Base ref: `--base REF`, else `GITHUB_BASE_REF` as `origin/<ref>`, else the nearest of the usual
 * long-lived refs (the measure prepush-check uses). A base without the baseline file (the PR that
 * adds it) falls back to the working tree with a NOTICE.
 *
 * Usage: node scripts/prover-unattributed-ratchet.mjs [--root DIR] [--base REF]
 * Exit 0 clean (hints and notices printed); 1 on a finding.
 */
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pickBase } from './lib/prepush-check.mjs';
import { lintProvers, UNATTRIBUTED_BASELINE } from './lib/prover-wiring-lint.mjs';

const BASES = ['personal/integration/v2', 'origin/integration/v2', 'personal/main', 'origin/main'];

const git = (root, args) =>
  spawnSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 1 << 26 });

/** `[commits mine, commits theirs]` from the merge-base, or null; the same measure prepush-check uses. */
function distanceFrom(root, ref) {
  if (git(root, ['rev-parse', '--verify', '-q', ref]).status !== 0) return null;
  const mb = git(root, ['merge-base', 'HEAD', ref]);
  if (mb.status !== 0) return null;
  const m = mb.stdout.trim();
  const mine = git(root, ['rev-list', '--count', `${m}..HEAD`]);
  const theirs = git(root, ['rev-list', '--count', `${m}..${ref}`]);
  return mine.status === 0 && theirs.status === 0
    ? [Number(mine.stdout.trim()), Number(theirs.stdout.trim())]
    : null;
}

/**
 * @returns {{ref?: string, baseline: Record<string, number> | null, commitLog: string}}
 */
export function resolveBase(root, { base, env = process.env } = {}) {
  const ref =
    base ??
    (env.GITHUB_BASE_REF
      ? `origin/${env.GITHUB_BASE_REF}`
      : pickBase(BASES, (b) => distanceFrom(root, b)));
  if (!ref) return { baseline: null, commitLog: '' };
  const mb = git(root, ['merge-base', 'HEAD', ref]);
  if (mb.status !== 0) return { ref, baseline: null, commitLog: '' };
  const mergeBase = mb.stdout.trim();
  const commitLog = git(root, ['log', '--format=%B', `${mergeBase}..HEAD`]).stdout ?? '';
  const shown = git(root, ['show', `${mergeBase}:${UNATTRIBUTED_BASELINE}`]);
  if (shown.status !== 0) return { ref, baseline: null, commitLog };
  return { ref, baseline: JSON.parse(shown.stdout), commitLog };
}

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const arg = (name) => {
    const i = process.argv.indexOf(name);
    return i === -1 ? undefined : process.argv[i + 1];
  };
  const root = arg('--root') ? resolve(arg('--root')) : REPO_ROOT;
  const { lines, failures, hints, notices } = lintProvers(root, {
    base: resolveBase(root, { base: arg('--base') }),
  });
  for (const l of lines) console.log(l);
  for (const h of hints) console.log(`HINT ${h}`);
  for (const n of notices) console.log(`NOTICE ${n}`);
  for (const f of failures) console.error(f);
  process.exit(failures.length > 0 ? 1 : 0);
}
