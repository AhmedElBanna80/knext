/**
 * Behavioural tests for which pod ANSWERED a held call in the Z11 drill (heldwarm):
 * packages/grpc/e2e/z11-activator-drill/answering-pod.sh, and the way run.sh uses it.
 *
 * The drill used to ASSIGN the answering pod's uid from the hold's target, so "the right pod
 * answered" was true by construction. These tests run the real shell functions on fabricated
 * counters and require that a different pod answering, two pods answering, nobody answering and
 * a weakened comparison are each caught. Verdicts come from exit codes.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const DRILL = resolve(REPO_ROOT, 'packages/grpc/e2e/z11-activator-drill');
const LIB = resolve(DRILL, 'answering-pod.sh');
const run = readFileSync(resolve(DRILL, 'run.sh'), 'utf8');

function sh(script: string): { code: number; out: string; err: string } {
  const r = Bun.spawnSync(['bash', '-c', script], { stdout: 'pipe', stderr: 'pipe' });
  return { code: r.exitCode ?? -1, out: r.stdout.toString(), err: r.stderr.toString() };
}
const lib = (body: string) => `set -uo pipefail\nsource '${LIB}'\n${body}`;

const BEFORE = 'uid-a 4\nuid-b 7';

describe('answering_pod_uid: the pod whose counter rose by exactly one', () => {
  const answered = (before: string, after: string) =>
    sh(lib(`answering_pod_uid '${before}' '${after}'`));

  it('names pod A when only A rose', () => {
    const r = answered(BEFORE, 'uid-a 5\nuid-b 7');
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe('uid-a');
  });
  it('names pod B when only B rose', () => {
    const r = answered(BEFORE, 'uid-a 4\nuid-b 8');
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe('uid-b');
  });
  it('refuses when nobody counted the call', () => {
    expect(answered(BEFORE, BEFORE).code).not.toBe(0);
  });
  it('refuses when two pods counted it', () => {
    expect(answered(BEFORE, 'uid-a 5\nuid-b 8').code).not.toBe(0);
  });
  it('refuses when one pod counted more than one call', () => {
    expect(answered(BEFORE, 'uid-a 6\nuid-b 7').code).not.toBe(0);
  });
  it('refuses when a counter went down (a restarted pod)', () => {
    expect(answered(BEFORE, 'uid-a 5\nuid-b 1').code).not.toBe(0);
  });
  it('refuses when the pods differ between the snapshots', () => {
    expect(answered(BEFORE, 'uid-a 5\nuid-c 7').code).not.toBe(0);
    expect(answered(BEFORE, 'uid-a 5').code).not.toBe(0);
  });
});

describe('assert_answered_by: the answering pod must be the expected one', () => {
  const check = (want: string, after: string) =>
    sh(lib(`assert_answered_by '${want}' '${BEFORE}' '${after}'`));

  it('passes when the expected pod answered', () => {
    expect(check('uid-b', 'uid-a 4\nuid-b 8').code).toBe(0);
  });
  it('fails when a DIFFERENT pod answered', () => {
    const r = check('uid-b', 'uid-a 5\nuid-b 7');
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('uid-a');
  });
  it('fails when the call cannot be attributed at all', () => {
    expect(check('uid-b', BEFORE).code).not.toBe(0);
  });
});

describe('request_snapshot reads each pod through its queue-proxy counter', () => {
  const metrics = (pod: string) =>
    ({
      'pod-a':
        'revision_request_count{pod_name="pod-a",response_code="404"} 3\nrevision_request_count{pod_name="pod-a",response_code="401"} 1\n',
      'pod-b': '# HELP revision_go_alloc x\nrevision_go_alloc{name=""} 2.6e+06\n',
    })[pod] ?? '';

  it('sums every response code, and a pod with no series is 0', () => {
    const r = sh(
      lib(`
fn_pods_ready() { printf 'pod-a uid-a l\\npod-b uid-b l\\n'; }
pod_metrics() { case "$1" in pod-a) printf '%s' '${metrics('pod-a')}';; pod-b) printf '%s' '${metrics('pod-b')}';; esac; }
request_snapshot`),
    );
    expect(r.code).toBe(0);
    expect(r.out.trim().split('\n')).toEqual(['uid-a 4', 'uid-b 0']);
  });
  it('fails when a pod cannot be read, so no snapshot is silently short', () => {
    const r = sh(
      lib(`
fn_pods_ready() { printf 'pod-a uid-a l\\n'; }
pod_metrics() { return 1; }
request_snapshot`),
    );
    expect(r.code).not.toBe(0);
  });
});

describe('run.sh uses the observation, not the target', () => {
  const hold = (() => {
    const start = run.indexOf('\nhold_call() {');
    return run.slice(start, run.indexOf('\n}\n', start));
  })();
  it("reads every pod's counter before the call is sent and again after it is answered, before the pods are released", () => {
    const before = hold.indexOf('HELD_REQ_BEFORE="$(request_snapshot)"');
    const probe = hold.indexOf('bun "${Z7}/probe.ts"');
    const answered = hold.indexOf('wait "$(cat "${HELD_PIDFILE}")"');
    const after = hold.indexOf('HELD_REQ_AFTER="$(request_snapshot)"');
    const release = hold.indexOf('release_pods', answered);
    expect(before).toBeGreaterThan(-1);
    expect(before).toBeLessThan(probe);
    expect(after).toBeGreaterThan(answered);
    expect(after).toBeLessThan(release);
  });
  it('never assigns HELD_POD_UID from an argument or the target pod', () => {
    const assigns = run.split('\n').filter((l) => /^\s*HELD_POD_UID=/.test(l));
    expect(assigns.length).toBeGreaterThan(0);
    for (const l of assigns) {
      expect(l, 'only an empty reset or the observation').toMatch(
        /^\s*HELD_POD_UID=("")$|HELD_POD_UID="\$\(answering_pod_uid /,
      );
    }
  });
});

/**
 * The statements run.sh really executes, cut out of it and run on fabricated counters. A check
 * that is deleted, or weakened to something that no longer compares the answering pod with the
 * expected one, cannot pass these. `fail` is stubbed to exit 3, so the verdict is the exit code.
 */
