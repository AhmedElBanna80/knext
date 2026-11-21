import { describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { hermeticLaneEnv, LANE_ENV } from './helpers/lane-env';

const ROOT = resolve(import.meta.dirname, '..');

/**
 * ROUND 2, item 6. A lane runner killed by a signal mid-mutation must leave its tree as it found it: the
 * tracked files the prover mutated are restored from HEAD, and the untracked files it created are removed,
 * BEFORE the runner exits. The signal path used to only kill the prover group and run the exit cleanup, so a
 * killed prover left the tree dirty for whoever ran next. These tests drive the real runner in a throwaway
 * repo that holds a single fixture prover, which mutates a tracked file, creates an untracked one, then waits.
 */
const PROVER = `import { writeFileSync } from 'node:fs';
writeFileSync('fixture.txt', 'MUTATED\\n');
writeFileSync('scratch-residue.txt', 'untracked\\n');
setTimeout(() => process.exit(0), 60000); // self-exit: never outlives the test
`;

const git = (dir: string, args: string[]) =>
  execFileSync(
    'git',
    ['-c', 'user.email=t@t', '-c', 'user.name=t', '-c', 'commit.gpgsign=false', ...args],
    {
      cwd: dir,
      encoding: 'utf8',
    },
  );

/** A throwaway repo with the runner and its lib, and ONLY the fixture prover (the runner runs every prover it finds). */
function fixtureRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lane-tree-restore-'));
  mkdirSync(join(dir, 'scripts'));
  for (const f of readdirSync(join(ROOT, 'scripts'))) {
    if (f.startsWith('mutation-prove-')) continue;
    cpSync(join(ROOT, 'scripts', f), join(dir, 'scripts', f), { recursive: true });
  }
  writeFileSync(join(dir, 'scripts', 'mutation-prove-zz-fixture.mjs'), PROVER);
  writeFileSync(join(dir, 'fixture.txt'), 'original\n');
  git(dir, ['init', '-q']);
  // The runner imports typescript: link the repo's dependencies, invisible to git status.
  symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'));
  appendFileSync(join(dir, '.git', 'info', 'exclude'), 'node_modules\n');
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-qm', 'base']);
  return dir;
}

/** Process groups of this test's fixture prover (its pgid is its own pid, since the runner spawns it detached). */
function fixtureGroups(dir: string): number[] {
  const out = execFileSync('ps', ['-eo', 'pgid=,command='], { encoding: 'utf8' });
  const groups = new Set<number>();
  for (const line of out.split('\n')) {
    const m = /^\s*(\d+)\s+(.*)$/.exec(line);
    if (m && m[2]!.includes(dir) && m[2]!.includes('mutation-prove-zz-fixture'))
      groups.add(Number(m[1]));
  }
  return [...groups];
}

/**
 * The groups a fixture kill may signal: every fixture group EXCEPT the test process's own group, so a
 * misidentified pgid can never signal the test runner itself. ROUND 4 item 4.
 */
export function safeGroupsToKill(groups: number[], ownPgid: number): number[] {
  return groups.filter((g) => g !== ownPgid);
}

function ownProcessGroup(): number {
  return Number(
    execFileSync('ps', ['-o', 'pgid=', '-p', String(process.pid)], { encoding: 'utf8' }).trim(),
  );
}

function killFixtureGroups(dir: string) {
  for (const g of safeGroupsToKill(fixtureGroups(dir), ownProcessGroup())) {
    try {
      process.kill(-g, 'SIGKILL');
    } catch {
      // already gone
    }
  }
}

async function waitFor(check: () => boolean, ms = 20_000) {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await Bun.sleep(50);
  return check();
}

/** The env the fixture runner gets: the ambient env minus the lane's own variables (see helpers/lane-env.ts), plus the restore opt-in. */
function runnerEnv(): Record<string, string> {
  return hermeticLaneEnv({ KNEXT_LANE_RESTORE_AFTER_KILL: '1', GITHUB_ACTIONS: '' });
}

/** THE spawn site of the runner under test (one place, so the env scrub cannot be skipped at one of several). */
function spawnRunner(dir: string) {
  return Bun.spawn(['node', join(dir, 'scripts', 'run-mutation-provers.mjs')], {
    cwd: dir,
    env: runnerEnv(),
    stdout: 'ignore',
    stderr: 'ignore',
  });
}

