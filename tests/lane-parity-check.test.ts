import { afterAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import {
  checkLaneParity,
  formatManifest,
  recordLaneParity,
  validateManifest,
} from '../scripts/lib/lane-parity.mjs';

/**
 * #2170: the CI guard files must match across the release lanes, or the
 * difference must be recorded with a reason. The pure rules are tested on a
 * fake reader; the CLI is tested on a real git repository with three lanes, by
 * editing a guard on one lane only (the issue's exit criterion).
 */

const REPO = resolve(import.meta.dirname, '..');
const SCRIPT = join(REPO, 'scripts/lane-parity-check.mjs');

type Blobs = Record<string, Record<string, string | null>>;
const LANES = ['main', 'v2', 'v1'];

type Entry = {
  path: string;
  lane: string;
  here: string;
  there: string | null;
  reason: string;
  issue?: string;
};

function manifest(divergences: Entry[] = [], files = ['g.mjs']) {
  return { self: 'v2', lanes: LANES, files, divergences };
}
function reader(blobs: Blobs) {
  return (lane: string, path: string) => blobs[lane]?.[path] ?? null;
}
const REASON = 'differs on purpose for this test';

describe('checkLaneParity: the rules', () => {
  it('passes when every lane has the same bytes', () => {
    const b = { main: { 'g.mjs': 'a' }, v2: { 'g.mjs': 'a' }, v1: { 'g.mjs': 'a' } };
    expect(checkLaneParity({ manifest: manifest(), readBlob: reader(b) })).toEqual([]);
  });

  it('reds an unrecorded difference, naming the lane and both blobs', () => {
    const b = { main: { 'g.mjs': 'b' }, v2: { 'g.mjs': 'a' }, v1: { 'g.mjs': 'a' } };
    const f = checkLaneParity({ manifest: manifest(), readBlob: reader(b) });
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({
      kind: 'unexplained',
      path: 'g.mjs',
      lane: 'main',
      here: 'a',
      there: 'b',
    });
  });

  it('reds a file missing on another lane unless that is recorded (there: null)', () => {
    const b = { main: {}, v2: { 'g.mjs': 'a' }, v1: { 'g.mjs': 'a' } };
    expect(checkLaneParity({ manifest: manifest(), readBlob: reader(b) })[0]?.kind).toBe(
      'unexplained',
    );
    const rec = manifest([{ path: 'g.mjs', lane: 'main', here: 'a', there: null, reason: REASON }]);
    expect(checkLaneParity({ manifest: rec, readBlob: reader(b) })).toEqual([]);
  });

  it('passes a recorded difference, and reds it again when EITHER side changes', () => {
    const rec = manifest([{ path: 'g.mjs', lane: 'main', here: 'a', there: 'b', reason: REASON }]);
    const same = { main: { 'g.mjs': 'b' }, v2: { 'g.mjs': 'a' }, v1: { 'g.mjs': 'a' } };
    expect(checkLaneParity({ manifest: rec, readBlob: reader(same) })).toEqual([]);
    const thereMoved = { ...same, main: { 'g.mjs': 'c' } };
    expect(checkLaneParity({ manifest: rec, readBlob: reader(thereMoved) })[0]?.kind).toBe(
      'out-of-date',
    );
    // Here moved (v1 moved with it, so v1 still matches): only the recorded main
    // entry is now for other contents.
    const hereMoved = { main: { 'g.mjs': 'b' }, v2: { 'g.mjs': 'z' }, v1: { 'g.mjs': 'z' } };
    expect(
      checkLaneParity({ manifest: rec, readBlob: reader(hereMoved) }).map((x) => x.kind),
    ).toEqual(['out-of-date']);
  });

  it('reds a stale entry for a file that is identical again', () => {
    const rec = manifest([{ path: 'g.mjs', lane: 'main', here: 'a', there: 'b', reason: REASON }]);
    const b = { main: { 'g.mjs': 'a' }, v2: { 'g.mjs': 'a' }, v1: { 'g.mjs': 'a' } };
    expect(checkLaneParity({ manifest: rec, readBlob: reader(b) })[0]?.kind).toBe('stale');
  });

  it('reds a listed file that is missing on this lane', () => {
    const b = { main: { 'g.mjs': 'a' }, v2: {}, v1: { 'g.mjs': 'a' } };
    expect(checkLaneParity({ manifest: manifest(), readBlob: reader(b) })[0]?.kind).toBe(
      'missing-here',
    );
  });

  it.each([
    ['no reason', { path: 'g.mjs', lane: 'main', here: 'a', there: 'b', reason: '' }, /reason/],
    [
      'an unlisted path',
      { path: 'x.mjs', lane: 'main', here: 'a', there: 'b', reason: REASON },
      /not in `files`/,
    ],
    [
      'this lane as the other lane',
      { path: 'g.mjs', lane: 'v2', here: 'a', there: 'b', reason: REASON },
      /another lane/,
    ],
    [
      'an unknown lane',
      { path: 'g.mjs', lane: 'v9', here: 'a', there: 'b', reason: REASON },
      /another lane/,
    ],
  ])('rejects a divergence with %s', (_name, entry, msg) => {
    const f = validateManifest(manifest([entry]));
    expect(f.length).toBeGreaterThan(0);
    expect(f.map((x) => x.message).join('\n')).toMatch(msg);
  });

  it('requires a tracking issue on an UNPORTED difference', () => {
    const e = {
      path: 'g.mjs',
      lane: 'main',
      here: 'a',
      there: 'b',
      reason: 'UNPORTED from main: the fix',
    };
    expect(
      validateManifest(manifest([e]))
        .map((x) => x.message)
        .join(),
    ).toMatch(/tracking `issue`/);
    expect(validateManifest(manifest([{ ...e, issue: '#101' }]))).toEqual([]);
    expect(
      validateManifest(manifest([{ ...e, issue: 'soon' }]))
        .map((x) => x.message)
        .join(),
    ).toMatch(/#N/);
  });

  it('rejects a duplicate entry and a self lane missing from lanes', () => {
    const e = { path: 'g.mjs', lane: 'main', here: 'a', there: 'b', reason: REASON };
    expect(
      validateManifest(manifest([e, e]))
        .map((x) => x.message)
        .join(),
    ).toMatch(/twice/);
    expect(
      validateManifest({ ...manifest(), self: 'v7' })
        .map((x) => x.message)
        .join(),
    ).toMatch(/self/);
  });
});

describe('recordLaneParity: --record keeps the reasons and re-pins the blobs', () => {
  const entry = (here: string, there: string | null, extra: Partial<Entry> = {}): Entry => ({
    path: 'g.mjs',
    lane: 'main',
    here,
    there,
    reason: REASON,
    ...extra,
  });

  it('re-pins an out-of-date entry, keeping its reason and issue', () => {
    const b = { main: { 'g.mjs': 'c' }, v2: { 'g.mjs': 'd' }, v1: { 'g.mjs': 'd' } };
    const m = manifest([entry('a', 'b', { issue: '#7' })]);
    const r = recordLaneParity({ manifest: m, readBlob: reader(b) });
    expect(r.findings).toEqual([]);
    expect(r.manifest.divergences).toEqual([entry('d', 'c', { issue: '#7' })]);
    expect(r.changes).toEqual([
      { kind: 're-pinned', path: 'g.mjs', lane: 'main', from: ['a', 'b'], to: ['d', 'c'] },
    ]);
    // The input is not mutated.
    expect(m.divergences[0]?.here).toBe('a');
    // And the result passes the check.
    expect(checkLaneParity({ manifest: r.manifest, readBlob: reader(b) })).toEqual([]);
  });

  it('re-pins a file now absent on the other lane (there: null)', () => {
    const b = { main: {}, v2: { 'g.mjs': 'd' }, v1: { 'g.mjs': 'd' } };
    const r = recordLaneParity({ manifest: manifest([entry('a', 'b')]), readBlob: reader(b) });
    expect(r.manifest.divergences).toEqual([entry('d', null)]);
  });

  it('removes a stale entry (the file is identical again)', () => {
    const b = { main: { 'g.mjs': 'a' }, v2: { 'g.mjs': 'a' }, v1: { 'g.mjs': 'a' } };
    const r = recordLaneParity({ manifest: manifest([entry('a', 'b')]), readBlob: reader(b) });
    expect(r.manifest.divergences).toEqual([]);
    expect(r.changes).toEqual([{ kind: 'removed', path: 'g.mjs', lane: 'main' }]);
    expect(r.findings).toEqual([]);
  });

  it('never records an unexplained difference: there is no reason to keep', () => {
    const b = { main: { 'g.mjs': 'b' }, v2: { 'g.mjs': 'a' }, v1: { 'g.mjs': 'a' } };
    const m = manifest();
    const r = recordLaneParity({ manifest: m, readBlob: reader(b) });
    expect(r.manifest).toEqual(m);
    expect(r.changes).toEqual([]);
    expect(r.findings.map((f) => f.kind)).toEqual(['unexplained']);
  });

  it('changes nothing in an invalid manifest', () => {
    const m = { ...manifest([entry('a', 'b', { reason: 'short' })]) };
    const b = { main: { 'g.mjs': 'c' }, v2: { 'g.mjs': 'd' }, v1: { 'g.mjs': 'd' } };
    const r = recordLaneParity({ manifest: m, readBlob: reader(b) });
    expect(r.manifest).toEqual(m);
    expect(r.changes).toEqual([]);
    expect(r.findings[0]?.kind).toBe('manifest');
  });

  it('formatManifest writes the committed manifest back byte for byte', () => {
    const text = readFileSync(join(REPO, '.github/lane-parity.json'), 'utf8');
    expect(formatManifest(JSON.parse(text))).toBe(text);
  });
});

describe('the committed manifest', () => {
  const real = JSON.parse(readFileSync(join(REPO, '.github/lane-parity.json'), 'utf8'));

  it('is well formed and names this lane', () => {
    expect(validateManifest(real)).toEqual([]);
    expect(real.self).toBe('integration/v2');
    expect(real.lanes).toEqual(['main', 'integration/v2', 'integration/v1.3']);
  });

  it('the workflow runs on every v2 push and on a PR touching any listed file', () => {
    const wf = parse(readFileSync(join(REPO, '.github/workflows/lane-parity.yml'), 'utf8'));
    expect(wf.on.push.branches).toEqual(['integration/v2']);
    expect(wf.on.push.paths).toBeUndefined();
    expect(wf.on.pull_request.branches).toEqual(['integration/v2']);
    // Both halves: every guard file AND the checker's own files are in the filter.
    const paths: string[] = wf.on.pull_request.paths;
    for (const f of [
      ...real.files,
      '.github/lane-parity.json',
      '.github/workflows/lane-parity.yml',
      'scripts/lane-parity-check.mjs',
      'scripts/lib/lane-parity.mjs',
    ]) {
      expect(paths, f).toContain(f);
    }
    // A red push run reaches someone.
    expect(wf.jobs['lane-parity-alert'].if).toContain("needs.parity.result == 'failure'");
    expect(wf.jobs['lane-parity-alert'].if).toContain("needs.parity.result == 'cancelled'");
  });

  it("matches this checkout's blobs for every recorded difference", () => {
    // The other lanes are checked by the workflow (they need a fetch); this half
    // runs anywhere: an entry whose `here` is not this tree's blob is out of date.
    for (const d of real.divergences) {
      const r = spawnSync('git', ['rev-parse', `HEAD:${d.path}`], { cwd: REPO, encoding: 'utf8' });
      const blob = spawnSync('git', ['hash-object', d.path], {
        cwd: REPO,
        encoding: 'utf8',
      }).stdout.trim();
      expect(r.status, d.path).toBe(0);
      expect(d.here, `${d.path} vs ${d.lane}`).toBe(blob);
    }
  });
});

// ── the CLI, on a real repository with three lanes ───────────────────────────

const work = mkdtempSync(join(tmpdir(), 'knext-lane-parity-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', ['-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
}

function setup(name: string) {
  const origin = join(work, `${name}-origin`);
  const clone = join(work, `${name}-clone`);
  git(work, 'init', '-q', '-b', 'main', origin);
  git(origin, 'config', 'user.email', 't@t');
  git(origin, 'config', 'user.name', 't');
  writeFileSync(join(origin, 'g.mjs'), 'export const guard = 1;\n');
  git(origin, 'add', 'g.mjs');
  git(origin, 'commit', '-q', '-m', 'guard');
  git(origin, 'branch', 'v2');
  git(origin, 'branch', 'v1');
  git(work, 'clone', '-q', '-b', 'v2', origin, clone);
  const m = join(clone, 'lane-parity.json');
  writeFileSync(m, JSON.stringify(manifest()));
  return { origin, clone, m };
}

function run(clone: string, m: string) {
  return spawnSync('node', [SCRIPT, '--manifest', m], {
    cwd: clone,
    encoding: 'utf8',
    env: { ...process.env, LANE_PARITY_REMOTE: 'origin' },
  });
}

describe('lane-parity-check.mjs on a real repository', () => {
  it('passes at parity, and reds when a guard is edited on ONE lane only', () => {
    const { origin, clone, m } = setup('one-lane');
    expect(run(clone, m).status).toBe(0);
    // The guard fix lands on main and nowhere else: defect class D.
    git(origin, 'checkout', '-q', 'main');
    writeFileSync(join(origin, 'g.mjs'), 'export const guard = 2;\n');
    git(origin, 'commit', '-q', '-am', 'fix the guard on main only');
    git(clone, 'fetch', '-q', 'origin');
    const r = run(clone, m);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('g.mjs differs from main, and no divergence is recorded');
  });

  it('passes once the difference is recorded with both blobs and a reason', () => {
    const { origin, clone, m } = setup('recorded');
    git(origin, 'checkout', '-q', 'main');
    writeFileSync(join(origin, 'g.mjs'), 'export const guard = 2;\n');
    git(origin, 'commit', '-q', '-am', 'main only');
    git(clone, 'fetch', '-q', 'origin');
    const here = git(clone, 'rev-parse', 'HEAD:g.mjs');
    const there = git(clone, 'rev-parse', 'origin/main:g.mjs');
    writeFileSync(
      m,
      JSON.stringify(manifest([{ path: 'g.mjs', lane: 'main', here, there, reason: REASON }])),
    );
    expect(run(clone, m).status).toBe(0);
  });

  it('--record re-pins a changed difference, keeps its reason, and the plain check then passes', () => {
    const { origin, clone, m } = setup('record');
    git(origin, 'checkout', '-q', 'main');
    writeFileSync(join(origin, 'g.mjs'), 'export const guard = 2;\n');
    git(origin, 'commit', '-q', '-am', 'main only');
    git(clone, 'fetch', '-q', 'origin');
    const here = git(clone, 'rev-parse', 'HEAD:g.mjs');
    writeFileSync(
      m,
      formatManifest(
        manifest([
          { path: 'g.mjs', lane: 'main', here, there: 'old', reason: REASON, issue: '#7' },
        ]),
      ),
    );
    expect(run(clone, m).status).toBe(1);
    const r = spawnSync('node', [SCRIPT, '--manifest', m, '--record'], {
      cwd: clone,
      encoding: 'utf8',
      env: { ...process.env, LANE_PARITY_REMOTE: 'origin' },
    });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain('re-pinned g.mjs vs main');
    const written = JSON.parse(readFileSync(m, 'utf8'));
    expect(written.divergences).toEqual([
      {
        path: 'g.mjs',
        lane: 'main',
        here,
        there: git(clone, 'rev-parse', 'origin/main:g.mjs'),
        reason: REASON,
        issue: '#7',
      },
    ]);
    expect(run(clone, m).status).toBe(0);
  });

  it('--record leaves the manifest untouched and exits 1 on an unexplained difference', () => {
    const { origin, clone, m } = setup('record-unexplained');
    git(origin, 'checkout', '-q', 'main');
    writeFileSync(join(origin, 'g.mjs'), 'export const guard = 2;\n');
    git(origin, 'commit', '-q', '-am', 'main only');
    git(clone, 'fetch', '-q', 'origin');
    const before = readFileSync(m, 'utf8');
    const r = spawnSync('node', [SCRIPT, '--manifest', m, '--record'], {
      cwd: clone,
      encoding: 'utf8',
      env: { ...process.env, LANE_PARITY_REMOTE: 'origin' },
    });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('no divergence is recorded');
    expect(readFileSync(m, 'utf8')).toBe(before);
  });

  it('fails closed (exit 2) when another lane cannot be read', () => {
    const { clone, m } = setup('unreadable');
    writeFileSync(m, JSON.stringify({ ...manifest(), lanes: [...LANES, 'v9'] }));
    const r = run(clone, m);
    expect(r.status).toBe(2);
    expect(r.stderr).toContain('cannot read lane v9');
  });
});
