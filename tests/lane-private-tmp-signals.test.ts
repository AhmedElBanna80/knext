import { describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
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
