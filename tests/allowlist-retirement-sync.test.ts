import { describe, expect, it } from 'bun:test';
import {
  appendFileSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { HASH_FILE, PROBE_FILES, probeHash } from '../scripts/record-allowlist-retirement-hash.mjs';

const ROOT = resolve(import.meta.dirname, '..');

/**
 * The retirement probe exists on main AND integration/v2 and must be ONE program.
 * CI cannot reach the other branch offline, so both branches carry the same
 * recorded content hash of the probe (lib + CLI) and each asserts its own copy
 * matches it. Editing the probe on either branch reds this test until the hash is
 * re-recorded (`node scripts/record-allowlist-retirement-hash.mjs`); committing the
 * same hash file on the other branch is the human half, and a mismatch then shows
 * up as soon as the branches merge.
 */
describe('allowlist retirement probe: one program on both branches', () => {
  it('the probe files match the recorded hash', () => {
    const recorded = readFileSync(resolve(ROOT, HASH_FILE), 'utf8').trim();
    expect(recorded).toMatch(/^[0-9a-f]{64}$/);
    expect(
      probeHash(ROOT),
      `the probe changed: re-run \`node scripts/record-allowlist-retirement-hash.mjs\` and apply the SAME change + hash on the other branch (${PROBE_FILES.join(', ')})`,
    ).toBe(recorded);
  });

  it('a one-byte change to either probe file changes the hash', () => {
    for (const f of PROBE_FILES) {
      const dir = mkdtempSync(join(tmpdir(), 'probe-'));
      for (const p of PROBE_FILES) {
        mkdirSync(dirname(join(dir, p)), { recursive: true });
        copyFileSync(resolve(ROOT, p), join(dir, p));
      }
      expect(probeHash(dir)).toBe(probeHash(ROOT));
      appendFileSync(join(dir, f), ' ');
      expect(probeHash(dir)).not.toBe(probeHash(ROOT));
      rmSync(dir, { recursive: true });
    }
  });
});
