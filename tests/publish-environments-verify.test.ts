import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PUBLISH_LANES } from '../scripts/publish-lane-guard.mjs';
import {
  evaluatePublishEnvironments,
  manualChecks,
} from '../scripts/verify-publish-environments.mjs';
import { absTmpdir } from './helpers/abs-tmp';

// #2035 (c)+(d): the environment settings are founder/admin actions, so the
// code side is a read-only verifier that reds until they are configured.
const LANES = [...PUBLISH_LANES.keys()].map((r) => r.replace('refs/heads/', ''));
const pol = (names: string[]) => names.map((name) => ({ name, type: 'branch' }));
const env = (name: string, reviewers: boolean, custom = true) => ({
  name,
  protection_rules: reviewers
    ? [{ type: 'required_reviewers', reviewers: [{ type: 'User', reviewer: { login: 'a' } }] }]
    : [],
  deployment_branch_policy: custom
    ? { custom_branch_policies: true, protected_branches: false }
    : null,
});
const good = () => ({
  environments: [env('npm-publish', false), env('npm-publish-latest', true)],
  policies: { 'npm-publish': pol(LANES), 'npm-publish-latest': pol(LANES) } as Record<
    string,
    { name: string; type: string }[]
  >,
});

describe('evaluatePublishEnvironments', () => {
  it('accepts the fully configured state', () => {
    expect(evaluatePublishEnvironments(good())).toEqual([]);
  });
  it('reds when npm-publish-latest is absent', () => {
    const s = good();
    s.environments = s.environments.filter((e) => e.name !== 'npm-publish-latest');
    expect(evaluatePublishEnvironments(s).join('\n')).toContain('npm-publish-latest');
  });
  it('reds when npm-publish-latest has no required reviewer', () => {
    const s = good();
    s.environments[1] = env('npm-publish-latest', false);
    expect(evaluatePublishEnvironments(s).join('\n')).toContain('required reviewer');
  });
  it('reds when npm-publish has no custom branch policy (today)', () => {
    const s = good();
    s.environments[0] = env('npm-publish', false, false);
    expect(evaluatePublishEnvironments(s).join('\n')).toContain('custom branch');
  });
  it('reds on a glob policy', () => {
    const s = good();
    s.policies['npm-publish'] = pol([...LANES, 'integration/v*']);
    expect(evaluatePublishEnvironments(s).join('\n')).toContain('integration/v*');
  });
  it('reds on a missing lane and on an extra non-glob branch', () => {
    const s = good();
    s.policies['npm-publish'] = pol(LANES.slice(1));
    expect(evaluatePublishEnvironments(s).join('\n')).toContain(LANES[0]);
    const t = good();
    t.policies['npm-publish-latest'] = pol([...LANES, 'integration/v1-coldstart']);
    expect(evaluatePublishEnvironments(t).join('\n')).toContain('integration/v1-coldstart');
  });
  it('reds on a tag-type policy', () => {
    const s = good();
    // Named like a lane, so ONLY the type check can catch it.
    s.policies['npm-publish'] = [...pol(LANES), { name: LANES[0], type: 'tag' }];
    expect(evaluatePublishEnvironments(s).length).toBeGreaterThan(0);
  });
});

describe('policy entry without a type', () => {
  it('reds (fails closed) when a policy entry carries no type', () => {
    const s = good();
    s.policies['npm-publish'] = [...pol(LANES), { name: LANES[0] } as never];
    expect(evaluatePublishEnvironments(s).join('\n')).toContain('non-branch');
  });
});

describe('reviewer + secret checks', () => {
  it('reds when the required reviewer is a team', () => {
    const s = good();
    s.environments[1].protection_rules = [
      { type: 'required_reviewers', reviewers: [{ type: 'Team' }] },
    ] as never;
    expect(evaluatePublishEnvironments(s).join('\n')).toContain('not a user');
  });
  it('reds when a team sits beside the user', () => {
    const s = good();
    s.environments[1].protection_rules = [
      { type: 'required_reviewers', reviewers: [{ type: 'User' }, { type: 'Team' }] },
    ] as never;
    expect(evaluatePublishEnvironments(s).join('\n')).toContain('team');
  });
  it('reds when a readable secret list lacks NPM_TOKEN', () => {
    const s = { ...good(), secrets: { 'npm-publish': ['NPM_TOKEN'], 'npm-publish-latest': [] } };
    expect(evaluatePublishEnvironments(s).join('\n')).toContain('NPM_TOKEN');
  });
  it('green with secrets present; unreadable secrets become manual checks, not OK', () => {
    const s = {
      ...good(),
      secrets: { 'npm-publish': ['NPM_TOKEN'], 'npm-publish-latest': ['NPM_TOKEN'] },
    };
    expect(evaluatePublishEnvironments(s)).toEqual([]);
    expect(manualChecks(s)).toEqual([]);
    expect(manualChecks(good()).length).toBe(2);
  });
});

const SCRIPT = join(process.cwd(), 'scripts/verify-publish-environments.mjs');
function runCli(msg: string) {
  const dir = mkdtempSync(join(absTmpdir(), 'fakegh-'));
  try {
    const envs = JSON.stringify({
      environments: [{ name: 'npm-publish', protection_rules: [], deployment_branch_policy: null }],
    });
    writeFileSync(
      join(dir, 'gh'),
      `#!/bin/sh
case "$2" in
  *deployment-branch-policies) echo "gh: $FAKE_MSG" >&2; exit 1;;
  *secrets) echo "gh: HTTP 403 Forbidden" >&2; exit 1;;
  *) echo '${envs}';;
esac
`,
    );
    chmodSync(join(dir, 'gh'), 0o755);
    return spawnSync('node', [SCRIPT], {
      encoding: 'utf8',
      env: { ...process.env, PATH: `${dir}:${process.env.PATH}`, FAKE_MSG: msg },
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('CLI against a fake gh (fail-closed on API errors)', () => {
  for (const msg of ['HTTP 401: Bad credentials', 'HTTP 403: Forbidden']) {
    it(`exits 1 with a could-not-verify message on ${msg}`, () => {
      const r = runCli(msg);
      expect(r.status).toBe(1);
      expect(r.stderr).toContain('could not verify (fail-closed)');
    });
  }
  it('treats 404 on branch policies as a finding, not an API failure', () => {
    const r = runCli('Not Found (HTTP 404)');
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('no custom branch policy');
    expect(r.stderr).not.toContain('could not verify');
  });
});

describe('CLI', () => {
  it('exits non-zero on a garbage state file (fails closed)', () => {
    const r = spawnSync(
      'node',
      ['scripts/verify-publish-environments.mjs', '--state', 'package.json'],
      { encoding: 'utf8' },
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toContain('FAIL state has no environments array');
  });
  it('is read-only: no mutating gh api verbs', () => {
    const src = readFileSync('scripts/verify-publish-environments.mjs', 'utf8');
    expect(src).not.toMatch(/-X\s*(PUT|POST|PATCH|DELETE)/i);
    expect(src).not.toMatch(/--method/);
  });
});
