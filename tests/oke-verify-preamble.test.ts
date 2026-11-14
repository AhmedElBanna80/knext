import { afterAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { parse } from 'yaml';

/**
 * The OKE verify preamble (#2173) must fail when the cluster is not the
 * expected release candidate, and must never pass when it cannot read the
 * cluster. kubectl is a stub that serves JSON fixtures, so nothing here
 * touches a real cluster.
 */

const SCRIPT = resolve(import.meta.dirname, '../scripts/oke-verify-preamble.mjs');
const CRD = parse(
  readFileSync(
    resolve(
      import.meta.dirname,
      '../packages/kn-next-operator/config/crd/bases/apps.kn-next.dev_nextapps.yaml',
    ),
    'utf8',
  ),
);
const D = `sha256:${'a'.repeat(64)}`;
const OTHER = `sha256:${'b'.repeat(64)}`;
const IMG = 'ghcr.io/getknext-dev/kn-next-operator';

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

type Cluster = { pods?: unknown; crd?: unknown; ksvc?: unknown; fail?: 'pods' | 'crd' | 'ksvc' };

function pods(...ids: (string | null)[]) {
  return {
    items: ids.map((id, i) => ({
      metadata: { name: `op-${i}` },
      status: id === null ? {} : { containerStatuses: [{ name: 'manager', imageID: id }] },
    })),
  };
}

function stub(cluster: Cluster): string {
  const dir = mkdtempSync(join(tmpdir(), 'oke-preamble-'));
  dirs.push(dir);
  const files: Record<string, unknown> = {
    pods: cluster.pods ?? pods(`${IMG}@${D}`),
    crd: cluster.crd ?? CRD,
    ksvc: cluster.ksvc ?? { metadata: { generation: 7 } },
  };
  for (const [k, v] of Object.entries(files))
    writeFileSync(join(dir, `${k}.json`), JSON.stringify(v));
  const bin = join(dir, 'kubectl');
  writeFileSync(
    bin,
    `#!/bin/sh
echo "$@" >> "${dir}/calls"
for a in "$@"; do case "$a" in pods|crd|ksvc) kind="$a"; break;; esac; done
[ "$kind" = "${cluster.fail ?? ''}" ] && { echo "error: forbidden" >&2; exit 1; }
cat "${dir}/$kind.json"
`,
  );
  chmodSync(bin, 0o755);
  return dir;
}

function run(cluster: Cluster, args: string[] = ['--expect-operator-digest', D]) {
  const dir = stub(cluster);
  const r = spawnSync('node', [SCRIPT, ...args], {
    encoding: 'utf8',
    env: { ...process.env, KUBECTL: join(dir, 'kubectl') },
  });
  let calls = '';
  try {
    calls = readFileSync(join(dir, 'calls'), 'utf8');
  } catch {}
  return { code: r.status, out: `${r.stdout}${r.stderr}`, calls };
}

describe('oke-verify-preamble', () => {
  it('passes and prints the three facts when the cluster matches', () => {
    const r = run({}, ['--expect-operator-digest', D, '--expect-ksvc-generation', '7']);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`operator pod op-0 imageID: ${IMG}@${D}`);
    expect(r.out).toContain('schema equals the source');
    expect(r.out).toContain('ksvc knext-docs/knext-docs generation: 7');
  });

  it('only reads the cluster', () => {
    const r = run({});
    expect(r.code).toBe(0);
    const verbs = r.calls
      .trim()
      .split('\n')
      .map((l) => l.split(' ')[0]);
    expect(verbs).toEqual(['get', 'get', 'get']);
  });

  it('passes --context through to every kubectl call', () => {
    const r = run({}, ['--expect-operator-digest', D, '--context', 'knext-oke']);
    expect(r.code).toBe(0);
    for (const line of r.calls.trim().split('\n'))
      expect(line.startsWith('--context knext-oke get')).toBe(true);
  });

  it('fails on a different operator digest', () => {
    const r = run({ pods: pods(`${IMG}@${OTHER}`) });
    expect(r.code).toBe(1);
    expect(r.out).toContain(`MISMATCH: operator pod op-0 runs ${OTHER}, expected ${D}`);
  });

  it('fails when one of several operator pods runs another digest (half-done rollout)', () => {
    const r = run({ pods: pods(`${IMG}@${D}`, `${IMG}@${OTHER}`) });
    expect(r.code).toBe(1);
    expect(r.out).toContain(`operator pod op-1 runs ${OTHER}`);
  });

  it('fails when no operator pod is running', () => {
    const r = run({ pods: { items: [] } });
    expect(r.code).toBe(1);
    expect(r.out).toContain('MISMATCH: no operator pod');
  });

  it('fails when the live CRD lacks a field the source has', () => {
    const live = structuredClone(CRD);
    const spec = live.spec.versions[0].schema.openAPIV3Schema.properties.spec.properties;
    const dropped = Object.keys(spec)[0];
    delete spec[dropped];
    const r = run({ crd: live });
    expect(r.code).toBe(1);
    expect(r.out).toContain('MISMATCH: live CRD: version');
    expect(r.out).toContain(dropped);
  });

  it('fails on a different ksvc generation', () => {
    const r = run({}, ['--expect-operator-digest', D, '--expect-ksvc-generation', '8']);
    expect(r.code).toBe(1);
    expect(r.out).toContain('MISMATCH: ksvc generation is 7, expected 8');
  });

  it('fails when the ksvc has no generation', () => {
    const r = run({ ksvc: { metadata: {} } });
    expect(r.code).toBe(1);
    expect(r.out).toContain('has no integer metadata.generation');
  });

  it('accepts the docker-pullable imageID form', () => {
    expect(run({ pods: pods(`docker-pullable://${IMG}@${D}`) }).code).toBe(0);
  });

  it('fails on an imageID with no digest', () => {
    for (const id of ['', `${IMG}:v1`]) {
      const r = run({ pods: pods(id) });
      expect(r.code).toBe(1);
      expect(r.out).toContain('runs (no digest)');
    }
  });

  it('fails when an operator pod has no manager status yet (pod still starting)', () => {
    const r = run({ pods: pods(`${IMG}@${D}`, null) });
    expect(r.code).toBe(1);
    expect(r.out).toContain('operator pod op-1 imageID: (none)');
    expect(r.out).toContain('MISMATCH: operator pod op-1 runs (no digest)');
  });

  it('fails when the live CRD drops a source pattern but keeps every field', () => {
    const live = structuredClone(CRD);
    const dropPattern = (node: Record<string, unknown>): boolean => {
      if (typeof node.pattern === 'string') {
        delete node.pattern;
        return true;
      }
      return Object.values(node).some(
        (v) => v && typeof v === 'object' && dropPattern(v as Record<string, unknown>),
      );
    };
    expect(dropPattern(live.spec.versions[0].schema)).toBe(true);
    const r = run({ crd: live });
    expect(r.code).toBe(1);
    expect(r.out).toContain('the schema differs from the source');
  });

  it('fails when the cluster serves a version the source does not', () => {
    const live = structuredClone(CRD);
    live.spec.versions.push({
      ...structuredClone(live.spec.versions[0]),
      name: 'v9',
      storage: false,
    });
    const r = run({ crd: live });
    expect(r.code).toBe(1);
    expect(r.out).toContain('version "v9" is on the cluster but not in the source');
  });

  it('does not read schema key order as a difference', () => {
    const live = structuredClone(CRD);
    const v = live.spec.versions[0];
    const props = v.schema.openAPIV3Schema.properties;
    v.schema.openAPIV3Schema.properties = Object.fromEntries(Object.entries(props).reverse());
    expect(run({ crd: live }).code).toBe(0);
  });

  it('fails on a non-integer ksvc generation', () => {
    expect(run({ ksvc: { metadata: { generation: '7' } } }).code).toBe(1);
  });

  it('reads the ksvc named by --ksvc and --ksvc-namespace', () => {
    const r = run({}, [
      '--expect-operator-digest',
      D,
      '--ksvc',
      'docs2',
      '--ksvc-namespace',
      'ns2',
    ]);
    expect(r.code).toBe(0);
    expect(r.calls).toContain('get ksvc docs2 -n ns2 -o json');
    expect(r.out).toContain('ksvc ns2/docs2 generation: 7');
  });

  it('exits 2 on an unknown flag', () => {
    expect(run({}, ['--expect-operator-digest', D, '--nope', 'x']).code).toBe(2);
  });

  it('fails when a served or storage flag differs', () => {
    const live = structuredClone(CRD);
    live.spec.versions[0].served = !live.spec.versions[0].served;
    const r = run({ crd: live });
    expect(r.code).toBe(1);
    expect(r.out).toContain('served/storage differ');
  });

  it('fails when a source version is missing from the cluster', () => {
    const live = structuredClone(CRD);
    const name = live.spec.versions[0].name;
    live.spec.versions = [];
    const r = run({ crd: live });
    expect(r.code).toBe(1);
    expect(r.out).toContain(`version "${name}" is missing from the cluster`);
  });

  it('fails when the source CRD has no versions', () => {
    const dir = stub({});
    const src = join(dir, 'empty-crd.yaml');
    writeFileSync(src, 'spec:\n  versions: []\n');
    const r = run({}, ['--expect-operator-digest', D, '--source-crd', src]);
    expect(r.code).toBe(1);
    expect(r.out).toContain('the source CRD has no versions');
  });

  it('exits 2, never 0, when the source CRD cannot be read', () => {
    const r = run({}, ['--expect-operator-digest', D, '--source-crd', '/nonexistent/crd.yaml']);
    expect(r.code).toBe(2);
    expect(r.out).toContain('cannot read the cluster or the source CRD');
  });

  for (const fail of ['pods', 'crd', 'ksvc'] as const) {
    it(`exits 2, never 0, when the ${fail} read fails`, () => {
      const r = run({ fail });
      expect(r.code).toBe(2);
      expect(r.out).toContain('cannot read the cluster');
    });
  }

  it('exits 2 on a missing or malformed expected digest', () => {
    expect(run({}, []).code).toBe(2);
    expect(run({}, ['--expect-operator-digest', 'sha256:abc']).code).toBe(2);
    expect(run({}, ['--expect-operator-digest', D, '--expect-ksvc-generation', 'x']).code).toBe(2);
  });
});
