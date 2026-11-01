/**
 * stage-ffi-zone.sh stages apps/file-manager OUTSIDE the repository. The app's
 * next.config.ts pins `outputFileTracingRoot` / `turbopack.root` two directories
 * above itself (so it builds nested inside the bun workspace). Copied out of the
 * repo, those same two `..` land on the staging parent (`$RUNNER_TEMP`), which
 * knext reads as a deliberate monorepo root: the build context becomes that
 * parent and every app path in the image gains the app's directory as a prefix,
 * so `native/` lands in `.next/standalone/<dir>/native` while the lane (and the
 * runtime, beside the executable) look in `.next/standalone/native`.
 *
 * The staged fixture is a standalone app with no workspace around it, so it must
 * stay FLAT. Driven on the real script and the real layout resolver.
 */

import { afterAll, describe, expect, it } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { resolveStandaloneLayout } from '../packages/kn-next/src/cli/standalone-layout';

const REPO = resolve(import.meta.dirname, '..');
const SCRIPT = join(REPO, 'packages/ffi/scripts/stage-ffi-zone.sh');
const tmpDirs: string[] = [];
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

const stage = (): string => {
  const parent = mkdtempSync(join(tmpdir(), 'ffi-stage-'));
  tmpDirs.push(parent);
  const dest = join(parent, 'ffi-zone');
  mkdirSync(parent, { recursive: true });
  const r = spawnSync('bash', [SCRIPT, REPO, dest], { encoding: 'utf8' });
  expect(r.status, r.stderr).toBe(0);
  return dest;
};

describe('stage-ffi-zone.sh keeps the out-of-repo fixture a FLAT standalone app', () => {
  it('the staged next.config.ts names no tracing/turbopack root above the app', () => {
    const cfg = readFileSync(join(stage(), 'next.config.ts'), 'utf8');
    expect(cfg).not.toMatch(/outputFileTracingRoot/);
    expect(cfg).not.toMatch(/turbopack\s*:\s*\{\s*root/);
  });

  it('knext resolves the staged fixture as flat (native/ stays at .next/standalone/native)', () => {
    const layout = resolveStandaloneLayout(stage());
    expect(layout.nested).toBe(false);
    expect(layout.contextPrefix).toBe('');
  });
});
