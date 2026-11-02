import { describe, expect, it } from 'bun:test';
import {
  auditImageLanes,
  auditOperatorTags,
  auditTemplateImages,
  type Ctx,
  discoverImageLanes,
  evalExpr,
  type Finding,
  jobsOf,
  loadWorkflows,
  type NonImageLane,
  operatorTagWorkflows,
  templateDirs,
  UNKNOWN,
  type Workflow,
} from './helpers/image-supply-chain';

/**
 * SUPPLY-CHAIN GUARD, image half (#2044, v2 task R8).
 *
 * `security.md`: SBOM per image, Trivy fail on HIGH/CRITICAL, cosign signing.
 * The npm half (every publish lane `needs` the audit + SBOM job; `@getknext/grpc`
 * enters the audit/SBOM scope the moment it loses `private`) is
 * `tests/publish-lane-supply-chain.test.ts`. This file covers images:
 *   - every workflow job that PUBLISHES an image, discovered by what it does
 *     (build-push-action with push, `docker push`, `crane push`, `--push`, ...)
 *     under ANY trigger, local composite actions expanded, reusable workflows
 *     resolved: an enforcing HIGH+CRITICAL Trivy gate, an SBOM, and cosign;
 *   - function template images (`templates/*`): SBOM and cosign.
 * Gate steps that cannot fail or run (continue-on-error, a disabling `if`) do
 * not count. An unreadable or unresolvable construct is a finding or a throw.
 *
 * KNOWN_GAPS is the one explicit, named exception list. The engine reds on a
 * gap that is not listed AND on a listed gap that no longer exists (stale).
 * NON_IMAGE_LANES likewise lists push-shaped jobs that publish no release image.
 *
 * Mutation-proved by `scripts/mutation-prove-2044-image-supply-chain.mjs`.
 */

interface KnownGap {
  subject: string;
  check: string;
  reason: string;
}

const KNOWN_GAPS: readonly KnownGap[] = [
  {
    subject: 'template:go',
    check: 'cosign',
    reason:
      'TODO(#2044), tracked in #2425: go-template.yml builds, SBOMs and Trivy-scans the image but never publishes or signs it; its header defers GHCR push + cosign to a separate push-only workflow (Z4 follow-up)',
  },
  {
    subject: 'template:rust',
    check: 'cosign',
    reason:
      'TODO(#2044), tracked in #2425: rust-template.yml has the same deferral (Z5 follow-up): SBOM and Trivy, no push, no cosign',
  },
];

const NON_IMAGE_LANES: readonly NonImageLane[] = [
  {
    file: 'operator-e2e-nightly.yml',
    job: 'scale-to-zero-cache',
    reason:
      'crane copy of an already-signed digest into the throwaway in-cluster kind registry for a test; publishes nothing to GHCR',
  },
];

const key = (f: { subject: string; check: string }) => `${f.subject}|${f.check}`;

/** Findings not excused by KNOWN_GAPS, plus listed gaps that no longer exist. */
function judge(findings: Finding[], gaps: readonly KnownGap[]): string[] {
  const listed = new Set(gaps.map(key));
  const present = new Set(findings.map(key));
  return [
    ...findings
      .filter((f) => !listed.has(key(f)))
      .map((f) => `${f.subject}: ${f.check}: ${f.detail}`),
    ...gaps.filter((g) => !present.has(key(g))).map((g) => `STALE known gap ${key(g)}`),
  ];
}

const wfs = loadWorkflows();
const templates = templateDirs();
const clone = <T>(x: T): T => structuredClone(x);
const real = { nonLanes: NON_IMAGE_LANES };

function wfNamed(file: string, list: Workflow[] = wfs): Workflow {
  const w = list.find((x) => x.file === file);
  if (!w) throw new Error(`${file} not found`);
  return w;
}
// biome-ignore lint/suspicious/noExplicitAny: fixture editing of parsed YAML
const withWf = (file: string, edit: (doc: any) => void): Workflow[] => {
  const copy = clone(wfs);
  edit(wfNamed(file, copy).doc);
  return copy;
};
const checks = (f: Finding[]) => f.map((x) => x.check);

