/**
 * Pure logic for `scripts/prepush-check.mjs`, the pre-push guard for the three
 * defect classes that reached CI or merged in one sprint: a gate that rejected
 * a changed allowlist because nobody ran it, tests that leaked temp dirs, and a
 * PR that silently reverted another PR's files.
 *
 * Nothing here runs a gate or a test on import. The spawns live in the CLI and
 * are injected where a function needs one, so every check can be driven from a
 * fixture.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { unpairedTempDirs } from './scratch-space-scan.mjs';

/** A changed file that is a supply-chain allowlist. */
export const ALLOWLIST_RE = /^security\/[^/]*allowlist[^/]*\.json$/;

export const changedAllowlists = (files) => files.filter((f) => ALLOWLIST_RE.test(f));

/**
 * How to invoke each gate that reads an allowlist. The gate set is DISCOVERED
 * by scanning `scripts/` for the allowlist's filename; this table only says how
 * to run what was found. A discovered script with no entry here FAILS the check
 * rather than being skipped, so a new gate cannot be missed by omission.
 *
 * `needs` are binaries that must be on PATH. A missing one is UNVERIFIED, which
 * fails unless the caller passes --allow-missing-tools: "I could not run the
 * gate" is not "the gate passed".
 */
export const GATE_TABLE = {
  'secret-scan.mjs': { needs: ['gitleaks'], runs: [[]] },
  'precompile-closure-audit.mjs': {
    needs: ['syft', 'grype'],
    sbom: true,
    runs: [
      ['--app', 'apps/file-manager'],
      ['--app', 'apps/docs'],
      ['--closure', 'examples/bun-exec'],
    ],
  },
  'osv-gate.mjs': { needs: ['osv-scanner'], scanner: true, base: true, runs: [[]] },
  'audit-shipped-npm.mjs': { needs: ['osv-scanner', 'npm'], scanner: true, runs: [[]] },
  'audit-published.mjs': { needs: ['npm', 'bun'], runs: [[]] },
};

/**
 * Top-level `scripts/*.mjs` (not provers, not `lib/`) whose source mentions the
 * allowlist's file name. Scanning, not listing.
 */
export function discoverAllowlistGates(scriptsDir, allowlistRel) {
  const name = allowlistRel.split('/').pop();
  return readdirSync(scriptsDir)
    .filter((f) => f.endsWith('.mjs') && !f.startsWith('mutation-prove-'))
    .filter((f) => readFileSync(join(scriptsDir, f), 'utf8').includes(name))
    .sort();
}

/**
 * Expand the changed allowlists into concrete commands.
 * @returns {{ runs: {allowlist: string, script: string, args: string[], entry: any}[], unknown: {allowlist: string, script: string}[] }}
 */
export function planGateRuns(scriptsDir, allowlists, table = GATE_TABLE) {
  const runs = [];
  const unknown = [];
  const seen = new Set();
  for (const allowlist of allowlists) {
    for (const script of discoverAllowlistGates(scriptsDir, allowlist)) {
      const entry = table[script];
      if (!entry) {
        unknown.push({ allowlist, script });
        continue;
      }
      entry.runs.forEach((args, i) => {
        const key = `${script}#${i}`;
        if (seen.has(key)) return;
        seen.add(key);
        runs.push({ allowlist, script, args, entry });
      });
    }
  }
  return { runs, unknown };
}

/** Entries in `after` that were not in `before`. */
export function newEntries(before, after) {
  const was = new Set(before);
  return [...after].filter((e) => !was.has(e)).sort();
}

/** `mkdtemp` sites in `tests/**` that never reach a removal, past each file's recorded baseline. */
export function staticTempDirFindings(root, files, baseline = {}) {
  const out = [];
  for (const f of files) {
    if (!f.startsWith('tests/') || !existsSync(join(root, f))) continue;
    const n = unpairedTempDirs(readFileSync(join(root, f), 'utf8')).length;
    const allowed = baseline[f] ?? 0;
    if (n > allowed) out.push({ file: f, sites: n, baseline: allowed });
  }
  return out;
}

/** `Scope: a/**, b/*.ts` lines out of a commit or PR body. */
export function parseScopeLines(text) {
  const globs = [];
  for (const m of (text ?? '').matchAll(/^[ \t]*Scope:[ \t]*(.+)$/gim)) {
    for (const g of m[1].split(',')) if (g.trim()) globs.push(g.trim());
  }
  return globs;
}

/** `**` crosses directories, `*` and `?` do not. A bare directory means everything under it. */
export function globToRegExp(glob) {
  let g = glob.replace(/^\.\//, '');
  if (g.endsWith('/')) g += '**';
  let re = '';
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*' && g[i + 1] === '*') {
      i += 1;
      if (g[i + 1] === '/') {
        i += 1;
        re += '(?:.*/)?';
      } else re += '.*';
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

/** Files that match none of the declared scope globs. */
export function outOfScope(files, globs) {
  const res = globs.map(globToRegExp);
  return files.filter((f) => !res.some((r) => r.test(f)));
}

/** Group paths by their top-level directory; root files group as `(root)`. */
export function groupByArea(files) {
  const groups = new Map();
  for (const f of files) {
    const area = f.includes('/') ? f.slice(0, f.indexOf('/')) : '(root)';
    if (!groups.has(area)) groups.set(area, []);
    groups.get(area).push(f);
  }
  return new Map([...groups].sort(([a], [b]) => a.localeCompare(b)));
}

/** Test files among the changed ones, as the runner should receive them. */
export const changedTestFiles = (files) => files.filter((f) => /\.test\.(?:[cm]?[jt]sx?)$/.test(f));
