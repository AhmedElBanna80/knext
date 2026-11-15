/**
 * Cluster-free guards for the single-exec rollback kind lane (#2445):
 * scripts/single-exec-rollback-kind.sh, run by
 * .github/workflows/single-exec-rollback-kind-e2e.yml.
 *
 * The lane proves the way back from a single executable. Its claims only hold
 * if it deploys all three shapes, checks each revision's own command, takes its
 * "which build served" signal from a route that is rendered per request, and
 * compares one shared cache entry across the shapes. Each rule below reds when
 * one of those is weakened.
 */
// biome-ignore-all lint/suspicious/noTemplateCurlyInString: the strings are shell parameter expansions matched as literal text
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const SCRIPT_REL = 'scripts/single-exec-rollback-kind.sh';
const WORKFLOW_REL = '.github/workflows/single-exec-rollback-kind-e2e.yml';
const script = readFileSync(resolve(REPO_ROOT, SCRIPT_REL), 'utf8');
const workflowText = readFileSync(resolve(REPO_ROOT, WORKFLOW_REL), 'utf8');
const workflow = parse(workflowText) as {
  on: { pull_request: { paths: string[] } };
  jobs: Record<string, { steps: { name?: string; run?: string }[] }>;
};

/** The body of a shell function, from its opening line to its closing `}`. */
function body(name: string): string {
  const start = script.indexOf(`\n${name}() {`);
  expect(start, `${name}() is defined`).toBeGreaterThan(-1);
  const end = script.indexOf('\n}\n', start);
  expect(end, `${name}() is closed`).toBeGreaterThan(start);
  return script.slice(start, end);
}

describe('the workflow runs the lane', () => {
  const steps = Object.values(workflow.jobs).flatMap((j) => j.steps);

  it('runs the script, and only after Redis and the operator are up', () => {
    const names = steps.map((s) => s.name ?? '');
    const run = steps.findIndex((s) => (s.run ?? '').trim() === `bash ${SCRIPT_REL}`);
    expect(run, 'a step runs the script').toBeGreaterThan(-1);
    expect(names.indexOf('Redis for the shared cache')).toBeGreaterThan(-1);
    expect(names.indexOf('Redis for the shared cache')).toBeLessThan(run);
    expect(names.indexOf('Build + deploy the operator from this commit')).toBeLessThan(run);
  });

  it('is triggered by a change to the script, the workflow, the command decision or the CLI rollback', () => {
    const paths = workflow.on.pull_request.paths;
    for (const p of [
      SCRIPT_REL,
      WORKFLOW_REL,
      'packages/kn-next-operator/internal/controller/nextapp_ksvc.go',
      'packages/kn-next/src/cli/rollback.ts',
    ]) {
      expect(paths, p).toContain(p);
    }
  });
});

