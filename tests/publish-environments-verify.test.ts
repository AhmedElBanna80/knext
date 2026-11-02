import { describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { PUBLISH_LANES } from '../scripts/publish-lane-guard.mjs';
import { evaluatePublishEnvironments } from '../scripts/verify-publish-environments.mjs';

// #2035 (c)+(d): the environment settings are founder/admin actions, so the
// code side is a read-only verifier that reds until they are configured.
const LANES = [...PUBLISH_LANES.keys()].map((r) => r.replace('refs/heads/', ''));
const pol = (names: string[]) => names.map((name) => ({ name, type: 'branch' }));
const env = (name: string, reviewers: boolean, custom = true) => ({
  name,
  protection_rules: reviewers ? [{ type: 'required_reviewers' }] : [],
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

describe('CLI', () => {
  it('exits non-zero on a garbage state file (fails closed)', () => {
    const r = spawnSync('node', [
      'scripts/verify-publish-environments.mjs',
      '--state',
      'package.json',
    ]);
    expect(r.status).not.toBe(0);
  });
  it('is read-only: no mutating gh api verbs', () => {
    const src = readFileSync('scripts/verify-publish-environments.mjs', 'utf8');
    expect(src).not.toMatch(/-X\s*(PUT|POST|PATCH|DELETE)/i);
    expect(src).not.toMatch(/--method/);
  });
});