// ───────────────────────── real tree ─────────────────────────

describe('image publish lanes: the real workflows', () => {
  const { lanes, findings } = discoverImageLanes(wfs);
  const names = lanes.map((l) => `${l.wf.file}#${l.id}`);

  it('discovers lanes by behaviour: the operator AND the app image (supply-chain.yml)', () => {
    expect(names).toEqual(
      expect.arrayContaining([
        'operator-supply-chain.yml#operator-image-publish',
        'supply-chain.yml#image-publish',
      ]),
    );
    expect(findings).toEqual([]);
  });

  it('every publish lane has enforcing Trivy, SBOM and cosign, tied to the image', () => {
    expect(auditImageLanes(wfs, real)).toEqual([]);
  });

  it('is not vacuous: the ref-gated continue-on-error expressions in the real lanes are exercised and accepted', () => {
    const trivyCoe = (file: string) =>
      Object.values(jobsOf(wfNamed(file)))
        .flatMap((j) => (j.steps as Array<Record<string, unknown>>) ?? [])
        .filter((s) => /trivy-action/.test(String(s.uses ?? '')))
        .map((s) => s['continue-on-error'])
        .filter((v) => typeof v === 'string');
    expect(trivyCoe('supply-chain.yml').length).toBeGreaterThan(0);
    expect(trivyCoe('operator-supply-chain.yml').length).toBeGreaterThan(0);
  });

  it('the allowlisted non-lane is really a push-shaped job (the list cannot go stale)', () => {
    expect(names).toContain('operator-e2e-nightly.yml#scale-to-zero-cache');
    expect(auditImageLanes(wfs, { nonLanes: [{ ...NON_IMAGE_LANES[0], job: 'gone' }] })).toEqual(
      expect.arrayContaining([expect.objectContaining({ check: 'stale-non-lane' })]),
    );
  });

  it('without the allowlist the real tree is NOT clean (it is load-bearing)', () => {
    expect(auditImageLanes(wfs).length).toBeGreaterThan(0);
  });
});

describe('operator tags: trigger shape', () => {
  const OP = 'operator-supply-chain.yml';
  it('discovers the operator tag workflow by its trigger', () => {
    expect(operatorTagWorkflows(wfs).map((w) => w.file)).toContain(OP);
  });
  it('the real tag trigger fires from any branch and the lane publishes on the tag', () => {
    expect(auditOperatorTags(wfs)).toEqual([]);
  });
  it('a path filter on the push trigger reds', () => {
    const m = withWf(OP, (d) => {
      d.on.push.paths = ['packages/kn-next-operator/**'];
    });
    expect(checks(auditOperatorTags(m))).toContain('any-branch');
  });
  it('a push job confined to main (tag from another branch unpublished) reds', () => {
    const m = withWf(OP, (d) => {
      d.jobs['operator-image-publish'].if = "github.ref == 'refs/heads/main'";
    });
    expect(checks(auditOperatorTags(m))).toContain('any-branch');
  });
  it('an operator-v* workflow with no push step reds', () => {
    const m = withWf(OP, (d) => {
      for (const j of Object.values<{ steps?: unknown[] }>(d.jobs))
        j.steps = (j.steps ?? []).filter(
          (s) => !/crane push/.test(String((s as { run?: string }).run)),
        );
    });
    expect(checks(auditOperatorTags(m))).toContain('no-publish');
  });
  it('no operator tag lane at all reds (a vacuous scan fails)', () => {
    expect(checks(auditOperatorTags(wfs.filter((w) => w.file !== OP)))).toContain('discovered');
  });
  it('an unreadable workflow directory fails closed (throws)', () => {
    expect(() => loadWorkflows(`${import.meta.dirname}/helpers`)).toThrow();
  });
});

