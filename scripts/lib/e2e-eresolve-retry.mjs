#!/usr/bin/env node
/**
 * scripts/lib/e2e-eresolve-retry.mjs — decides whether an npm ERESOLVE refusal
 * of the knext tarball install may be retried with `--legacy-peer-deps`
 * (scripts/e2e-deploy.sh, #2319).
 *
 * The retry exists for fixtures that pin a dependency a peer range excludes
 * (vercel/next.js fixtures pinning a react canary, #2296): npm refuses, pnpm only
 * warns, so the deploy retries once. It must never hide a conflict in knext's own
 * packages: if any package in the conflict report is an `@getknext/*` package,
 * either as the package being resolved or as the one declaring the peer, the
 * conflict is knext's, and the retry is refused.
 *
 * npm names the packages in two shapes (npm 10 and 11):
 *   While resolving: <name>@<version>
 *   peer <dep>@"<range>" from <name>@<version>
 * Both are matched with or without the `npm error ` / `npm warn ` prefix.
 *
 * Usage: node e2e-eresolve-retry.mjs <npm-install-log>
 * Exit 0: the log is an ERESOLVE refusal that names no @getknext/* package (retry).
 * Exit 1, reason on stderr: not an ERESOLVE refusal, or it names an @getknext/*
 *         package (do not retry: fail the deploy).
 * Exit 2, reason on stderr: the log cannot be read.
 */
import { readFileSync } from 'node:fs';

const KNEXT = /(?:While resolving:|\bfrom)\s+(@getknext\/[^@\s]+)/g;

/** @returns {{ retry: boolean, reason: string }} */
export function decideRetry(log) {
  if (!/\bERESOLVE\b/.test(log)) {
    return { retry: false, reason: 'not an ERESOLVE refusal' };
  }
  const knext = [...new Set([...log.matchAll(KNEXT)].map((m) => m[1]))];
  if (knext.length > 0) {
    return {
      retry: false,
      reason: `the conflict names knext's own package(s): ${knext.join(', ')}`,
    };
  }
  return { retry: true, reason: "the conflict is in the fixture's own dependencies" };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const path = process.argv[2];
  let log;
  try {
    log = readFileSync(path, 'utf8');
  } catch (err) {
    process.stderr.write(`e2e-eresolve-retry: cannot read ${path}: ${err.message}\n`);
    process.exit(2);
  }
  const { retry, reason } = decideRetry(log);
  if (!retry) process.stderr.write(`e2e-eresolve-retry: no retry: ${reason}\n`);
  process.exit(retry ? 0 : 1);
}
