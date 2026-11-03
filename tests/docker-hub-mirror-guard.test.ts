import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { frozenFileSet } from '../scripts/compat-credential-freeze-guard.mjs';
import {
  baselineDrift,
  DEFERRAL_TRACKER,
  DEFERRED_DERIVED,
  DEFERRED_FROZEN,
  DEFERRED_PINNED,
  EXEMPT_NO_DOCKER_PULL,
  findViolations,
  imageRefOk,
  MIRROR_ACTION,
  pullSites,
  REPO_ROOT,
  UNMIRRORED_BASELINE,
} from '../scripts/docker-hub-mirror-guard.mjs';

/**
 * #2106: anonymous Docker Hub pulls red docker-heavy jobs. Every job that pulls
 * must route through mirror.gcr.io (same digests, no secret) BEFORE its first
 * pulling step. This scans the real workflows, and fixtures prove the scanner
 * sees red.
 */

const fixtures: string[] = [];
afterEach(() => {
  for (const d of fixtures.splice(0)) rmSync(d, { recursive: true, force: true });
});

function fixture(workflow: string, scripts: Record<string, string> = {}) {
  const root = mkdtempSync(join(tmpdir(), 'hub-mirror-'));
  fixtures.push(root);
  mkdirSync(join(root, '.github', 'workflows'), { recursive: true });
  mkdirSync(join(root, 'scripts'), { recursive: true });
  writeFileSync(join(root, '.github', 'workflows', 'w.yml'), workflow);
  for (const [name, body] of Object.entries(scripts)) writeFileSync(join(root, name), body);
  return root;
}

const job = (steps: string, extra = '') => `name: w
on: push
jobs:
  j:
    runs-on: ubuntu-latest
${extra}    steps:
${steps}`;

