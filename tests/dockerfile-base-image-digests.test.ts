/**
 * #2660 — Dockerfile base-image digests: form AND consistency at PR time.
 *
 * The two older guards check that a `FROM` carries `@sha256:`. Neither notices
 * the same `repo:tag` pinned to two different digests, so the operator image
 * (the control plane) sat on a different `distroless/static:nonroot` base than
 * every other image, and nothing was red. Resolving a digest against the
 * registry is a RUN-time question (nightly, scripts/verify-image-pins.mjs); this
 * file owns FORM and SCOPE: scan, never enumerate, and fail on anything it
 * cannot parse.
 */
import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parse } from 'yaml';
import {
  checkDockerfiles,
  discoverDockerfiles,
  loadExclusions,
  parseDockerfileRefs,
} from '../scripts/lib/dockerfile-base-images.mjs';
import { verifyRepo } from '../scripts/verify-image-pins.mjs';
import { globToRegExp } from './helpers/blocking-gate';

const ROOT = resolve(import.meta.dirname, '..');
const A = `sha256:${'a'.repeat(64)}`;
const B = `sha256:${'b'.repeat(64)}`;
const DS = 'gcr.io/distroless/static:nonroot';
const TODAY = new Date('2026-11-02T00:00:00Z');

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop() as string, { recursive: true, force: true });
});
function fixture(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), 'dfdigest-'));
  dirs.push(root);
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  return root;
}
const reasons = (r: { findings: { reason: string }[] }) => r.findings.map((f) => f.reason);

describe('parseDockerfileRefs', () => {
  it('classifies pinned, unpinned, scratch, stage alias and unparseable FROMs', () => {
    const refs = parseDockerfileRefs(
      [
        `FROM --platform=$BUILDPLATFORM golang:1.26@${A} AS build`,
        'FROM alpine:3.20',
        'FROM scratch',
        'FROM build',
        `FROM \${BASE}`,
        `# FROM commented:1@${B}`,
      ].join('\n'),
      'x/Dockerfile',
    );
    // `scratch` and stage aliases pull nothing external, so they are not refs.
    expect(refs.map((r: { kind: string }) => r.kind)).toEqual([
      'pinned',
      'unpinned',
      'unparseable',
    ]);
    expect(refs[0]).toMatchObject({ key: 'registry-1.docker.io/library/golang:1.26', digest: A });
  });

  it('treats COPY --from=<image> as an external reference but --from=<stage> as not', () => {
    const refs = parseDockerfileRefs(
      `FROM alpine:3.22@${A} AS b\nCOPY --from=b /a /a\nCOPY --from=busybox:1.36 /x /x\n`,
      'x/Dockerfile',
    );
    expect(refs.filter((r: { kind: string }) => r.kind === 'unpinned')).toHaveLength(1);
  });
});

describe('checkDockerfiles (fixtures, both halves)', () => {
  it('passes a consistent tree and reports what it scanned', () => {
    const root = fixture({
      'a/Dockerfile': `FROM ${DS}@${A}\n`,
      'b/Dockerfile.hbs': `FROM ${DS}@${A}\n`,
      'c/gateway.Dockerfile': `FROM ${DS}@${A}\n`,
    });
    const r = checkDockerfiles(root, { exclusions: [], today: TODAY });
    expect(r.findings).toEqual([]);
    expect(r.files).toHaveLength(3);
  });

  it('FAILS when one tag maps to two digests, naming both files', () => {
    const root = fixture({
      'a/Dockerfile': `FROM ${DS}@${A}\n`,
      'b/Dockerfile': `FROM ${DS}@${B}\n`,
    });
    const r = checkDockerfiles(root, { exclusions: [], today: TODAY });
    expect(reasons(r)).toEqual(['tag-digest-conflict']);
    expect(JSON.stringify(r.findings)).toContain('a/Dockerfile');
    expect(JSON.stringify(r.findings)).toContain('b/Dockerfile');
  });

  it('does not conflate different tags of one repo', () => {
    const root = fixture({
      'a/Dockerfile': `FROM alpine:3.22@${A}\n`,
      'b/Dockerfile': `FROM alpine:3.20@${B}\n`,
    });
    expect(checkDockerfiles(root, { exclusions: [], today: TODAY }).findings).toEqual([]);
  });

  it('FAILS a reference with no digest', () => {
    const root = fixture({ 'a/Dockerfile': 'FROM alpine:3.20\n' });
    expect(reasons(checkDockerfiles(root, { exclusions: [], today: TODAY }))).toEqual(['unpinned']);
  });

  it('FAILS an unparseable reference instead of skipping it', () => {
    const root = fixture({ 'a/Dockerfile': `ARG BASE\nFROM \${BASE}\n` });
    expect(reasons(checkDockerfiles(root, { exclusions: [], today: TODAY }))).toEqual([
      'unparseable',
    ]);
  });

  it('FAILS closed when it finds no Dockerfile at all', () => {
    const root = fixture({ 'README.md': 'x' });
    expect(reasons(checkDockerfiles(root, { exclusions: [], today: TODAY }))).toEqual([
      'no-dockerfiles',
    ]);
  });

  it('scans, not enumerates: a Dockerfile in a new directory is covered', () => {
    const root = fixture({
      'brand/new/place/Dockerfile.oke': 'FROM node:24-alpine\n',
      'node_modules/x/Dockerfile': 'FROM ignored\n',
    });
    expect(discoverDockerfiles(root)).toEqual(['brand/new/place/Dockerfile.oke']);
  });

  describe('exclusions', () => {
    const ex = (over: object) => ({
      file: 'a/Dockerfile',
      covers: ['unpinned'],
      justification: 'bakeoff artifact, never shipped',
      added: '2026-11-01',
      expires: '2026-12-01',
      ...over,
    });
    const root = () => fixture({ 'a/Dockerfile': 'FROM alpine:3.20\n' });

    it('a dated, justified, unexpired exclusion suppresses exactly its finding', () => {
      expect(checkDockerfiles(root(), { exclusions: [ex({})], today: TODAY }).findings).toEqual([]);
    });
    it('is scoped: a different file or a different check is NOT suppressed', () => {
      expect(
        reasons(
          checkDockerfiles(root(), { exclusions: [ex({ file: 'z/Dockerfile' })], today: TODAY }),
        ),
      ).toContain('unpinned');
      expect(
        reasons(
          checkDockerfiles(root(), { exclusions: [ex({ covers: ['unparseable'] })], today: TODAY }),
        ),
      ).toContain('unpinned');
    });
    it('an EXPIRED exclusion stops suppressing and is itself reported', () => {
      const r = checkDockerfiles(root(), {
        exclusions: [ex({ expires: '2026-10-01' })],
        today: TODAY,
      });
      expect(reasons(r)).toContain('unpinned');
      expect(reasons(r)).toContain('exclusion-expired');
    });
    it('an exclusion without justification, date or expiry is invalid', () => {
      for (const bad of [{ justification: '' }, { added: undefined }, { expires: undefined }]) {
        const r = checkDockerfiles(root(), { exclusions: [ex(bad)], today: TODAY });
        expect(reasons(r)).toContain('exclusion-invalid');
        expect(reasons(r)).toContain('unpinned');
      }
    });
  });
});

