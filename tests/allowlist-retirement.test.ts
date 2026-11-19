import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import { parse } from 'yaml';
import {
  ALLOWLIST_FILES,
  classifyAdvisory,
  classifyVendored,
  collectEntries,
  exitCodeFor,
  isPinnedFixtureLockfile,
  loadLockfileFromDisk,
  parseLockfile,
  pickNewestStable,
  probeEntries,
  reachability,
  readTarEntry,
  renderReport,
  resolveAllowlistFiles,
  satisfiesPatched,
  satisfiesRange,
  validateVendoredIn,
  versionInRange,
} from '../scripts/lib/allowlist-retirement.mjs';
import {
  MAX_RETRIES,
  makeFetchAdvisory,
  makeResolveVendored,
} from '../scripts/verify-allowlist-retirement.mjs';

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
    // main has no OSV gate: it is probed for the two allowlists it carries (the nightly names them
    // via ALLOWLIST_FILES); a root with the full set is probed for all three.
    const files = ALLOWLIST_FILES.filter((f) => existsSync(resolve(ROOT, f)));
    expect(ALLOWLIST_FILES).toHaveLength(3);
    expect(files.length).toBeGreaterThanOrEqual(2);
    const entries = collectEntries(ROOT, files);
    for (const f of files) expect(entries.some((e) => e.file === f)).toBe(true);
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

describe('workflow caller and alert wiring', () => {
  const wf = parse(
    readFileSync(resolve(ROOT, '.github/workflows/allowlist-retirement-nightly.yml'), 'utf8'),
  ) as {
    on: Record<string, unknown>;
    permissions: Record<string, string>;
    jobs: Record<
      string,
      {
        if?: string;
        permissions?: Record<string, string>;
        strategy?: { matrix?: { include?: { ref: string; files: string }[] } };
        steps?: { uses?: string; with?: Record<string, string>; env?: Record<string, string> }[];
      }
    >;
  };

  it('is scheduled (it lives on main, where a schedule fires) with read-only default permissions', () => {
    expect(wf.on.schedule).toBeDefined();
    expect(wf.permissions).toEqual({ contents: 'read' });
  });

  it('probes BOTH branches: main and integration/v2', () => {
    const legs = wf.jobs['probe-allowlists'].strategy?.matrix?.include ?? [];
    expect(legs.map((l) => l.ref)).toEqual(['main', 'integration/v2']);
    const osv = 'security/osv-allowlist.json';
    // v2 carries all three allowlists; main has no OSV gate. Both must name the two shared ones.
    expect(legs[1].files.split(',')).toContain(osv);
    expect(legs[0].files.split(',')).not.toContain(osv);
    for (const l of legs) {
      expect(l.files.split(',')).toContain('security/precompile-closure-allowlist.json');
      expect(l.files.split(',')).toContain('security/npm-audit-allowlist.json');
    }
  });

  it('runs main’s script over the branch checked out as DATA (ALLOWLIST_ROOT), never the branch’s script', () => {
    const steps = wf.jobs['probe-allowlists'].steps ?? [];
    const checkouts = steps.filter((st) => st.uses?.startsWith('actions/checkout@'));
    expect(checkouts.map((c) => c.with?.ref)).toEqual(['main', '${{ matrix.ref }}']);
    expect(checkouts[1].with?.path).toBe('target');
    const probe = steps.find((st) => st.env?.ALLOWLIST_ROOT);
    expect(probe?.env?.ALLOWLIST_ROOT).toBe('target');
    expect(probe?.env?.ALLOWLIST_FILES).toBe('${{ matrix.files }}');
  });

  it('every action is SHA-pinned', () => {
    for (const job of Object.values(wf.jobs))
      for (const st of job.steps ?? []) if (st.uses) expect(st.uses).toMatch(/@[0-9a-f]{40}$/);
  });

  it('the alert fires on failure OR cancelled, carries always(), and is the only write scope', () => {
    const alert = wf.jobs['nightly-red-alert'];
    const cond = alert.if ?? '';
    expect(cond).toContain('always()');
    expect(cond).toContain("needs.probe-allowlists.result == 'failure'");
    expect(cond).toContain("needs.probe-allowlists.result == 'cancelled'");
    expect(alert.permissions).toEqual({ issues: 'write' });
    expect(wf.jobs['probe-allowlists'].permissions).toBeUndefined();
  });
});