describe('operator and app lanes: removing a gate from the REAL workflows reds', () => {
  // biome-ignore lint/suspicious/noExplicitAny: fixture editing of parsed YAML
  const dropSteps = (file: string, match: (s: any) => boolean) =>
    withWf(file, (d) => {
      for (const j of Object.values<{ steps?: unknown[] }>(d.jobs))
        j.steps = (j.steps ?? []).filter((s) => !match(s));
    });
  for (const file of ['operator-supply-chain.yml', 'supply-chain.yml']) {
    it(`${file}: no Trivy step`, () => {
      const m = dropSteps(file, (s) => /trivy-action/.test(s.uses ?? ''));
      expect(checks(auditImageLanes(m, real))).toContain('trivy');
    });
    it(`${file}: no SBOM step`, () => {
      const m = dropSteps(
        file,
        (s) => /sbom-action/.test(s.uses ?? '') && !/download-syft/.test(s.uses),
      );
      expect(checks(auditImageLanes(m, real))).toContain('sbom');
    });
    it(`${file}: no cosign step`, () => {
      const m = dropSteps(file, (s) => /\bcosign\s+(sign|attest)\b/.test(s.run ?? ''));
      expect(checks(auditImageLanes(m, real))).toContain('cosign');
    });
  }
  it('operator: the push job stops waiting for the scan job', () => {
    const m = withWf('operator-supply-chain.yml', (d) => {
      d.jobs['operator-image-publish'].needs = [];
    });
    expect(checks(auditImageLanes(m, real))).toContain('trivy');
  });
});

// ───────────────────────── fixtures: lane engine ─────────────────────────

type Any = Record<string, unknown>;
const noVars = () => ({});
const trivyStep = (extra: Any = {}, withExtra: Any = {}): Any => ({
  uses: 'aquasecurity/trivy-action@abc',
  with: { input: 'oci', severity: 'HIGH,CRITICAL', 'exit-code': '1', ...withExtra },
  ...extra,
});
const sbomStep = (extra: Any = {}): Any => ({ uses: 'anchore/sbom-action@abc', ...extra });
const pushStep = (extra: Any = {}): Any => ({ run: 'crane push oci ghcr.io/x/y:1', ...extra });
const signStep = (extra: Any = {}): Any => ({ run: 'cosign sign --yes "$IMG@$DIGEST"', ...extra });

interface LaneOpts {
  on?: Any;
  scan?: Any[];
  push?: Any[];
  pushJob?: Any;
  scanJob?: Any;
  extraJobs?: Record<string, Any>;
}
const lane = (o: LaneOpts = {}): Workflow => ({
  file: 'fx.yml',
  doc: {
    on: o.on ?? { workflow_dispatch: {} },
    jobs: {
      scan: { steps: o.scan ?? [trivyStep(), sbomStep()], ...(o.scanJob ?? {}) },
      publish: {
        needs: 'scan',
        steps: o.push ?? [pushStep(), signStep()],
        ...(o.pushJob ?? {}),
      },
      ...(o.extraJobs ?? {}),
    },
  },
});
const fx = (w: Workflow[] | Workflow, extra: Any = {}) =>
  auditImageLanes(Array.isArray(w) ? w : [w], {
    varsFor: noVars,
    resolveAction: () => null,
    ...extra,
  });

