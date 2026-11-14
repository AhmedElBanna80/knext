#!/usr/bin/env node
/**
 * scripts/lib/e2e-eresolve-retry.mjs — decides whether an npm ERESOLVE refusal
 * of the knext tarball install may be retried with `--legacy-peer-deps`
 * (scripts/e2e-deploy.sh, #2319).
 *
 * The retry exists for fixtures that pin a dependency a peer range excludes
 * (vercel/next.js fixtures pinning a react canary, #2296): npm refuses, pnpm only
 * warns, so the deploy retries once. It must not hide a conflict that names
 * knext's own packages: if `@getknext/` appears ANYWHERE in the ERESOLVE report
 * (the package being resolved, the one declaring the peer, the one found, or a
 * path line), the retry is refused. That over-refuses a fixture conflict whose
 * report only mentions a knext package in passing; failing closed is the
 * intended trade.
 *
 * What it does NOT catch: a conflict deeper in knext's dependency tree. If
 * `@getknext/core` depends on `foo` and `foo` peers on a range the fixture's pin
 * excludes, npm's report names `foo` (the declarer), not the knext package above
 * it, so no `@getknext/` string appears and the retry is allowed. Today no
 * knext dependency declares a non-optional peer, so the case is hypothetical; a
 * check for it would have to read the tree, not the report.
 *
 * It fails closed in its output too: the deploy retries only when this script
 * prints exactly `retry` on stdout, so a script that never reaches its decision
 * (a module-path mismatch, a crash) cannot allow a retry by exiting 0.
 *
 * Usage: node e2e-eresolve-retry.mjs <npm-install-log>
 * Prints `retry`, exit 0: an ERESOLVE refusal that mentions no @getknext/ package.
 * Exit 1, reason on stderr: not an ERESOLVE refusal, or a knext package is in it.
 * Exit 2, reason on stderr: the log cannot be read.
 */
import { readFileSync, realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The refusal itself: the error code line, npm 7+ (`npm error code ERESOLVE`) or
// older (`npm ERR! code ERESOLVE`). A bare ERESOLVE word elsewhere (a `npm warn
// ERESOLVE overriding peer dependency` line on an install that failed for
// another reason) is not one.
const ERESOLVE_CODE = /^npm (?:error|ERR!) code ERESOLVE\s*$/m;
// Names, for the message only. The decision is a plain substring check.
const KNEXT_NAMES = /@getknext\/[A-Za-z0-9._-]*/gi;

/** @returns {{ retry: boolean, reason: string }} */
export function decideRetry(log) {
  if (!ERESOLVE_CODE.test(log)) {
    return { retry: false, reason: 'not an ERESOLVE refusal' };
  }
  if (log.toLowerCase().includes('@getknext/')) {
    const knext = [...new Set([...log.matchAll(KNEXT_NAMES)].map((m) => m[0]))].sort();
    return {
      retry: false,
      reason: `the conflict names knext's own package(s): ${knext.join(', ')}`,
    };
  }
  return { retry: true, reason: "the conflict is in the fixture's own dependencies" };
}

// Real paths on both sides: argv[1] may go through a symlink (macOS /var -> /private/var).
const isMain = () => {
  try {
    return (
      Boolean(process.argv[1]) &&
      realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
};

if (isMain()) {
  const path = process.argv[2];
  let log;
  try {
    log = readFileSync(path, 'utf8');
  } catch (err) {
    process.stderr.write(`e2e-eresolve-retry: cannot read ${path}: ${err.message}\n`);
    process.exit(2);
  }
  const { retry, reason } = decideRetry(log);
  if (!retry) {
    process.stderr.write(`e2e-eresolve-retry: no retry: ${reason}\n`);
    process.exit(1);
  }
  process.stdout.write('retry\n');
}
