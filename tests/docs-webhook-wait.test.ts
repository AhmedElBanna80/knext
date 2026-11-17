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

// `kubectl apply`, any flags, then -f/--filename and its target (quotes stripped).
const APPLY_FILE = /\bkubectl\s+apply\b.*?\s(?:-f|--filename)(?:\s+|=)["']?([^\s"'`]+)/;
const VAR_TARGET = /^\$\{?([A-Za-z_]\w*)\}?$/;

// Exemptions are per page AND per apply line (the exact trimmed logical line), each with
// the true reason. A page with a non-listed install apply must carry the probe.
const EXCLUDED: Record<string, Record<string, string>> = {
  'upgrading.mdx': {
    'kubectl apply --server-side -f https://github.com/getknext-dev/knext/releases/download/operator-vX.Y.Z/install-vX.Y.Z.yaml':
      'operator upgrade on an existing cluster: Knative Serving is already serving there, so the fresh-install webhook race does not apply',
    'kubectl apply -f https://github.com/getknext-dev/knext/releases/download/operator-latest/install.yaml':
      'operator upgrade of an existing 0.4.x cluster: Knative Serving is already serving there, so the fresh-install webhook race does not apply',
  },
  'operator-upgrade.mdx': {
    'kubectl apply --server-side -f install-new.yaml':
      'upgrade: applies a newer release bundle to a running operator; Knative Serving is already serving there',
    '3. Apply the new bundle: `kubectl apply --server-side -f install-new.yaml`.':
      'upgrade: applies a newer release bundle (breaking-CRD path) to a running operator; Knative Serving is already serving there',
    'kubectl apply --server-side -f https://github.com/getknext-dev/knext/releases/download/<last-good-tag>/install.yaml':
      'rollback: re-applies the previous release bundle to a running operator; Knative Serving is already serving there',
  },
  'versioning.mdx': {
    'kubectl apply --server-side -f "https://github.com/getknext-dev/knext/releases/download/operator-v${NEW_VERSION}/install-v${NEW_VERSION}.yaml"':
      'upgrade: applies a newer release bundle to a running operator; Knative Serving is already serving there',
    'kubectl apply --server-side -f "https://github.com/getknext-dev/knext/releases/download/operator-v${PREVIOUS_VERSION}/install-v${PREVIOUS_VERSION}.yaml"':
      'rollback: re-applies the previous release bundle to a running operator; Knative Serving is already serving there',
  },
};

/** Logical lines (backslash continuations joined, whitespace collapsed) with the raw offset where each starts. */
function logicalLines(text: string): { line: string; start: number }[] {
  const out: { line: string; start: number }[] = [];
  let pos = 0;
  let cur: { line: string; start: number } | undefined;
  for (const phys of text.split('\n')) {
    const cont = /\\\r?$/.test(phys);
    const piece = phys.replace(/\\\r?$/, '');
    if (cur) cur.line += ` ${piece.trim()}`;
    else cur = { line: piece, start: pos };
    pos += phys.length + 1;
    if (!cont) {
      out.push(cur);
      cur = undefined;
    }
  }
  if (cur) out.push(cur);
  return out;
}

/** A literal target is returned as-is; a ${VAR} target resolves to its assignment in `doc`. */
function resolveTarget(target: string, doc: string): string | undefined {
  const v = VAR_TARGET.exec(target);
  if (!v) return target;
  const assign = new RegExp(`^\\s*(?:export\\s+)?${v[1]}=["']?([^\\s"']+)`, 'm');
  return assign.exec(doc)?.[1];
}

/** Any install*.yaml file name (install.yaml, install-vX.yaml, dist/install.yaml, install-new.yaml), path or URL. */
const INSTALL_FILE = /(^|\/)install[^/]*\.yaml$/;

/** Logical lines in `text` that run kubectl apply on an install*.yaml target. Variables resolve against `doc`. */
function installAppliesAt(text: string, doc: string = text) {
  return logicalLines(text).filter(({ line }) => {
    const m = APPLY_FILE.exec(line);
    if (!m) return false;
    const target = resolveTarget(m[1], doc);
    return target !== undefined && INSTALL_FILE.test(target.split(/[?#]/)[0]);
  });
}
const installApplies = (text: string, doc: string = text): string[] =>
  installAppliesAt(text, doc).map((l) => l.line);

const FILES = readdirSync(join(ROOT, DOCS))
  .filter((f) => f.endsWith('.mdx'))
  .map((f) => `${DOCS}/${f}`);
const MATCHING = FILES.filter((p) => installApplies(read(p)).length > 0);

/** Apply lines on a page that are not exempted by name: each must be probed. */
function freshApplies(page: string) {
  const doc = read(page);
  const ex = EXCLUDED[basename(page)] ?? {};
  return installAppliesAt(doc).filter((l) => !Object.hasOwn(ex, extractKey(l.line)));
}
/** The allowlist key of a logical line: its trimmed text. */
const extractKey = (line: string) => line.trim().replace(/\s+/g, ' ');
const PAGES = MATCHING.filter((p) => freshApplies(p).length > 0);

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
    [
      'install-v${VERSION}.yaml pinned bundle',
      'kubectl apply --server-side -f "https://github.com/o/r/releases/download/operator-v${VERSION}/install-v${VERSION}.yaml"',
    ],
    ['local dist/install.yaml', 'kubectl apply --server-side -f dist/install.yaml'],
    ['local install-new.yaml', 'kubectl apply --server-side -f install-new.yaml'],
    [
      'inline prose apply of install-new.yaml',
      'Apply it: `kubectl apply --server-side -f install-new.yaml`.',
    ],
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

  for (const [name, entries] of Object.entries(EXCLUDED)) {
    for (const [key, reason] of Object.entries(entries)) {
      it(`allowlist: ${name} :: ${key.slice(0, 70)} exists once, has a reason, and still matches the scan`, () => {
        expect(FILES).toContain(`${DOCS}/${name}`);
        expect(reason.trim().length).toBeGreaterThan(20);
        const hits = installAppliesAt(read(`${DOCS}/${name}`)).filter(
          (l) => extractKey(l.line) === key,
        );
        expect(hits).toHaveLength(1);
      });
    }
  }

  for (const page of PAGES) {
    it(`${page}: every non-exempt install apply is gated by the probe inside a subshell`, () => {
      const doc = read(page);
      const applies = freshApplies(page);
      expect(applies.length).toBeGreaterThan(0);
      for (const { line, start } of applies) {
        expect(line.trimStart().startsWith(') && kubectl apply --server-side -f ')).toBe(true);
        const before = doc.slice(0, start);
        const open = before.lastIndexOf('\n(\n');
        expect(open).toBeGreaterThanOrEqual(0);
        const probe = before.slice(open + 1);
        expectProbe(probe);
        // the probe sits directly above the apply: no other apply or fence close in between
        expect(probe).not.toContain('```');
        expect(probe).not.toMatch(/kubectl apply/);
      }
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
