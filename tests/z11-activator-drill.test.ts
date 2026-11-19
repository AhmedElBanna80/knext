/**
 * Cluster-free guards for the Z11 activator-path drill (#2056):
 * packages/grpc/e2e/z11-activator-drill/run.sh.
 *
 * The drill's claims hold only if: the cluster runs Calico; the refusal it records
 * is the function's 401 on a call that went through the activator; the direct dial
 * is judged next to a mutation that removes the policy; and the no-interceptor
 * mutation must flip the same call to reaching the handler.
 */
import { describe, expect, it } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const WORKFLOW = resolve(
  import.meta.dirname,
  '..',
  '.github/workflows/z11-activator-drill-e2e.yml',
);

const REPO_ROOT = resolve(import.meta.dirname, '..');
const own = readFileSync(
  resolve(REPO_ROOT, 'packages/grpc/e2e/z11-activator-drill/run.sh'),
  'utf8',
);
const calico = readFileSync(resolve(REPO_ROOT, 'scripts/kind-manifests/apply-calico.sh'), 'utf8');

function body(name: string): string {
  const start = own.indexOf(`\n${name}() {`);
  expect(start, `${name}() is defined`).toBeGreaterThan(-1);
  return own.slice(start, own.indexOf('\n}\n', start));
}

describe('the drill is careful', () => {
  it('fails on errors, never traces, and dispatches every phase', () => {
    expect(own).toMatch(/^set -euo pipefail$/m);
    expect(own).toMatch(/^set \+x$/m);
    expect(own).not.toMatch(/kind delete/);
    expect(own).toMatch(
      /^ {4}up \| deploy \| token \| direct \| policyoff \| noauth \| rotcold \| held \| heldwarm\) ;;$/m,
    );
    for (const p of [
      'up',
      'deploy',
      'token',
      'direct',
      'policyoff',
      'noauth',
      'rotcold',
      'held',
      'heldwarm',
    ]) {
      expect(own).toContain(`if has_phase ${p}; then phase_${p}; fi`);
    }
  });

  it('refuses to run on a cluster without Calico', () => {
    expect(own).toMatch(
      /get daemonset calico-node >\/dev\/null 2>&1 \\\n\s*\|\| fail "the cluster runs no Calico/,
    );
  });

  it('installs Calico checksum- and digest-pinned', () => {
    expect(calico).toMatch(/sha256sum -c -/);
    expect(calico).toMatch(/pin-known-images\.sh" "\$OUT" --expect 3/);
    expect(own).toContain('"${REPO}/scripts/kind-manifests/apply-calico.sh"');
  });
});

describe('every direct dial wakes the function and waits for a Ready pod first', () => {
  const w = body('wake_ready');
  it('wake_ready calls the zone, waits bounded for 404 and a Ready pod, and fails closed', () => {
    expect(w).toContain('zone_call "/example/get?sub=alice&id=missing"');
    expect(w).toContain('fn_pod_ip');
    expect(w).toContain('SECONDS + 180');
    expect(w).toMatch(/\[ "\$\{ZC_STATUS\}" = 404 \] && \[ -n "\$\{ip\}" \]/);
    expect(w).toMatch(/\n {2}fail "no Ready/);
  });
  it('phase_direct wakes before any pod lookup or dial; every await_direct_ip call is preceded by wake_ready', () => {
    const b = body('phase_direct');
    expect(b.indexOf('wake_ready'), 'phase_direct wakes').toBeGreaterThan(-1);
    expect(b.indexOf('wake_ready')).toBeLessThan(b.indexOf('dial_rc'));
    expect(b.indexOf('wake_ready')).toBeLessThan(b.indexOf('fn_pod_ip'));
    // await_direct_ip does not call wake_ready itself (the call chain would be too deep
    // for the supply-chain scanner); its callers do, on the line right before it.
    expect(body('await_direct_ip')).not.toContain('wake_ready');
    const calls = [...own.matchAll(/^( *)await_direct_ip$/gm)];
    expect(calls.length).toBeGreaterThanOrEqual(2);
    for (const m of calls) {
      const before = own.slice(0, m.index).trimEnd().split('\n').pop();
      expect(before, 'wake_ready right before await_direct_ip').toBe(`${m[1]}wake_ready`);
    }
  });
});

describe('token: the refusal is the function, on the activator path', () => {
  const t = body('phase_token');
  it('the function is at zero first, and the refused call woke it', () => {
    // Present AND before: indexOf of a missing line is -1, which would also sort first.
    expect(t.indexOf('await_zero "${GO_FN}"')).toBeGreaterThan(-1);
    expect(t.indexOf('await_zero "${GO_FN}"')).toBeLessThan(t.indexOf('foreign_get ""'));
    expect(t).toMatch(/\[ "\$\(all_pods "\$\{GO_FN\}"\)" -ge 1 \] \|\| fail/);
  });
  it('both a missing and a garbage token must be 401 unauthenticated, next to a zone control', () => {
    expect(t.match(/= 401 \] && \[ "\$\{FC_CODE\}" = unauthenticated \]/g)?.length).toBe(2);
    expect(t).toContain('foreign_get "Bearer not-a-token"');
    expect(t).toContain('[ "${FC_MESSAGE}" = "missing bearer token" ]');
    expect(t).toContain('[ "${FC_MESSAGE}" = "token rejected" ]');
    // The garbage-token call is cold too.
    expect(t.match(/await_zero "\$\{GO_FN\}"/g)?.length).toBe(2);
    expect(t).toMatch(/expect_zone "control: [^"]*" \\\n\s*"[^"]*" 404 '[^']*"NotFound"'/);
  });
  it('the foreign call goes to the cluster-local URL from another namespace', () => {
    expect(own).toContain('FN_URL="http://${GO_FN}.${NS}.svc.cluster.local"');
    expect(own).toContain('FOREIGN="${NS}-foreign"');
    expect(body('foreign_get')).toContain('k -n "${FOREIGN}" exec caller');
  });
});

