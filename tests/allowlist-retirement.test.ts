import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import {
  ALLOWLIST_FILES,
  classifyAdvisory,
  collectEntries,
  exitCodeFor,
  probeEntries,
  renderReport,
  versionInRange,
} from '../scripts/lib/allowlist-retirement.mjs';
import { makeFetchAdvisory } from '../scripts/verify-allowlist-retirement.mjs';

const ROOT = resolve(import.meta.dir, '..');

const entry = (over: Record<string, unknown> = {}) => ({
  file: 'security/x.json',
  id: 'GHSA-aaaa-bbbb-cccc',
  justification: 'No fix available; not reachable.',
  ...over,
});
const advisory = (over: Record<string, unknown> = {}) => ({
  withdrawn_at: null,
  vulnerabilities: [
    { package: { ecosystem: 'npm', name: 'pkg' }, vulnerable_version_range: '< 2.0.0', first_patched_version: null },
  ],
  ...over,
});
const stub = (map: Record<string, unknown>) => async (id: string) => {
  const v = map[id];
  if (v instanceof Error) throw v;
  if (!v) throw new Error(`stub: no advisory ${id}`);
  return v;
};

describe('allowlist retirement probe', () => {
  it('RETIRE: advisory withdrawn upstream', async () => {
    const r = await probeEntries([entry()], stub({ 'GHSA-aaaa-bbbb-cccc': advisory({ withdrawn_at: '2026-11-18T00:00:00Z' }) }));
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].reasons[0]).toContain('withdrawn');
    expect(exitCodeFor(r)).toBe(1);
  });

  it('RETIRE: a patched version now exists for the package', async () => {
    const adv = advisory({
      vulnerabilities: [{ package: { name: 'pkg' }, vulnerable_version_range: '< 2.0.0', first_patched_version: '2.0.0' }],
    });
    const r = await probeEntries([entry()], stub({ 'GHSA-aaaa-bbbb-cccc': adv }));
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].reasons[0]).toContain('2.0.0');
    expect(exitCodeFor(r)).toBe(1);
  });

  it('KEEP: still unpatched and not withdrawn is no finding', async () => {
    const r = await probeEntries([entry()], stub({ 'GHSA-aaaa-bbbb-cccc': advisory() }));
    expect(r.findings).toEqual([]);
    expect(r.errors).toEqual([]);
    expect(exitCodeFor(r)).toBe(0);
  });

  it('FAIL CLOSED: an API error is an error and a non-zero exit, never a pass', async () => {
    const r = await probeEntries([entry()], stub({ 'GHSA-aaaa-bbbb-cccc': new Error('HTTP 503') }));
    expect(r.errors).toHaveLength(1);
    expect(r.findings).toEqual([]);
    expect(exitCodeFor(r)).toBe(1);
    expect(renderReport(r)).toContain('ERROR GHSA-aaaa-bbbb-cccc');
  });

  it('FAIL CLOSED: zero entries refuses to pass vacuously', () => {
    expect(exitCodeFor({ findings: [], errors: [], checked: 0 })).toBe(1);
  });

  it('a non-2xx response from the real fetch wrapper throws', async () => {
    const f = makeFetchAdvisory((async () => ({ ok: false, status: 502 })) as never, 't');
    await expect(f('GHSA-aaaa-bbbb-cccc')).rejects.toThrow('HTTP 502');
  });

  it('a patch the justification already names is not news; a different patch is', () => {
    const adv = advisory({
      vulnerabilities: [{ package: { name: 'pkg' }, vulnerable_version_range: '<= 0.5.0', first_patched_version: '0.5.1' }],
    });
    expect(classifyAdvisory(entry({ justification: 'fixed only in 0.5.1, ESM-only' }), adv).retire).toBe(false);
    expect(classifyAdvisory(entry({ justification: 'fixed in 10.5.1' }), adv).retire).toBe(true);
    expect(classifyAdvisory(entry({ justification: 'No patched release exists' }), adv).retire).toBe(true);
  });

  it('osv entries: a patch for another package or another version range is ignored', () => {
    const adv = advisory({
      vulnerabilities: [
        { package: { name: 'other' }, vulnerable_version_range: '< 9', first_patched_version: '9.0.0' },
        { package: { name: 'pkg' }, vulnerable_version_range: '>= 4.0.0, < 4.5.0', first_patched_version: '4.5.0' },
      ],
    });
    expect(classifyAdvisory(entry({ package: 'pkg', version: '3.1.0' }), adv).retire).toBe(false);
    expect(classifyAdvisory(entry({ package: 'pkg', version: '4.2.0' }), adv).retire).toBe(true);
  });

  it('versionInRange handles comparators and answers true for unparseable ranges', () => {
    expect(versionInRange('1.2.1', '>= 1.0.0, < 1.2.2')).toBe(true);
    expect(versionInRange('1.2.2', '>= 1.0.0, < 1.2.2')).toBe(false);
    expect(versionInRange('1.0.0', 'weird range')).toBe(true);
  });

  it('covers all three real allowlists (shapes verified, not assumed)', () => {
    const entries = collectEntries(ROOT);
    expect(ALLOWLIST_FILES).toHaveLength(3);
    for (const f of ALLOWLIST_FILES) expect(entries.some((e) => e.file === f)).toBe(true);
    expect(entries.every((e) => /^(GHSA|CVE)-/i.test(e.id))).toBe(true);
  });

  it('importing the CLI module does not run main() (entrypoint guard)', () => {
    const r = spawnSync('node', ['-e', "globalThis.fetch=async()=>{throw new Error('offline')};await import('./scripts/verify-allowlist-retirement.mjs').then(m=>m)"], { cwd: ROOT, encoding: 'utf8' });
    // Importing must not run main() (entrypoint guard): no network, clean exit.
    expect(r.status).toBe(0);
  });
});