describe('lane engine: both halves', () => {
  it('a compliant lane passes', () => {
    expect(fx(lane())).toEqual([]);
  });

  describe('discovery is by behaviour, under any trigger', () => {
    const noGates = (step: Any, on?: Any) =>
      lane({ on, scan: [], push: [step], pushJob: { needs: [] } });
    const forms: Array<[string, Any]> = [
      ['crane push', { run: 'crane push oci ghcr.io/x:1' }],
      ['docker push', { run: 'docker push ghcr.io/x:1' }],
      ['docker buildx build --push', { run: 'docker buildx build --push -t ghcr.io/x:1 .' }],
      [
        'a line-continued push',
        { run: 'docker \\\n push ghcr.io/x:1'.replace('docker \\\n push', 'crane \\\n push') },
      ],
      [
        'build-push-action push: true',
        { uses: 'docker/build-push-action@abc', with: { push: true } },
      ],
      [
        'build-push-action push expression',
        {
          uses: 'docker/build-push-action@abc',
          with: { push: "${{ github.ref == 'refs/heads/main' }}" },
        },
      ],
      [
        'build-push-action type=registry',
        { uses: 'docker/build-push-action@abc', with: { outputs: 'type=registry' } },
      ],
      ['a push-to-registry action', { uses: 'redhat-actions/push-to-registry@abc' }],
    ];
    for (const [label, step] of forms) {
      for (const [trigName, on] of [
        ['workflow_dispatch', { workflow_dispatch: {} }],
        ['workflow_call', { workflow_call: {} }],
        ['schedule', { schedule: [{ cron: '0 0 * * *' }] }],
      ] as const) {
        it(`${label} under ${trigName} with no gates reds on trivy, sbom and cosign`, () => {
          expect(checks(fx(noGates(step, on)))).toEqual(
            expect.arrayContaining(['trivy', 'sbom', 'cosign']),
          );
        });
      }
    }
    it('build-push-action with push: false is not a lane', () => {
      const w = noGates({ uses: 'docker/build-push-action@abc', with: { push: false } });
      expect(fx(w)).toEqual([]);
    });
    it('comment prose that says `crane push` is not a lane', () => {
      expect(fx(noGates({ run: '# crane push later\necho ok' }))).toEqual([]);
    });
    it('the allowlist excuses only a named job, and a stale entry reds', () => {
      const w = noGates(pushStep());
      expect(fx(w, { nonLanes: [{ file: 'fx.yml', job: 'publish', reason: 'r' }] })).toEqual([]);
      expect(checks(fx(w, { nonLanes: [{ file: 'fx.yml', job: 'nope', reason: 'r' }] }))).toContain(
        'stale-non-lane',
      );
    });
  });

  describe('reusable workflows and local actions are resolved, never skipped', () => {
    it('a local reusable workflow that resolves is accepted as a call; its callee is scanned as a lane', () => {
      const callee = { ...lane({ on: { workflow_call: {} }, scan: [] }), file: 'callee.yml' };
      const caller: Workflow = {
        file: 'caller.yml',
        doc: { on: {}, jobs: { go: { uses: './.github/workflows/callee.yml' } } },
      };
      expect(checks(fx([caller, callee]))).toEqual(expect.arrayContaining(['trivy', 'sbom']));
      expect(discoverImageLanes([caller, callee]).findings).toEqual([]);
    });
    it('a local reusable workflow that does not exist reds', () => {
      const caller: Workflow = {
        file: 'caller.yml',
        doc: { on: {}, jobs: { go: { uses: './.github/workflows/missing.yml' } } },
      };
      expect(checks(fx(caller))).toContain('unresolved');
    });
    it('a remote reusable workflow reds (cannot be scanned)', () => {
      const caller: Workflow = {
        file: 'caller.yml',
        doc: { on: {}, jobs: { go: { uses: 'org/repo/.github/workflows/p.yml@v1' } } },
      };
      expect(checks(fx(caller))).toContain('unresolved');
    });
    it('a local composite action that pushes makes its caller a lane', () => {
      const w: Workflow = {
        file: 'c.yml',
        doc: { on: {}, jobs: { j: { steps: [{ uses: './.github/actions/p' }] } } },
      };
      const out = fx(w, { resolveAction: () => [{ run: 'crane push oci ghcr.io/x:1' }] });
      expect(checks(out)).toEqual(expect.arrayContaining(['trivy', 'sbom', 'cosign']));
    });
    it('a local action that cannot be resolved reds', () => {
      const w: Workflow = {
        file: 'c.yml',
        doc: { on: {}, jobs: { j: { steps: [{ uses: './.github/actions/p' }] } } },
      };
      expect(checks(fx(w))).toContain('unresolved');
    });
  });

  describe('a gate that cannot fail or cannot run does not count', () => {
    const kinds: Array<[string, (e: Any) => LaneOpts]> = [
      ['trivy', (e) => ({ scan: [trivyStep(e), sbomStep()] })],
      ['sbom', (e) => ({ scan: [trivyStep(), sbomStep(e)] })],
      ['cosign', (e) => ({ push: [pushStep(), signStep(e)] })],
    ];
    for (const [kind, build] of kinds) {
      it(`${kind}: continue-on-error: true reds`, () => {
        expect(checks(fx(lane(build({ 'continue-on-error': true }))))).toContain(kind);
      });
      it(`${kind}: continue-on-error as an expression true on main reds`, () => {
        const e = { 'continue-on-error': "${{ github.ref == 'refs/heads/main' }}" };
        expect(checks(fx(lane(build(e))))).toContain(kind);
      });
      it(`${kind}: a continue-on-error expression that is false on every publishing ref passes`, () => {
        const e = { 'continue-on-error': "${{ github.ref != 'refs/heads/main' }}" };
        expect(fx(lane(build(e)))).toEqual([]);
      });
      it(`${kind}: a continue-on-error expression the evaluator cannot read reds (fail closed)`, () => {
        expect(
          checks(fx(lane(build({ 'continue-on-error': '${{ fromJSON(env.X) }}' })))),
        ).toContain(kind);
      });
      it(`${kind}: a step if that disables it on main reds`, () => {
        expect(checks(fx(lane(build({ if: "github.ref == 'refs/heads/dev'" }))))).toContain(kind);
      });
      it(`${kind}: a step if that depends on something unprovable reds`, () => {
        expect(checks(fx(lane(build({ if: "steps.x.outputs.y == 'z'" }))))).toContain(kind);
      });
      it(`${kind}: a step if provably true on the publishing ref passes`, () => {
        expect(fx(lane(build({ if: "github.ref == 'refs/heads/main'" })))).toEqual([]);
        expect(fx(lane(build({ if: 'always()' })))).toEqual([]);
      });
    }
    it('job-level continue-on-error on the scan job reds', () => {
      expect(checks(fx(lane({ scanJob: { 'continue-on-error': true } })))).toContain('trivy');
    });
    it('a job-level if that disables the scan job on main reds', () => {
      expect(checks(fx(lane({ scanJob: { if: "github.ref == 'refs/heads/dev'" } })))).toContain(
        'trivy',
      );
    });
    it('a job-level if that depends on another job output is not treated as disabling', () => {
      expect(fx(lane({ scanJob: { if: "needs.changes.outputs.relevant == 'true'" } }))).toEqual([]);
    });
  });

  describe('Trivy must cover HIGH and CRITICAL and fail the build', () => {
    for (const sev of ['LOW', 'LOW,MEDIUM', 'CRITICAL', 'HIGH', 'MEDIUM,HIGH']) {
      it(`severity ${sev} reds`, () => {
        const w = lane({ scan: [trivyStep({}, { severity: sev }), sbomStep()] });
        expect(checks(fx(w))).toContain('trivy');
      });
    }
    it('severity HIGH,CRITICAL, lowercase, and an absent severity (Trivy default = all) pass', () => {
      expect(
        fx(lane({ scan: [trivyStep({}, { severity: 'high, critical' }), sbomStep()] })),
      ).toEqual([]);
      const noSev = trivyStep();
      delete (noSev.with as Any).severity;
      expect(fx(lane({ scan: [noSev, sbomStep()] }))).toEqual([]);
    });
    it('exit-code 0 reds', () => {
      expect(
        checks(fx(lane({ scan: [trivyStep({}, { 'exit-code': '0' }), sbomStep()] }))),
      ).toContain('trivy');
    });
    it('a CLI trivy call with --severity LOW reds; with --exit-code 1 HIGH,CRITICAL passes', () => {
      const cli = (a: string): LaneOpts => ({
        scan: [{ run: `trivy image --exit-code 1 --severity ${a} oci` }, sbomStep()],
      });
      expect(checks(fx(lane(cli('LOW'))))).toContain('trivy');
      expect(fx(lane(cli('HIGH,CRITICAL')))).toEqual([]);
    });
  });

  describe('ordering and tie to the published image (as far as YAML allows)', () => {
    it('a push job that does not wait for the Trivy job reds', () => {
      expect(checks(fx(lane({ pushJob: { needs: [] } })))).toContain('trivy');
    });
    it('cosign before the push in the same job reds', () => {
      expect(checks(fx(lane({ push: [signStep(), pushStep()] })))).toContain('cosign-order');
    });
    it('pushing a layout Trivy did not scan reds', () => {
      expect(
        checks(fx(lane({ push: [pushStep({ run: 'crane push other ghcr.io/x:1' }), signStep()] }))),
      ).toContain('tie-trivy');
    });
    it('pushing a layout derived from the scanned one by a named script passes', () => {
      const w = lane({
        scan: [{ run: 'bash build-index.sh oci oci-mp' }, trivyStep(), sbomStep()],
        push: [pushStep({ run: 'crane push oci-mp ghcr.io/x:1-mp' }), signStep()],
      });
      expect(fx(w)).toEqual([]);
    });
    it('cosign addressed by tag instead of digest reds', () => {
      const w = lane({
        push: [pushStep(), signStep({ run: 'cosign sign --yes ghcr.io/x/y:latest' })],
      });
      expect(checks(fx(w))).toContain('tie-cosign');
    });
  });
});

