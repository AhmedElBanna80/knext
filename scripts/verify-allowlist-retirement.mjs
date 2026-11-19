#!/usr/bin/env node
/**
 * verify-allowlist-retirement — read-only nightly probe (S9-7).
 *
 * For every entry in the three security allowlists, asks the GitHub advisory
 * database whether the entry can be RETIRED: the advisory was withdrawn, or a
 * patched version now exists for the allowlisted package. Exits non-zero on any
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
  probeEntries,
  renderReport,
} from './lib/allowlist-retirement.mjs';

const REPO_ROOT = resolve(import.meta.dirname, '..');

export function makeFetchAdvisory(fetchImpl = fetch, token = process.env.GITHUB_TOKEN) {
  const headers = { accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28' };
  if (token) headers.authorization = `Bearer ${token}`;
  return async (id) => {
    const url = /^CVE-/i.test(id)
      ? `https://api.github.com/advisories?cve_id=${encodeURIComponent(id)}`
      : `https://api.github.com/advisories/${encodeURIComponent(id)}`;
    const res = await fetchImpl(url, { headers });
    if (!res.ok) throw new Error(`${url} returned HTTP ${res.status}; cannot verify ${id}`);
    const body = await res.json();
    if (Array.isArray(body)) {
      if (body.length === 0) throw new Error(`no advisory found for ${id}`);
      return body[0];
    }
    return body;
  };
}

async function main() {
  const entries = collectEntries(REPO_ROOT);
  const result = await probeEntries(entries, makeFetchAdvisory());
  const text = renderReport(result);
  console.log(text);
  if (result.findings.length > 0) console.error('::error::allowlist entries are retirable; drop them and bump the dependency');
  process.exit(exitCodeFor(result));
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  main().catch((error) => {
    console.error(`::error::${error instanceof Error ? error.message : String(error)}`);
    process.exit(1);
  });
}
