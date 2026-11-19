import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { parse } from 'yaml';
import { checkPinSkew, evaluateSkew, parsePin } from '../scripts/lib/z7-pin-skew.mjs';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const read = (p: string) => readFileSync(resolve(REPO_ROOT, p), 'utf8');
const SHA = 'a'.repeat(40);
const caller = (line: string) => `jobs:\n  z7:\n    ${line}\n`;
const GOOD = caller(`uses: Owner/repo/.github/workflows/z7.yml@${SHA} # integration/v2`);

const stubGh = (pinned: string | Error, tip: string | Error) => (args: string[]) => {
  const url = args[args.length - 1];
  const v = url.includes(`ref=${SHA}`) ? pinned : tip;
  if (v instanceof Error) throw v;
  return v;
};

describe('parsePin', () => {
  it('reads repo, path, sha and branch from the caller text', () => {
    expect(parsePin(GOOD)).toEqual({
      repo: 'Owner/repo',
      path: '.github/workflows/z7.yml',
      sha: SHA,
      branch: 'integration/v2',
    });
  });
  it('rejects a floating ref, a short sha, a missing comment and zero or two pins', () => {
    for (const bad of [
      caller('uses: Owner/repo/.github/workflows/z7.yml@integration/v2'),
      caller(`uses: Owner/repo/.github/workflows/z7.yml@${'a'.repeat(7)} # integration/v2`),
      caller(`uses: Owner/repo/.github/workflows/z7.yml@${SHA}`),
      'jobs: {}\n',
      GOOD + GOOD,
    ]) {
      expect(() => parsePin(bad)).toThrow();
    }
  });
});

describe('checkPinSkew', () => {
  it('passes when the YAML at the pin equals the tip', () => {
    expect(checkPinSkew({ callerText: GOOD, gh: stubGh('a: 1\n', 'a: 1\n') }).ok).toBe(true);
  });
  it('reds when the tip YAML changed, and names the difference', () => {
    const r = checkPinSkew({ callerText: GOOD, gh: stubGh('a: 1\nb: 2\n', 'a: 1\nb: 3\n') });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/PIN SKEW.*first difference at line 2/);
  });
  it('throws (fail closed) on an unparseable pin', () => {
    expect(() => checkPinSkew({ callerText: 'nothing', gh: stubGh('a', 'a') })).toThrow();
  });
  it('throws (fail closed) when either fetch fails', () => {
    expect(() => checkPinSkew({ callerText: GOOD, gh: stubGh(new Error('404'), 'a') })).toThrow();
    expect(() => checkPinSkew({ callerText: GOOD, gh: stubGh('a', new Error('500')) })).toThrow();
  });
  it('a comment-only difference passes', () => {
    const base = 'jobs:\n  a:\n    timeout-minutes: 5\n    steps:\n      - run: x\n';
    expect(
      evaluateSkew({ pinned: base, tip: `# note\n${base.replace('jobs:', 'jobs: # c')}` }).ok,
    ).toBe(true);
  });
  it('a changed step, env value or timeout reds', () => {
    const base =
      'jobs:\n  a:\n    timeout-minutes: 5\n    env:\n      K: v\n    steps:\n      - run: x\n';
    for (const [f, t] of [
      ['run: x', 'run: y'],
      ['K: v', 'K: w'],
      ['minutes: 5', 'minutes: 6'],
    ]) {
      expect(evaluateSkew({ pinned: base, tip: base.replace(f, t) }).ok).toBe(false);
    }
  });
  it('fails closed when either side is unparseable', () => {
    expect(evaluateSkew({ pinned: 'a: [', tip: 'a: 1\n' }).ok).toBe(false);
    expect(evaluateSkew({ pinned: 'a: 1\n', tip: 'a: [' }).ok).toBe(false);
  });
  it('a list order change reds', () => {
    expect(evaluateSkew({ pinned: 'a: [1, 2]\n', tip: 'a: [2, 1]\n' }).ok).toBe(false);
  });
  it('an anchor/alias that resolves equal passes', () => {
    const pinned = 'a: &x {k: v}\nb: *x\n';
    const tip = 'a: {k: v}\nb: {k: v}\n';
    expect(evaluateSkew({ pinned, tip }).ok).toBe(true);
  });
  it('a duplicate key fails closed', () => {
    expect(evaluateSkew({ pinned: 'a: 1\na: 2\n', tip: 'a: 2\n' }).ok).toBe(false);
    expect(evaluateSkew({ pinned: 'a: 2\n', tip: 'a: 1\na: 2\n' }).ok).toBe(false);
  });
  it('an int key 1 and a string key "1" compare EQUAL', () => {
    // Deliberate: the YAML parser stringifies mapping keys, and GitHub Actions also reads both
    // as the string "1", so the workflow behaves identically. Values still compare by type.
    expect(evaluateSkew({ pinned: '1: a\n', tip: '"1": a\n' }).ok).toBe(true);
    expect(evaluateSkew({ pinned: 'k: 1\n', tip: 'k: "1"\n' }).ok).toBe(false);
  });
  it('reds on empty bodies, even if both are empty', () => {
    expect(evaluateSkew({ pinned: '', tip: '' }).ok).toBe(false);
    expect(evaluateSkew({ pinned: 'a', tip: ' \n' }).ok).toBe(false);
  });
});

