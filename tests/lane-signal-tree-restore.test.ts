import { describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

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
setInterval(() => {}, 1000);
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

async function waitFor(check: () => boolean, ms = 20_000) {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await Bun.sleep(50);
  return check();
}

describe('a signal to the lane runner restores the tree its killed prover left (ROUND 2 item 6)', () => {
  it('SIGTERM mid-mutation: the tracked file is restored, the untracked file removed, the tree clean', async () => {
    const dir = fixtureRepo();
    const proc = Bun.spawn(['node', join(dir, 'scripts', 'run-mutation-provers.mjs')], {
      cwd: dir,
      env: { ...process.env, KNEXT_LANE_RESTORE_AFTER_KILL: '1', GITHUB_ACTIONS: '' },
      stdout: 'ignore',
      stderr: 'ignore',
    });
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
});
