/**
 * Cluster-free guards for the Z10 zone-functions kind lane (#2055):
 * packages/grpc/e2e/z10-zone-functions-kind/run.sh, run by the Z7 job on the
 * cluster it builds.
 *
 * The lane's claims only hold if its cold calls are really cold (no live pod
 * before the call, a pod after it) and its failed calls are compared on the code,
 * next to a warm control. Each rule below reds when one of those is weakened.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const RUN_SH = resolve(REPO_ROOT, 'packages/grpc/e2e/z10-zone-functions-kind/run.sh');
const LIB_SH = resolve(REPO_ROOT, 'packages/grpc/e2e/lib/kind-lane.sh');
const WORKFLOW = resolve(REPO_ROOT, '.github/workflows/z7-identity-kind-e2e.yml');

const own = readFileSync(RUN_SH, 'utf8');
const all = `${own}\n${readFileSync(LIB_SH, 'utf8')}`;

/** The body of a shell function in run.sh, from its opening line to its closing `}`. */
function body(name: string): string {
  const start = own.indexOf(`\n${name}() {`);
  expect(start, `${name}() is defined`).toBeGreaterThan(-1);
  const end = own.indexOf('\n}\n', start);
  return own.slice(start, end);
}

describe('the harness is as careful as the Z7 lane', () => {
  it('fails on any error, never traces, keeps files private, and sources the shared helpers', () => {
    expect(own).toMatch(/^set -euo pipefail$/m);
    expect(own).toMatch(/^set \+x$/m);
    expect(own).toMatch(/^umask 077$/m);
    expect(all).not.toMatch(/\bset -[a-z]*x/);
    expect(own).toMatch(/^source "\$\{HERE\}\/\.\.\/lib\/kind-lane\.sh"$/m);
  });

  it('never deletes a cluster, and deletes only a namespace it stamped', () => {
    expect(all).not.toMatch(/kind delete/);
    const guard = own.indexOf('e2e.kn-next.dev/z10-owned"] // ""');
    const del = own.indexOf('k delete namespace "${NS}"');
    expect(guard).toBeGreaterThan(-1);
    expect(del).toBeGreaterThan(guard);
    expect(own.slice(guard, del)).toMatch(/refusing to delete/);
    expect(own).toMatch(/label namespace "\$\{NS\}" e2e\.kn-next\.dev\/z10-owned=true/);
  });

  it('enforces Pod Security restricted on its namespace', () => {
    expect(own).toContain('pod-security.kubernetes.io/enforce=restricted');
  });

  it('runs every phase by default', () => {
    expect(own).toContain(
      'PHASES="${PHASES:-images deploy cold trailers rollout sovereignty}"',
    );
  });
});

describe('the cold path is really cold', () => {
  it('deploys the functions at minScale 0 and the zone at minScale 1', () => {
    const deploy = body('phase_deploy');
    expect(deploy.match(/minScale: 0/g)?.length).toBe(2);
    expect(deploy.match(/minScale: 1/g)?.length).toBe(1);
  });

  it('a cold call requires zero live pods before it and a pod after it', () => {
    const cold = body('cold_call');
    // Zero pods of ANY state before (a draining pod could serve the call), so a pod
    // after can only be one the call created.
    expect(cold).toMatch(/\[ "\$\(all_pods "\$\{fn\}"\)" = 0 \] \|\| fail/);
    expect(cold).toMatch(/\[ -n "\$\(pod_uids "\$\{fn\}"\)" \] \|\| fail/);
    expect(cold.indexOf('= 0 ]')).toBeLessThan(cold.indexOf('zone_call'));
    expect(cold.indexOf('pod_uids')).toBeGreaterThan(cold.indexOf('zone_call'));
  });

  it('every cold call waits for scale-to-zero first, for both functions', () => {
    for (const phase of ['phase_cold', 'phase_trailers']) {
      const b = body(phase);
      expect(b).toContain('await_zero "${GO_FN}"');
      expect(b).toContain('await_zero "${RUST_FN}"');
      expect(b.indexOf('await_zero "${GO_FN}"')).toBeLessThan(b.indexOf('cold_call "${GO_FN}"'));
      expect(b.indexOf('await_zero "${RUST_FN}"')).toBeLessThan(
        b.indexOf('cold_call "${RUST_FN}"'),
      );
    }
  });

  it('scale-to-zero means no pod at all, terminating ones included', () => {
    expect(body('await_zero')).toContain('all_pods');
    expect(own).toMatch(/all_pods\(\) \{[^\n]*\n\s*k -n "\$\{NS\}" get pods [^\n]*\| jq '\.items \| length'/);
  });

  it('turns wake-ahead off on both functions (the operator defaults it on)', () => {
    expect(body('phase_deploy').match(/^ {2}wakeAhead: false$/gm)?.length).toBe(2);
  });
});

describe('a failed call keeps its code through the activator', () => {
  it('the cold read of a missing item must come back NotFound / not_found, next to a warm control', () => {
    const t = body('phase_trailers');
    expect(t.match(/404 '\.ok == false and \.code == "NotFound"'/g)?.length).toBe(2);
    expect(t.match(/404 '\.ok == false and \.code == "not_found"'/g)?.length).toBe(2);
    expect(t).toMatch(/cold_call "\$\{GO_FN\}" "\/example\/get\?sub=alice&id=missing"/);
    expect(t).toMatch(
      /expect_zone "warm control: [^"]*" \\\n\s*"\/example\/get\?sub=alice&id=missing"/,
    );
  });
});

