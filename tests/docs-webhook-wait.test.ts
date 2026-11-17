import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');

const PAGES = [
  'apps/docs/content/docs/first-cluster.mdx',
  'apps/docs/content/docs/install.mdx',
];

const PROBE = /kubectl patch configmap\/config-network -n knative-serving\s*\\\s*--type merge --patch '\{"data":\{\}\}' --dry-run=server/;

describe('docs wait for the Knative webhook with a portable dry-run probe', () => {
  for (const page of PAGES) {
    it(`${page}: bounded dry-run probe loop precedes the operator apply`, () => {
      const doc = read(page);
      const probe = doc.search(PROBE);
      const apply = doc.indexOf('kubectl apply --server-side -f');
      expect(probe).toBeGreaterThan(0);
      expect(apply).toBeGreaterThan(probe);
      expect(doc).toContain('seq 1 60');
      expect(doc).toContain('sleep 2');
    });

    it(`${page}: no existence-only jsonpath wait (newer than the kubectl floor)`, () => {
      expect(read(page)).not.toMatch(/--for=jsonpath=/);
    });
  }

  it('docs and the nightly use the same probe', () => {
    const wf = read('.github/workflows/published-bundle-kind-nightly.yml');
    expect(wf).toMatch(PROBE);
    expect(wf).toContain('seq 1 60');
  });
});