describe('direct: dropped by the policy, proved by removing it', () => {
  const d = body('phase_direct');
  it('only a timeout counts as dropped, on both ports, after a wake that reached the function', () => {
    expect(d).toContain('for port in 8080 8013; do');
    expect(d).toMatch(/\[ "\$\{rc\}" = 28 \] \|\| fail/);
    expect(d).toContain('wake_ready');
    expect(body('wake_ready')).toMatch(/\[ "\$\{ZC_STATUS\}" = 404 \]/);
    expect(body('fn_pod_ip')).toContain('select(.type == "Ready")');
  });

  it('with the policy off both ports must connect, and the policy is restored', () => {
    expect(d).toContain('[ "$(dial_rc "${ip}" 8080)" = 0 ] && [ "$(dial_rc "${ip}" 8013)" = 0 ]');
    expect(d.indexOf('set_policy false')).toBeGreaterThan(d.indexOf('for port in 8080 8013'));
    expect(d).toMatch(/\[ "\$\{opened\}" = 1 \] \|\| fail/);
    expect(d.indexOf('set_policy true')).toBeLessThan(d.indexOf('[ "${opened}" = 1 ]'));
  });
});

describe('an aborted mutation never leaves the function unsafe', () => {
  it('the exit handler restores the policy and the image when a mutation is in flight', () => {
    const c = body('cleanup');
    expect(c).toMatch(/if \[ "\$\{RESTORE_POLICY\}" = 1 \]; then/);
    expect(c).toContain('{"spec":{"security":{"networkPolicy":true}}}');
    expect(c).toMatch(/if \[ -n "\$\{RESTORE_IMAGE\}" \]; then/);
    expect(body('set_policy')).toContain('if [ "$1" = false ]; then RESTORE_POLICY=1; fi');
    const n = body('phase_noauth');
    expect(n.indexOf('RESTORE_IMAGE="${good}"')).toBeLessThan(n.indexOf('"image\\":\\"${bad}'));
    expect(n).toMatch(/\[ "\$\{good\}" != "\$\{bad\}" \] \|\| fail/);
  });
});

describe('noauth: without the interceptor the same call reaches the handler', () => {
  it('removes exactly the interceptor line, and requires not_found for the no-token call', () => {
    const dep = body('phase_deploy');
    expect(dep).toContain("anchor='\t\tauth.NewInterceptor(verifier),'");
    expect(dep).toMatch(/grep -cxF -- "\$\{anchor\}"[^\n]*\)" = 1 \]/);
    const n = body('phase_noauth');
    expect(n).toMatch(/\[ "\$\{status\}" = 404 \] && \[ "\$\{code\}" = not_found \]/);
    expect(n.indexOf('await_zero')).toBeGreaterThan(-1);
    expect(n.indexOf('await_zero')).toBeLessThan(n.indexOf('foreign_get ""'));
  });
});

describe('policyoff: with the NetworkPolicy off the function itself refuses a token-less call', () => {
  const p = body('phase_policyoff');
  it('turns the policy off, proves the object is gone, and restores it afterwards', () => {
    expect(p).toContain('set_policy false');
    expect(p).toMatch(
      /networkpolicy "\$\{GO_FN\}-function-ingress"[^\n]*grep -c \.\)" = 0 \] \\\n\s*\|\| fail/,
    );
    expect(p.indexOf('set_policy false')).toBeLessThan(p.indexOf('foreign_get ""'));
    expect(p.indexOf('set_policy true')).toBeGreaterThan(p.indexOf('foreign_post "http://'));
  });
  it('the cold call is refused 401 unauthenticated after waking the function', () => {
    expect(p.indexOf('await_zero_all "${GO_FN}"')).toBeGreaterThan(p.indexOf('set_policy false'));
    expect(p.indexOf('await_zero_all "${GO_FN}"')).toBeLessThan(p.indexOf('foreign_get ""'));
    expect(p).toMatch(/\[ "\$\(all_pods "\$\{GO_FN\}"\)" -ge 1 \] \|\| fail/);
  });
  // Each leg's assertion is tied to its OWN call: the slice from that call to the next
  // one must carry the full 401/code/message check. Counting matches elsewhere would let
  // one leg's assertion be weakened while the others still add up.
  const seg = (from: string, to: string): string => {
    const a = p.indexOf(from);
    expect(a, `${from} is in phase_policyoff`).toBeGreaterThan(-1);
    expect(p.indexOf(from, a + 1), `${from} occurs once`).toBe(-1);
    const b = p.indexOf(to, a);
    expect(b, `${to} follows ${from}`).toBeGreaterThan(a);
    return p.slice(a, b);
  };
  const refused = (msg: string) =>
    `[ "\${FC_STATUS}" = 401 ] && [ "\${FC_CODE}" = unauthenticated ] && [ "\${FC_MESSAGE}" = "${msg}" ]`;
  it('the cold call is its own call, asserted 401 unauthenticated "missing bearer token"', () => {
    const leg = seg('foreign_get ""', 'all_pods');
    expect(leg).toContain(refused('missing bearer token'));
    expect(leg).toContain('policy off, cold, no token');
  });
  it('the direct dial must connect (rc 0), kept warm through the zone', () => {
    const w = body('await_direct_ip');
    expect(w).toContain('zone_call "/example/get?sub=alice&id=missing"');
    expect(w.indexOf('zone_call')).toBeLessThan(w.indexOf('dial_rc'));
    expect(w).toMatch(/dial_rc "\$\{ip\}" 8080\)" = 0 \]; then DIRECT_IP=/);
    expect(w).toMatch(/\n {2}fail "policy off: the foreign pod could not reach/);
    expect(p).toContain('await_direct_ip');
  });
  it('the direct no-token call is asserted 401 "missing bearer token"', () => {
    const leg = seg(
      'foreign_post "http://${ip}:8080${GET_ITEM}" ""',
      'foreign_post "http://${ip}:8080${GET_ITEM}" "Bearer',
    );
    expect(leg).toContain(refused('missing bearer token'));
    expect(leg).toContain('direct to the pod, no token');
  });
  it('the direct garbage-token call is asserted 401 "token rejected"', () => {
    const leg = seg(
      'foreign_post "http://${ip}:8080${GET_ITEM}" "Bearer not-a-token"',
      'echo "REFUSED',
    );
    expect(leg).toContain(refused('token rejected'));
    expect(leg).toContain('direct to the pod, garbage token');
  });
});

