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
  for (const root of dirs.splice(0)) rmSync(root, { recursive: true, force: true });
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

describe('parseDockerfileRefs: references the line-by-line reader used to miss (#2665)', () => {
  const kinds = (text: string) =>
    parseDockerfileRefs(text, 'x/Dockerfile').map((r: { kind: string }) => r.kind);

  it('reads a COPY --from=<image> whose flag sits on a continuation line', () => {
    const text = `FROM alpine:3.22@${A}\nCOPY \\\n  --chown=1:1 \\\n  --from=busybox:1.36 \\\n  /x /x\n`;
    expect(kinds(text)).toEqual(['pinned', 'unpinned']);
  });

  it('reports the line where the instruction STARTS', () => {
    const text = `FROM alpine:3.22@${A}\nCOPY \\\n  --from=busybox:1.36 /x /x\n`;
    expect(parseDockerfileRefs(text, 'x/Dockerfile')[1]).toMatchObject({ line: 2, origin: 'COPY' });
  });

  it('reads RUN --mount=type=bind,from=<image> and ignores a stage name', () => {
    const text =
      `FROM alpine:3.22@${A} AS tools\n` +
      'RUN --mount=type=bind,from=busybox:1.36,target=/b true\n' +
      'RUN --mount=type=bind,from=tools,target=/t true\n';
    const refs = parseDockerfileRefs(text, 'x/Dockerfile');
    expect(refs.map((r: { kind: string }) => r.kind)).toEqual(['pinned', 'unpinned']);
    expect(refs[1]).toMatchObject({ origin: 'RUN', image: 'busybox:1.36' });
  });

  it('accepts both new shapes once they carry a digest', () => {
    const text =
      `FROM alpine:3.22@${A}\n` +
      `COPY \\\n  --from=busybox:1.36@${B} /x /x\n` +
      `RUN --mount=type=bind,from=busybox:1.36@${B},target=/b true\n`;
    expect(kinds(text)).toEqual(['pinned', 'pinned', 'pinned']);
  });

  it('checkDockerfiles FAILS both shapes unless pinned', () => {
    const cont = fixture({
      'a/Dockerfile': `FROM alpine:3.22@${A}\nCOPY \\\n --from=busybox:1.36 /x /x\n`,
    });
    const mount = fixture({
      'a/Dockerfile': `FROM alpine:3.22@${A}\nRUN --mount=type=bind,from=busybox:1.36,target=/b true\n`,
    });
    expect(reasons(checkDockerfiles(cont, { exclusions: [], today: TODAY }))).toEqual(['unpinned']);
    expect(reasons(checkDockerfiles(mount, { exclusions: [], today: TODAY }))).toEqual([
      'unpinned',
    ]);
  });
});

