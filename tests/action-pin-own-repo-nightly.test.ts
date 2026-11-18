/**
 * The nightly resolver's own-repo reusable-workflow call site, end to end with a
 * stubbed API. An exempted call skips ONLY the SHA/tag resolution; the declared-
 * input check still runs, against the called file read at the branch ref.
 */
import { afterAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyPins } from '../scripts/verify-action-pins.mjs';

const CALLED =
  'on:\n  workflow_call:\n    inputs:\n      rotation_realtime:\n        type: boolean\njobs: {}\n';
const contentsOk = (text: string) => ({
  status: 200,
  body: { content: Buffer.from(text, 'utf8').toString('base64'), encoding: 'base64' },
});

const roots: string[] = [];
afterAll(() => {
  for (const d of roots) rmSync(d, { recursive: true, force: true });
});

const repoWith = (uses: string, withKey = 'rotation_realtime') => {
  const root = mkdtempSync(join(tmpdir(), 'knext-own-repo-nightly-'));
  roots.push(root);
  mkdirSync(join(root, '.github/workflows'), { recursive: true });
  writeFileSync(
    join(root, '.github/workflows/caller.yml'),
    ['jobs:', '  rotate:', `    uses: ${uses}`, '    with:', `      ${withKey}: true`].join('\n'),
  );
  return root;
};

const run = async (root: string, paths: string[] = []) =>
  verifyPins({
    repoRoot: root,
    api: async (path: string) => {
      paths.push(path);
      if (path.includes('/contents/.github/workflows/lane.yml?ref=integration/v2')) {
        return contentsOk(CALLED);
      }
      return { status: 404, body: {} };
    },
    lsRemote: () => ({ kind: 'transport-error', message: 'unused' }),
  });

const LANE = '.github/workflows/lane.yml';

describe('nightly: own-repo reusable-workflow call site', () => {
  it('passes an exempted own-repo call with no SHA, reading inputs at the branch ref', async () => {
    const paths: string[] = [];
    const findings = await run(repoWith(`AhmedElBanna80/knext/${LANE}@integration/v2`), paths);
    expect(findings).toEqual([]);
    expect(paths.some((p) => p.includes('contents/') && p.endsWith('?ref=integration/v2'))).toBe(
      true,
    );
    // No SHA/tag resolution was attempted for the exempted call.
    expect(paths.some((p) => p.includes('/git/ref/tags/'))).toBe(false);
  });

  it('fails a lookalike owner (not exempt, so not SHA pinned)', async () => {
    const findings = await run(repoWith(`AhmedElBanna80x/knext/${LANE}@integration/v2`));
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.some((f: { reason: string }) => f.reason === 'not-sha-pinned')).toBe(true);
  });

  it('fails an own-repo call on an unprotected ref (owner alone is not enough)', async () => {
    const findings = await run(repoWith(`AhmedElBanna80/knext/${LANE}@v1`));
    expect(findings.some((f: { reason: string }) => f.reason === 'not-sha-pinned')).toBe(true);
  });

  it('fails an own-repo call that passes an undeclared input', async () => {
    const findings = await run(
      repoWith(`AhmedElBanna80/knext/${LANE}@integration/v2`, 'bogus_input'),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0].reason).toBe('unknown-input');
    expect(findings[0].inputKey).toBe('bogus_input');
  });
});
