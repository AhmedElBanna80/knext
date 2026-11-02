import { describe, expect, it } from 'bun:test';
import {
  auditOperatorTags,
  auditTemplateImages,
  type Finding,
  loadWorkflows,
  operatorTagWorkflows,
  templateDirs,
  type Workflow,
} from './helpers/image-supply-chain';

/**
 * SUPPLY-CHAIN GUARD, image half (#2044, v2 task R8).
 *
 * `security.md`: SBOM per image, Trivy fail on HIGH/CRITICAL, cosign signing.
 * The npm half (every publish lane `needs` the audit + SBOM job, including
 * `@getknext/grpc`) is `tests/publish-lane-supply-chain.test.ts`. This file
 * covers the two image families:
 *   - operator tags (`operator-v*`, pushed from ANY branch): Trivy, cosign, SBOM;
 *   - function template images (`templates/*`): SBOM and cosign.
 *
 * Lanes and templates are DERIVED by scanning `.github/workflows` and
 * `templates/`, never listed here. An unreadable or unparseable workflow throws.
 *
 * KNOWN_GAPS is the one explicit, named exception list: gaps that are TRUE of
 * the tree today and are reported in the PR, not hidden. The engine reds on a
 * gap that is not listed (new regression) AND on a listed gap that no longer
 * exists (stale), so closing a gap forces deleting its entry.
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
      'TODO(#2044): go-template.yml builds, SBOMs and Trivy-scans the image but never publishes or signs it; its header defers GHCR push + cosign to a separate push-only workflow (Z4 follow-up)',
  },
  {
    subject: 'template:rust',
    check: 'cosign',
    reason:
      'TODO(#2044): rust-template.yml has the same deferral (Z5 follow-up): SBOM and Trivy, no push, no cosign',
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

function wfNamed(file: string, list: Workflow[] = wfs): Workflow {
  const w = list.find((x) => x.file === file);
  if (!w) throw new Error(`${file} not found`);
  return w;
}
const withWf = (file: string, edit: (doc: any) => void): Workflow[] => {
  const copy = clone(wfs);
  edit(wfNamed(file, copy).doc);
  return copy;
};

describe('operator tags: the real workflows', () => {
  it('discovers the operator tag lane by scanning triggers, not a list', () => {
    expect(operatorTagWorkflows(wfs).map((w) => w.file)).toContain('operator-supply-chain.yml');
  });

  it('every operator-v* tag lane has Trivy (enforcing), SBOM and cosign, in order, on any branch', () => {
    expect(auditOperatorTags(wfs)).toEqual([]);
  });
});

describe('operator tags: a non-compliant lane fails (negative half)', () => {
  const OP = 'operator-supply-chain.yml';
  const strip = (match: (step: any) => boolean) => (doc: any) => {
    for (const job of Object.values<any>(doc.jobs))
      job.steps = (job.steps ?? []).filter((s: any) => !match(s));
  };
  const checks = (list: Workflow[]) => auditOperatorTags(list).map((f) => f.check);

  it('no Trivy step reds', () => {
    const m = withWf(
      OP,
      strip((s) => /trivy-action/.test(s.uses ?? '')),
    );
    expect(checks(m)).toContain('trivy');
  });
  it('Trivy that does not fail the build reds', () => {
    const m = withWf(OP, (d) => {
      for (const j of Object.values<any>(d.jobs))
        for (const s of j.steps ?? [])
          if (/trivy-action/.test(s.uses ?? '')) s.with['exit-code'] = '0';
    });
    expect(checks(m)).toContain('trivy');
  });
  it('no SBOM step reds', () => {
    const m = withWf(
      OP,
      strip((s) => /sbom-action/.test(s.uses ?? '')),
    );
    expect(checks(m)).toContain('sbom');
  });
  it('no cosign step reds', () => {
    const m = withWf(
      OP,
      strip((s) => /\bcosign\s+(sign|attest)\b/.test(s.run ?? '')),
    );
    expect(checks(m)).toContain('cosign');
  });
  it('a cosign job that no longer waits for the scan job reds', () => {
    const m = withWf(OP, (d) => {
      d.jobs['operator-image-publish'].needs = [];
    });
    expect(checks(m)).toContain('trivy-before-cosign');
  });
  it('a path filter on the push trigger reds (a tag could be skipped)', () => {
    const m = withWf(OP, (d) => {
      d.on.push.paths = ['packages/kn-next-operator/**'];
    });
    expect(checks(m)).toContain('any-branch');
  });
  it('a branch-only condition on the signing job reds (tags from other branches unsigned)', () => {
    const m = withWf(OP, (d) => {
      d.jobs['operator-image-publish'].if = "github.ref == 'refs/heads/main'";
    });
    expect(checks(m)).toContain('any-branch');
  });
  it('a workflow that publishes operator tags with no gates at all reds on all three', () => {
    const m = clone(wfs);
    m.push({
      file: 'new-operator.yml',
      doc: {
        on: { push: { tags: ['operator-v*'] } },
        jobs: { push: { steps: [{ run: 'crane push layout ghcr.io/x/op' }] } },
      },
    });
    const c = auditOperatorTags(m)
      .filter((f) => f.subject === 'new-operator.yml')
      .map((f) => f.check);
    expect(c).toEqual(expect.arrayContaining(['trivy', 'sbom', 'cosign']));
  });
  it('no operator tag lane at all reds (a vacuous scan is a failure)', () => {
    const m = wfs.filter((w) => w.file !== OP);
    expect(auditOperatorTags(m).map((f) => f.check)).toContain('discovered');
  });
  it('an unparseable workflow fails closed (throws)', () => {
    expect(() => loadWorkflows(`${import.meta.dirname}/helpers`)).toThrow();
  });
});

describe('function template images: the real tree', () => {
  it('derives the template images from templates/*/Dockerfile', () => {
    expect(templates).toEqual(expect.arrayContaining(['go', 'rust']));
  });

  it('every template image has an SBOM and cosign, except the NAMED known gaps', () => {
    expect(judge(auditTemplateImages(wfs, templates), KNOWN_GAPS)).toEqual([]);
  });

  it('every template image has an SBOM (no exception)', () => {
    expect(auditTemplateImages(wfs, templates).filter((f) => f.check === 'sbom')).toEqual([]);
  });

  it('the known gaps are load-bearing: without them the real tree is NOT clean', () => {
    expect(judge(auditTemplateImages(wfs, templates), []).length).toBe(KNOWN_GAPS.length);
  });
});

