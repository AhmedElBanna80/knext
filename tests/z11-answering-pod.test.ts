/**
 * Tests for which pod ANSWERED a held call in the Z11 drill (heldwarm), and for the verdicts on
 * that call: packages/grpc/e2e/z11-activator-drill/answering-pod.sh.
 *
 * The drill used to ASSIGN the answering pod's uid from the hold's target, so "the right pod
 * answered" was true by construction. The decisions now live in sourced shell functions, and
 * these tests RUN them: the counter reading through a stub `kubectl` on PATH, the attribution on
 * fabricated snapshots, and the verdicts on fabricated answers. A different pod, two pods,
 * nobody, an unreadable pod, an empty or malformed scrape and a weakened comparison must each be
 * caught. Verdicts come from exit codes.
 *
 * The last block is a WIRING check, and says so: it only asserts that run.sh calls these
 * functions in the right phase, in order. It is not evidence of behaviour.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const DRILL = resolve(REPO_ROOT, 'packages/grpc/e2e/z11-activator-drill');
const LIB = resolve(DRILL, 'answering-pod.sh');
const run = readFileSync(resolve(DRILL, 'run.sh'), 'utf8');

// A stub `kubectl` on PATH. `kubectl get --raw /api/v1/namespaces/<ns>/pods/<pod>:9091/proxy/metrics`
// prints the file named after the pod, or fails when there is none.
const STUB = mkdtempSync(join(tmpdir(), 'z11-answering-pod-'));
const FIXTURES = join(STUB, 'metrics');
mkdirSync(FIXTURES);
const BIN = join(STUB, 'bin');
mkdirSync(BIN);
writeFileSync(
  join(BIN, 'kubectl'),
  `#!/usr/bin/env bash
path="\${3:-}"
pod="\${path#*/pods/}"; pod="\${pod%%:*}"
[ -f "${FIXTURES}/\${pod}" ] || exit 1
cat "${FIXTURES}/\${pod}"
`,
);
chmodSync(join(BIN, 'kubectl'), 0o755);
afterAll(() => rmSync(STUB, { recursive: true, force: true }));

const metrics = (pod: string, body: string | null) => {
  if (body === null) rmSync(join(FIXTURES, pod), { force: true });
  else writeFileSync(join(FIXTURES, pod), body);
};
const series = (pod: string, code: string, n: string) =>
  `revision_request_count{pod_name="${pod}",response_code="${code}"} ${n}\n`;

function sh(script: string): { code: number; out: string; err: string } {
  const r = Bun.spawnSync(['bash', '-c', script], {
    stdout: 'pipe',
    stderr: 'pipe',
    env: { ...process.env, PATH: `${BIN}:${process.env.PATH}` },
  });
  return { code: r.exitCode ?? -1, out: r.stdout.toString(), err: r.stderr.toString() };
}
const lib = (body: string) =>
  `set -uo pipefail\nk() { kubectl "$@"; }\nNS=z11-e2e\nsource '${LIB}'\n${body}`;

describe('pod_request_total reads the counter through kubectl and fails closed', () => {
  const total = (pod: string) => sh(lib(`pod_request_total ${pod}`));

  it('sums every response code of the revision_request_count family', () => {
    metrics('pod-a', series('pod-a', '404', '3') + series('pod-a', '401', '1'));
    const r = total('pod-a');
    expect(r.code).toBe(0);
    expect(r.out.trim()).toBe('4');
  });
  it('accepts a float-formatted value', () => {
    metrics('pod-a', series('pod-a', '404', '1e+01'));
    expect(total('pod-a').out.trim()).toBe('10');
  });
  it('FAILS, naming the pod, on an empty scrape', () => {
    metrics('pod-e', '');
    const r = total('pod-e');
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('pod-e');
    expect(r.err).toContain('empty');
  });
  it('FAILS, naming the pod, when the family is missing (other series only)', () => {
    metrics('pod-m', '# HELP revision_go_alloc x\nrevision_go_alloc{name=""} 2.6e+06\n');
    const r = total('pod-m');
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('pod-m');
    expect(r.err).toContain('revision_request_count');
  });
  it('FAILS, naming the pod, on a non-numeric value, even when another series is fine', () => {
    metrics('pod-n', series('pod-n', '404', '3') + series('pod-n', '401', 'NaN'));
    const r = total('pod-n');
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('pod-n');
    metrics('pod-n2', series('pod-n2', '404', 'abc'));
    expect(total('pod-n2').code).not.toBe(0);
  });
  it('FAILS, naming the pod, when kubectl cannot read it', () => {
    metrics('pod-x', null);
    const r = total('pod-x');
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('pod-x');
  });
});

describe('request_snapshot', () => {
  it('lists "<uid> <total>" for every Ready pod', () => {
    metrics('pod-a', series('pod-a', '404', '4'));
    metrics('pod-b', series('pod-b', '404', '7'));
    const r = sh(
      lib(`fn_pods_ready() { printf 'pod-a uid-a l\\npod-b uid-b l\\n'; }\nrequest_snapshot`),
    );
    expect(r.code).toBe(0);
    expect(r.out.trim().split('\n')).toEqual(['uid-a 4', 'uid-b 7']);
  });
  it('FAILS when any one pod cannot be read: no short snapshot, no zero for the unreadable one', () => {
    metrics('pod-a', series('pod-a', '404', '4'));
    metrics('pod-b', '');
    const r = sh(
      lib(`fn_pods_ready() { printf 'pod-a uid-a l\\npod-b uid-b l\\n'; }\nrequest_snapshot`),
    );
    expect(r.code).not.toBe(0);
    expect(r.err).toContain('pod-b');
  });
});

const BEFORE = 'uid-a 4\nuid-b 7';

describe('answering_pod_uid: the pod whose counter rose by exactly one', () => {
  const answered = (before: string, after: string) =>
    sh(lib(`answering_pod_uid '${before}' '${after}'`));

  it('names pod A when only A rose, and pod B when only B rose', () => {
    expect(answered(BEFORE, 'uid-a 5\nuid-b 7').out.trim()).toBe('uid-a');
    expect(answered(BEFORE, 'uid-a 4\nuid-b 8').out.trim()).toBe('uid-b');
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

describe('the verdicts on a held call: status, code, message AND the answering pod', () => {
  const A_ROSE = 'uid-a 5\nuid-b 7';
  const B_ROSE = 'uid-a 4\nuid-b 8';
  const accepted = (want: string, after: string, status: string, code: string) =>
    sh(lib(`check_accepted_by '${want}' '${BEFORE}' '${after}' '${status}' '${code}'`)).code;
  const refused = (want: string, after: string, status: string, code: string, msg: string) =>
    sh(lib(`check_refused_by '${want}' '${BEFORE}' '${after}' '${status}' '${code}' '${msg}'`))
      .code;

  it('the control: 404 not_found from the expected pod passes, and only that', () => {
    expect(accepted('uid-a', A_ROSE, '404', 'not_found')).toBe(0);
    expect(accepted('uid-a', B_ROSE, '404', 'not_found')).not.toBe(0); // wrong pod
    expect(accepted('uid-a', BEFORE, '404', 'not_found')).not.toBe(0); // nobody
    expect(accepted('uid-a', A_ROSE, '401', 'not_found')).not.toBe(0); // status
    expect(accepted('uid-a', A_ROSE, '404', 'unauthenticated')).not.toBe(0); // code
  });
  it('the fresh-token control on pod B uses the same verdict, so pod B must be the answerer', () => {
    expect(accepted('uid-b', B_ROSE, '404', 'not_found')).toBe(0);
    expect(accepted('uid-b', A_ROSE, '404', 'not_found')).not.toBe(0);
  });
  it("the refusal: 401 unauthenticated 'token rejected' from the expected pod passes, and only that", () => {
    expect(refused('uid-b', B_ROSE, '401', 'unauthenticated', 'token rejected')).toBe(0);
    expect(refused('uid-b', A_ROSE, '401', 'unauthenticated', 'token rejected')).not.toBe(0);
    expect(refused('uid-b', BEFORE, '401', 'unauthenticated', 'token rejected')).not.toBe(0);
    expect(refused('uid-b', B_ROSE, '404', 'unauthenticated', 'token rejected')).not.toBe(0);
    expect(refused('uid-b', B_ROSE, '401', 'not_found', 'token rejected')).not.toBe(0);
    expect(refused('uid-b', B_ROSE, '401', 'unauthenticated', 'missing bearer token')).not.toBe(0);
    expect(refused('uid-b', B_ROSE, '401', 'unauthenticated', 'something else')).not.toBe(0);
    expect(refused('uid-b', B_ROSE, '401', 'unauthenticated', '')).not.toBe(0);
  });
});

describe('check_direct_accepted: the policy-off positive control (a VALID token on the direct path)', () => {
  const direct = (status: string, code: string) =>
    sh(lib(`check_direct_accepted '${status}' '${code}'`));

  it('passes on 404 not_found, and only that', () => {
    expect(direct('404', 'not_found').code).toBe(0);
    expect(direct('401', 'unauthenticated').code).not.toBe(0); // the valid token was refused
    expect(direct('404', 'unauthenticated').code).not.toBe(0);
    expect(direct('200', '').code).not.toBe(0);
    expect(direct('000', '').code).not.toBe(0); // no answer
    expect(direct('500', 'internal').code).not.toBe(0);
  });
  it('says why a refused valid token makes the policy-off refusals meaningless', () => {
    expect(direct('401', 'unauthenticated').err).toContain('refused a VALID token');
  });
});

/**
 * WIRING checks. These read run.sh as text and only establish that it CALLS the functions above,
 * where it should, in the order it should. They say nothing about what the functions decide.
 */
describe('wiring: run.sh calls the answering-pod functions in the right place', () => {
  const fnBody = (name: string): string => {
    const start = run.indexOf(`\n${name}() {`);
    expect(start, `${name}() is defined`).toBeGreaterThan(-1);
    return run.slice(start, run.indexOf('\n}\n', start));
  };
  const hold = fnBody('hold_call');
  const warm = fnBody('phase_heldwarm');

  it('sources the lib', () => {
    expect(run).toContain('source "${HERE}/answering-pod.sh"');
  });
  it('never assigns HELD_POD_UID from an argument or the target pod', () => {
    const assigns = run.split('\n').filter((l) => /^\s*HELD_POD_UID=/.test(l));
    expect(assigns.length).toBeGreaterThan(0);
    for (const l of assigns) {
      expect(l).toMatch(/^\s*HELD_POD_UID=("")$|HELD_POD_UID="\$\(answering_pod_uid /);
    }
  });
  it('hold_call snapshots the counters before the call and after the answer, before release_pods', () => {
    const before = hold.indexOf('HELD_REQ_BEFORE="$(request_snapshot)"');
    const probe = hold.indexOf('bun "${Z7}/probe.ts"');
    const answered = hold.indexOf('wait "$(cat "${HELD_PIDFILE}")"');
    const after = hold.indexOf('HELD_REQ_AFTER="$(request_snapshot)"');
    const release = hold.indexOf('release_pods', answered);
    expect(before).toBeGreaterThan(-1);
    expect(before).toBeLessThan(probe);
    expect(after).toBeGreaterThan(answered);
    expect(after).toBeLessThan(release);
    expect(hold).toContain('answering_pod_uid "${HELD_REQ_BEFORE}" "${HELD_REQ_AFTER}"');
  });
  it('policyoff (Go and Rust): the valid-token control follows the garbage-token refusal and is judged by check_direct_accepted', () => {
    for (const [phase, refusedMarker, controlHost] of [
      ['phase_policyoff', 'REFUSED-BY-FUNCTION-WITH-POLICY-OFF', '"${FN_HOST}"'],
      [
        'policyoff_rust',
        'REFUSED-BY-RUST-FUNCTION-WITH-POLICY-OFF',
        '"${RUST_FN}.${NS}.svc.cluster.local"',
      ],
    ] as const) {
      const body = fnBody(phase);
      const refused = body.indexOf(refusedMarker);
      const mint = body.indexOf('direct_valid_token', refused);
      const verdict = body.indexOf('check_direct_accepted "${FC_STATUS}" "${FC_CODE}"', mint);
      expect(refused, `${phase}: refusal line`).toBeGreaterThan(-1);
      expect(mint, `${phase}: valid-token call`).toBeGreaterThan(refused);
      expect(body.slice(mint, verdict)).toContain(controlHost);
      expect(verdict, `${phase}: verdict`).toBeGreaterThan(mint);
    }
  });
  it('phase_heldwarm: the control, the refusal and the pod B fresh-token control each call their check', () => {
    const ctl = warm.indexOf('check_accepted_by "${wuid_a}" "${HELD_REQ_BEFORE}"');
    const ref = warm.indexOf('check_refused_by "${wuid_b}" "${HELD_REQ_BEFORE}"');
    const fresh = warm.indexOf('check_accepted_by "${wuid_b}" "${bctl_before}" "${bctl_after}"');
    expect(ctl).toBeGreaterThan(-1);
    expect(ref).toBeGreaterThan(ctl);
    expect(fresh).toBeGreaterThan(ref);
  });
  it('phase_heldwarm: the fresh call goes to pod B alone, between its isolation and the release', () => {
    const iso = warm.indexOf('isolate_pods "${wuid_b}"', warm.indexOf('check_refused_by'));
    const b0 = warm.indexOf('bctl_before="$(request_snapshot)"');
    const probe = warm.indexOf('fn_probe "${WORK}/key-held" fresh-b');
    const b1 = warm.indexOf('bctl_after="$(request_snapshot)"');
    const rel = warm.indexOf('release_pods', b1);
    expect(iso).toBeGreaterThan(-1);
    expect(b0).toBeGreaterThan(iso);
    expect(probe).toBeGreaterThan(b0);
    expect(b1).toBeGreaterThan(probe);
    expect(rel).toBeGreaterThan(b1);
  });
});