describe('evalExpr (the small three-valued evaluator)', () => {
  const ctx = (ref: string, event = 'push', vars: Record<string, string> = {}): Ctx => ({
    ref,
    event,
    vars,
  });
  const main = ctx('refs/heads/main');
  it('decides ref gates on literal refs', () => {
    expect(evalExpr("${{ github.ref != 'refs/heads/main' }}", main)).toBe(false);
    expect(evalExpr("github.ref == 'refs/heads/main'", main)).toBe(true);
    expect(evalExpr("startsWith(github.ref, 'refs/tags/')", ctx('refs/tags/v1'))).toBe(true);
    expect(evalExpr("!startsWith(github.ref, 'refs/heads/integration/')", main)).toBe(true);
  });
  it('handles && || ! parentheses and always()', () => {
    expect(
      evalExpr(
        "(github.event_name == 'push' || github.event_name == 'workflow_dispatch') && github.ref == 'refs/heads/main'",
        main,
      ),
    ).toBe(true);
    expect(evalExpr('always()', main)).toBe(true);
    expect(evalExpr('failure()', main)).toBe(false);
  });
  it('is three-valued: an unknown operand propagates unless short-circuited', () => {
    expect(evalExpr("steps.x.outputs.y == 'z'", main)).toBe(UNKNOWN);
    expect(evalExpr("steps.x.outputs.y == 'z' && github.ref == 'refs/heads/dev'", main)).toBe(
      false,
    );
    expect(evalExpr("steps.x.outputs.y == 'z' || github.ref == 'refs/heads/main'", main)).toBe(
      true,
    );
  });
  it('resolves provided variables', () => {
    expect(
      evalExpr(
        "steps.channel.outputs.publish != 'true'",
        ctx('refs/heads/main', 'push', { 'steps.channel.outputs.publish': 'true' }),
      ),
    ).toBe(false);
  });
  it('anything it cannot parse or does not know is UNKNOWN (fail closed)', () => {
    expect(evalExpr('fromJSON(env.X)', main)).toBe(UNKNOWN);
    expect(evalExpr('github.ref ==', main)).toBe(UNKNOWN);
    expect(evalExpr("github.ref @ 'x'", main)).toBe(UNKNOWN);
    expect(evalExpr(42, main)).toBe(UNKNOWN);
  });
});