describe('probe root confinement and file selection', () => {
  it('loadLockfileFromDisk rejects an absolute path and any path that escapes the root', () => {
    const dir = mkdtempSync(join(tmpdir(), 'allow-'));
    expect(() => loadLockfileFromDisk(dir, '/etc/passwd')).toThrow(/outside/);
    expect(() => loadLockfileFromDisk(dir, '../../etc/passwd')).toThrow(/outside/);
    expect(() => loadLockfileFromDisk(dir, 'a/../../x')).toThrow(/outside/);
    expect(loadLockfileFromDisk(dir, 'bun.lock')).toBeNull();
    rmSync(dir, { recursive: true });
  });

  it('loadLockfileFromDisk rejects a symlink that resolves outside the root', () => {
    const dir = mkdtempSync(join(tmpdir(), 'allow-'));
    const out = mkdtempSync(join(tmpdir(), 'allow-out-'));
    writeFileSync(join(out, 'bun.lock'), '{}');
    symlinkSync(join(out, 'bun.lock'), join(dir, 'bun.lock'));
    expect(() => loadLockfileFromDisk(dir, 'bun.lock')).toThrow(/outside/);
    rmSync(dir, { recursive: true });
    rmSync(out, { recursive: true });
  });

  it('a MISSING allowlist is an error on every root (fail closed)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'allow-'));
    expect(() => collectEntries(dir)).toThrow(/ENOENT/);
    rmSync(dir, { recursive: true });
  });

  it('resolveAllowlistFiles: default is all three; a list must name known files', () => {
    expect(resolveAllowlistFiles(undefined)).toEqual(ALLOWLIST_FILES);
    expect(resolveAllowlistFiles('security/npm-audit-allowlist.json')).toEqual([
      'security/npm-audit-allowlist.json',
    ]);
    expect(() => resolveAllowlistFiles('security/nope.json')).toThrow(/unknown/);
    expect(() => resolveAllowlistFiles(' , ')).toThrow(/names no allowlist/);
  });
});

describe('the CLI honours ALLOWLIST_ROOT', () => {
  it('reads the tree named by ALLOWLIST_ROOT, not its own checkout', () => {
    const dir = mkdtempSync(join(tmpdir(), 'allow-'));
    const r = spawnSync('node', ['scripts/verify-allowlist-retirement.mjs'], {
      cwd: ROOT,
      encoding: 'utf8',
      env: { ...process.env, ALLOWLIST_ROOT: dir },
    });
    rmSync(dir, { recursive: true });
    expect(r.status).not.toBe(0);
    expect(`${r.stdout}${r.stderr}`).toContain(dir);
  });
});

// ── vendored advisories ─────────────────────────────────────────────────────

const VENDORED = {
  package: 'next',
  range: '>=16.4.3 <16.5.0',
  path: 'dist/compiled/rsd/package.json',
  field: 'peerDependencies.react',
  patched: ['>= 19.3.1'],
};
const vEntry = () => entry({ vendoredIn: VENDORED });
const tarFile = (name: string, body: string, type = '0') => {
  const data = Buffer.from(body);
  const head = Buffer.alloc(512);
  head.write(name, 0);
  head.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124);
  head.write(type, 156);
  const pad = Buffer.alloc(Math.ceil(data.length / 512) * 512);
  data.copy(pad);
  return Buffer.concat([head, pad]);
};
const tgzOf = (...files: Buffer[]) => gzipSync(Buffer.concat([...files, Buffer.alloc(1024)]));
const integrityOf = (b: Buffer) => `sha512-${createHash('sha512').update(b).digest('base64')}`;
const rsd = (react: string) => JSON.stringify({ peerDependencies: { react } });
const ok = (body: unknown) => ({
  ok: true,
  status: 200,
  json: async () => body,
  arrayBuffer: async () => body as ArrayBuffer,
});
const reg = (versions: string[], tgz: Buffer, integrity = integrityOf(tgz)) => {
  const calls: string[] = [];
  const fetchImpl = async (url: string) => {
    calls.push(url);
    if (url.endsWith('.tgz'))
      return ok(tgz.buffer.slice(tgz.byteOffset, tgz.byteOffset + tgz.length));
    return ok({
      versions: Object.fromEntries(
        versions.map((v) => [
          v,
          { dist: { tarball: `https://registry.npmjs.org/next/-/next-${v}.tgz`, integrity } },
        ]),
      ),
    });
  };
  return { fetchImpl: fetchImpl as never, calls };
};
const noSleep = async () => {};
const probeV = (resolved: { hostVersion: string; vendoredVersion: string } | Error) =>
  probeEntries([vEntry()], stub({ 'GHSA-aaaa-bbbb-cccc': unpatched() }), {
    resolveVendored: async () => {
      if (resolved instanceof Error) throw resolved;
      return resolved;
    },
  });