describe('docker-hub-mirror-guard (fixtures)', () => {
  it('reds a job that docker-builds with no mirror step', () => {
    const root = fixture(job('      - run: docker build -t x .\n'));
    expect(findViolations(root).length).toBe(1);
  });

  it('greens when the mirror action precedes the pull', () => {
    const root = fixture(job(`      - uses: ${MIRROR_ACTION}\n      - run: docker build -t x .\n`));
    expect(findViolations(root)).toEqual([]);
  });

  it('reds a mirrored ref in a run step that dropped its sha256 pin', () => {
    const pinned = `mirror.gcr.io/library/registry:2@sha256:${'0'.repeat(64)}`;
    const mk = (ref: string) =>
      fixture(job(`      - uses: ${MIRROR_ACTION}\n      - run: docker run -d ${ref}\n`));
    expect(findViolations(mk(pinned))).toEqual([]);
    expect(findViolations(mk('mirror.gcr.io/library/registry:2')).length).toBe(1);
  });

  it('reds when the mirror step comes AFTER the pull', () => {
    const root = fixture(job(`      - run: docker pull alpine\n      - uses: ${MIRROR_ACTION}\n`));
    expect(findViolations(root).length).toBe(1);
  });

  it('accepts the inline form (jobs that run before any checkout)', () => {
    const root = fixture(
      job(
        `      - run: |\n          echo '{"registry-mirrors":["https://mirror.gcr.io"]}' | sudo tee /etc/docker/daemon.json\n      - run: docker pull alpine\n`,
      ),
    );
    expect(findViolations(root)).toEqual([]);
  });

  it('reds setup-buildx / kind-action without the mirror', () => {
    expect(
      findViolations(fixture(job('      - uses: docker/setup-buildx-action@abc # v3\n'))).length,
    ).toBeGreaterThanOrEqual(1);
    expect(findViolations(fixture(job('      - uses: helm/kind-action@abc # v1\n'))).length).toBe(
      1,
    );
  });

  it('follows a run: script that itself pulls', () => {
    const root = fixture(job('      - run: bash scripts/x.sh\n'), {
      'scripts/x.sh': 'docker run --rm alpine true\n',
    });
    expect(findViolations(root).length).toBe(1);
  });

  it('reds an unprefixed Docker Hub services image, greens the mirror prefix', () => {
    const bad = fixture(
      job('      - run: echo hi\n', '    services:\n      r:\n        image: redis:7\n'),
    );
    expect(findViolations(bad).length).toBe(1);
    const ok = fixture(
      job(
        '      - run: echo hi\n',
        '    services:\n      r:\n        image: mirror.gcr.io/library/redis:7@sha256:0000000000000000000000000000000000000000000000000000000000000000\n',
      ),
    );
    expect(findViolations(ok)).toEqual([]);
  });

  it('imageRefOk: Docker Hub short refs fail; other registries and the mirror pass', () => {
    expect(imageRefOk('redis:7')).toBe(false);
    expect(imageRefOk('grafana/grafana:11')).toBe(false);
    expect(imageRefOk(`mirror.gcr.io/library/redis:7@sha256:${'0'.repeat(64)}`)).toBe(true);
    // the mirror is not a licence to drop the digest pin
    expect(imageRefOk('mirror.gcr.io/library/redis:7')).toBe(false);
    expect(imageRefOk('mirror.gcr.io/library/redis:7@sha256:aa')).toBe(false);
    expect(imageRefOk('ghcr.io/o/i:1')).toBe(true);
    expect(imageRefOk('us-central1-docker.pkg.dev/p/r/i@sha256:aa')).toBe(true);
  });

  it('reds setup-buildx-action with no buildkitd-config even when the mirror step runs', () => {
    const root = fixture(
      job(`      - uses: ${MIRROR_ACTION}\n      - uses: docker/setup-buildx-action@abc # v3\n`),
    );
    expect(findViolations(root).length).toBe(1);
    const ok = fixture(
      job(
        `      - uses: ${MIRROR_ACTION}\n      - uses: docker/setup-buildx-action@abc # v3\n        with:\n          buildkitd-config: /tmp/x.toml\n`,
      ),
    );
    expect(findViolations(ok)).toEqual([]);
  });

  it('skips deferred frozen files', () => {
    const root = fixture(job('      - run: docker build -t x .\n'));
    expect(findViolations(root, { deferred: ['.github/workflows/w.yml'] })).toEqual([]);
  });
});