describe('function template images: both halves on fixtures', () => {
  const image = (steps: unknown[], extra: Record<string, unknown> = {}) =>
    ({
      file: 'fx.yml',
      doc: { on: {}, jobs: { image: { steps }, ...extra } },
    }) as Workflow;
  const build = { run: 'docker build -t x templates/go' };
  const sbom = { uses: 'anchore/sbom-action@abc' };
  const sign = { run: 'cosign sign --yes "$IMG@$DIGEST"' };

  it('a compliant template (build + SBOM + cosign) passes', () => {
    expect(auditTemplateImages([image([build, sbom, sign])], ['go'])).toEqual([]);
  });
  it('a downstream publish job that signs counts', () => {
    const w = image([build, sbom], { sign: { needs: 'image', steps: [sign] } });
    expect(auditTemplateImages([w], ['go'])).toEqual([]);
  });
  it('missing SBOM reds', () => {
    expect(auditTemplateImages([image([build, sign])], ['go']).map((f) => f.check)).toEqual([
      'sbom',
    ]);
  });
  it('missing cosign reds', () => {
    expect(auditTemplateImages([image([build, sbom])], ['go']).map((f) => f.check)).toEqual([
      'cosign',
    ]);
  });
  it('installing cosign without signing is not signing', () => {
    const w = image([build, sbom, { uses: 'sigstore/cosign-installer@abc' }]);
    expect(auditTemplateImages([w], ['go']).map((f) => f.check)).toEqual(['cosign']);
  });
  it('a signing job that does not need the image job is not counted', () => {
    const w = image([build, sbom], { sign: { steps: [sign] } });
    expect(auditTemplateImages([w], ['go']).map((f) => f.check)).toEqual(['cosign']);
  });
  it('a template with a Dockerfile that no job builds reds', () => {
    expect(
      auditTemplateImages([image([build, sbom, sign])], ['go', 'zig']).map((f) => f.subject),
    ).toEqual(['template:zig']);
  });
  it('a build-push-action context under templates/ is discovered too', () => {
    const w = image([{ uses: 'docker/build-push-action@abc', with: { context: 'templates/go' } }]);
    expect(
      auditTemplateImages([w], ['go'])
        .map((f) => f.check)
        .sort(),
    ).toEqual(['cosign', 'sbom']);
  });
  it('comment prose that mentions cosign sign is not a signing step', () => {
    const w = image([build, sbom, { run: '# cosign sign later\necho ok' }]);
    expect(auditTemplateImages([w], ['go']).map((f) => f.check)).toEqual(['cosign']);
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