describe('vendored advisories: classification', () => {
  it('RETIRE (red): the newest stable host vendors a patched version', async () => {
    const r = await probeV({ hostVersion: '16.4.9', vendoredVersion: '19.3.1' });
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0].reasons.join()).toContain('next@16.4.9');
    expect(exitCodeFor(r)).toBe(1);
  });

  it('INFO (not red): the newest stable host still vendors an unpatched canary', async () => {
    const r = await probeV({
      hostVersion: '16.4.6',
      vendoredVersion: '19.3.0-canary-278794d7-20261002',
    });
    expect(r.findings).toHaveLength(0);
    expect(r.informational).toHaveLength(1);
    expect(r.informational[0].reasons.join()).toContain('19.3.0-canary-278794d7-20261002');
    expect(exitCodeFor(r)).toBe(0);
  });

  it('a prerelease of the patched version is NOT patched; the stable one is', () => {
    expect(satisfiesPatched('19.3.1-canary-abc-20261101', ['>= 19.3.1'])).toBe(false);
    expect(satisfiesPatched('19.3.1', ['>= 19.3.1'])).toBe(true);
    expect(satisfiesPatched('19.2.9', ['>= 19.2.9, < 19.3.0', '>= 19.3.1'])).toBe(true);
    expect(satisfiesPatched('19.3.0', ['>= 19.3.1'])).toBe(false);
    expect(() => satisfiesPatched('canary', ['>= 19.3.1'])).toThrow();
  });

  it('classifyVendored on a host with no vendored fix names the host, path and range', () => {
    const c = classifyVendored(vEntry() as never, {
      hostVersion: '16.4.6',
      vendoredVersion: '19.3.0',
    });
    expect(c.level).toBe('INFO');
    expect(c.reasons[0]).toContain(VENDORED.path);
  });

  it('FAIL CLOSED: a resolver error is an error and a non-zero exit', async () => {
    const r = await probeV(new Error('registry down'));
    expect(r.errors).toHaveLength(1);
    expect(exitCodeFor(r)).toBe(1);
  });

  it('FAIL CLOSED: an entry with vendoredIn and no resolver is an error, never a skip', async () => {
    const r = await probeEntries([vEntry()], stub({ 'GHSA-aaaa-bbbb-cccc': unpatched() }));
    expect(r.errors).toHaveLength(1);
    expect(exitCodeFor(r)).toBe(1);
  });

  it('a withdrawn advisory retires without touching the registry', async () => {
    let called = 0;
    const r = await probeEntries(
      [vEntry()],
      stub({ 'GHSA-aaaa-bbbb-cccc': { withdrawn_at: '2026-11-01', vulnerabilities: [] } }),
      {
        resolveVendored: async () => {
          called++;
          return { hostVersion: '1.0.0', vendoredVersion: '1.0.0' };
        },
      },
    );
    expect(r.findings).toHaveLength(1);
    expect(called).toBe(0);
  });

  it('pickNewestStable ignores prereleases and honours the range', () => {
    const vs = ['16.4.3', '16.4.6', '16.4.7-canary.1', '16.5.0', '16.5.1-rc.0'];
    expect(pickNewestStable(vs, '>=16.4.3 <16.5.0')).toBe('16.4.6');
    expect(() => pickNewestStable(['16.5.0-canary.1'], '>=16.4.3 <16.5.0')).toThrow();
    expect(() => pickNewestStable(vs, 'workspace:*')).toThrow();
  });

  it('validateVendoredIn rejects malformed declarations', () => {
    expect(validateVendoredIn(VENDORED, 'f', 'id').field).toBe('peerDependencies.react');
    const bad = (over: Record<string, unknown>) =>
      expect(() => validateVendoredIn({ ...VENDORED, ...over }, 'f', 'id')).toThrow();
    bad({ path: '../escape/package.json' });
    bad({ path: '/abs/package.json' });
    bad({ package: 'Not A Name' });
    bad({ patched: [] });
    bad({ patched: ['^19.3.1'] });
    bad({ range: '' });
    bad({ range: 'workspace:*' });
    bad({ field: 'a..b' });
  });
});

