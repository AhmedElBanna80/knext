import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import {
  ALLOWLIST_FILES,
  classifyAdvisory,
  collectEntries,
  exitCodeFor,
  isPinnedFixtureLockfile,
  parseLockfile,
  probeEntries,
  reachability,
  renderReport,
  satisfiesRange,
  versionInRange,
} from '../scripts/lib/allowlist-retirement.mjs';
import { MAX_RETRIES, makeFetchAdvisory } from '../scripts/verify-allowlist-retirement.mjs';

const ROOT = resolve(import.meta.dir, '..');

const entry = (over: Record<string, unknown> = {}) => ({
  file: 'security/x.json',
  id: 'GHSA-aaaa-bbbb-cccc',
  ...over,
});
const unpatched = () => ({
  withdrawn_at: null,
  vulnerabilities: [
    {
      package: { name: 'pkg' },
      vulnerable_version_range: '< 2.0.0',
      first_patched_version: null,
    },
  ],
});
const patched = (range = '< 1.9.0', fix = '1.9.0', name = 'pkg') => ({
  withdrawn_at: null,
  vulnerabilities: [
    { package: { name }, vulnerable_version_range: range, first_patched_version: fix },
  ],
});
const lock = (parentRange: string, installed = '1.5.0') => ({
  packages: [
    { name: 'pkg', version: installed, deps: {} },
    { name: 'parent', version: '3.0.0', deps: { pkg: parentRange } },
  ],
  roots: [],
});
const stub = (map: Record<string, unknown>) => async (id: string) => {
  const v = map[id];
  if (v instanceof Error) throw v;
  if (!v) throw new Error(`stub: no advisory ${id}`);
  return v;
};
const withLock = (l: unknown) => ({ loadLock: () => l as never });

describe('allowlist retirement probe: outcomes', () => {
  it('RETIRE: advisory withdrawn upstream', async () => {
    const adv = { ...unpatched(), withdrawn_at: '2026-11-18T00:00:00Z' };
    const r = await probeEntries([entry()], stub({ 'GHSA-aaaa-bbbb-cccc': adv }));
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].reasons[0]).toContain('withdrawn');
    expect(exitCodeFor(r)).toBe(1);
  });

  it('RETIRE: a patched version is reachable now (parent range accepts it)', async () => {
    const r = await probeEntries(
      [entry({ package: 'pkg', version: '1.5.0', lockfile: 'a/bun.lock' })],
      stub({ 'GHSA-aaaa-bbbb-cccc': patched() }),
      withLock(lock('^1.0.0 || ^2.0.0')),
    );
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].reasons[0]).toContain('reachable');
    expect(exitCodeFor(r)).toBe(1);
  });

  it('INFO, not red: a patch exists but the parent pins it out', async () => {
    const r = await probeEntries(
      [entry({ package: 'pkg', version: '1.5.0', lockfile: 'a/bun.lock' })],
      stub({ 'GHSA-aaaa-bbbb-cccc': patched() }),
      withLock(lock('1.5.0')),
    );
    expect(r.findings).toEqual([]);
    expect(r.informational).toHaveLength(1);
    expect(r.informational[0].reasons[0]).toContain('not reachable');
    expect(exitCodeFor(r)).toBe(0);
    expect(renderReport(r)).toContain('does NOT fail the run');
  });

  it('INFO, not red: a reachable patch in a deliberately pinned fixture lockfile', async () => {
    const r = await probeEntries(
      [entry({ package: 'pkg', version: '1.5.0', lockfile: 'x/__tests__/fixtures/app/bun.lock' })],
      stub({ 'GHSA-aaaa-bbbb-cccc': patched() }),
      withLock(lock('^1.0.0')),
    );
    expect(r.findings).toEqual([]);
    expect(r.informational[0].reasons[0]).toContain('pinned fixture');
    expect(isPinnedFixtureLockfile('a/fixtures/b/bun.lock')).toBe(true);
    expect(isPinnedFixtureLockfile('bun.lock')).toBe(false);
  });

  it('INFO, not red: an entry that cannot be resolved against any lockfile', async () => {
    const r = await probeEntries([entry()], stub({ 'GHSA-aaaa-bbbb-cccc': patched() }));
    expect(r.findings).toEqual([]);
    expect(r.informational).toHaveLength(1);
    expect(exitCodeFor(r)).toBe(0);
  });

  it('no entry (npm-audit shape): the package comes from the advisory, the version from the lockfile', async () => {
    const reach = await probeEntries(
      [entry()],
      stub({ 'GHSA-aaaa-bbbb-cccc': patched() }),
      withLock(lock('^1.2.0')),
    );
    expect(reach.findings).toHaveLength(1);
    const blocked = await probeEntries(
      [entry()],
      stub({ 'GHSA-aaaa-bbbb-cccc': patched() }),
      withLock(lock('1.5.0')),
    );
    expect(blocked.findings).toEqual([]);
    expect(blocked.informational).toHaveLength(1);
  });

  it('KEEP: still unpatched and not withdrawn is no finding at all', async () => {
    const r = await probeEntries([entry()], stub({ 'GHSA-aaaa-bbbb-cccc': unpatched() }));
    expect(r.findings).toEqual([]);
    expect(r.informational).toEqual([]);
    expect(r.errors).toEqual([]);
    expect(exitCodeFor(r)).toBe(0);
  });

  it('FAIL CLOSED: an API error is an error and a non-zero exit', async () => {
    const r = await probeEntries([entry()], stub({ 'GHSA-aaaa-bbbb-cccc': new Error('HTTP 503') }));
    expect(r.errors).toHaveLength(1);
    expect(exitCodeFor(r)).toBe(1);
    expect(renderReport(r)).toContain('ERROR GHSA-aaaa-bbbb-cccc');
  });

  it('FAIL CLOSED: zero entries refuses to pass vacuously', () => {
    expect(exitCodeFor({ findings: [], errors: [], checked: 0 })).toBe(1);
  });
});