describe('the assertions in run.sh, executed', () => {
  const statement = (re: RegExp, what: string): string => {
    const m = run.match(re);
    expect(m, `${what} is in run.sh exactly as the test expects`).not.toBeNull();
    return (m as RegExpMatchArray)[0];
  };
  const assertion = (uid: 'wuid_a' | 'wuid_b' | 'wuid_b" "${bctl_before}" "${bctl_after') => {
    const dollar = '\\$';
    const body =
      uid === 'wuid_a' || uid === 'wuid_b'
        ? `${dollar}\\{${uid}\\}" "${dollar}\\{HELD_REQ_BEFORE\\}" "${dollar}\\{HELD_REQ_AFTER\\}`
        : `${dollar}\\{wuid_b\\}" "${dollar}\\{bctl_before\\}" "${dollar}\\{bctl_after\\}`;
    return statement(
      new RegExp(`  assert_answered_by "${body}" \\\\\\n\\s*\\|\\| fail "[^\\n]*"`),
      `the ${uid} assertion`,
    );
  };
  const exec = (stmt: string, vars: string): number =>
    sh(
      `set -uo pipefail\nsource '${LIB}'\nfail() { echo "FAIL: $*" >&2; exit 3; }\n${vars}\n${stmt}\nexit 0`,
    ).code;
  const vars = (rose: 'uid-a' | 'uid-b' | 'both' | 'none') =>
    [
      'wuid_a=uid-a; wuid_b=uid-b',
      "HELD_REQ_BEFORE=$'uid-a 4\\nuid-b 7'",
      `HELD_REQ_AFTER=$'uid-a ${rose === 'uid-a' || rose === 'both' ? 5 : 4}\\nuid-b ${rose === 'uid-b' || rose === 'both' ? 8 : 7}'`,
      'bctl_before="${HELD_REQ_BEFORE}"; bctl_after="${HELD_REQ_AFTER}"',
      `HELD_POD_UID=${rose}`,
    ].join('\n');

  it('the control (pod A) passes only when pod A answered', () => {
    const stmt = assertion('wuid_a');
    expect(exec(stmt, vars('uid-a'))).toBe(0);
    expect(exec(stmt, vars('uid-b'))).toBe(3);
    expect(exec(stmt, vars('both'))).toBe(3);
    expect(exec(stmt, vars('none'))).toBe(3);
  });
  it('the long hold (pod B) passes only when pod B answered', () => {
    const stmt = assertion('wuid_b');
    expect(exec(stmt, vars('uid-b'))).toBe(0);
    expect(exec(stmt, vars('uid-a'))).toBe(3);
    expect(exec(stmt, vars('both'))).toBe(3);
    expect(exec(stmt, vars('none'))).toBe(3);
  });
  it("the fresh-token positive control passes only when pod B's own counter rose", () => {
    const stmt = assertion('wuid_b" "${bctl_before}" "${bctl_after');
    expect(exec(stmt, vars('uid-b'))).toBe(0);
    expect(exec(stmt, vars('uid-a'))).toBe(3);
    expect(exec(stmt, vars('none'))).toBe(3);
  });
  it('hold_call takes HELD_POD_UID from the counters and fails when the call cannot be attributed', () => {
    const stmt = statement(
      /    HELD_POD_UID="\$\(answering_pod_uid "\$\{HELD_REQ_BEFORE\}" "\$\{HELD_REQ_AFTER\}"\)" \|\| fail "[^\n]*"/,
      'the observation in hold_call',
    );
    const r = sh(
      `set -uo pipefail\nsource '${LIB}'\nfail() { exit 3; }\n${vars('uid-b')}\n${stmt}\necho "$HELD_POD_UID"`,
    );
    expect(r.out.trim()).toBe('uid-b');
    expect(exec(stmt, vars('both'))).toBe(3);
    expect(exec(stmt, vars('none'))).toBe(3);
  });
});

