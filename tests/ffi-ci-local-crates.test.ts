/**
 * The generator step of .github/workflows/rust-crates.yml must build the
 * `knext ffi init` crate without contacting the knext remote, while the crate
 * the user gets keeps its git + rev dependency. Both halves are asserted.
 *
 * S9-4 adds the egress proof: with github.com routed to a refused proxy, the
 * local rewrite must still serve the recorded revision, and a control with the
 * rewrite removed must be refused. The git half runs here with real git. The
 * cargo half also needs crates.io (knext-ffi pulls serde), so it runs as the
 * `Generator — egress denied` CI step; this file guards that step's shape and
 * the wiring of the probe.
 */

import { afterAll, describe, expect, it } from 'bun:test';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';
import {
  assertRevOnBase,
  cargoEgressProbe,
  DENIED_PROXY,
  egressVerdict,
  githubDenialGitConfig,
  localCrateSourceEnv,
  type ProbeRun,
} from '../crates/harness/local-crates-source';
import { CRATE_GIT, recordedCrateRev, runInit } from '../packages/ffi/src/init';

const ROOT = resolve(import.meta.dir, '..');
const WORKFLOW = readFileSync(join(ROOT, '.github', 'workflows', 'rust-crates.yml'), 'utf8');
const HARNESS = readFileSync(join(ROOT, 'crates', 'harness', 'ffi-generated.ts'), 'utf8');
const EGRESS_SCRIPT = readFileSync(
  join(ROOT, 'crates', 'harness', 'ffi-egress-offline.ts'),
  'utf8',
);
const INIT_STEP = 'Generator — knext ffi init';
const EGRESS_STEP = 'Generator — egress denied';
const REPO = '/work/knext';
const REV = 'ab'.repeat(20);

/** The raw text of the workflow step whose name is `name` (up to the next step). */
function stepBlock(name: string): string {
  const start = WORKFLOW.indexOf(`      - name: ${name}`);
  expect(start).toBeGreaterThan(-1);
  const next = WORKFLOW.indexOf('\n      - name:', start + 1);
  const end = next === -1 ? WORKFLOW.indexOf('\n  # ', start) : next;
  return WORKFLOW.slice(start, end);
}

type Step = { name?: string; run?: string; env?: Record<string, string>; [k: string]: unknown };
type Job = { steps: Step[]; [k: string]: unknown };
const crates = (parse(WORKFLOW) as { jobs: Record<string, Job> }).jobs.crates;

/** The git config dir for the egress tests; removed after the suite. */
const CFG_DIR = mkdtempSync(join(tmpdir(), 'knext-egress-cfg-'));
afterAll(() => rmSync(CFG_DIR, { recursive: true, force: true }));

/**
 * The environment of the egress proof: no ambient git config, github.com routed
 * to the refused proxy, plus `extra`. Built from the process env minus any
 * GIT_CONFIG_* so a CI-wide rewrite cannot leak into the control.
 */
function egressEnv(extra: Record<string, string>): Record<string, string> {
  const base: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (v !== undefined && !k.startsWith('GIT_CONFIG_')) base[k] = v;
  }
  const cfg = join(CFG_DIR, `gitconfig-${Math.random().toString(36).slice(2)}`);
  writeFileSync(cfg, githubDenialGitConfig());
  return {
    ...base,
    GIT_CONFIG_GLOBAL: cfg,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_TERMINAL_PROMPT: '0',
    ...extra,
  };
}

/** A throwaway repo with one commit: stands in for the checkout. */
function localRepo(): { dir: string; sha: string } {
  const dir = mkdtempSync(join(tmpdir(), 'knext-egress-repo-'));
  const g = (...a: string[]) =>
    execFileSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], {
      encoding: 'utf8',
    }).trim();
  g('init', '-q', '-b', 'main');
  g('commit', '-q', '--allow-empty', '-m', 'a');
  return { dir, sha: g('rev-parse', 'HEAD') };
}