describe('the script', () => {
  it('fails on any error', () => {
    expect(script).toMatch(/^set -euo pipefail$/m);
  });

  it('deploys exactly the three shapes, in order', () => {
    expect(script).toMatch(/^SHAPES=\(sc disk node\)$/m);
    const write = body('write_config');
    expect(write).toMatch(/sc\) sc=true ;;/);
    expect(write).toMatch(/node\) runtime=node ;;/);
    expect(write).toContain('selfContained: ${sc},');
    expect(write).toContain('runtime: "${runtime}",');
  });

  it("wants each shape's own command, and checks every revision against it", () => {
    const want = body('want_command');
    expect(want).toMatch(/sc \| node\) echo "" ;;/);
    expect(want).toContain(`disk) echo '["bun","run","server.js"]' ;;`);
    const check = body('assert_command');
    expect(check).toContain('{.spec.containers[0].command}');
    expect(check).toContain('[ "$got" = "$want" ] || fail');
    // Once after each deploy, and again for every revision at the end.
    expect(script).toContain('assert_command "$rev" "$shape"');
    expect(script).toContain(
      'for shape in "${SHAPES[@]}"; do assert_command "${REV[$shape]}" "$shape"; done',
    );
  });

  it('takes the serving build and the cache stamp from per-request routes, never from ISR HTML', () => {
    const probe = body('probe');
    expect(probe).toContain('for path in /api/health /build-mark /rb-stamp /tagged; do');
    expect(probe).toContain('[ "$code" = 200 ] || fail');
    expect(probe).toMatch(/mark="\$\(sed -n [^\n]*"\$\{body\}-build-mark"/);
    expect(probe).toMatch(/stamp="\$\(sed -n [^\n]*"\$\{body\}-rb-stamp"/);
    // /tagged's mark is read as the STORING build's (tmark), never as the serving one.
    expect(probe).not.toMatch(/(^|\s)(mark|stamp)="\$\(sed -n [^\n]*"\$\{body\}-tagged"/);
    expect(probe).toMatch(/tmark="\$\(sed -n [^\n]*"\$\{body\}-tagged"/);
    expect(probe).toContain('[ -n "$mark" ] || fail');
    expect(probe).toContain('[ -n "$stamp" ] || fail');
    expect(probe).toContain('[ -n "$tmark" ] || fail');
  });

  it('the stamp route reads unstable_cache on every request', () => {
    const page = readFileSync(
      resolve(
        REPO_ROOT,
        'packages/kn-next/src/__tests__/fixtures/cdn-kind-app/app/rb-stamp/page.tsx',
      ),
      'utf8',
    );
    expect(page).toContain('await connection();');
    expect(page).toContain('unstable_cache(');
    expect(page).toContain('<p id="stamp">{await stamp()}</p>');
    expect(page).not.toMatch(/export const (revalidate|dynamic)/);
  });

  it('requires each switch to serve the ISR page an earlier shape stored in the shared Redis', () => {
    expect(script).toContain('if [ "$SEEN_MARKS" != " " ]; then');
    expect(script).toContain('*" ${tmark} "*) ;;');
    expect(script).toContain('the page cache was lost across the switch" ;;');
    expect(script).toContain('SEEN_MARKS="${SEEN_MARKS}${mark} "');
  });

  it('reports the data-cache entry per shape and does not claim it is shared', () => {
    expect(script).toContain('say "data cache: NOT shared across shapes:');
    expect(script).not.toContain('[ "$stamp" = "$STAMP" ] || fail');
    expect(workflowText).not.toMatch(
      /unstable_cache entry [^\n]*is the same one under every shape/,
    );
  });

  it('requires three distinct builds, and a canary that reaches both sides', () => {
    expect(script).toContain('|| fail "the three shapes did not serve three builds');
    expect(script).toContain('[ "$seen_sc" = 1 ] && [ "$seen_node" = 1 ] \\\n  || fail "canary:');
  });

  it('compares the programmed traffic split, and fails when it never matches', () => {
    const t = body('await_traffic');
    expect(t).toContain('.status.traffic[]?');
    expect(t).toContain('fail "ksvc traffic is');
  });

  it('pins back to the single executable, then disk-mode Bun, a canary, and latest', () => {
    const order = [
      'rollback --to "${REV[sc]}"\n',
      'rollback --to "${REV[disk]}"\n',
      'rollback --to "${REV[sc]}" --canary 50\n',
      'rollback\nawait_traffic latest 100\n',
    ].map((s) => script.indexOf(s));
    for (const i of order) expect(i).toBeGreaterThan(-1);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(body('pinned')).toContain('[ "$mark" = "${MARK[$1]}" ] || fail');
  });

  it('never lets a probe failure pass: every probe result is an assignment', () => {
    expect(script).not.toContain('<<<"$(probe');
    const calls = script
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('#') && /out="\$\(probe /.test(l));
    expect(calls.length).toBe(3);
  });

  it('fails when its own port-forward is not the listener', () => {
    expect(body('start_pf')).toContain('kill -0 "$PF_PID" 2>/dev/null || fail');
  });

  it('does not accept a revision that existed before its deploy', () => {
    expect(script).toContain('prev="$(latest_created)"');
    expect(body('await_new_revision')).toContain('[ "$created" != "$prev" ]');
  });
});
