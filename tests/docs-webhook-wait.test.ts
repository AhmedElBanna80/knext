import { describe, expect, it } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';

// Guards every docs page that tells a user to apply the operator bundle on a fresh
// install. Each such page must wait for the Knative webhook with the portable
// dry-run probe, gate the apply inside a subshell, and avoid a jsonpath wait. The
// probe must also match the one the published-bundle nightly runs.
//
// Scan: a docs page is a candidate when a logical line (backslash continuations
// joined) runs `kubectl apply` on a -f/--filename target containing install.yaml.
// The target may be literal or quoted, flags may come in any order, and a ${VAR}
// target counts when the same page assigns VAR an install.yaml value. Lines that
// are not a kubectl apply (curl, prose, a deploy.yaml apply) do not count.
//
// EXCLUDED is the only exemption. Each entry names a matching page and why the
// fresh-install probe does not apply to it. A test asserts each entry still exists
// and still matches the scan, so an entry cannot go stale silently.

const ROOT = join(import.meta.dirname, '..');
const read = (p: string) => readFileSync(join(ROOT, p), 'utf8');
const DOCS = 'apps/docs/content/docs';

// The canonical fresh-install apply, which the probe must directly precede.
const APPLY_URL =
  /kubectl apply --server-side -f (https:\/\/github\.com\/[^\s/]+\/[^\s/]+\/releases\/download\/[^\s/]+\/install\.yaml)/;

// `kubectl apply`, any flags, then -f/--filename and its target (quotes stripped).
const APPLY_FILE = /\bkubectl\s+apply\b.*?\s(?:-f|--filename)(?:\s+|=)["']?([^\s"']+)/;
const VAR_TARGET = /^\$\{?([A-Za-z_]\w*)\}?$/;

const EXCLUDED: Record<string, string> = {
  'upgrading.mdx':
    'upgrade of an existing 0.4.x cluster: Knative Serving is already serving there, so the fresh-install webhook race does not apply',
  'operator-upgrade.mdx':
    'rollback: re-applies a previous release bundle to a running operator; Knative Serving is already serving there',
};

/** Joins backslash-continued lines so a URL on the next line stays with its kubectl apply. */
function logicalLines(text: string): string[] {
  return text.replace(/\\\r?\n[ \t]*/g, ' ').split('\n');
}

/** A literal target is returned as-is; a ${VAR} target resolves to its assignment in `doc`. */
function resolveTarget(target: string, doc: string): string | undefined {
  const v = VAR_TARGET.exec(target);
  if (!v) return target;
  const assign = new RegExp(`^\\s*(?:export\\s+)?${v[1]}=["']?([^\\s"']+)`, 'm');
  return assign.exec(doc)?.[1];
}

/** Logical lines in `text` that run kubectl apply on an install.yaml target. Variables resolve against `doc`. */
function installApplies(text: string, doc: string = text): string[] {
  return logicalLines(text).filter((line) => {
    const m = APPLY_FILE.exec(line);
    if (!m) return false;
    const target = resolveTarget(m[1], doc);
    return target !== undefined && target.includes('install.yaml');
  });
}

const FILES = readdirSync(join(ROOT, DOCS))
  .filter((f) => f.endsWith('.mdx'))
  .map((f) => `${DOCS}/${f}`);
const MATCHING = FILES.filter((p) => installApplies(read(p)).length > 0);
const PAGES = MATCHING.filter((p) => !Object.hasOwn(EXCLUDED, basename(p)));

/**
 * The fenced block carrying the published-bundle apply (APPLY_URL). A locally built
 * dist/install.yaml apply on the same page (fork builds) is a separate block and is
 * not the published-bundle block this probe guards.
 */
function applyBlock(doc: string): { lang: string; body: string } {
  const blocks = [...doc.matchAll(/```(\S*)[^\n]*\n([\s\S]*?)```/g)];
  const hit = blocks.filter((b) => installApplies(b[2], doc).length > 0 && APPLY_URL.test(b[2]));
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

const URL_ = 'https://github.com/getknext-dev/knext/releases/download/operator-latest/install.yaml';

describe('matcher self-test: which lines count as an apply of install.yaml', () => {
  const caught: [string, string][] = [
    ['plain kubectl apply -f <install.yaml URL>', `kubectl apply -f ${URL_}`],
    ['-f before --server-side', `kubectl apply -f ${URL_} --server-side`],
    ['--server-side before -f', `kubectl apply --server-side -f ${URL_}`],
    ['quoted URL', `kubectl apply --server-side -f "${URL_}"`],
    [
      '${VAR} assigned an install.yaml URL on the page',
      `URL="${URL_}"\nkubectl apply --server-side -f "\${URL}"`,
    ],
    ['URL on the continuation line', `kubectl apply --server-side -f \\\n  ${URL_}`],
  ];
  for (const [name, src] of caught) {
    it(`catches: ${name}`, () => {
      expect(installApplies(src)).toHaveLength(1);
    });
  }

  const missed: [string, string][] = [
    ['kubectl get pods', 'kubectl get pods -n knative-serving'],
    ['kubectl apply of a non-install.yaml file', 'kubectl apply -f deploy.yaml'],
    [
      'prose mentioning install.yaml with no kubectl apply',
      'The install.yaml bundle is published on each release.',
    ],
    ['curl download of install.yaml', `curl -sL -o install.yaml ${URL_}`],
    ['${VAR} with no assignment on the page', 'kubectl apply -f "${URL}"'],
  ];
  for (const [name, src] of missed) {
    it(`ignores: ${name}`, () => {
      expect(installApplies(src)).toEqual([]);
    });
  }
});

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

  for (const [name, reason] of Object.entries(EXCLUDED)) {
    it(`allowlist: ${name} exists, has a reason, and still matches the scan`, () => {
      expect(FILES).toContain(`${DOCS}/${name}`);
      expect(reason.trim().length).toBeGreaterThan(20);
      expect(MATCHING).toContain(`${DOCS}/${name}`);
    });
  }

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