describe('a partial rollout is ordered function-first', () => {
  it('a newer function is called, an older one is refused before the call, both after the zone sees the version', () => {
    const r = body('phase_rollout');
    const newer = r.indexOf('set_served 1.1.0');
    const older = r.indexOf('set_served 0.9.0');
    expect(newer).toBeGreaterThan(-1);
    expect(older).toBeGreaterThan(newer);
    expect(r.slice(newer, older)).toMatch(/200 '\.ok == true'/);
    expect(r.slice(older)).toMatch(/502 '\.ok == false and \.code == "FailedPrecondition"'/);
    const set = body('set_served');
    expect(set).toContain('.status.servedProtoVersion');
    expect(set).toContain('zone_sees_version');
    expect(body('zone_sees_version')).toContain('EXAMPLE_SERVICE_PROTO_VERSION');
  });
});

describe("another zone's Secret is refused through every source", () => {
  const sv = body('phase_sovereignty');

  it('the zone lists every function, so a refusal is the allowlist and not a missing binding', () => {
    for (const fn of ['sov-env', 'sov-envfrom', 'sov-volume', 'sov-own']) {
      expect(sv).toContain(`service: ${fn}`);
    }
  });

  it('each violator is SecretNotAllowed after a hold, with no Knative Service and no pod', () => {
    expect(sv).toContain('for fn in sov-env sov-envfrom sov-volume; do');
    expect(sv).toMatch(/sleep 20/);
    expect(sv).toMatch(/= False\/SecretNotAllowed \] \|\| fail/);
    expect(sv).toMatch(/get ksvc "\$\{fn\}" >\/dev\/null 2>&1; then fail/);
    expect(sv).toMatch(/\[ "\$\(all_pods "\$\{fn\}"\)" = 0 \] \|\| fail/);
  });

  it('each source is used by a violator, and the control uses all three with its own Secret', () => {
    expect(sv).toMatch(/sov-env\) extra="  env:\n[\s\S]*?secretKeyRef:/);
    expect(sv).toMatch(/sov-envfrom\) extra="  envFrom:\n[\s\S]*?secretRef:/);
    expect(sv).toMatch(/sov-volume\) extra="  volumes:\n[\s\S]*?secretName:/);
    expect(sv).toContain('[ "${fn}" = sov-own ] && secret="${SOV_ZONE}-creds"');
    expect(sv).toMatch(/\[ "\$\(sov_condition sov-own\)" = True\/Compliant \] \|\| fail/);
    expect(sv).toMatch(/get ksvc sov-own >\/dev\/null 2>&1 \|\| fail/);
  });
});

describe('CI runs the lane on the Z7 cluster', () => {
  const wf = parse(readFileSync(WORKFLOW, 'utf8')) as {
    jobs: Record<string, { steps: { run?: string; if?: string }[] }>;
  };
  const steps = Object.values(wf.jobs).flatMap((j) => j.steps);
  const z7 = steps.findIndex((s) => s.run === 'packages/grpc/e2e/z7-identity-kind/run.sh');
  const z10 = steps.findIndex((s) => s.run === 'packages/grpc/e2e/z10-zone-functions-kind/run.sh');

  it('after the Z7 run, before teardown, and not as a best-effort step', () => {
    expect(z7).toBeGreaterThan(-1);
    expect(z10).toBeGreaterThan(z7);
    const teardown = steps.findIndex((s) => (s.run ?? '').includes('kind delete cluster'));
    expect(z10).toBeLessThan(teardown);
    expect(JSON.stringify(steps[z10])).not.toContain('continue-on-error');
    expect(steps[z10]?.if).toBeUndefined();
  });

  it('the step sees the cluster and registry the Z7 run built', () => {
    const env = Object.values(wf.jobs)[0] as unknown as { env?: Record<string, string> };
    expect(env.env?.KIND_CLUSTER).toBeTruthy();
    expect(env.env?.REGISTRY_PORT).toBeTruthy();
    expect(readFileSync(WORKFLOW, 'utf8')).toContain("- 'tests/z10-zone-functions-kind-lane.test.ts'");
  });
});
