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

import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import {
  collectEntries,
  exitCodeFor,
  loadLockfileFromDisk,
  pickNewestStable,
  probeEntries,
  readField,
  readTarEntry,
  renderReport,
  resolveAllowlistFiles,
} from './lib/allowlist-retirement.mjs';

// The tree whose allowlists and lockfiles are PROBED. Defaults to this checkout; the nightly
// caller on main points it at a second checkout of each branch so ONE trusted copy of this
// script (main's) reads each branch's data and no branch's code is executed.
const REPO_ROOT = resolve(process.env.ALLOWLIST_ROOT || resolve(import.meta.dirname, '..'));

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

const REGISTRY = 'https://registry.npmjs.org';
const MAX_TARBALL_BYTES = 200 * 1024 * 1024;

/**
 * GET with BOUNDED retries on network errors, 429 and 5xx, then FAIL CLOSED. Returns the Response.
 */
async function getWithRetries(fetchImpl, url, init, sleep) {
  let last = '';
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      const res = await fetchImpl(url, init);
      if (res.ok) return res;
      last = `HTTP ${res.status}`;
      if (res.status !== 429 && res.status < 500) break;
    } catch (error) {
      last = error instanceof Error ? error.message : String(error);
    }
    if (attempt < MAX_RETRIES) await sleep(Math.min(2 ** attempt * 1000, MAX_WAIT_MS));
  }
  throw new Error(`${url} failed (${last}); cannot resolve the vendored version`);
}

/**
 * Resolve `vendoredIn` to `{ hostVersion, vendoredVersion }`: newest STABLE host release in
 * `range` (registry packument, no prereleases), then the vendored file read out of that release's
 * tarball. The tarball is integrity-checked against the registry and only READ (gunzip + tar
 * header walk + JSON.parse); nothing in it is executed or extracted to disk.
 */
export function makeResolveVendored(fetchImpl = fetch, sleep = realSleep) {
  return async (v) => {
    const metaRes = await getWithRetries(
      fetchImpl,
      `${REGISTRY}/${v.package.replace('/', '%2f')}`,
      { headers: { accept: 'application/vnd.npm.install-v1+json' } },
      sleep,
    );
    const packument = await metaRes.json();
    const versions = packument?.versions;
    if (versions === null || typeof versions !== 'object') {
      throw new Error(`registry returned no versions for ${v.package}`);
    }
    const hostVersion = pickNewestStable(Object.keys(versions), v.range);
    const dist = versions[hostVersion]?.dist;
    const expected = typeof dist?.integrity === 'string' ? dist.integrity : null;
    if (typeof dist?.tarball !== 'string' || !expected?.startsWith('sha512-')) {
      throw new Error(
        `${v.package}@${hostVersion} has no tarball URL / sha512 integrity in the registry`,
      );
    }
    const tarUrl = new URL(dist.tarball);
    if (tarUrl.protocol !== 'https:' || tarUrl.host !== new URL(REGISTRY).host) {
      throw new Error(`${v.package}@${hostVersion} tarball is not on ${REGISTRY}: ${dist.tarball}`);
    }
    const tgz = Buffer.from(
      await (await getWithRetries(fetchImpl, dist.tarball, {}, sleep)).arrayBuffer(),
    );
    if (tgz.length > MAX_TARBALL_BYTES)
      throw new Error(`${v.package}@${hostVersion} tarball is too large`);
    const actual = `sha512-${createHash('sha512').update(tgz).digest('base64')}`;
    if (actual !== expected)
      throw new Error(`${v.package}@${hostVersion} tarball failed its integrity check`);
    const file = readTarEntry(gunzipSync(tgz), `package/${v.path}`);
    if (file === null)
      throw new Error(`${v.package}@${hostVersion} tarball has no package/${v.path}`);
    const vendoredVersion = readField(JSON.parse(file.toString('utf8')), v.field);
    if (typeof vendoredVersion !== 'string') {
      throw new Error(`${v.package}@${hostVersion}: \`${v.field}\` in ${v.path} is not a string`);
    }
    return { hostVersion, vendoredVersion };
  };
}

async function main() {
  const entries = collectEntries(REPO_ROOT, resolveAllowlistFiles(process.env.ALLOWLIST_FILES));
  const result = await probeEntries(entries, makeFetchAdvisory(), {
    loadLock: (rel) => loadLockfileFromDisk(REPO_ROOT, rel),
    resolveVendored: makeResolveVendored(),
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