describe('the positive control on pod B, executed', () => {
  it('accepts only 404 not_found from the fresh token', () => {
    const m = run.match(
      /  \[ "\$\{PR_STATUS\}" = 404 \] && \[ "\$\{PR_CODE\}" = not_found \] \\\n\s*\|\| fail "warm pod B: a FRESH token[^\n]*"/,
    );
    expect(m, 'the fresh-token status check is in run.sh').not.toBeNull();
    const go = (status: string, code: string) =>
      sh(
        `fail() { exit 3; }\nPR_STATUS=${status}; PR_CODE=${code}\n${(m as RegExpMatchArray)[0]}\nexit 0`,
      ).code;
    expect(go('404', 'not_found')).toBe(0);
    expect(go('401', 'unauthenticated')).toBe(3);
    expect(go('404', 'unauthenticated')).toBe(3);
    expect(go('200', 'not_found')).toBe(3);
  });
});

describe('the positive control on pod B', () => {
  const w = (() => {
    const start = run.indexOf('\nphase_heldwarm() {');
    return run.slice(start, run.indexOf('\n}\n', start));
  })();
  it('sends a FRESH token to pod B alone, after its refusal, and requires 404 not_found', () => {
    const refusal = w.indexOf('was refused by pod B');
    const iso = w.indexOf('isolate_pods "${wuid_b}"', refusal);
    const probe = w.indexOf('fn_probe "${WORK}/key-held" fresh-b');
    const rel = w.indexOf('release_pods', probe);
    expect(refusal).toBeGreaterThan(-1);
    expect(iso).toBeGreaterThan(refusal);
    expect(probe).toBeGreaterThan(iso);
    expect(rel).toBeGreaterThan(probe);
    expect(w).toMatch(
      /\[ "\$\{PR_STATUS\}" = 404 \] && \[ "\$\{PR_CODE\}" = not_found \] \\\n\s*\|\| fail "warm pod B: a FRESH token/,
    );
    // Counters are read around the call and before the pods are re-attached.
    expect(w.indexOf('bctl_before="$(request_snapshot)"')).toBeLessThan(probe);
    expect(w.indexOf('bctl_after="$(request_snapshot)"')).toBeGreaterThan(probe);
    expect(w.indexOf('bctl_after="$(request_snapshot)"')).toBeLessThan(rel);
  });
});