describe('docker-hub-mirror-guard (the real workflows)', () => {
  it('no non-deferred workflow job pulls Docker Hub anonymously', () => {
    expect(findViolations(REPO_ROOT)).toEqual([]);
  });

  it('every deferral is still credential-frozen (a stale deferral must be removed)', () => {
    const frozen = frozenFileSet(REPO_ROOT);
    for (const f of DEFERRED_FROZEN) expect(frozen.has(f)).toBe(true);
  });

  // Deferral markers live HERE, not in the workflows: three of the four deferred files
  // are frozen or derived and cannot carry a comment without moving a fingerprint.
  // TODO(#2650): mirror test-e2e-deploy.yml + compat-vinext.yml (and re-derive
  // compat-credential-v1.3.yml) once the credential window closes; mirror
  // bun-base-build.yml under its own signing-chain review.
  it('the full deferred set equals the expected list (a new deferral needs a reason)', () => {
    expect([...DEFERRED_FROZEN, ...DEFERRED_DERIVED, ...DEFERRED_PINNED].sort()).toEqual([
      '.github/workflows/bun-base-build.yml',
      '.github/workflows/compat-credential-v1.3.yml',
      '.github/workflows/compat-vinext.yml',
      '.github/workflows/test-e2e-deploy.yml',
    ]);
  });

  it('the no-docker-pull exemption holds: the anonymous script never shells out', () => {
    expect(EXEMPT_NO_DOCKER_PULL).toEqual(['.github/workflows/anonymous-install-nightly.yml']);
    const script = readFileSync(join(REPO_ROOT, 'scripts/verify-anonymous-install.mjs'), 'utf8');
    expect(script).not.toMatch(/child_process|execSync|execFileSync|spawnSync/);
    // and the workflow still carries no mirror step (the credential audit forbids extra steps)
    const wf = readFileSync(join(REPO_ROOT, EXEMPT_NO_DOCKER_PULL[0]), 'utf8');
    expect(wf).not.toContain('docker-hub-mirror');
  });

  it('every DEFERRED_DERIVED file is still a generated derived copy', () => {
    for (const f of DEFERRED_DERIVED) {
      const text = readFileSync(join(REPO_ROOT, f), 'utf8');
      expect(text).toContain('GENERATED by scripts/compat-line-workflow.mjs');
      expect(text).toMatch(/^# derived-from-sha256: [0-9a-f]{64}$/m);
    }
  });

  it('every DEFERRED_PINNED file still has its step order pinned by bun-base-supply-chain', () => {
    const pinTest = readFileSync(join(REPO_ROOT, 'tests/bun-base-supply-chain.test.ts'), 'utf8');
    for (const f of DEFERRED_PINNED) {
      const name = f.split('/').pop() ?? f;
      expect(pinTest).toContain(`${name}: the submit/download/verify/sign chain is pinned`);
      expect(pinTest).toContain('const REVIEWED_ORDER = [');
      expect(pinTest).toContain('const REVIEWED_RUN');
    }
  });

  it('the composite action sets the daemon mirror and a buildkitd mirror config', () => {
    const a = readFileSync(join(REPO_ROOT, '.github/actions/docker-hub-mirror/action.yml'), 'utf8');
    expect(a).toContain('registry-mirrors');
    expect(a).toContain('mirror.gcr.io');
    expect(a).toContain('buildkitd');
  });
});

/**
 * #2650: the deferred files are skipped by the mirror scan, so a NEW Docker Hub pull added to
 * one would be invisible. Each carries a pinned baseline of its known unmirrored pull sites;
 * drift in EITHER direction is red (added = new anonymous pull; removed = stale baseline, the
 * mirror work landed and the deferral must go).
 */
describe('deferred-file pull baseline (#2650, fixtures)', () => {
  const F = '.github/workflows/test-e2e-deploy.yml';
  const mk = (workflow: string, scripts: Record<string, string> = {}) => {
    const root = fixture('name: x\non: push\njobs: {}\n', scripts);
    writeFileSync(join(root, F), workflow);
    return root;
  };
  const wf = (run: string) => job(`      - run: ${run}\n`);

  it('pullSites counts every pulling construct, ignores comment lines', () => {
    const root = mk(wf('docker run alpine true') + '      # docker run commented\n');
    expect(pullSites(F, root)).toEqual([`${F}: docker run alpine true`]);
  });

  it('pullSites follows a referenced script, including a ${{ workspace }}/knext/ prefixed path', () => {
    const root = mk(wf('bash "${{ github.workspace }}/knext/scripts/x.sh"'), {
      'scripts/x.sh': 'docker run a\ndocker run b\n',
    });
    expect(pullSites(F, root)).toEqual([
      'scripts/x.sh: docker run a',
      'scripts/x.sh: docker run b',
    ]);
  });

  it('greens when the actual pulls equal the baseline', () => {
    const root = mk(wf('docker run alpine true'));
    expect(baselineDrift(root, { [F]: [`${F}: docker run alpine true`] })).toEqual([]);
  });

  it('MUTATION: a new `docker run alpine` in a frozen file is red (added)', () => {
    const root = mk(wf('echo hi; docker run alpine true'));
    const d = baselineDrift(root, { [F]: [] });
    expect(d.length).toBe(1);
    expect(d[0].added).toEqual([`${F}: docker run alpine true`]);
    expect(d[0].removed).toEqual([]);
  });

  it('a second pull beside an existing one is red (multiplicity, not set membership)', () => {
    const two = `name: x\non: push\njobs:\n  j:\n    runs-on: x\n    steps:\n      - run: docker run a\n      - run: docker run a\n`;
    const root = mk(two);
    expect(baselineDrift(root, { [F]: [`${F}: docker run a`] })[0].added).toEqual([
      `${F}: docker run a`,
    ]);
    expect(baselineDrift(root, { [F]: [`${F}: docker run a`, `${F}: docker run a`] })).toEqual([]);
  });

  it('a removed pull is red (stale baseline)', () => {
    const root = mk(wf('echo hi'));
    const d = baselineDrift(root, { [F]: [`${F}: docker run alpine`] });
    expect(d.length).toBe(1);
    expect(d[0].removed).toEqual([`${F}: docker run alpine`]);
    expect(d[0].added).toEqual([]);
  });

  it('a pull added to a referenced script is red', () => {
    const root = mk(wf('bash scripts/x.sh'), { 'scripts/x.sh': 'docker pull redis\n' });
    expect(baselineDrift(root, { [F]: [] })[0].added).toEqual(['scripts/x.sh: docker pull redis']);
  });

  it('FINDING 1: swapping the image at a baselined site is red (image is in the entry)', () => {
    const root = mk(wf('docker run alpine true'));
    const d = baselineDrift(root, { [F]: [`${F}: docker run ubuntu true`] });
    expect(d.length).toBe(1);
    expect(d[0].added).toEqual([`${F}: docker run alpine true`]);
    expect(d[0].removed).toEqual([`${F}: docker run ubuntu true`]);
  });

  const NEW_PULLS: Record<string, string> = {
    'docker create': 'docker create redis:7',
    'docker image pull': 'docker image pull redis:7',
    'docker container run': 'docker container run redis:7',
    'docker container create': 'docker container create redis:7',
  };
  for (const [label, cmd] of Object.entries(NEW_PULLS)) {
    it(`FINDING 2: a new unmirrored ${label} in a frozen file is red`, () => {
      const root = mk(wf(cmd));
      expect(baselineDrift(root, { [F]: [] })[0].added.length).toBe(1);
    });
  }

  it('FINDING 2: a new uses: docker://image step in a frozen file is red', () => {
    const root = mk(job('      - uses: docker://redis:7\n'));
    expect(baselineDrift(root, { [F]: [] })[0].added.length).toBe(1);
  });

  it('FINDING 2: a new services: image in a frozen file is red', () => {
    const root = mk(
      job('      - run: echo hi\n', '    services:\n      r:\n        image: redis:7\n'),
    );
    const d = baselineDrift(root, { [F]: [] });
    expect(d[0].added.length).toBe(1);
    expect(d[0].added[0]).toContain('redis:7');
  });

  it('FINDING 2: a new container: image in a frozen file is red', () => {
    const root = mk(job('      - run: echo hi\n', '    container:\n      image: node:20\n'));
    expect(baselineDrift(root, { [F]: [] })[0].added[0]).toContain('node:20');
  });

  it('FINDING 2: a continued docker run keeps its image (on the next line) in the entry', () => {
    const root = mk(wf('|\n          docker run --rm \\\n            redis:7 true'));
    expect(pullSites(F, root)[0]).toContain('redis:7');
  });

  it('FINDING 2: a dynamic image is red until listed in the baseline explicitly', () => {
    const root = mk(wf('docker run "$IMG" true'));
    expect(baselineDrift(root, { [F]: [] })[0].added).toEqual([`${F}: docker run "$IMG" true`]);
    expect(baselineDrift(root, { [F]: [`${F}: docker run "$IMG" true`] })).toEqual([]);
  });

  it('FINDING 3: follows workflow -> a.sh -> b.sh transitively', () => {
    const root = mk(wf('bash scripts/a.sh'), {
      'scripts/a.sh': 'bash scripts/b.sh\n',
      'scripts/b.sh': 'docker pull redis\n',
    });
    expect(baselineDrift(root, { [F]: [] })[0].added).toEqual(['scripts/b.sh: docker pull redis']);
  });

  it('FINDING 3: a script cycle terminates', () => {
    const root = mk(wf('bash scripts/a.sh'), {
      'scripts/a.sh': 'bash scripts/b.sh\n',
      'scripts/b.sh': 'bash scripts/a.sh\ndocker pull redis\n',
    });
    expect(pullSites(F, root)).toEqual(['scripts/b.sh: docker pull redis']);
  });

  it('FINDING 3: a referenced script that does not exist fails (throws), not passes', () => {
    const root = mk(wf('bash scripts/gone.sh'));
    expect(() => baselineDrift(root, { [F]: [] })).toThrow(/scripts\/gone\.sh/);
    const root2 = mk(wf('bash scripts/a.sh'), { 'scripts/a.sh': 'bash scripts/gone.sh\n' });
    expect(() => pullSites(F, root2)).toThrow(/scripts\/gone\.sh/);
  });

  it('FINDING 3: a .json under scripts/ is data, not a script reference', () => {
    const root = mk(wf('cat scripts/data/x.json'));
    expect(pullSites(F, root)).toEqual([]);
  });
});

describe('deferred-file tracking (#2650, the real tree)', () => {
  it('the real deferred files match their pinned baseline (both halves)', () => {
    expect(baselineDrift(REPO_ROOT)).toEqual([]);
  });

  it('the baseline covers exactly the deferred frozen/derived/pinned set', () => {
    expect(Object.keys(UNMIRRORED_BASELINE).sort()).toEqual(
      [...DEFERRED_FROZEN, ...DEFERRED_DERIVED, ...DEFERRED_PINNED].sort(),
    );
  });

  it('the baseline is not vacuous: it pins the known pulls', () => {
    const n = (f: string) => UNMIRRORED_BASELINE[f].length;
    expect(n('.github/workflows/test-e2e-deploy.yml')).toBeGreaterThan(0);
    expect(n('.github/workflows/compat-credential-v1.3.yml')).toBeGreaterThan(0);
    expect(n('.github/workflows/bun-base-build.yml')).toBe(1);
  });

  it('every deferral names the open tracker and a removal condition', () => {
    expect(DEFERRAL_TRACKER.issue).toBe(2650);
    for (const f of Object.keys(UNMIRRORED_BASELINE)) {
      expect(DEFERRAL_TRACKER.removal[f]).toBeTruthy();
    }
    expect(DEFERRAL_TRACKER.closes).toMatch(/DEFERRED_/);
  });

  it('the removal condition for each frozen file is enforced: it must still be credential-frozen', () => {
    const frozen = frozenFileSet(REPO_ROOT);
    for (const f of DEFERRED_FROZEN) expect(frozen.has(f)).toBe(true);
  });

  it('no TODO points at the closed tracker (guard or mutation prover)', () => {
    for (const f of [
      'scripts/docker-hub-mirror-guard.mjs',
      'scripts/mutation-prove-docker-hub-mirror-guard.mjs',
    ]) {
      const text = readFileSync(join(REPO_ROOT, f), 'utf8');
      expect(text).not.toMatch(/TODO\(#2106\)/);
    }
    const guard = readFileSync(join(REPO_ROOT, 'scripts/docker-hub-mirror-guard.mjs'), 'utf8');
    for (const m of guard.matchAll(/TODO\(#(\d+)\)/g)) expect(m[1]).toBe('2650');
  });

  it('no TODO(#2106) survives anywhere under .github/ (workflows, actions)', () => {
    const walk = (d: string): string[] =>
      readdirSync(d, { withFileTypes: true }).flatMap((e) =>
        e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)],
      );
    for (const f of walk(join(REPO_ROOT, '.github'))) {
      expect(readFileSync(f, 'utf8'), f).not.toMatch(/TODO\(#2106\)/);
    }
  });
});