describe('rust-crates generator step is independent of the restricted remote', () => {
  it('serves the knext crates from the checkout (the init step sets KNEXT_FFI_LOCAL_REPO)', () => {
    expect(stepBlock(INIT_STEP)).toMatch(
      /KNEXT_FFI_LOCAL_REPO:\s*\$\{\{\s*github\.workspace\s*\}\}/,
    );
  });

  it('the local-source env appears ONLY on the two generator steps (init and egress), never at workflow or job level', () => {
    const rest = WORKFLOW.replace(stepBlock(INIT_STEP), '').replace(stepBlock(EGRESS_STEP), '');
    expect(rest).not.toMatch(/KNEXT_FFI_LOCAL/);
    expect(rest).not.toMatch(/GIT_CONFIG_/);
    expect(stepBlock(INIT_STEP)).toMatch(/KNEXT_FFI_LOCAL_BASE_REF:/);
    expect(stepBlock(EGRESS_STEP)).toMatch(/KNEXT_FFI_LOCAL_BASE_REF:/);
  });

  it('requires the recorded rev to be merged (ancestor of the base) before rewriting', () => {
    expect(HARNESS).toMatch(/^\s*assertRevOnBase\(localRepo/m);
    expect(HARNESS.indexOf('assertRevOnBase(')).toBeLessThan(
      HARNESS.indexOf('localCrateSourceEnv(localRepo'),
    );
  });

  it('assertRevOnBase fails closed on unmerged, malformed and unresolvable input', () => {
    const repo = mkdtempSync(join(tmpdir(), 'knext-ci-anc-'));
    try {
      const g = (...a: string[]) =>
        execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], {
          encoding: 'utf8',
        }).trim();
      g('init', '-q', '-b', 'main');
      g('commit', '-q', '--allow-empty', '-m', 'a');
      const merged = g('rev-parse', 'HEAD');
      g('checkout', '-q', '-b', 'pr');
      g('commit', '-q', '--allow-empty', '-m', 'b');
      const unmerged = g('rev-parse', 'HEAD');
      expect(() => assertRevOnBase(repo, merged, 'main')).not.toThrow();
      expect(() => assertRevOnBase(repo, unmerged, 'main')).toThrow(/not an ancestor/);
      expect(() => assertRevOnBase(repo, merged, undefined)).toThrow(/unset/);
      expect(() => assertRevOnBase(repo, merged, 'nope')).toThrow(/does not resolve/);
      expect(() => assertRevOnBase(repo, 'abc', 'main')).toThrow(/40-hex/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('checks out full history so the recorded revision exists in the clone', () => {
    const job = WORKFLOW.slice(WORKFLOW.indexOf('  crates:\n    name: knext-ffi crates (fmt'));
    const checkout = job.slice(
      job.indexOf('actions/checkout'),
      job.indexOf('Install the pinned Rust'),
    );
    expect(checkout).toMatch(/fetch-depth:\s*0/);
  });

  it('the harness applies the local source only from that variable, never a [patch]', () => {
    expect(HARNESS).toMatch(/process\.env\.KNEXT_FFI_LOCAL_REPO/);
    expect(HARNESS).toMatch(/localCrateSourceEnv\(/);
    expect(HARNESS).not.toMatch(/\[patch/);
  });

  it('rewrites exactly the user-facing git URL to the local clone, via the git CLI', () => {
    const env = localCrateSourceEnv('/work/knext', CRATE_GIT);
    expect(env.GIT_CONFIG_KEY_0).toBe('url.file:///work/knext.insteadOf');
    expect(env.GIT_CONFIG_VALUE_0).toBe(CRATE_GIT);
    expect(env.GIT_CONFIG_COUNT).toBe('1');
    expect(env.CARGO_NET_GIT_FETCH_WITH_CLI).toBe('true');
  });

  it('the generated Cargo.toml still uses the git source at the recorded revision', () => {
    const dir = mkdtempSync(join(tmpdir(), 'knext-ci-local-'));
    try {
      const io = { stdout: () => {}, stderr: () => {} };
      expect(runInit({ cwd: dir, io })).toBe(0);
      const toml = readFileSync(join(dir, 'rust', 'Cargo.toml'), 'utf8');
      expect(toml).toContain(`knext-ffi = { git = "${CRATE_GIT}", rev = "${recordedCrateRev()}" }`);
      expect(toml).not.toMatch(/path\s*=|\[patch/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('egress proof, git half (S9-4): real git, github.com routed to a refused proxy', () => {
  // The control uses a github.com repo other than the knext remote, so that
  // even with the denial removed (a mutation) nothing touches the knext remote.
  it('control: with the rewrite removed, the denied route refuses github.com', () => {
    const r = spawnSync('git', ['ls-remote', 'https://github.com/git/git'], {
      env: egressEnv({}),
      encoding: 'utf8',
    });
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/127\.0\.0\.1 port 9|Failed to connect/);
  });

  it('positive: the rewrite lists the local commit for CRATE_GIT with the same denial in force', () => {
    const repo = localRepo();
    const r = spawnSync('git', ['ls-remote', CRATE_GIT], {
      env: egressEnv(localCrateSourceEnv(repo.dir, CRATE_GIT)),
      encoding: 'utf8',
    });
    expect(r.status).toBe(0);
    expect(r.stdout).toContain(repo.sha);
  });

  it('positive: the recorded revision itself is fetchable from the local clone (what cargo does)', () => {
    const repo = localRepo();
    const scratch = mkdtempSync(join(tmpdir(), 'knext-egress-fetch-'));
    try {
      execFileSync('git', ['init', '-q', scratch]);
      const r = spawnSync('git', ['-C', scratch, 'fetch', '--no-tags', CRATE_GIT, repo.sha], {
        env: egressEnv(localCrateSourceEnv(repo.dir, CRATE_GIT)),
        encoding: 'utf8',
      });
      expect(r.status).toBe(0);
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });

  it('the denial is scoped to github.com and names the refused proxy', () => {
    const cfg = githubDenialGitConfig();
    expect(cfg).toContain('[http "https://github.com/"]');
    expect(cfg).toContain(`proxy = ${DENIED_PROXY}`);
  });
});

describe('egress proof, verdict and wiring (S9-4)', () => {
  const ok: ProbeRun = { status: 0, stderr: `From file://${REPO}` };
  const refused: ProbeRun = { status: 101, stderr: 'Failed to connect to 127.0.0.1 port 9' };

  it('passes only when the local fetch succeeds AND the control is refused at the denied route', () => {
    expect(egressVerdict(REPO, ok, refused)).toEqual([]);
  });

  it('fails when the local fetch fails', () => {
    const problems = egressVerdict(REPO, { status: 1, stderr: 'boom' }, refused);
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/local clone failed/);
  });

  it('fails when the fetch succeeded without reading the local clone', () => {
    const problems = egressVerdict(
      REPO,
      { status: 0, stderr: 'From https://github.com/getknext-dev/knext' },
      refused,
    );
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/did not read the local clone/);
  });

  it('fails when the control is NOT refused (the denial does not hold)', () => {
    const problems = egressVerdict(REPO, ok, { status: 0, stderr: '' });
    expect(problems).toHaveLength(1);
    expect(problems[0]).toMatch(/does not hold/);
  });

  it('fails when the control dies for a reason other than the denied route (DNS, timeout)', () => {
    const dns = egressVerdict(REPO, ok, { status: 101, stderr: 'Could not resolve host' });
    expect(dns[0]).toMatch(/not at the denied route/);
    const timeout = egressVerdict(REPO, ok, { status: null, stderr: '' });
    expect(timeout[0]).toMatch(/not at the denied route/);
  });

  it('cargoEgressProbe wires the rewrite into the positive run only, under the same github denial', () => {
    const seen: Record<string, { env: Record<string, string>; cfg: string; manifest: string }> = {};
    const spawn = (_cmd: string, args: string[], env: Record<string, string>): ProbeRun => {
      const name = env.CARGO_HOME.includes('cargo-home-positive') ? 'positive' : 'control';
      seen[name] = {
        env,
        cfg: readFileSync(env.GIT_CONFIG_GLOBAL, 'utf8'),
        manifest: readFileSync(args[2], 'utf8'),
      };
      return name === 'positive' ? ok : refused;
    };
    expect(cargoEgressProbe({ repoDir: REPO, gitUrl: CRATE_GIT, rev: REV, spawn })).toEqual([]);

    expect(seen.positive.env.GIT_CONFIG_KEY_0).toBe(`url.file://${REPO}.insteadOf`);
    expect(seen.positive.env.GIT_CONFIG_VALUE_0).toBe(CRATE_GIT);
    expect(seen.control.env.GIT_CONFIG_COUNT).toBeUndefined();
    expect(seen.control.env.GIT_CONFIG_KEY_0).toBeUndefined();
    for (const name of ['positive', 'control']) {
      expect(seen[name].cfg).toContain(`proxy = ${DENIED_PROXY}`);
      expect(seen[name].manifest).toContain(`knext-ffi = { git = "${CRATE_GIT}", rev = "${REV}" }`);
    }
    // Each run gets its own CARGO_HOME, so no cache can answer for the other.
    expect(seen.positive.env.CARGO_HOME).not.toBe(seen.control.env.CARGO_HOME);
  });

  it('cargoEgressProbe refuses a rev that is not a full SHA before spawning anything', () => {
    let calls = 0;
    const spawn = (): ProbeRun => {
      calls++;
      return ok;
    };
    expect(() => cargoEgressProbe({ repoDir: REPO, gitUrl: CRATE_GIT, rev: 'abc', spawn })).toThrow(
      /40-hex/,
    );
    expect(calls).toBe(0);
  });

  it('the egress script turns any problem into a non-zero exit (no mask, no swallowed verdict)', () => {
    expect(EGRESS_SCRIPT).toMatch(/cargoEgressProbe\(/);
    expect(EGRESS_SCRIPT).toMatch(/if \(problems\.length > 0\) \{[\s\S]*?process\.exit\(1\)/);
    expect(EGRESS_SCRIPT).not.toMatch(/\|\|\s*true/);
  });
});

describe('egress proof, CI step shape (S9-4): present, ordered after init, unmasked', () => {
  const steps = crates.steps;
  const egressIndex = steps.findIndex((s) => (s.name ?? '').startsWith(EGRESS_STEP));
  const initIndex = steps.findIndex((s) => (s.name ?? '').startsWith(INIT_STEP));

  it('the crates job has an egress step, placed after the init step', () => {
    expect(egressIndex).toBeGreaterThan(-1);
    expect(initIndex).toBeGreaterThan(-1);
    expect(egressIndex).toBeGreaterThan(initIndex);
  });

  it('the egress step is not masked: no continue-on-error, no if:, and the job has no continue-on-error', () => {
    const step = steps[egressIndex];
    expect('continue-on-error' in step).toBe(false);
    expect('if' in step).toBe(false);
    expect('continue-on-error' in crates).toBe(false);
  });

  it('the egress step runs exactly the proof script, with nothing appended that could swallow its exit code', () => {
    expect(steps[egressIndex].run?.trim()).toBe('bun harness/ffi-egress-offline.ts');
  });

  it('the egress step uses the same local source and base ref as the init step', () => {
    const env = steps[egressIndex].env ?? {};
    expect(env.KNEXT_FFI_LOCAL_REPO).toBe('${{ github.workspace }}');
    expect(env.KNEXT_FFI_LOCAL_BASE_REF).toBe(steps[initIndex].env?.KNEXT_FFI_LOCAL_BASE_REF);
  });
});