describe('the runner under test is hermetic against the lane (the S13-5 baseline bug)', () => {
  it('runnerEnv drops PROVER_LANE_SHA and every other lane variable, keeps unrelated ones', () => {
    const saved = { sha: process.env.PROVER_LANE_SHA, ci: process.env.GITHUB_ACTIONS };
    process.env.PROVER_LANE_SHA = 'b'.repeat(40);
    process.env.GITHUB_ACTIONS = 'true';
    try {
      const env = runnerEnv();
      for (const k of LANE_ENV)
        if (k !== 'KNEXT_LANE_RESTORE_AFTER_KILL' && k !== 'GITHUB_ACTIONS')
          expect(k in env).toBe(false);
      expect(env.PATH).toBe(process.env.PATH ?? '');
      expect(env.KNEXT_LANE_RESTORE_AFTER_KILL).toBe('1');
      expect(env.GITHUB_ACTIONS).toBe('');
    } finally {
      if (saved.sha === undefined) delete process.env.PROVER_LANE_SHA;
      else process.env.PROVER_LANE_SHA = saved.sha;
      if (saved.ci === undefined) delete process.env.GITHUB_ACTIONS;
      else process.env.GITHUB_ACTIONS = saved.ci;
    }
  });

  it('a bogus PROVER_LANE_SHA in the parent env does not stop the fixture prover from running', async () => {
    const dir = fixtureRepo();
    const saved = process.env.PROVER_LANE_SHA;
    process.env.PROVER_LANE_SHA = 'c'.repeat(40); // not the fixture repo's HEAD: leaked, the runner fatals
    const proc = spawnRunner(dir);
    try {
      const mutated = () => readFileSync(join(dir, 'fixture.txt'), 'utf8') === 'MUTATED\n';
      expect(await waitFor(mutated, 10_000)).toBe(true);
    } finally {
      if (saved === undefined) delete process.env.PROVER_LANE_SHA;
      else process.env.PROVER_LANE_SHA = saved;
      try {
        proc.kill('SIGKILL');
      } catch {
        // already gone
      }
      killFixtureGroups(dir);
      rmSync(dir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('the fixture kill never targets the test process group (ROUND 4 item 4)', () => {
  it('safeGroupsToKill drops the test process own group and keeps every other fixture group', () => {
    expect(safeGroupsToKill([101, 4242, 303], 4242)).toEqual([101, 303]);
    expect(safeGroupsToKill([4242], 4242)).toEqual([]);
    expect(safeGroupsToKill([], 4242)).toEqual([]);
  });
});

describe('a signal to the lane runner restores the tree its killed prover left (ROUND 2 item 6)', () => {
  it('SIGTERM mid-mutation: the tracked file is restored, the untracked file removed, the tree clean', async () => {
    const dir = fixtureRepo();
    const proc = spawnRunner(dir);
    try {
      const mutated = () => readFileSync(join(dir, 'fixture.txt'), 'utf8') === 'MUTATED\n';
      expect(await waitFor(mutated)).toBe(true);
      proc.kill('SIGTERM');
      await proc.exited;
      expect(readFileSync(join(dir, 'fixture.txt'), 'utf8')).toBe('original\n');
      expect(git(dir, ['status', '--porcelain'])).toBe('');
    } finally {
      try {
        proc.kill('SIGKILL');
      } catch {
        // already gone
      }
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it('a SIGKILLed runner cannot run its handler, so the prover survives until the test kills its group, and nothing is left', async () => {
    const dir = fixtureRepo();
    const proc = spawnRunner(dir);
    try {
      expect(
        await waitFor(() => readFileSync(join(dir, 'fixture.txt'), 'utf8') === 'MUTATED\n'),
      ).toBe(true);
      proc.kill('SIGKILL');
      await proc.exited;
      // The prover is orphaned and alive: the runner's SIGTERM handler never ran.
      expect(await waitFor(() => fixtureGroups(dir).length > 0, 3000)).toBe(true);
    } finally {
      killFixtureGroups(dir);
      rmSync(dir, { recursive: true, force: true });
    }
    expect(await waitFor(() => fixtureGroups(dir).length === 0, 3000)).toBe(true);
  }, 60_000);
});
