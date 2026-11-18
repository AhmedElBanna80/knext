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
    for (const p of ['up', 'deploy', 'token', 'direct', 'policyoff', 'noauth']) {
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
    expect(d).toMatch(/\[ "\$\{ZC_STATUS\}" = 404 \] \|\| fail/);
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
    expect(p.indexOf('await_zero "${GO_FN}"')).toBeGreaterThan(p.indexOf('set_policy false'));
    expect(p.indexOf('await_zero "${GO_FN}"')).toBeLessThan(p.indexOf('foreign_get ""'));
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
  it('the default phase list of the script includes policyoff', () => {
    expect(own).toMatch(/PHASES="\$\{PHASES:-up deploy token direct policyoff noauth\}"/);
  });
});