describe('policyoff, Rust: the Rust template function itself refuses a token-less call with the policy off', () => {
  const r = body('policyoff_rust');
  const refused = (msg: string) =>
    `[ "\${FC_STATUS}" = 401 ] && [ "\${FC_CODE}" = unauthenticated ] && [ "\${FC_MESSAGE}" = "${msg}" ]`;
  const seg = (from: string, to: string): string => {
    const a = r.indexOf(from);
    expect(a, `${from} is in policyoff_rust`).toBeGreaterThan(-1);
    expect(r.indexOf(from, a + 1), `${from} occurs once`).toBe(-1);
    const b = r.indexOf(to, a);
    expect(b, `${to} follows ${from}`).toBeGreaterThan(a);
    return r.slice(a, b);
  };
  it('the drill deploys the Rust template function next to the Go one, and runs the leg from policyoff', () => {
    expect(own).toContain('RUST_FN=inventory-rust');
    expect(own).toMatch(/Z10_WITH_RUST=1 /);
    expect(own).not.toMatch(/Z10_WITH_RUST=0/);
    const p = body('phase_policyoff');
    expect(p).toContain('set_rust_policy false');
    expect(p).toContain('policyoff_rust');
    expect(p.indexOf('set_rust_policy false')).toBeLessThan(p.indexOf('policyoff_rust'));
    // The Rust object is proven gone before any Rust call, like the Go one.
    expect(p).toMatch(
      /networkpolicy "\$\{RUST_FN\}-function-ingress"[^\n]*grep -c \.\)" = 0 \] \\\n\s*\|\| fail/,
    );
  });
  it('the Rust policy is restored by the leg and by the exit handler', () => {
    expect(r).toContain('set_rust_policy true');
    expect(body('set_rust_policy')).toContain('RESTORE_RUST_POLICY=1');
    expect(body('set_rust_policy')).toContain('RESTORE_RUST_POLICY=0');
    expect(body('set_rust_policy')).toContain('${RUST_FN}-function-ingress');
    const c = body('cleanup');
    expect(c).toMatch(/if \[ "\$\{RESTORE_RUST_POLICY\}" = 1 \]; then/);
    expect(c).toContain('backendservice "${RUST_FN}"');
  });
  it('the Rust function is cold first, and the refused call woke it', () => {
    expect(r.indexOf('all_pods "${RUST_FN}")" = 0 ] || fail')).toBeGreaterThan(-1);
    expect(r.indexOf('all_pods "${RUST_FN}")" = 0 ] || fail')).toBeLessThan(
      r.indexOf('foreign_post "${RUST_URL}${GET_ITEM}" ""'),
    );
    expect(r).toMatch(/\[ "\$\(all_pods "\$\{RUST_FN\}"\)" -ge 1 \] \|\| fail/);
  });
  it('the cold Rust call is its own call, asserted 401 unauthenticated "missing bearer token"', () => {
    const leg = seg('foreign_post "${RUST_URL}${GET_ITEM}" ""', 'all_pods "${RUST_FN}")" -ge 1');
    expect(leg).toContain(refused('missing bearer token'));
    expect(leg).toContain('policy off, Rust, cold, no token');
  });
  it('the direct Rust dial must connect (rc 0) before the direct calls are judged', () => {
    const w = body('await_rust_ip');
    expect(w).toContain('foreign_post "${RUST_URL}${GET_ITEM}" ""');
    expect(w).toMatch(/dial_rc "\$\{ip\}" 8080\)" = 0 \]; then RUST_IP=/);
    expect(w).toMatch(/\n {2}fail "policy off: the foreign pod could not reach the warm Rust/);
    expect(r).toContain('await_rust_ip');
    expect(r.indexOf('await_rust_ip')).toBeLessThan(
      r.indexOf('foreign_post "http://${RUST_IP}:8080'),
    );
  });
  it('the direct Rust no-token call is asserted 401 "missing bearer token"', () => {
    const leg = seg(
      'foreign_post "http://${RUST_IP}:8080${GET_ITEM}" ""',
      'foreign_post "http://${RUST_IP}:8080${GET_ITEM}" "Bearer',
    );
    expect(leg).toContain(refused('missing bearer token'));
    expect(leg).toContain('policy off, Rust, direct to the pod, no token');
  });
  it('the direct Rust garbage-token call is asserted 401 "token rejected"', () => {
    const leg = seg(
      'foreign_post "http://${RUST_IP}:8080${GET_ITEM}" "Bearer not-a-token"',
      'echo "REFUSED',
    );
    expect(leg).toContain(refused('token rejected'));
    expect(leg).toContain('policy off, Rust, direct to the pod, garbage token');
  });
});

describe('drain: the Go and Rust functions drain at the same time', () => {
  it('await_zero_all polls every named service under one bound and fails closed', () => {
    const a = body('await_zero_all');
    expect(a).toContain('for svc in "$@"; do');
    expect(a).toMatch(/until \[ "\$\(all_pods "\$\{svc\}"\)" = 0 \]; do/);
    expect(a).toMatch(/\[ "\$\{SECONDS\}" -lt "\$\{end\}" \] \|\| fail/);
    expect(a).toContain('local end=$((SECONDS + 300))');
  });
  it('policyoff waits for both functions at once before the first cold call', () => {
    const p = body('phase_policyoff');
    expect(p).toContain('await_zero_all "${GO_FN}" "${RUST_FN}"');
    expect(p).not.toContain('await_zero "${GO_FN}"');
    expect(p.indexOf('await_zero_all')).toBeLessThan(p.indexOf('foreign_get ""'));
    expect(p.indexOf('await_zero_all')).toBeGreaterThan(p.indexOf('set_rust_policy false'));
  });
});

