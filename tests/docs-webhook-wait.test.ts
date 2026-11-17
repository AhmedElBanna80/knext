import { describe, expect, it } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const DOCS = 'apps/docs/content/docs';

// A fresh-install apply of the operator bundle: server-side, the published URL.
const APPLY_URL =
  /kubectl apply --server-side -f (https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/releases\/download\/[^\s/]+\/install\.yaml)/;

// Derived by scanning, so a new page that applies the bundle cannot be missed.
const PAGES = readdirSync(join(ROOT, DOCS))
  .filter((f) => f.endsWith('.mdx'))
  .map((f) => `${DOCS}/${f}`)
  .filter((p) => APPLY_URL.test(read(p)));

/** The fenced block containing the operator apply. */
function applyBlock(doc: string): { lang: string; body: string } {
  const blocks = [...doc.matchAll(/```(\S*)[^\n]*\n([\s\S]*?)```/g)];
  const hit = blocks.filter((b) => APPLY_URL.test(b[2]));
  expect(hit.length).toBe(1);
  return { lang: hit[0][1], body: hit[0][2] };
}

/** What the probe must contain, shared by docs and the workflow. */
function expectProbe(block: string) {
  expect(block).toMatch(
    /kubectl patch configmap\/config-network -n knative-serving\s*\\\s*--type=merge -p '\{"data":\{\}\}' --dry-run=server/,
  );
  expect(block).toMatch(/until kubectl patch/);
  expect(block).toMatch(/-ge 60\b/);
  expect(block).toContain('exit 1');
  expect(block).toContain('sleep 2');
  expect(block).not.toContain('seq ');
}

describe('docs wait for the Knative webhook with a portable dry-run probe', () => {
  it('finds the pages that apply the operator bundle', () => {
    expect(PAGES).toEqual(
      expect.arrayContaining([
        `${DOCS}/first-cluster.mdx`,
        `${DOCS}/install.mdx`,
        `${DOCS}/operator.mdx`,
      ]),
    );
  });

  for (const page of PAGES) {
    it(`${page}: the probe block gates the apply and exits inside a subshell`, () => {
      const { lang, body } = applyBlock(read(page));
      expect(lang).toBe('sh');
      const marker = body.indexOf(') && kubectl apply');
      expect(marker).toBeGreaterThan(0);
      const probe = body.slice(0, marker);
      expectProbe(probe);
      expect(probe.trimStart().startsWith('(')).toBe(true);
      const apply = body.slice(marker + 5);
      expect(apply).toMatch(APPLY_URL);
      expect(apply).toContain('kubectl apply --server-side -f ');
    });

    it(`${page}: no existence-only jsonpath wait (newer than the kubectl floor)`, () => {
      expect(read(page)).not.toMatch(/--for=jsonpath=/);
    });
  }

  it('docs and the nightly use the same probe', () => {
    const wf = read('.github/workflows/published-bundle-kind-nightly.yml');
    const start = wf.indexOf('- name: Wait for the Knative webhook to be routable');
    const end = wf.indexOf('- name: Apply the documented install.yaml, unmodified');
    expect(start).toBeGreaterThan(0);
    expectProbe(wf.slice(start, end));
  });
});