describe('parseDockerfileRefs: constructs the first parser missed or over-flagged (#2712)', () => {
  const refsOf = (text: string) =>
    parseDockerfileRefs(text, 'x/Dockerfile') as {
      kind: string;
      origin: string;
      image: string;
      line: number;
    }[];
  const kinds = (text: string) => refsOf(text).map((r) => r.kind);
  const BASE = `FROM alpine:3.22@${A} AS b\n`;

  describe('silent misses (an unpinned image must not pass)', () => {
    it('reads a quoted key inside a mount value', () => {
      const text = `${BASE}RUN --mount=type=bind,"from=evil:1",target=/e true\n`;
      expect(refsOf(text)[1]).toMatchObject({ kind: 'unpinned', origin: 'RUN', image: 'evil:1' });
    });

    it('reads a quoted field that holds a space', () => {
      expect(kinds(`${BASE}RUN --mount=type=bind,"target=/a b",from=evil:1 true\n`)).toEqual([
        'pinned',
        'unpinned',
      ]);
    });

    it('FAILS a mount whose quoting it cannot read, instead of skipping it', () => {
      expect(kinds(`${BASE}RUN --mount=type=bind,"from=evil:1 true\n`)).toEqual([
        'pinned',
        'unparseable',
      ]);
      expect(kinds(`${BASE}RUN --mount=type=bind,fr"om=evil:1" true\n`)).toEqual([
        'pinned',
        'unparseable',
      ]);
    });

    it('FAILS an unclosed quote in an earlier flag that would swallow a later mount', () => {
      const text = `${BASE}RUN --network="none --mount=type=bind,from=evil:1,target=/e true\n`;
      expect(kinds(text)).toEqual(['pinned', 'unparseable']);
    });

    it('reads a quoted COPY --from value', () => {
      expect(kinds(`${BASE}COPY --from="busybox:1.36" /x /x\n`)).toEqual(['pinned', 'unpinned']);
    });

    it('reads instructions behind ONBUILD', () => {
      const text =
        `${BASE}ONBUILD COPY --from=busybox:1.36 /x /x\n` +
        'ONBUILD RUN --mount=type=bind,from=evil:1,target=/e true\n' +
        `ONBUILD copy --from=busybox:1.36@${B} /y /y\n`;
      expect(refsOf(text).map((r) => [r.kind, r.origin])).toEqual([
        ['pinned', 'FROM'],
        ['unpinned', 'COPY'],
        ['unpinned', 'RUN'],
        ['pinned', 'COPY'],
      ]);
    });

    it('honours # escape=` so a backtick continuation is joined', () => {
      const text = `# escape=\`\n${BASE}COPY \`\n  --from=busybox:1.36 \`\n  /x /x\n`;
      expect(refsOf(text)[1]).toMatchObject({ kind: 'unpinned', origin: 'COPY', line: 3 });
    });

    it('with # escape=` a trailing backslash does NOT join the next line', () => {
      // Under the default escape this FROM would be swallowed into the RUN line.
      const text = `# escape=\`\nFROM alpine:3.22@${A}\nRUN echo C:\\\nFROM busybox:1.36\n`;
      expect(kinds(text)).toEqual(['pinned', 'unpinned']);
    });

    it('does not honour an escape directive that is not at the top', () => {
      // Default escape stays in force, so the trailing backslash DOES join the FROM below.
      const text = `FROM alpine:3.22@${A}\n# escape=\`\nRUN echo C:\\\nFROM busybox:1.36\n`;
      expect(kinds(text)).toEqual(['pinned']);
    });

    it('FAILS an escape directive with an unusable character', () => {
      expect(kinds(`# escape=x\nFROM alpine:3.22@${A}\n`)).toEqual(['unparseable', 'pinned']);
    });
  });

  describe('false positives (a stage reference is not an image)', () => {
    it('treats a numeric RUN --mount from= as a stage index when that stage exists', () => {
      expect(kinds(`${BASE}RUN --mount=type=bind,from=0,target=/e true\n`)).toEqual(['pinned']);
    });

    it('treats a numeric COPY --from as a stage index only when that stage exists', () => {
      expect(kinds(`${BASE}COPY --from=0 /x /x\n`)).toEqual(['pinned']);
      // Index 1 is out of range with one stage: Docker would read it as an image.
      expect(kinds(`${BASE}COPY --from=1 /x /x\n`)).toEqual(['pinned', 'unpinned']);
      expect(kinds('COPY --from=0 /x /x\n')).toEqual(['unpinned']);
    });

    it('matches stage names case-insensitively, as Docker does', () => {
      const text =
        `FROM alpine:3.22@${A} AS Builder\n` +
        'COPY --from=builder /x /x\n' +
        'RUN --mount=type=bind,from=BUILDER,target=/e true\n' +
        'FROM BUILDER AS second\n' +
        'COPY --from=Second /y /y\n';
      expect(kinds(text)).toEqual(['pinned']);
    });

    it('does not read the body of a heredoc as instructions', () => {
      const text = `${BASE}RUN <<EOF\nFROM evil:1\nCOPY --from=evil:2 /a /a\nRUN --mount=from=evil:3 x\nEOF\n`;
      expect(kinds(text)).toEqual(['pinned']);
    });

    it('handles <<-, quoted delimiters, several heredocs and a continued start line', () => {
      const text =
        `${BASE}RUN <<-'END'\n\tFROM evil:1\n\tEND\n` +
        'COPY <<ONE <<"TWO" /x/\nFROM evil:2\nONE\nFROM evil:3\nTWO\n' +
        'RUN python3 - \\\n  <<PY\nFROM evil:4\nPY\n' +
        'COPY --from=busybox:1.36 /z /z\n';
      expect(kinds(text)).toEqual(['pinned', 'unpinned']);
    });

    it('does not mistake a here-string for a heredoc', () => {
      const text = `${BASE}RUN cat <<<"hello"\nCOPY --from=busybox:1.36 /x /x\n`;
      expect(kinds(text)).toEqual(['pinned', 'unpinned']);
    });

    it('does not read --mount= in the shell text of a RUN as a flag', () => {
      expect(kinds(`${BASE}RUN echo --mount=type=bind,from=evil:1\n`)).toEqual(['pinned']);
    });

    it('FAILS an unterminated heredoc instead of silently swallowing the file', () => {
      const text = `${BASE}RUN <<EOF\nCOPY --from=busybox:1.36 /x /x\n`;
      expect(kinds(text)).toEqual(['pinned', 'unparseable']);
    });
  });

  it('checkDockerfiles FAILS each silent-miss shape end to end', () => {
    const tree = (body: string) =>
      reasons(
        checkDockerfiles(fixture({ 'a/Dockerfile': `FROM alpine:3.22@${A} AS b\n${body}` }), {
          exclusions: [],
          today: TODAY,
        }),
      );
    expect(tree('RUN --mount=type=bind,"from=evil:1" true\n')).toEqual(['unpinned']);
    expect(tree('ONBUILD COPY --from=evil:1 /x /x\n')).toEqual(['unpinned']);
    expect(tree('RUN --mount=type=bind,"from=evil:1 true\n')).toEqual(['unparseable']);
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

describe('an exclusion cannot mask a digest other than the one it names (#2665)', () => {
  const entry = (over: object) => ({
    file: 'a/Dockerfile',
    digest: A,
    covers: ['registry-resolution'],
    justification: 'tag drifted; bump pending',
    added: '2026-11-01',
    expires: '2026-12-01',
    ...over,
  });
  const api = async () => ({ status: 200, digest: B });
  const rootWith = (digest: string) => fixture({ 'a/Dockerfile': `FROM ${DS}@${digest}\n` });
  const mismatch = ['digest-mismatch'];

  it('suppresses the drift of the exact file + digest it names', async () => {
    const r = await verifyRepo(rootWith(A), { api, exclusions: [entry({})], today: TODAY });
    expect(r.findings).toEqual([]);
  });

  it('does NOT suppress the same file once re-pinned to a different (wrong) digest', async () => {
    const r = await verifyRepo(rootWith(`sha256:${'c'.repeat(64)}`), {
      api,
      exclusions: [entry({})],
      today: TODAY,
    });
    expect(r.findings.map((f: { reason: string }) => f.reason)).toEqual(mismatch);
  });

  it('does NOT suppress the same digest in a different file', async () => {
    const r = await verifyRepo(rootWith(A), {
      api,
      exclusions: [entry({ file: 'z/Dockerfile' })],
      today: TODAY,
    });
    expect(r.findings.map((f: { reason: string }) => f.reason)).toEqual(mismatch);
  });

  it('a registry-resolution exclusion without `file` + `digest` is invalid and suppresses nothing', async () => {
    for (const bad of [{ digest: undefined }, { file: undefined, image: DS }]) {
      const r = await verifyRepo(rootWith(A), { api, exclusions: [entry(bad)], today: TODAY });
      expect(r.findings.map((f: { reason: string }) => f.reason)).toEqual(mismatch);
      const c = checkDockerfiles(rootWith(A), { exclusions: [entry(bad)], today: TODAY });
      expect(reasons(c)).toContain('exclusion-invalid');
    }
  });
});

describe('the real tree', () => {
  it('every committed exclusion names an exact file, and registry ones a digest', () => {
    const allow = loadExclusions(ROOT) as { file?: string; digest?: string; covers: string[] }[];
    for (const e of allow) {
      expect(e.file).toBeTruthy();
      if (e.covers.includes('registry-resolution')) {
        expect(e.digest).toMatch(/^sha256:[0-9a-f]{64}$/);
      }
    }
  });

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
      file: 'a/Dockerfile',
      digest: A,
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