// ───────────────────────── function template images ─────────────────────────

describe('function template images: the real tree', () => {
  it('derives the template images from templates/*/Dockerfile', () => {
    expect(templates).toEqual(expect.arrayContaining(['go', 'rust']));
  });

  it('every template image has an SBOM and cosign, except the NAMED known gaps (#2425)', () => {
    expect(judge(auditTemplateImages(wfs, templates), KNOWN_GAPS)).toEqual([]);
  });

  it('every template image has an SBOM (no exception)', () => {
    expect(auditTemplateImages(wfs, templates).filter((f) => f.check === 'sbom')).toEqual([]);
  });

  it('every known gap cites #2425', () => {
    expect(KNOWN_GAPS.every((g) => g.reason.includes('#2425'))).toBe(true);
  });

  it('the known gaps are load-bearing: without them the real tree is NOT clean', () => {
    expect(judge(auditTemplateImages(wfs, templates), []).length).toBe(KNOWN_GAPS.length);
  });
});

describe('function template images: both halves on fixtures', () => {
  const image = (steps: unknown[], extra: Record<string, unknown> = {}) =>
    ({ file: 'fx.yml', doc: { on: {}, jobs: { image: { steps }, ...extra } } }) as Workflow;
  const build = { run: 'docker build -t x templates/go' };
  const sbom = { uses: 'anchore/sbom-action@abc' };
  const sign = { run: 'cosign sign --yes "$IMG@$DIGEST"' };
  const tpl = (w: Workflow, t = ['go']) => auditTemplateImages([w], t, { varsFor: noVars });

  it('a compliant template (build + SBOM + cosign) passes', () => {
    expect(tpl(image([build, sbom, sign]))).toEqual([]);
  });
  it('a downstream publish job that signs counts', () => {
    expect(tpl(image([build, sbom], { sign: { needs: 'image', steps: [sign] } }))).toEqual([]);
  });
  it('missing SBOM reds', () => {
    expect(checks(tpl(image([build, sign])))).toEqual(['sbom']);
  });
  it('missing cosign reds', () => {
    expect(checks(tpl(image([build, sbom])))).toEqual(['cosign']);
  });
  it('an SBOM or cosign step that is continue-on-error reds', () => {
    expect(checks(tpl(image([build, { ...sbom, 'continue-on-error': true }, sign])))).toEqual([
      'sbom',
    ]);
    expect(checks(tpl(image([build, sbom, { ...sign, 'continue-on-error': true }])))).toEqual([
      'cosign',
    ]);
  });
  it('an SBOM or cosign step with a disabling if reds', () => {
    expect(
      checks(tpl(image([build, { ...sbom, if: "github.ref == 'refs/heads/dev'" }, sign]))),
    ).toEqual(['sbom']);
    expect(checks(tpl(image([build, sbom, { ...sign, if: 'false' }])))).toEqual(['cosign']);
  });
  it('installing cosign without signing is not signing', () => {
    expect(checks(tpl(image([build, sbom, { uses: 'sigstore/cosign-installer@abc' }])))).toEqual([
      'cosign',
    ]);
  });
  it('a signing job that does not need the image job is not counted', () => {
    expect(checks(tpl(image([build, sbom], { sign: { steps: [sign] } })))).toEqual(['cosign']);
  });
  it('a template with a Dockerfile that no job builds reds', () => {
    expect(tpl(image([build, sbom, sign]), ['go', 'zig']).map((f) => f.subject)).toEqual([
      'template:zig',
    ]);
  });
  it('a build-push-action context under templates/ is discovered too', () => {
    const w = image([{ uses: 'docker/build-push-action@abc', with: { context: 'templates/go' } }]);
    expect(checks(tpl(w)).sort()).toEqual(['cosign', 'sbom']);
  });
  it('comment prose that mentions cosign sign is not a signing step', () => {
    expect(checks(tpl(image([build, sbom, { run: '# cosign sign later\necho ok' }])))).toEqual([
      'cosign',
    ]);
  });
});

describe('judge: the known-gap list cannot go stale or hide a new gap', () => {
  const gap = { subject: 's', check: 'cosign', reason: 'r' };
  it('an unlisted finding reds', () => {
    expect(judge([{ subject: 's', check: 'sbom', detail: 'd' }], [gap]).length).toBe(2);
  });
  it('a listed gap that is gone reds as stale', () => {
    expect(judge([], [gap])).toEqual(['STALE known gap s|cosign']);
  });
  it('a listed gap that is present passes', () => {
    expect(judge([{ subject: 's', check: 'cosign', detail: 'd' }], [gap])).toEqual([]);
  });
});
