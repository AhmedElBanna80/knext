/**
 * Advisory-allowlist RETIREMENT probe — pure logic (S9-7).
 *
 * The three security allowlists (`precompile-closure`, `npm-audit`, `osv`) each
 * carry an `expires` or review discipline, but nothing told us to DROP an entry
 * when its advisory is withdrawn upstream or gains a patched version. This module
 * holds every pure function; `scripts/verify-allowlist-retirement.mjs` is the thin
 * network wrapper. All of it is unit-tested against an injected advisory double
 * (`tests/allowlist-retirement.test.ts`).
 *
 * All three files share the shape `{ allow: [{ id, justification, ... }] }`; the
 * osv file additionally carries `package` + `version` (the installed version), so
 * a patched version is only a finding when it covers THAT version's range.
 * A patched version the entry's justification already NAMES is not a finding:
 * it was known when the entry was accepted, so only a NEW patch is news.
 */

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const ALLOWLIST_FILES = [
  'security/precompile-closure-allowlist.json',
  'security/npm-audit-allowlist.json',
  'security/osv-allowlist.json',
];

/** Read every allowlist; a malformed file/entry THROWS (never silently skipped). */
export function collectEntries(repoRoot, files = ALLOWLIST_FILES) {
  const entries = [];
  for (const file of files) {
    const doc = JSON.parse(readFileSync(resolve(repoRoot, file), 'utf8'));
    if (!Array.isArray(doc.allow)) throw new Error(`${file}: \`allow\` is not an array`);
    for (const e of doc.allow) {
      if (typeof e?.id !== 'string' || e.id.length === 0) {
        throw new Error(`${file}: entry without a string \`id\``);
      }
      entries.push({
        file,
        id: e.id,
        package: e.package,
        version: e.version,
        justification: typeof e.justification === 'string' ? e.justification : '',
      });
    }
  }
  return entries;
}

function cmp(a, b) {
  const pa = String(a)
    .split('-')[0]
    .split('.')
    .map((n) => Number.parseInt(n, 10) || 0);
  const pb = String(b)
    .split('-')[0]
    .split('.')
    .map((n) => Number.parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Is `version` inside a GitHub `vulnerable_version_range` (`>= 1, < 2` style)?
 * An unparseable range answers TRUE: when unsure, flag rather than stay quiet.
 */
export function versionInRange(version, range) {
  if (!range) return true;
  for (const part of String(range).split(',')) {
    const m = part.trim().match(/^(<=|>=|<|>|=)?\s*([0-9][^\s]*)$/);
    if (!m) return true;
    const d = cmp(version, m[2]);
    const op = m[1] ?? '=';
    const ok =
      op === '<'
        ? d < 0
        : op === '<='
          ? d <= 0
          : op === '>'
            ? d > 0
            : op === '>='
              ? d >= 0
              : d === 0;
    if (!ok) return false;
  }
  return true;
}

function mentionsVersion(text, version) {
  if (!text) return false;
  const esc = String(version).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![\\d.])${esc}(?![\\d]|\\.\\d)`).test(text);
}

/** @returns {{retire: boolean, reasons: string[]}} */
export function classifyAdvisory(entry, advisory) {
  const reasons = [];
  if (advisory.withdrawn_at) reasons.push(`withdrawn upstream on ${advisory.withdrawn_at}`);
  for (const v of advisory.vulnerabilities ?? []) {
    if (!v.first_patched_version) continue;
    const name = v.package?.name;
    if (entry.package && name !== entry.package) continue;
    if (entry.version && !versionInRange(entry.version, v.vulnerable_version_range)) continue;
    // A patch the justification already names was known when the entry was
    // accepted (the entry rests on reachability, not on "no fix"): not news.
    if (mentionsVersion(entry.justification, v.first_patched_version)) continue;
    reasons.push(
      `${name} ${v.vulnerable_version_range ?? ''} now has a patched version ${v.first_patched_version}`.replace(
        /\s+/g,
        ' ',
      ),
    );
  }
  return { retire: reasons.length > 0, reasons };
}

/**
 * Probe every entry. `fetchAdvisory(id)` returns the advisory object or THROWS.
 * A throw is an ERROR (fail closed) — never a pass, never a skip.
 */
export async function probeEntries(entries, fetchAdvisory) {
  const findings = [];
  const errors = [];
  const cache = new Map();
  for (const entry of entries) {
    try {
      if (!cache.has(entry.id)) cache.set(entry.id, await fetchAdvisory(entry.id));
      const { retire, reasons } = classifyAdvisory(entry, cache.get(entry.id));
      if (retire)
        findings.push({ file: entry.file, id: entry.id, package: entry.package, reasons });
    } catch (error) {
      errors.push({
        file: entry.file,
        id: entry.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { findings, errors, checked: entries.length };
}

export function exitCodeFor({ findings, errors, checked }) {
  return findings.length > 0 || errors.length > 0 || checked === 0 ? 1 : 0;
}

export function renderReport({ findings, errors, checked }) {
  const lines = [`Checked ${checked} allowlist entries.`];
  for (const f of findings)
    lines.push(
      `RETIRE ${f.id} (${f.file}${f.package ? `, ${f.package}` : ''}): ${f.reasons.join('; ')}`,
    );
  for (const e of errors) lines.push(`ERROR ${e.id} (${e.file}): ${e.message}`);
  if (checked === 0)
    lines.push('ERROR: no allowlist entries were found; refusing to pass vacuously.');
  if (findings.length === 0 && errors.length === 0 && checked > 0)
    lines.push('OK: no entry is retirable.');
  return lines.join('\n');
}
