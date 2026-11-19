import { describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { unpairedTempDirs } from '../scripts/lib/scratch-space-scan.mjs';
import { EXIT_SIGNALS } from '../scripts/lib/lane-exit-signals.mjs';

const ROOT = resolve(import.meta.dirname, '..');
const RUNNER = 'scripts/run-mutation-provers.mjs';

/**
 * TD-S12-2a. The lane runner makes a PRIVATE temp dir (`knext-lane-provers-*`) and removes it on the
 * `exit` event. `exit` does not fire when a signal kills the process, so every signal the runner did not
 * handle left the directory behind (measured: SIGHUP left one). These tests drive a real node child, not
 * a mock: the cleanup must run on each signal, and the child's exit code must be the conventional one.
 */
const CHILD = `
  (async () => {
    const { mkdtempSync, rmSync } = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { pinExitSignals } = await import(process.env.PIN);
    const dir = mkdtempSync(join(tmpdir(), 'knext-lane-provers-'));
    process.on('exit', () => rmSync(dir, { recursive: true, force: true }));
    pinExitSignals();
    process.stdout.write('READY\\n');
    setInterval(() => {}, 1000);
  })();
`;

async function runSignalled(signal: string, tmpRoot: string) {
  const proc = Bun.spawn(['node', '-e', CHILD], {
    cwd: ROOT,
    env: {
      ...process.env,
      TMPDIR: tmpRoot,
      PIN: pathToFileURL(resolve(ROOT, 'scripts/lib/lane-exit-signals.mjs')).href,
    },
    stdout: 'pipe',
    stderr: 'pipe',
  });
  const reader = proc.stdout.getReader();
  let out = '';
  const dec = new TextDecoder();
  while (!out.includes('READY')) {
    const { value, done } = await reader.read();
    if (done) break;
    out += dec.decode(value);
  }
  reader.releaseLock();
  proc.kill(signal);
  await proc.exited;
  return proc.exitCode;
}

describe('the lane runner leaves no private temp dir behind on a signal (TD-S12-2a)', () => {
  for (const [signal, code] of EXIT_SIGNALS) {
    it(`${signal}: the private dir is removed and the exit code is ${code}`, async () => {
      const tmpRoot = mkdtempSync(join(tmpdir(), 'lane-signal-scan-'));
      try {
        const exitCode = await runSignalled(signal, tmpRoot);
        expect(exitCode).toBe(code);
        expect(readdirSync(tmpRoot)).toEqual([]);
      } finally {
        rmSync(tmpRoot, { recursive: true, force: true });
      }
    });
  }

  it('the runner pins the exit signals through the shared helper (not an ad hoc list)', () => {
    const src = readFileSync(resolve(ROOT, RUNNER), 'utf8');
    expect(src.match(/pinExitSignals\(\);/g)?.length).toBe(1);
    expect(src).not.toMatch(/process\.once\('SIG/);
  });

  it('the runner is inside the D9 temp-dir scan and its mkdtemp is paired with a removal', () => {
    const tracked = execFileSync('git', ['ls-files', RUNNER], { cwd: ROOT, encoding: 'utf8' });
    expect(tracked.trim()).toBe(RUNNER);
    expect(unpairedTempDirs(readFileSync(resolve(ROOT, RUNNER), 'utf8'))).toEqual([]);
  });

  it('covers the signals that kill a process without an exit event (HUP and QUIT are in the set)', () => {
    const names = EXIT_SIGNALS.map(([s]) => s);
    expect(names).toEqual(expect.arrayContaining(['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGQUIT']));
  });
});

/**
 * ITEM 5. The runner spawns each prover detached (its own process group). A signal that ends the
 * runner must kill those groups first: otherwise a running prover outlives the runner while its TMPDIR
 * is being deleted. The harness below tracks a detached child exactly as the runner tracks a prover
 * (`trackProverGroup`), writes its pid, and waits. The test signals the harness, not the child.
 */
const TRACKED_CHILD = `
  (async () => {
    const fs = await import('node:fs');
    const { tmpdir } = await import('node:os');
    const { join } = await import('node:path');
    const { spawn } = await import('node:child_process');
    const { pinExitSignals, trackProverGroup } = await import(process.env.PIN);
    const dir = fs.mkdtempSync(join(tmpdir(), 'knext-lane-provers-'));
    process.on('exit', () => {
      // Record the handler count first: a handler that was removed (once) reads 0 here.
      fs.writeFileSync(process.env.OUTFILE, 'LISTENERS ' + process.listenerCount('SIGTERM') + '\\n');
      // A slow cleanup, so a second signal would land inside it if the handler were gone.
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 300);
      fs.rmSync(dir, { recursive: true, force: true });
    });
    pinExitSignals();
    const kid = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      detached: true,
      stdio: 'ignore',
    });
    trackProverGroup(() => process.kill(-kid.pid, 'SIGKILL'));
    fs.writeFileSync(process.env.PIDFILE, String(kid.pid));
    setInterval(() => {}, 1000);
  })();
`;

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function waitFor(check: () => boolean, ms = 10_000) {
  const end = Date.now() + ms;
  while (!check() && Date.now() < end) await Bun.sleep(20);
  return check();
}

describe('a signal to the runner kills its tracked prover groups before the private dir is removed (ITEM 5)', () => {
  const launch = (dir: string) => {
    const tmpRoot = join(dir, 'tmp');
    mkdirSync(tmpRoot);
    const pidFile = join(dir, 'pid');
    const outFile = join(dir, 'out');
    const proc = Bun.spawn(['node', '-e', TRACKED_CHILD], {
      cwd: ROOT,
      env: {
        ...process.env,
        TMPDIR: tmpRoot,
        PIN: pathToFileURL(resolve(ROOT, 'scripts/lib/lane-exit-signals.mjs')).href,
        PIDFILE: pidFile,
        OUTFILE: outFile,
      },
      stdout: 'ignore',
      stderr: 'ignore',
    });
    return { proc, tmpRoot, pidFile, outFile };
  };

  it('SIGTERM: the tracked child is gone, the private dir is removed, the exit code is 143', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lane-group-'));
    try {
      const { proc, tmpRoot, pidFile } = launch(dir);
      expect(await waitFor(() => existsSync(pidFile))).toBe(true);
      const pid = Number(readFileSync(pidFile, 'utf8'));
      expect(alive(pid)).toBe(true);
      proc.kill('SIGTERM');
      await proc.exited;
      expect(proc.exitCode).toBe(143);
      expect(await waitFor(() => !alive(pid), 3000)).toBe(true);
      expect(readdirSync(tmpRoot)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('a second SIGTERM during cleanup does not drop the handler or interrupt the removal', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lane-group-'));
    try {
      const { proc, tmpRoot, pidFile, outFile } = launch(dir);
      expect(await waitFor(() => existsSync(pidFile))).toBe(true);
      const pid = Number(readFileSync(pidFile, 'utf8'));
      proc.kill('SIGTERM');
      proc.kill('SIGTERM');
      await proc.exited;
      expect(proc.exitCode).toBe(143);
      // The handler was still installed while the exit cleanup ran (once() would have removed it).
      expect(readFileSync(outFile, 'utf8')).toBe('LISTENERS 1\n');
      expect(readdirSync(tmpRoot)).toEqual([]);
      expect(await waitFor(() => !alive(pid), 3000)).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('the runner tracks each prover group while it runs, and untracks it when it closes', () => {
    const src = readFileSync(resolve(ROOT, RUNNER), 'utf8');
    expect(src).toMatch(/trackProverGroup\(killGroup\)/);
    expect(src).toMatch(/untrack\(\)/);
  });

  it('the helper kills tracked groups before it exits (the kill happens in the signal handler)', () => {
    const src = readFileSync(resolve(ROOT, 'scripts/lib/lane-exit-signals.mjs'), 'utf8');
    expect(src).toMatch(/killTrackedGroups\(\);\s*process\.exit\(code\)/);
    expect(src).not.toMatch(/process\.once\(/);
  });
});