describe('noauth with the policy off: nothing refuses the direct no-token call', () => {
  const n = body('phase_noauth');
  it('turns the policy off, dials the pod directly, and requires 404 not_found', () => {
    const off = n.indexOf('set_policy false');
    expect(off).toBeGreaterThan(n.indexOf('foreign_get ""'));
    expect(n.indexOf('await_direct_ip')).toBeGreaterThan(off);
    const dial = n.indexOf('foreign_post "http://${dip}:8080${GET_ITEM}" ""');
    expect(dial).toBeGreaterThan(n.indexOf('await_direct_ip'));
    const restore = n.indexOf('set_policy true');
    expect(restore).toBeGreaterThan(dial);
    // The policy goes back on before the image is put back.
    expect(restore).toBeLessThan(n.indexOf('\\"image\\":\\"${good}'));
    expect(n).toMatch(
      /\[ "\$\{pstatus\}" = 404 \] && \[ "\$\{pcode\}" = not_found \] \\\n\s*\|\| fail "no interceptor and no policy/,
    );
  });
});

describe('CI runs the drill by default, including the policy-off leg', () => {
  const wf = readFileSync(WORKFLOW, 'utf8');
  it('runs run.sh with no PHASES override, on integration and main, with no continue-on-error', () => {
    expect(wf).toContain('packages/grpc/e2e/z11-activator-drill/run.sh');
    expect(wf).not.toMatch(/^\s*PHASES:/m);
    expect(wf).not.toMatch(/continue-on-error/);
    // No step-level condition on the drill run step either: it would skip it silently.
    const runStep = wf.slice(wf.indexOf('- name: Run the Z11 activator-path drill'));
    const stepBlock = runStep.slice(
      0,
      runStep.indexOf('\n\n') > 0 ? runStep.indexOf('\n\n') : runStep.length,
    );
    expect(stepBlock).toContain('run: packages/grpc/e2e/z11-activator-drill/run.sh');
    expect(stepBlock).not.toMatch(/^\s+if:/m);
    expect(wf).toMatch(/push:\n\s+branches: \[main, 'integration\/\*\*'\]/);
  });
  const pathLists = (): string[][] =>
    [...wf.matchAll(/^ {4}paths:\n((?: {6}(?:#.*|- .*)\n)+)/gm)].map((m) =>
      m[1]
        .split('\n')
        .filter((l) => l.trim().startsWith('- '))
        .map((l) => l.trim().slice(2).replace(/^'|'$/g, '')),
    );
  it('path filters are narrow but cover everything that can change the drill outcome', () => {
    const lists = pathLists();
    expect(lists.length).toBe(2);
    expect(lists[0]).toEqual(lists[1]);
    const paths = lists[0];
    for (const must of [
      'packages/grpc/e2e/z11-activator-drill/**',
      'packages/grpc/e2e/lib/kind-lane.sh',
      'packages/grpc/e2e/z7-identity-kind/probe.ts',
      'packages/grpc/e2e/z7-identity-kind/probe-lib.ts',
      'scripts/kind-manifests/**',
      'templates/go/internal/auth/**',
      'templates/go/internal/rpc/rpc.go',
      'packages/grpc/src/signer.ts',
      'packages/kn-next-operator/internal/controller/netpol_*.go',
      'packages/kn-next-operator/internal/controller/nextapp_networkpolicy.go',
      'packages/kn-next-operator/internal/controller/backendservice_render.go',
      '.github/workflows/z11-activator-drill-e2e.yml',
      'tests/z11-activator-drill.test.ts',
    ]) {
      expect(paths, `${must} triggers the drill`).toContain(must);
    }
    // Whole-tree globs are the cost this narrowing removed.
    for (const broad of [
      'packages/kn-next-operator/**',
      'templates/go/**',
      'packages/grpc/e2e/**',
      'packages/grpc/src/*.ts',
      'packages/grpc/scripts/**',
      'bun.lock',
    ]) {
      expect(paths, `${broad} is too broad`).not.toContain(broad);
    }
    // Every include that names a file in the repo must exist (a stale path never fires).
    for (const g of paths.filter((x) => !x.startsWith('!') && !x.includes('*'))) {
      expect(existsSync(resolve(REPO_ROOT, g)), `${g} exists`).toBe(true);
    }
  });
  it('the run step and the job budget cover the rotcold, held and heldwarm phases', () => {
    expect(wf).toContain(
      'Run the Z11 activator-path drill (all phases, including policyoff, rotcold, held and heldwarm)',
    );
    expect(wf).toMatch(/timeout-minutes: 90\b/);
  });
  it('the default phase list of the script includes policyoff, rotcold, held and heldwarm', () => {
    expect(own).toMatch(
      /PHASES="\$\{PHASES:-up deploy token direct policyoff noauth rotcold held heldwarm\}"/,
    );
  });
});

// The failure mode ADR-0004 names: a zone key rotated while a function is at zero, and a
// call the activator holds past the token's life. Both phases are scanned as text, so each
// assertion is tied to its own call (a slice from one call to the next), never counted.
describe('rotcold: a cold pod accepts only the new key after a rotation done at zero', () => {
  const r = body('phase_rotcold');
  const seg = (from: string, to: string): string => {
    const a = r.indexOf(from);
    expect(a, `${from} is in phase_rotcold`).toBeGreaterThan(-1);
    expect(r.indexOf(from, a + 1), `${from} occurs once`).toBe(-1);
    const b = r.indexOf(to, a);
    expect(b, `${to} follows ${from}`).toBeGreaterThan(a);
    return r.slice(a, b);
  };
  it('refuses to start on a zone with a rotation in flight, and exports the old key first', () => {
    expect(r).toMatch(
      /\[ -z "\$\(secret_get next\.kid\)" \] && \[ -z "\$\(secret_get previous\.kid\)" \] \\\n\s*\|\| fail/,
    );
    expect(r.indexOf('export_key "${WORK}/key-old" current')).toBeGreaterThan(-1);
    expect(r.indexOf('export_key "${WORK}/key-old" current')).toBeLessThan(
      r.indexOf('apps.kn-next.dev/rotate-signing-key='),
    );
  });
  it('the control: before the rotation a cold pod accepts the old key (404 not_found)', () => {
    const leg = seg('fn_probe "${WORK}/key-old" ctl', 'await_zero');
    expect(leg).toContain('[ "${PR_STATUS}" = 404 ] && [ "${PR_CODE}" = not_found ]');
    expect(leg).toContain('before the rotation');
  });
  it('the rotation is requested, switched and retired while the function is at zero', () => {
    // The scale to zero sits between the phase's 1/4 marker and the request itself: the
    // control's own await_zero before it must not be able to stand in for this one.
    expect(seg('log "rotcold 1/4', 'apps.kn-next.dev/rotate-signing-key=')).toContain(
      'await_zero "${GO_FN}"',
    );
    expect(r).toContain(
      '"the previous key to leave the Secret" \'[ -z "$(secret_get previous.kid)" ]\'',
    );
    expect(r).toContain(
      '"the JWKS to publish only the new key" \'[ "$(jwks_kids)" = "${new_kid}" ]\'',
    );
    expect(r).toContain(
      'wait_until 60 1 "the operator to take the rotation request" \'[ -n "$(secret_get next.kid)" ]\'',
    );
    expect(r).toContain(
      'wait_until $((BOUND_SECONDS + 150)) 2 "signing to switch to the new key" \'[ "$(secret_get current.kid)" = "${new_kid}" ]\'',
    );
    expect(r).toContain('apps.kn-next.dev/signing-key-switched-at=');
    expect(r).toContain('rollout restart deployment/kn-next-operator-controller-manager');
    expect(r).toContain('[ "$(jwks_kids)" = "${new_kid}" ]');
    expect(seg('log "rotcold 4/4', 'fn_probe "${WORK}/key-old" old')).toMatch(
      /\[ "\$\(all_pods "\$\{GO_FN\}"\)" = 0 \] \|\| fail/,
    );
  });
  it('the cold pod refuses the OLD key as 401 unauthenticated, and the refused call woke it', () => {
    const leg = seg('fn_probe "${WORK}/key-old" old', 'await_zero');
    expect(leg).toContain('[ "${PR_STATUS}" = 401 ] && [ "${PR_CODE}" = unauthenticated ]');
    expect(leg).toContain('cold pod, retired key');
    expect(leg).toMatch(/\[ "\$\(all_pods "\$\{GO_FN\}"\)" -ge 1 \] \|\| fail/);
  });
  it('a second cold pod accepts the NEW key (404 not_found), and the zone still reaches it', () => {
    const leg = seg('fn_probe "${WORK}/key-new" new', 'expect_zone');
    // A second scale to zero first: the pod that refused the old key must not answer this call.
    expect(seg('cold pod, retired key ${old_kid}', 'fn_probe "${WORK}/key-new" new')).toContain(
      'await_zero "${GO_FN}"',
    );
    expect(leg).toContain('[ "${PR_STATUS}" = 404 ] && [ "${PR_CODE}" = not_found ]');
    expect(leg).toContain('cold pod, new key');
    expect(r).toContain('expect_zone "control: after the rotation the zone');
  });
  it('fn_probe: no retry on an answer, and the key slot is read from the Secret', () => {
    const f = body('fn_probe');
    expect(f).toContain('--auth signer --key-dir "$1"');
    expect(f).toContain('--timeout-seconds');
    expect(f).toContain('[ "${rc}" = 2 ]');
    expect(body('export_key')).toContain(
      `'.data[$s] // empty | @base64d' <<<"\${json}" >"\${dir}/current.key"`,
    );
  });
});

describe('held: a call the activator holds past the token life is refused, and validation still works', () => {
  const h = body('phase_held');
  const c = body('hold_call');
  it('hold_call scales to zero (cold), records the quota, then creates it before it sends the call', () => {
    expect(c.indexOf('await_zero "${GO_FN}"')).toBeGreaterThan(-1);
    expect(c.indexOf('await_zero "${GO_FN}"')).toBeLessThan(c.indexOf('create resourcequota'));
    expect(c.indexOf('RESTORE_QUOTA=1')).toBeGreaterThan(-1);
    expect(c.indexOf('RESTORE_QUOTA=1')).toBeLessThan(c.indexOf('create resourcequota'));
    expect(c).toContain('create resourcequota "${HOLD_QUOTA}" --hard=pods=0');
    expect(c.indexOf('create resourcequota')).toBeLessThan(c.indexOf('bun "${Z7}/probe.ts"'));
    expect(c).toContain('echo "$!" >"${HELD_PIDFILE}"');
    // Nothing is cordoned: the hold is scoped to the function's namespace.
    expect(c).not.toMatch(/cordon/);
    expect(own).not.toMatch(/\bk (un)?cordon\b/);
    // Flat: an inline wait (wait_until's eval would exceed the scanner's call-chain limit).
    expect(c).toContain('-ge 1 ]; do');
    expect(c).toContain('.items[].spec.replicas');
    expect(c).not.toMatch(/wait_until [0-9]/);
  });
  it('the call stays outstanding for the whole hold, is a direct call with its own long timeout', () => {
    expect(own).toMatch(/^HELD_SECONDS="\$\{Z11_HELD_SECONDS:-80\}"$/m);
    expect(own).toMatch(/^CONTROL_HELD_SECONDS="\$\{Z11_CONTROL_HELD_SECONDS:-30\}"$/m);
    expect(c).toContain('while [ $((SECONDS - start)) -lt "$1" ]; do');
    expect(c).toMatch(
      /kill -0 "\$\(cat "\$\{HELD_PIDFILE\}"\)" 2>\/dev\/null \|\| fail "the held call ended/,
    );
    expect(c).toContain('--with-message --timeout-seconds 240');
    expect(c).toMatch(/\[ "\$\{HELD_FOR\}" -ge "\$1" \] \|\| fail/);
    expect(c).not.toContain('fn_probe');
    expect(c.indexOf('kill -0')).toBeLessThan(c.indexOf('delete resourcequota "${HOLD_QUOTA}"'));
    expect(c.indexOf('delete resourcequota "${HOLD_QUOTA}"')).toBeLessThan(
      c.indexOf('RESTORE_QUOTA=0'),
    );
    // After the quota is gone the ReplicaSet is nudged, so it is not still in its retry backoff.
    expect(c.indexOf('delete resourcequota')).toBeLessThan(c.indexOf('annotate replicaset'));
    // Both halves of the hold check: a cold hold has no pod, a warm hold has exactly the one.
    expect(c).toMatch(
      /\[ "\$\(all_pods "\$\{GO_FN\}"\)" = 0 \] \|\| fail "a \$\{GO_FN\} pod exists/,
    );
    expect(c).toMatch(
      /\[ "\$\(fn_pod_uids\)" = "\$\{uids_before\}" \] \|\| fail "the warm pods changed during the hold/,
    );
  });
  it('the control: the same hold, shorter than the token life, must be ACCEPTED (404 not_found)', () => {
    const ctl = h.slice(
      h.indexOf('hold_call "${CONTROL_HELD_SECONDS}"'),
      h.indexOf('hold_call "${HELD_SECONDS}"'),
    );
    expect(ctl).toContain('hold_call "${CONTROL_HELD_SECONDS}"');
    expect(ctl).toMatch(
      /\[ "\$\{HELD_STATUS\}" = 404 \] && \[ "\$\{HELD_CODE\}" = not_found \] \\\n\s*\|\| fail "control: a call held/,
    );
    // The control runs BEFORE the long hold, and both go through the one helper.
    expect(h.indexOf('hold_call "${CONTROL_HELD_SECONDS}"')).toBeLessThan(
      h.indexOf('hold_call "${HELD_SECONDS}"'),
    );
    expect(h.indexOf('hold_call "${CONTROL_HELD_SECONDS}"')).toBeGreaterThan(-1);
  });
  it('the long hold must be 401 unauthenticated "token rejected", never "missing bearer token"', () => {
    expect(h).toMatch(
      /\[ "\$\{HELD_STATUS\}" = 401 \] && \[ "\$\{HELD_CODE\}" = unauthenticated \] && \[ "\$\{HELD_MESSAGE\}" = "token rejected" \] \\\n\s*\|\| fail "a call held/,
    );
    expect(c).toContain('HELD_MESSAGE="$(jq -r \'.message // ""\' "${out}")"');
  });
  it('after the hold a fresh token is accepted and a garbage token is still refused', () => {
    const after = h.slice(h.indexOf('hold_call "${HELD_SECONDS}"'));
    expect(after).toContain('fn_probe "${WORK}/key-held" fresh');
    expect(after).toMatch(
      /\[ "\$\{PR_STATUS\}" = 404 \] && \[ "\$\{PR_CODE\}" = not_found \] \\\n\s*\|\| fail "after the hold a fresh token/,
    );
    expect(after).toContain('foreign_get "Bearer not-a-token"');
    expect(after).toMatch(
      /\[ "\$\{FC_STATUS\}" = 401 \] && \[ "\$\{FC_CODE\}" = unauthenticated \] && \[ "\$\{FC_MESSAGE\}" = "token rejected" \] \\\n\s*\|\| fail "after the hold a garbage token/,
    );
  });
  it('an aborted hold never leaves the quota, a detached pod, the raised scale or the call running', () => {
    const x = body('cleanup');
    expect(x).toMatch(
      /if \[ -s "\$\{HELD_PIDFILE\}" \]; then kill "\$\(cat "\$\{HELD_PIDFILE\}"\)"/,
    );
    expect(x).toMatch(/if \[ "\$\{RESTORE_QUOTA\}" = 1 \]; then/);
    expect(x).toContain('delete resourcequota "${HOLD_QUOTA}" --ignore-not-found');
    expect(x).toContain('for entry in ${RESTORE_DETACH}; do');
    expect(x).toContain('"serving.knative.dev/revisionUID=${entry#*=}" --overwrite');
    // Every detached pod goes back BEFORE the quota is deleted.
    expect(x.indexOf('for entry in ${RESTORE_DETACH}')).toBeLessThan(
      x.indexOf('delete resourcequota'),
    );
    expect(x).toMatch(/if \[ "\$\{RESTORE_MINSCALE\}" = 1 \]; then/);
    expect(x).toContain('{"spec":{"scaling":{"minScale":0,"maxScale":1}}}');
    expect(x.indexOf('kill "$(cat "${HELD_PIDFILE}")"')).toBeLessThan(
      x.indexOf('delete resourcequota'),
    );
  });
  it('the probe prints the interceptor message only on request, so the defaults are unchanged', () => {
    const probe = readFileSync(
      resolve(REPO_ROOT, 'packages/grpc/e2e/z7-identity-kind/probe.ts'),
      'utf8',
    );
    expect(probe).toContain("'with-message': { type: 'boolean', default: false }");
    expect(probe).toContain("summarize(outcome, auth.kid, values['with-message'])");
  });
});

describe('rotcold: the woken pods really started after the retirement', () => {
  const r = body('phase_rotcold');
  it('records the retirement by the API server clock and compares each pod start with it', () => {
    expect(r).toContain('retired_at="$(jwks_written_at)"');
    expect(r.indexOf('retired_at="$(jwks_written_at)"')).toBeGreaterThan(
      r.indexOf('"the JWKS to publish only the new key"'),
    );
    expect(r).toMatch(
      /\[ "\$\{old_start\}" -ge "\$\{retired_at\}" \] \\\n\s*\|\| fail "the pod that refused/,
    );
    expect(r).toMatch(
      /\[ "\$\{new_uid\}" != "\$\{old_uid\}" \] && \[ "\$\{new_start\}" -ge "\$\{retired_at\}" \] \\\n\s*\|\| fail "the pod that accepted/,
    );
    expect(body('fn_pod_started')).toContain('.metadata.uid');
    expect(body('fn_pod_started')).toContain('.status.startTime | fromdateiso8601');
    expect(body('jwks_written_at')).toContain('--show-managed-fields');
    expect(body('jwks_written_at')).toContain('managedFields');
  });
  it('the zero-pods snapshot is kept', () => {
    expect(r).toMatch(/\[ "\$\(all_pods "\$\{GO_FN\}"\)" = 0 \] \|\| fail/);
  });
});

describe('the long-call timeouts are what the phases need', () => {
  it('fn_probe waits 60 s for an answer', () => {
    expect(body('fn_probe')).toContain('--timeout-seconds 60');
  });
});

// The combined case ADR-0004 names: warm pods that cached the old key set, the key rotated under
// them, one call held past the token's life. Scanned as text; each assertion is tied to its own
// call.
describe('heldwarm: warm pods with the old key set cached, a call held past the token life', () => {
  const w = body('phase_heldwarm');
  const c = body('hold_call');
  const seg = (from: string, to: string): string => {
    const a = w.indexOf(from);
    expect(a, `${from} is in phase_heldwarm`).toBeGreaterThan(-1);
    const z = to === '' ? w.length : w.indexOf(to, a + from.length);
    expect(z, `${to} follows ${from}`).toBeGreaterThan(-1);
    return w.slice(a, z);
  };

  it('keeps TWO warm pods on a new revision and waits for exactly two', () => {
    expect(w).toContain('RESTORE_MINSCALE=1');
    expect(w.indexOf('RESTORE_MINSCALE=1')).toBeLessThan(w.indexOf('"minScale":2'));
    expect(w).toContain('{"spec":{"scaling":{"minScale":2,"maxScale":2}}}');
    expect(w).toMatch(
      /!= "\$\{rev_before\}" \] && \[ "\$\(all_pods "\$\{GO_FN\}"\)" = 2 \] && \[ "\$\(fn_pods_ready \| wc -l \| tr -d " "\)" = 2 \]/,
    );
    expect(w.indexOf('rev_before="$(')).toBeLessThan(w.indexOf('"minScale":2'));
    expect(w).toMatch(
      /\[ "\$\{wuid_a\}" != "\$\{wuid_b\}" \] \|\| fail "want two distinct warm pods/,
    );
  });

  it('loads the OLD key set into each pod with ONE call, isolated, and each must answer 404', () => {
    const pre = seg('isolate_pods "${wuid_a}"', 'log "heldwarm 1/3');
    expect(pre.indexOf('isolate_pods "${wuid_a}"')).toBeLessThan(
      pre.indexOf('fn_probe "${WORK}/key-pre" load-a'),
    );
    expect(pre.indexOf('fn_probe "${WORK}/key-pre" load-a')).toBeLessThan(
      pre.indexOf('isolate_pods "${wuid_b}"'),
    );
    expect(pre.indexOf('isolate_pods "${wuid_b}"')).toBeLessThan(
      pre.indexOf('fn_probe "${WORK}/key-pre" load-b'),
    );
    for (const x of ['A', 'B']) {
      expect(pre).toMatch(
        new RegExp(
          `\\[ "\\$\\{PR_STATUS\\}" = 404 \\] && \\[ "\\$\\{PR_CODE\\}" = not_found \\] \\\\\\n\\s*\\|\\| fail "the warm pod ${x} answered`,
        ),
      );
    }
    expect(pre.match(/release_pods/g)?.length).toBe(2);
    expect(w).toContain('export_key "${WORK}/key-pre" current');
    // No call reaches either pod between its load and its held call.
    const between = seg('log "heldwarm 1/3', 'hold_call "${CONTROL_HELD_SECONDS}" warm');
    expect(between).not.toContain('fn_probe');
    expect(between).not.toContain('foreign_get');
    expect(between).not.toContain('zone_call');
  });

  it('isolate_pods keeps one pod, waits for the endpoints to hold only it, and release_pods re-attaches before the quota goes', () => {
    const iso = body('isolate_pods');
    expect(iso).toContain('[ "${uid}" = "$1" ] && continue');
    expect(iso).toContain('create resourcequota "${HOLD_QUOTA}" --hard=pods=0');
    expect(iso).toContain("-o json | jq '[.subsets[]?.addresses[]?] | length')\" = 1 ]");
    expect(iso.indexOf('RESTORE_DETACH="${RESTORE_DETACH}${pod}=${label} "')).toBeLessThan(
      iso.indexOf('"serving.knative.dev/revisionUID=detached"'),
    );
    const rel = body('release_pods');
    expect(rel.indexOf('revisionUID=${entry#*=}')).toBeGreaterThan(-1);
    expect(rel.indexOf('revisionUID=${entry#*=}')).toBeLessThan(
      rel.indexOf('delete resourcequota "${HOLD_QUOTA}"'),
    );
    expect(rel).toContain('RESTORE_DETACH=""');
    expect(rel).toContain('RESTORE_QUOTA=0');
  });

  it('rotates and retires the key while those pods are warm, and proves none restarted', () => {
    expect(w).toContain('apps.kn-next.dev/rotate-signing-key=${wnonce}');
    expect(w).toContain(
      '"signing to switch under the warm pod" \'[ "$(secret_get current.kid)" = "${new_kid}" ]\'',
    );
    expect(w).toContain('Date.now() - 7200 * 1000');
    expect(w).toContain('rollout restart deployment.apps/kn-next-operator-controller-manager');
    expect(w).toContain(
      '"the previous key to leave the Secret under the warm pod" \'[ -z "$(secret_get previous.kid)" ]\'',
    );
    expect(w).toContain(
      '"the JWKS to publish only the new key under the warm pod" \'[ "$(jwks_kids)" = "${new_kid}" ]\'',
    );
    expect(w).toContain('wretired_at="$(jwks_written_at)"');
    expect(w).toMatch(
      /\[ "\$\(fn_pod_uids\)" = "\$\{wuids\}" \] && \[ "\$\(fn_pods_started_max\)" -lt "\$\{wretired_at\}" \] \\\n\s*\|\| fail "the pods are/,
    );
    expect(w.indexOf('wretired_at="$(jwks_written_at)"')).toBeLessThan(
      w.indexOf('hold_call "${CONTROL_HELD_SECONDS}" warm'),
    );
    expect(body('fn_pods_started_max')).toContain('.status.startTime | fromdateiso8601');
  });

  it('the control: new-key token held INSIDE the token life on stale pod A must be ACCEPTED, by A', () => {
    const ctl = seg('hold_call "${CONTROL_HELD_SECONDS}" warm "${wuid_a}"', 'log "heldwarm 3/3');
    // Wiring only: the verdict itself is exercised in tests/z11-answering-pod.test.ts.
    expect(ctl).toMatch(
      /check_accepted_by "\$\{wuid_a\}" "\$\{HELD_REQ_BEFORE\}" "\$\{HELD_REQ_AFTER\}" "\$\{HELD_STATUS\}" "\$\{HELD_CODE\}" \\\n\s*\|\| fail "warm pod control: a call held/,
    );
    expect(w.indexOf('export_key "${WORK}/key-held" current')).toBeGreaterThan(-1);
    expect(w.indexOf('export_key "${WORK}/key-held" current')).toBeLessThan(
      w.indexOf('hold_call "${CONTROL_HELD_SECONDS}" warm'),
    );
  });

  it('the test: the same token held PAST the token life on stale pod B must be 401 "token rejected", by B', () => {
    const held = seg('hold_call "${HELD_SECONDS}" warm "${wuid_b}"', 'foreign_get');
    // Wiring only: the verdict itself is exercised in tests/z11-answering-pod.test.ts.
    expect(held).toMatch(
      /check_refused_by "\$\{wuid_b\}" "\$\{HELD_REQ_BEFORE\}" "\$\{HELD_REQ_AFTER\}" "\$\{HELD_STATUS\}" "\$\{HELD_CODE\}" "\$\{HELD_MESSAGE\}" \\\n\s*\|\| fail "warm pod: a call held/,
    );
    // The control runs BEFORE the long hold, both on pods in the loaded-but-never-called state.
    expect(w.indexOf('hold_call "${CONTROL_HELD_SECONDS}" warm')).toBeLessThan(
      w.indexOf('hold_call "${HELD_SECONDS}" warm'),
    );
    expect(seg('foreign_get', '')).toMatch(
      /\[ "\$\{FC_STATUS\}" = 401 \] && \[ "\$\{FC_CODE\}" = unauthenticated \] && \[ "\$\{FC_MESSAGE\}" = "token rejected" \] \\\n\s*\|\| fail "warm pod: after the holds a garbage token/,
    );
  });

  it('puts minScale and maxScale back and clears the restore flag when it finishes', () => {
    const end = seg('{"spec":{"scaling":{"minScale":0,"maxScale":1}}}', '');
    expect(end).toContain('RESTORE_MINSCALE=0');
  });

  it('the warm hold detaches EVERY pod, re-attaches only the target first, and the label goes back before the quota', () => {
    expect(c).not.toContain('HELD_POD_UID="$3"');
    expect(c).toContain(
      'HELD_POD_UID="$(answering_pod_uid "${HELD_REQ_BEFORE}" "${HELD_REQ_AFTER}")"',
    );
    expect(c).toContain('uids_before="$(fn_pod_uids)"');
    expect(c).toContain('RESTORE_DETACH="${RESTORE_DETACH}${pod}=${label} "');
    expect(c.indexOf('RESTORE_DETACH="${RESTORE_DETACH}${pod}=${label} "')).toBeLessThan(
      c.indexOf('"serving.knative.dev/revisionUID=detached"'),
    );
    expect(c.indexOf('"serving.knative.dev/revisionUID=detached"')).toBeLessThan(
      c.indexOf('bun "${Z7}/probe.ts"'),
    );
    // Target label first, then the answer, then the rest, then the quota (release_pods).
    const t = c.indexOf('"serving.knative.dev/revisionUID=${tlabel}"');
    expect(t).toBeGreaterThan(c.indexOf('kill -0'));
    expect(t).toBeLessThan(c.indexOf('wait "$(cat "${HELD_PIDFILE}")"'));
    expect(c.indexOf('wait "$(cat "${HELD_PIDFILE}")"')).toBeLessThan(c.indexOf('release_pods'));
    // The target's label goes back before ANY quota deletion in the warm path.
    expect(t).toBeLessThan(c.indexOf('delete resourcequota'));
    // Exactly the pods that were there: counted by uid, all of them, before and after.
    expect(c).toMatch(
      /\[ "\$\(fn_pod_uids\)" = "\$\{uids_before\}" \] \|\| fail "after the answer the pods are/,
    );
    expect(body('fn_pod_uids')).toContain('select(.metadata.deletionTimestamp == null)');
    expect(body('fn_pods_ready')).toContain('.metadata.deletionTimestamp == null');
    expect(body('fn_pods_ready')).toContain('"Ready"');
  });
});
