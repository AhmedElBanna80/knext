/**
 * The temporary own-repo form: a reusable workflow pinned by 40-hex SHA with a
 * `# <protected branch>` comment. One shared definition (`ownRepoShaPinBranch`),
 * used by the PR-time guard and the nightly resolver. Both halves: what is
 * accepted and what must still be rejected.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ownRepoShaPinBranch, verifyPins } from '../scripts/verify-action-pins.mjs';

const SHA = 'a'.repeat(40);
const LANE = '.github/workflows/lane.yml';
const ACTION = `AhmedElBanna80/knext/${LANE}`;

describe('ownRepoShaPinBranch', () => {
  it.each([
    ['AhmedElBanna80/knext', 'integration/v2'],
    ['AhmedElBanna80/knext', 'main'],
    ['getknext-dev/knext', 'integration/v2'],
  ])('accepts %s with a `# %s` comment', (repo, branch) => {
    expect(ownRepoShaPinBranch(`${repo}/${LANE}`, SHA, branch)).toBe(branch);
    expect(ownRepoShaPinBranch(`${repo}/${LANE}`, SHA, `${branch} extra words`)).toBe(branch);
  });
  it.each([
    ['a version tag comment', ACTION, SHA, 'v1.2.3'],
    ['no comment', ACTION, SHA, undefined],
    ['an unprotected branch comment', ACTION, SHA, 'feature/x'],
    ['a non-SHA ref', ACTION, 'integration/v2', 'integration/v2'],
    ['a short SHA', ACTION, 'abc1234', 'integration/v2'],
    ['a third-party action', `someone/else/${LANE}`, SHA, 'integration/v2'],
    ['a lookalike owner', `AhmedElBanna80x/knext/${LANE}`, SHA, 'integration/v2'],
    ['an own-repo composite action', 'AhmedElBanna80/knext/.github/actions/x', SHA, 'main'],
    ['path traversal', 'AhmedElBanna80/knext/.github/workflows/../x.yml', SHA, 'main'],
  ])('rejects %s', (_l, action, ref, comment) => {
    expect(ownRepoShaPinBranch(action, ref as string, comment)).toBeUndefined();
  });
});

const CALLED =
  'on:\n  workflow_call:\n    inputs:\n      rotation_realtime:\n        type: boolean\njobs: {}\n';
const roots: string[] = [];
afterAll(() => {
  for (const d of roots) rmSync(d, { recursive: true, force: true });
});
const repoWith = (uses: string) => {
  const root = mkdtempSync(join(tmpdir(), 'knext-own-repo-sha-'));
  roots.push(root);
  mkdirSync(join(root, '.github/workflows'), { recursive: true });
  writeFileSync(
    join(root, '.github/workflows/caller.yml'),
    ['jobs:', '  rotate:', `    uses: ${uses}`, '    with:', '      rotation_realtime: true'].join(
      '\n',
    ),
  );
  return root;
};
const run = (root: string, compare: { status: number; body: unknown }) =>
  verifyPins({
    repoRoot: root,
    api: async (path: string) => {
      if (path.includes('/contents/') && path.includes(`ref=${SHA}`)) {
        return {
          status: 200,
          body: { content: Buffer.from(CALLED).toString('base64'), encoding: 'base64' },
        };
      }
      if (path.includes(`/compare/${SHA}...integration/v2`)) return compare;
      return { status: 404, body: {} };
    },
    lsRemote: () => ({ kind: 'transport-error', message: 'unused' }),
  });
const pin = `${ACTION}@${SHA} # integration/v2`;

describe('nightly: own-repo SHA pin with a branch comment', () => {
  it('passes when the SHA is reachable from the named branch (ahead/identical)', async () => {
    for (const status of ['ahead', 'identical']) {
      expect(await run(repoWith(pin), { status: 200, body: { status } })).toEqual([]);
    }
  });
  it('fails when the SHA is NOT reachable from the branch (diverged/behind/404)', async () => {
    for (const compare of [
      { status: 200, body: { status: 'diverged' } },
      { status: 200, body: { status: 'behind' } },
      { status: 404, body: {} },
    ]) {
      const f = await run(repoWith(pin), compare);
      expect(f.map((x: { reason: string }) => x.reason)).toEqual(['branch-pin-sha-not-in-branch']);
    }
  });
  it('fails closed when the API errors', async () => {
    const f = await run(repoWith(pin), { status: 500, body: { message: 'boom' } });
    expect(f.map((x: { reason: string }) => x.reason)).toEqual(['branch-pin-api-error']);
  });
  it('still checks declared inputs at the pinned SHA', async () => {
    const root = repoWith(pin);
    writeFileSync(
      join(root, '.github/workflows/caller.yml'),
      `jobs:\n  r:\n    uses: ${pin}\n    with:\n      bogus: true\n`,
    );
    const f = await run(root, { status: 200, body: { status: 'ahead' } });
    expect(f.map((x: { reason: string }) => x.reason)).toEqual(['unknown-input']);
  });
  it('a non-own-repo SHA pin with a branch comment still needs a version tag', async () => {
    const f = await run(repoWith(`someone/else/${LANE}@${SHA} # integration/v2`), {
      status: 200,
      body: { status: 'ahead' },
    });
    expect(f.some((x: { reason: string }) => x.reason === 'no-version-comment')).toBe(true);
  });
});