describe('version range and reachability', () => {
  it('the vulnerable-range check decides which patch applies to the installed version', () => {
    const adv = {
      withdrawn_at: null,
      vulnerabilities: [
        {
          package: { name: 'pkg' },
          vulnerable_version_range: '< 1.0.0',
          first_patched_version: '1.0.0',
        },
        {
          package: { name: 'pkg' },
          vulnerable_version_range: '>= 4.0.0, < 4.5.0',
          first_patched_version: '4.5.0',
        },
      ],
    };
    const l = (v: string) => (() => lock('*', v)) as never;
    expect(
      classifyAdvisory(entry({ package: 'pkg', version: '3.1.0', lockfile: 'l' }), adv, l('3.1.0'))
        .level,
    ).toBe('INFO');
    expect(
      classifyAdvisory(entry({ package: 'pkg', version: '4.2.0', lockfile: 'l' }), adv, l('4.2.0'))
        .level,
    ).toBe('RETIRE');
  });

  it('a patch for another package is ignored', () => {
    const adv = patched('< 9', '9.0.0', 'other');
    expect(
      classifyAdvisory(
        entry({ package: 'pkg', version: '1.0.0', lockfile: 'l' }),
        adv,
        () => lock('*') as never,
      ).level,
    ).toBe('KEEP');
  });

  it('versionInRange handles comparators; an unparseable range counts as affected', () => {
    expect(versionInRange('1.2.1', '>= 1.0.0, < 1.2.2')).toBe(true);
    expect(versionInRange('1.2.2', '>= 1.0.0, < 1.2.2')).toBe(false);
    expect(versionInRange('1.0.0', 'weird range')).toBe(true);
  });

  it('satisfiesRange: caret, tilde, exact, comparators, ||, unknown -> null', () => {
    expect(satisfiesRange('7.5.19', '^7.0.0')).toBe(true);
    expect(satisfiesRange('8.0.0', '^7.0.0')).toBe(false);
    expect(satisfiesRange('0.5.1', '^0.2.2')).toBe(false);
    expect(satisfiesRange('1.2.9', '~1.2.0')).toBe(true);
    expect(satisfiesRange('1.3.0', '~1.2.0')).toBe(false);
    expect(satisfiesRange('0.5.1', '0.2.2')).toBe(false);
    expect(satisfiesRange('2.0.0', '>=1 <3')).toBe(true);
    expect(satisfiesRange('4.0.0', '^2 || ^4')).toBe(true);
    expect(satisfiesRange('1.0.0', 'workspace:*')).toBe(null);
  });

  it('reachability: reachable, blocked, and unknown', () => {
    expect(reachability(lock('^1.0.0'), 'pkg', '1.5.0', '1.9.0').status).toBe('reachable');
    expect(reachability(lock('1.5.0'), 'pkg', '1.5.0', '1.9.0').status).toBe('blocked');
    expect(reachability(lock('workspace:*'), 'pkg', '1.5.0', '1.9.0').status).toBe('unknown');
    expect(reachability({ packages: [], roots: [] }, 'pkg', '1.5.0', '1.9.0').status).toBe(
      'unknown',
    );
  });

  it('parseLockfile reads bun.lock (trailing commas) and package-lock.json', () => {
    const bun = `{ "workspaces": { "": { "dependencies": { "pkg": "^1.0.0", }, }, }, "packages": { "pkg": ["pkg@1.5.0", "", { "dependencies": { "x": "^1" }, }, "sha"], } }`;
    const b = parseLockfile(bun, 'bun');
    expect(b?.packages[0]).toMatchObject({ name: 'pkg', version: '1.5.0' });
    expect(b?.roots[0].pkg).toBe('^1.0.0');
    const n = parseLockfile(
      JSON.stringify({
        packages: {
          '': { dependencies: { pkg: '^1' } },
          'node_modules/a/node_modules/pkg': { version: '1.5.0' },
        },
      }),
      'npm',
    );
    expect(n?.packages[0]).toMatchObject({ name: 'pkg', version: '1.5.0' });
    expect(parseLockfile('not json', 'bun')).toBe(null);
  });
});

