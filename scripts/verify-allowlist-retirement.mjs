#!/usr/bin/env node
/**
 * verify-allowlist-retirement — read-only nightly probe (S9-7).
 *
 * For every entry in the three security allowlists, asks the GitHub advisory
 * database whether the entry can be RETIRED: the advisory was withdrawn, or a
 * patched version is REACHABLE now (the locked version's parents accept it).
 * Patches that exist but cannot be reached are listed as INFO and do not fail. Exits non-zero on any
 * RETIRE finding AND on any API failure — a probe that goes green when it cannot
 * reach upstream is worse than none (security.md nightly-pin precedent).
 *
 * Read-only: GET requests only; never edits an allowlist.
 * Logic + tests: scripts/lib/allowlist-retirement.mjs, tests/allowlist-retirement.test.ts.
 *
 * Usage:  GITHUB_TOKEN=... node scripts/verify-allowlist-retirement.mjs
 */

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  collectEntries,
  exitCodeFor,
  loadLockfileFromDisk,
  probeEntries,
  renderReport,
} from './lib/allowlist-retirement.mjs';

const REPO_ROOT = resolve(import.meta.dirname, '..');

export const MAX_RETRIES = 3;
const MAX_WAIT_MS = 60_000;

const realSleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * 403/429 are GitHub's rate-limit answers: wait `Retry-After` (else exponential
 * backoff, capped) and retry up to MAX_RETRIES times, then FAIL CLOSED. Any other
 * non-2xx fails at once. A CVE id must resolve to EXACTLY ONE advisory.
 */
export function makeFetchAdvisory(
  fetchImpl = fetch,
  token = process.env.GITHUB_TOKEN,
  sleep = realSleep,
) {
  const headers = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' };
  if (token) headers.authorization = `Bearer ${token}`;
  return async (id) => {
    const isCve = /^CVE-/i.test(id);
    const url = isCve
      ? `https://api.github.com/advisories?cve_id=${encodeURIComponent(id)}`
      : `https://api.github.com/advisories/${encodeURIComponent(id)}`;
    let res;
    for (let attempt = 0; ; attempt++) {
      res = await fetchImpl(url, { headers });
      if (res.ok) break;
      if ((res.status === 403 || res.status === 429) && attempt < MAX_RETRIES) {
        const ra = Number(res.headers?.get?.('retry-after'));
        await sleep(
          Math.min(Number.isFinite(ra) && ra > 0 ? ra * 1000 : 2 ** attempt * 1000, MAX_WAIT_MS),
        );
        continue;
      }
      throw new Error(`${url} returned HTTP ${res.status}; cannot verify ${id}`);
    }
    const body = await res.json();
    if (isCve) {
      if (!Array.isArray(body) || body.length !== 1) {
        throw new Error(
          `expected exactly one advisory for ${id}, got ${Array.isArray(body) ? body.length : 'a non-list'}`,
        );
      }
      return body[0];
    }
    return body;
  };
}

async function main() {
  const entries = collectEntries(REPO_ROOT);
  const result = await probeEntries(entries, makeFetchAdvisory(), {
    loadLock: (rel) => loadLockfileFromDisk(REPO_ROOT, rel),
  });
  const text = renderReport(result);
  console.log(text);
  if (result.findings.length > 0)
    console.error('::error::actionable allowlist findings (see the RETIRE/ERROR lines above)');
  process.exit(exitCodeFor(result));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