describe('real caller file and nightly wiring', () => {
  it('the checked-in caller parses to a 40-hex pin on integration/v2', () => {
    const pin = parsePin(read('.github/workflows/z7-rotation-weekly.yml'));
    expect(pin.sha).toMatch(/^[0-9a-f]{40}$/);
    expect(pin.branch).toBe('integration/v2');
  });
  it('the watchdog nightly runs the check and files a distinct-titled alert', () => {
    const text = read('.github/workflows/z7-watchdog-nightly.yml');
    const wf = parse(text);
    expect(
      wf.jobs['z7-pin-skew'].steps.some((s: { run?: string }) =>
        s.run?.includes('scripts/verify-z7-pin-skew.mjs'),
      ),
    ).toBe(true);
    expect(wf.jobs['z7-pin-skew'].permissions).toEqual({ contents: 'read' });
    expect(wf.jobs['z7-pin-skew-red-alert'].needs).toEqual(['z7-pin-skew']);
    expect(text).toContain("title='Z7 pin skew RED'");
    expect(text).toMatch(/bump the SHA/i);
    expect(text).not.toMatch(/bdbe014b/);
  });
});

describe('the nightly job can run on a fresh runner', () => {
  const text = read('.github/workflows/z7-watchdog-nightly.yml');
  const run: string = parse(text).jobs['z7-pin-skew'].steps.find((s: { run?: string }) =>
    s.run?.includes('verify-z7-pin-skew'),
  ).run;
  it('installs yaml at an exact version with lifecycle scripts off, outside the checkout', () => {
    expect(run).toMatch(/npm install[^\n]*--ignore-scripts[^\n]*yaml@\d+\.\d+\.\d+/);
    expect(run).toContain('RUNNER_TEMP');
  });
  it('the scripts import nothing but node:*, yaml and relative files', () => {
    for (const f of ['scripts/verify-z7-pin-skew.mjs', 'scripts/lib/z7-pin-skew.mjs']) {
      const specs = [...read(f).matchAll(/^import .*? from '([^']+)'/gm)].map((m) => m[1]);
      for (const sp of specs) expect(sp).toMatch(/^(node:|yaml$|\.\/)/);
    }
  });
  it('runs in a clean directory with only the install step providing yaml', () => {
    const dir = mkdtempSync(resolve(tmpdir(), 'z7skew-'));
    mkdirSync(resolve(dir, 'scripts/lib'), { recursive: true });
    cpSync(
      resolve(REPO_ROOT, 'scripts/verify-z7-pin-skew.mjs'),
      resolve(dir, 'scripts/verify-z7-pin-skew.mjs'),
    );
    cpSync(
      resolve(REPO_ROOT, 'scripts/lib/z7-pin-skew.mjs'),
      resolve(dir, 'scripts/lib/z7-pin-skew.mjs'),
    );
    const r = spawnSync('node', [resolve(dir, 'scripts/verify-z7-pin-skew.mjs')], {
      cwd: dir,
      encoding: 'utf8',
    });
    // No yaml installed: the run must fail closed (nonzero), proving the install step is load-bearing.
    expect(r.status).not.toBe(0);
    expect(r.stderr).toMatch(/fail closed/);
  });
});