describe('vendored advisories: registry and tarball resolution', () => {
  const tgz = tgzOf(
    tarFile('package/dist/compiled/rsd/package.json', rsd('19.3.0-canary-x-20261002')),
  );

  it('reads the vendored version from the newest STABLE host tarball in range', async () => {
    const { fetchImpl, calls } = reg(['16.4.3', '16.4.6', '16.4.7-canary.1', '16.5.0'], tgz);
    const r = await makeResolveVendored(fetchImpl, noSleep)(VENDORED as never);
    expect(r).toEqual({ hostVersion: '16.4.6', vendoredVersion: '19.3.0-canary-x-20261002' });
    expect(calls.some((c) => c.includes('16.4.7-canary.1'))).toBe(false);
    expect(calls.some((c) => c.endsWith('next-16.4.6.tgz'))).toBe(true);
  });

  it('FAIL CLOSED: a tarball that fails its integrity check', async () => {
    const { fetchImpl } = reg(['16.4.6'], tgz, integrityOf(Buffer.from('other')));
    await expect(makeResolveVendored(fetchImpl, noSleep)(VENDORED as never)).rejects.toThrow(
      /integrity/,
    );
  });

  it('FAIL CLOSED: the vendored file is absent from the tarball', async () => {
    const { fetchImpl } = reg(['16.4.6'], tgzOf(tarFile('package/other.json', '{}')));
    await expect(makeResolveVendored(fetchImpl, noSleep)(VENDORED as never)).rejects.toThrow(
      /no package\//,
    );
  });

  it('FAIL CLOSED: the version field is missing or not a string', async () => {
    const { fetchImpl } = reg(
      ['16.4.6'],
      tgzOf(tarFile('package/dist/compiled/rsd/package.json', '{"peerDependencies":{}}')),
    );
    await expect(makeResolveVendored(fetchImpl, noSleep)(VENDORED as never)).rejects.toThrow(
      /not a string/,
    );
  });

  it('FAIL CLOSED: a registry error is retried a BOUNDED number of times, then thrown', async () => {
    let n = 0;
    const fetchImpl = (async () => {
      n++;
      return { ok: false, status: 503 };
    }) as never;
    await expect(makeResolveVendored(fetchImpl, noSleep)(VENDORED as never)).rejects.toThrow(/503/);
    expect(n).toBe(MAX_RETRIES + 1);
  });

  it('FAIL CLOSED: a network error is retried, then thrown', async () => {
    let n = 0;
    const fetchImpl = (async () => {
      n++;
      throw new Error('ECONNRESET');
    }) as never;
    await expect(makeResolveVendored(fetchImpl, noSleep)(VENDORED as never)).rejects.toThrow(
      /ECONNRESET/,
    );
    expect(n).toBe(MAX_RETRIES + 1);
  });

  it('a 404 is not retried', async () => {
    let n = 0;
    const fetchImpl = (async () => {
      n++;
      return { ok: false, status: 404 };
    }) as never;
    await expect(makeResolveVendored(fetchImpl, noSleep)(VENDORED as never)).rejects.toThrow(/404/);
    expect(n).toBe(1);
  });

  it('FAIL CLOSED: a tarball URL off the registry host is refused (nothing is fetched from it)', async () => {
    const calls: string[] = [];
    const fetchImpl = (async (url: string) => {
      calls.push(url);
      return ok({
        versions: {
          '16.4.6': { dist: { tarball: 'https://evil.example/next.tgz', integrity: 'sha512-x' } },
        },
      });
    }) as never;
    await expect(makeResolveVendored(fetchImpl, noSleep)(VENDORED as never)).rejects.toThrow(
      /not on/,
    );
    expect(calls).toHaveLength(1);
  });

  it('readTarEntry matches regular files only, by exact name', () => {
    const tar = Buffer.concat([
      tarFile('package/a.json', '{"a":1}', '5'),
      tarFile('package/b.json', '{"b":2}'),
      Buffer.alloc(1024),
    ]);
    expect(readTarEntry(tar, 'package/b.json')?.toString()).toBe('{"b":2}');
    expect(readTarEntry(tar, 'package/a.json')).toBeNull();
    expect(readTarEntry(tar, 'package/b')).toBeNull();
  });
});

describe('real allowlists: vendored entries', () => {
  it('every vendoredIn is valid, and GHSA-xqc2 (when present) declares one and keeps its expiry', () => {
    const file = 'security/precompile-closure-allowlist.json';
    const doc = JSON.parse(readFileSync(resolve(ROOT, file), 'utf8'));
    for (const e of doc.allow) {
      if (e.vendoredIn !== undefined) validateVendoredIn(e.vendoredIn, file, e.id);
    }
    const x = doc.allow.find((e: { id: string }) => e.id === 'GHSA-xqc2-xf4c-x3h3');
    if (x === undefined) return; // integration/v2 carries no such entry
    expect(x.expires).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    const v = validateVendoredIn(x.vendoredIn, file, x.id);
    expect(v.package).toBe('next');
    expect(v.patched).toContain('>= 19.3.1');
    expect(collectEntries(ROOT, [file]).some((e) => e.vendoredIn)).toBe(true);
  });
});