const res = (status: number, body: unknown = {}, retryAfter?: string) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: { get: (k: string) => (k === 'retry-after' ? (retryAfter ?? null) : null) },
  json: async () => body,
});

describe('advisory API client', () => {
  it('a non-2xx response throws', async () => {
    const f = makeFetchAdvisory((async () => res(502)) as never, 't', async () => {});
    await expect(f('GHSA-aaaa-bbbb-cccc')).rejects.toThrow('HTTP 502');
  });

  it('429 honours Retry-After, then succeeds', async () => {
    const waits: number[] = [];
    let n = 0;
    const f = makeFetchAdvisory(
      (async () => (n++ === 0 ? res(429, {}, '7') : res(200, { ok: 1 }))) as never,
      't',
      async (ms: number) => {
        waits.push(ms);
      },
    );
    expect(await f('GHSA-aaaa-bbbb-cccc')).toEqual({ ok: 1 });
    expect(waits).toEqual([7000]);
  });

  it('403 is retried a BOUNDED number of times, then fails closed', async () => {
    let calls = 0;
    const f = makeFetchAdvisory(
      (async () => {
        calls++;
        return res(403);
      }) as never,
      't',
      async () => {},
    );
    await expect(f('GHSA-aaaa-bbbb-cccc')).rejects.toThrow('HTTP 403');
    expect(calls).toBe(MAX_RETRIES + 1);
  });

  it('a CVE id needs exactly one advisory: zero or two throw, one is returned', async () => {
    const mk = (body: unknown) =>
      makeFetchAdvisory((async () => res(200, body)) as never, 't', async () => {});
    await expect(mk([])('CVE-2026-1')).rejects.toThrow('exactly one');
    await expect(mk([{ a: 1 }, { a: 2 }])('CVE-2026-1')).rejects.toThrow('exactly one');
    expect(await mk([{ a: 1 }])('CVE-2026-1')).toEqual({ a: 1 });
  });
});

describe('real allowlists', () => {
  it('covers all three (shapes verified, not assumed)', () => {
    const entries = collectEntries(ROOT);
    expect(ALLOWLIST_FILES).toHaveLength(3);
    for (const f of ALLOWLIST_FILES) expect(entries.some((e) => e.file === f)).toBe(true);
    expect(entries.every((e) => /^(GHSA|CVE)-/i.test(e.id))).toBe(true);
  });

  it('importing the CLI module does not run main() (entrypoint guard)', () => {
    const r = spawnSync(
      'node',
      ['-e', "await import('./scripts/verify-allowlist-retirement.mjs')"],
      { cwd: ROOT, encoding: 'utf8' },
    );
    expect(r.status).toBe(0);
  });
});
