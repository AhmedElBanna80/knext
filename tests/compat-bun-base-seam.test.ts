import { afterAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import {
  assertBaseMatchesCompiler,
  assertSeamAllowed,
  assertSourceRun,
  laneBunId,
  laneMuslImage,
  parseSums,
  signerIdentity,
} from '../scripts/compat-bun-base.mjs';

/**
 * #2804 (ADR-0072 item 3) — the dispatch-only patched Bun base for the compat bun lane.
 *
 * Two halves, both asserted. BEHAVIOUR: scripts/compat-bun-base.mjs is run for real with
 * gh/cosign/docker/bun stubbed on PATH, and every fail-closed check is shown to refuse (a check
 * that is deleted turns its case green-when-it-should-be-red). WIRING: the workflow passes the
 * verified base, and only it, to the fingerprint, the shards, the ledger scope and the summaries,
 * and the input is empty on every schedule event.
 */
const ROOT = resolve(import.meta.dirname, '..');
const SCRIPT = resolve(ROOT, 'scripts/compat-bun-base.mjs');
const WORKFLOW_TEXT = readFileSync(resolve(ROOT, '.github/workflows/test-e2e-deploy.yml'), 'utf8');
type Step = {
  name?: string;
  id?: string;
  if?: string;
  run?: string;
  uses?: string;
  env?: Record<string, string>;
};
type Job = { steps?: Step[]; outputs?: Record<string, string> };
const WF = parse(WORKFLOW_TEXT) as { env: Record<string, string>; jobs: Record<string, Job> };

const temps: string[] = [];
afterAll(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

const sha = (b: string | Buffer) => createHash('sha256').update(b).digest('hex');

interface World {
  /** The run JSON `gh api` returns. */
  run?: Record<string, unknown>;
  /** Exit code of the stub cosign. */
  cosign?: number;
  /** Corrupt the base after its sums are written. */
  tamper?: boolean;
  /** What the base prints for --revision. */
  baseRevision?: string;
  /** What `bun --version` prints. */
  compiler?: string;
  /** Number of bun-base-* artifacts `gh run download` lays down. */
  artifacts?: number;
  /** Write a different digest into the base's own .sha256 (the file the seam reads). */
  ownSha?: string;
}

/** Runs `fetch` with stubbed tools; returns the exit status, stderr and GITHUB_ENV text. */
function fetch(world: World, env: Record<string, string> = {}, extra: string[] = []) {
  const t = mkdtempSync(join(tmpdir(), 'knext-bun-base-'));
  temps.push(t);
  const bin = join(t, 'bin');
  mkdirSync(bin);
  const run = world.run ?? {
    path: '.github/workflows/bun-base-build.yml',
    status: 'completed',
    conclusion: 'success',
    head_branch: 'main',
  };
  writeFileSync(join(t, 'run.json'), JSON.stringify(run));
  // The artifact the stub `gh run download` lays down.
  const art = join(t, 'art');
  mkdirSync(art);
  const base = 'patched-base-bytes';
  writeFileSync(join(art, 'bun-linux-x64-musl'), base);
  writeFileSync(join(art, 'manifest.json'), '{}');
  const sums = `${sha(base)}  bun-linux-x64-musl\n${sha('{}')}  manifest.json\n`;
  writeFileSync(join(art, 'SHA256SUMS'), sums);
  writeFileSync(
    join(art, 'bun-linux-x64-musl.sha256'),
    `${world.ownSha ?? sha(base)}  bun-linux-x64-musl\n`,
  );
  writeFileSync(join(art, 'SHA256SUMS.sigstore.json'), '{}');
  if (world.tamper) writeFileSync(join(art, 'bun-linux-x64-musl'), 'other-bytes');
  const stub = (name: string, body: string) => {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  };
  const copies = Array.from(
    { length: world.artifacts ?? 1 },
    (_, i) => `mkdir -p "$D/bun-base-x-${i}" && cp -R "${art}/." "$D/bun-base-x-${i}/"`,
  ).join('\n');
  stub(
    'gh',
    `case "$1 $2" in
  "api "*) cat "${join(t, 'run.json')}" ;;
  "run download") while [ $# -gt 0 ]; do [ "$1" = -D ] && D="$2"; shift; done; mkdir -p "$D"; ${copies || ':'} ;;
  *) exit 9 ;;
esac`,
  );
  stub('cosign', `[ "$1" = verify-blob ] || exit 9\nexit ${world.cosign ?? 0}`);
  stub('docker', `echo "${world.baseRevision ?? '1.4.2+4e3fb0c65'}"`);
  stub('bun', `echo "${world.compiler ?? '1.4.2'}"`);
  const ghEnv = join(t, 'github-env');
  writeFileSync(ghEnv, '');
  const r = spawnSync(
    process.execPath,
    [SCRIPT, 'fetch', '--run-id', '123', '--repo', 'o/r', '--dir', join(t, 'dl'), ...extra],
    {
      encoding: 'utf8',
      env: {
        PATH: `${bin}:${process.env.PATH}`,
        KNEXT_RUNTIME: 'bun',
        KNEXT_COMPAT_MODE: 'early-warning',
        GITHUB_EVENT_NAME: 'workflow_dispatch',
        GITHUB_ENV: ghEnv,
        ...env,
      },
    },
  );
  return {
    status: r.status,
    stderr: r.stderr,
    ghEnv: readFileSync(ghEnv, 'utf8'),
    baseSha: sha(base),
  };
}

describe('compat-bun-base fetch — behaviour (stubbed tools, real script)', () => {
  it('a good run exports the base, its sha256 and a lane Bun id that is never a bare X.Y.Z', () => {
    const r = fetch({});
    expect(r.stderr).toBe('');
    expect(r.status).toBe(0);
    expect(r.ghEnv).toContain('/bun-linux-x64-musl\n');
    expect(r.ghEnv).toContain(`KNEXT_BUN_BASE_SHA256=${r.baseSha}\n`);
    expect(r.ghEnv).toContain(`KNEXT_BUN_BASE_ID=1.4.2+bun-base.${r.baseSha.slice(0, 12)}\n`);
  });

  it.each([
    ['a schedule event', {}, { GITHUB_EVENT_NAME: 'schedule' }, /dispatch-only/],
    ['credential mode', {}, { KNEXT_COMPAT_MODE: 'credential' }, /never a credential night/],
    ['the node lane', {}, { KNEXT_RUNTIME: 'node' }, /needs runtime=bun/],
    [
      'a run of another workflow',
      {
        run: {
          path: '.github/workflows/evil.yml',
          status: 'completed',
          conclusion: 'success',
          head_branch: 'main',
        },
      },
      {},
      /source run is/,
    ],
    [
      'a run on another branch',
      {
        run: {
          path: '.github/workflows/bun-base-build.yml',
          status: 'completed',
          conclusion: 'success',
          head_branch: 'fork-branch',
        },
      },
      {},
      /source run is/,
    ],
    [
      'a failed run',
      {
        run: {
          path: '.github/workflows/bun-base-build.yml',
          status: 'completed',
          conclusion: 'failure',
          head_branch: 'main',
        },
      },
      {},
      /source run is/,
    ],
    ['no artifact', { artifacts: 0 }, {}, /exactly one bun-base/],
    ['two artifacts', { artifacts: 2 }, {}, /exactly one bun-base/],
    ['a bad signature', { cosign: 1 }, {}, /cosign verify-blob failed/],
    ['a tampered base', { tamper: true }, {}, /bun-linux-x64-musl: sha256/],
    [
      'a .sha256 that disagrees with SHA256SUMS',
      { ownSha: 'e'.repeat(64) },
      {},
      /not the single SHA256SUMS line/,
    ],
    ['a base from another Bun release', { baseRevision: '1.4.4+a623dd48d' }, {}, /same release/],
    ['an unreadable base revision', { baseRevision: 'segfault' }, {}, /unreadable base --revision/],
  ] as const)('refuses %s (exit 1, nothing exported)', (_n, world, env, why) => {
    const r = fetch(world as World, env as Record<string, string>);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(why);
    expect(r.ghEnv).toBe('');
  });

  it('refuses bytes other than the ones the fingerprint folded (--expect-sha256)', () => {
    const r = fetch({}, {}, ['--expect-sha256', 'f'.repeat(64)]);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/fingerprint folded/);
    expect(fetch({}, {}, ['--expect-sha256', r.baseSha]).status).toBe(0);
  });
});

describe('compat-bun-base — pure checks', () => {
  it('signs as bun-base-build.yml on main', () => {
    expect(signerIdentity('getknext-dev/knext')).toBe(
      'https://github.com/getknext-dev/knext/.github/workflows/bun-base-build.yml@refs/heads/main',
    );
  });
  it('rejects a non-numeric run id', () => {
    expect(() =>
      assertSeamAllowed({
        runId: '1; rm',
        runtime: 'bun',
        compatMode: 'early-warning',
        eventName: 'workflow_dispatch',
      }),
    ).toThrow(/numeric run id/);
  });
  it('rejects a run that is still in progress', () => {
    expect(() =>
      assertSourceRun({
        path: '.github/workflows/bun-base-build.yml',
        status: 'in_progress',
        conclusion: 'success',
        head_branch: 'main',
      }),
    ).toThrow();
  });
  it('parses sha256sum lines and refuses malformed or duplicate ones', () => {
    expect(parseSums(`${'a'.repeat(64)}  f\n`).get('f')).toBe('a'.repeat(64));
    expect(() => parseSums('nope  f\n')).toThrow();
    expect(() => parseSums(`${'a'.repeat(64)}  f\n${'b'.repeat(64)}  f\n`)).toThrow(/twice/);
  });
  it('accepts a base of the compiler release only', () => {
    expect(() =>
      assertBaseMatchesCompiler({ compilerVersion: '1.4.2', baseRevision: '1.4.2+4e3fb0c65' }),
    ).not.toThrow();
    expect(() =>
      assertBaseMatchesCompiler({ compilerVersion: '1.4.2', baseRevision: '1.4.20+4e3fb0c65' }),
    ).toThrow();
  });
  it('a lane Bun id can never equal a stock version', () => {
    expect(laneBunId('1.4.2', 'a'.repeat(64))).toBe(`1.4.2+bun-base.${'a'.repeat(12)}`);
    expect(() => laneBunId('1.4.2', '')).toThrow();
  });
  it('boots the base in the musl image the lane boots the compiled exec in (one pin, read not copied)', () => {
    expect(laneMuslImage(ROOT)).toMatch(/^oven\/bun:[^@]+-alpine@sha256:[0-9a-f]{64}$/);
  });
});

describe('test-e2e-deploy.yml — the seam wiring', () => {
  const steps = (job: string) => WF.jobs[job]?.steps ?? [];
  const fetchSteps = (job: string) =>
    steps(job).filter((s) => s.run?.startsWith('node scripts/compat-bun-base.mjs fetch '));

  it('the input is empty on every schedule event (gated on the event AND the input)', () => {
    expect(WF.env.KNEXT_BUN_BASE_RUN_ID).toBe(
      "${{ github.event_name == 'workflow_dispatch' && github.event.inputs.bunBaseRunId || '' }}",
    );
  });

  it('every step that touches the seam is gated on it', () => {
    for (const job of ['build-next', 'deploy-tests']) {
      const touching = steps(job).filter(
        (s) =>
          s.uses?.startsWith('sigstore/cosign-installer@') ||
          s.run?.includes('compat-bun-base.mjs'),
      );
      expect(touching.length).toBe(2);
      for (const s of touching) expect(s.if).toBe("env.KNEXT_BUN_BASE_RUN_ID != ''");
    }
  });

  it('build-next fetches before it fingerprints, and exports the folded sha256', () => {
    const names = steps('build-next').map((s) => s.name);
    const fetchAt = steps('build-next').findIndex((s) => s.id === 'bun-base');
    expect(fetchAt).toBeGreaterThan(-1);
    expect(fetchAt).toBeLessThan(names.indexOf('Fingerprint the frozen compat-window set'));
    expect(WF.jobs['build-next']?.outputs?.bun_base_sha256).toBe(
      '${{ steps.bun-base.outputs.sha256 }}',
    );
    expect(fetchSteps('build-next')).toHaveLength(1);
  });

  it('every shard re-fetches and must get exactly the folded bytes', () => {
    const [s] = fetchSteps('deploy-tests');
    expect(s?.env?.FOLDED_SHA256).toBe('${{ needs.build-next.outputs.bun_base_sha256 }}');
    expect(s?.run).toContain('--expect-sha256 "${FOLDED_SHA256}"');
    const names = steps('deploy-tests').map((x) => x.name);
    expect(names.indexOf(s?.name)).toBeLessThan(
      names.indexOf('Scope ref-pinned per-case deselections to NEXTJS_REF'),
    );
  });

  it('the ledger is scoped to the base the lane runs, not to the stock compiler', () => {
    const scope = steps('deploy-tests').find(
      (x) => x.name === 'Scope ref-pinned per-case deselections to NEXTJS_REF',
    );
    expect(scope?.run).toContain('${KNEXT_BUN_BASE_ID:+--bun-version "${KNEXT_BUN_BASE_ID}"}');
  });

  it('the shard summary reports the lane Bun id, never the stock version, on a patched base', () => {
    expect(WORKFLOW_TEXT).toContain(
      '          if [ -n "${KNEXT_BUN_BASE_ID:-}" ]; then\n            RUNTIME_VERSION="${KNEXT_BUN_BASE_ID}"\n          fi\n          node scripts/e2e-summary.mjs \\',
    );
  });
});