describe('the real tree', () => {
  it('every Dockerfile reference is digest-pinned and tag-consistent', () => {
    const r = checkDockerfiles(ROOT, { exclusions: loadExclusions(ROOT), today: new Date() });
    expect(r.findings).toEqual([]);
    // Not vacuous: the scan really reaches the shipped images.
    expect(r.files).toContain('packages/kn-next-operator/Dockerfile');
    expect(r.files).toContain('packages/scale-zero-pg/gateway/Dockerfile');
    expect(r.files).toContain('templates/rust/Dockerfile');
  });

  it('the operator and the other distroless users share ONE digest', () => {
    const r = checkDockerfiles(ROOT, { exclusions: loadExclusions(ROOT), today: new Date() });
    const users = r.refs.filter(
      (x: { key?: string }) => x.key === 'gcr.io/distroless/static:nonroot',
    );
    expect(users.length).toBeGreaterThanOrEqual(4);
    expect(new Set(users.map((x: { digest?: string }) => x.digest)).size).toBe(1);
  });

  it('without ANY exclusion, the only digest-less FROM is the locally built bake-off image', () => {
    const r = checkDockerfiles(ROOT, { exclusions: [], today: new Date() });
    const unpinned = r.findings
      .filter((f: { reason: string }) => f.reason === 'unpinned')
      .map((f: { image?: string }) => f.image);
    expect(unpinned).toEqual(['scale-zero-pg/gateway:dev']);
  });
});

describe('nightly resolution covers Dockerfiles (run-time half)', () => {
  const nightlyRoot = () =>
    fixture({
      'packages/kn-next-operator/x.go': '// nothing\n',
      'a/Dockerfile': `FROM ${DS}@${A}\n`,
    });

  it('verifyRepo resolves a Dockerfile pin and flags a digest that is not its tag', async () => {
    const root = nightlyRoot();
    const bad = await verifyRepo(root, {
      api: async () => ({ status: 200, digest: B }),
      exclusions: [],
    });
    expect(bad.findings.map((f: { reason: string }) => f.reason)).toEqual(['digest-mismatch']);
    const ok = await verifyRepo(root, {
      api: async () => ({ status: 200, digest: A }),
      exclusions: [],
    });
    expect(ok.findings).toEqual([]);
  });

  it('an unreachable registry is a failure, never a pass', async () => {
    const api = async () => {
      throw new Error('ENOTFOUND');
    };
    const { findings } = await verifyRepo(nightlyRoot(), { api, exclusions: [] });
    expect(findings.map((f: { reason: string }) => f.reason)).toEqual(['api-error']);
  });

  it('registry-resolution exclusions are scoped and expire', async () => {
    const root = nightlyRoot();
    const api = async () => ({ status: 200, digest: B });
    const exclusion = {
      image: DS,
      covers: ['registry-resolution'],
      justification: 'tag drifted; bump pending',
      added: '2026-11-01',
      expires: '2026-12-01',
    };
    const live = await verifyRepo(root, { api, exclusions: [exclusion], today: TODAY });
    expect(live.findings).toEqual([]);
    const dead = await verifyRepo(root, {
      api,
      exclusions: [{ ...exclusion, expires: '2026-10-01' }],
      today: TODAY,
    });
    expect(dead.findings.map((f: { reason: string }) => f.reason)).toContain('digest-mismatch');
    const other = await verifyRepo(root, {
      api,
      exclusions: [{ ...exclusion, image: 'alpine:3.22' }],
      today: TODAY,
    });
    expect(other.findings.map((f: { reason: string }) => f.reason)).toContain('digest-mismatch');
  });
});

describe('the nightly trigger covers every Dockerfile the scan reaches', () => {
  it('each discovered Dockerfile matches a pull_request path of the nightly', () => {
    const wf = parse(
      readFileSync(join(ROOT, '.github/workflows/image-pin-resolution-nightly.yml'), 'utf8'),
    ) as { on: { pull_request: { paths: string[] } } };
    const patterns = wf.on.pull_request.paths.map(globToRegExp);
    const uncovered = discoverDockerfiles(ROOT).filter(
      (f: string) => !patterns.some((re) => re.test(f)),
    );
    expect(uncovered).toEqual([]);
  });
});
