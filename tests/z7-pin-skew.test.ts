import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
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
