/**
 * The generator step of .github/workflows/rust-crates.yml must build the
 * `knext ffi init` crate without contacting the knext remote, while the crate
 * the user gets keeps its git + rev dependency. Both halves are asserted.
 */

import { describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  assertRevOnBase,
  localCrateSourceEnv,
} from '../../../../crates/harness/local-crates-source';
import { CRATE_GIT, recordedCrateRev, runInit } from '../init';

const ROOT = resolve(import.meta.dir, '..', '..', '..', '..');
const WORKFLOW = readFileSync(join(ROOT, '.github', 'workflows', 'rust-crates.yml'), 'utf8');
const HARNESS = readFileSync(join(ROOT, 'crates', 'harness', 'ffi-generated.ts'), 'utf8');

/** The workflow step whose name starts with "Generator — knext ffi init". */
function initStep(): string {
  const start = WORKFLOW.indexOf('      - name: Generator — knext ffi init');
  expect(start).toBeGreaterThan(-1);
  const next = WORKFLOW.indexOf('\n      - name:', start + 1);
  const end = next === -1 ? WORKFLOW.indexOf('\n  # ', start) : next;
  return WORKFLOW.slice(start, end);
}

describe('rust-crates generator step is independent of the restricted remote', () => {
  it('serves the knext crates from the checkout (the step sets KNEXT_FFI_LOCAL_REPO)', () => {
    expect(initStep()).toMatch(/KNEXT_FFI_LOCAL_REPO:\s*\$\{\{\s*github\.workspace\s*\}\}/);
  });

  it('the local-source env appears ONLY on that step (no workflow- or job-level env)', () => {
    const step = initStep();
    const rest = WORKFLOW.replace(step, '');
    expect(rest).not.toMatch(/KNEXT_FFI_LOCAL/);
    expect(rest).not.toMatch(/GIT_CONFIG_/);
    expect(step).toMatch(/KNEXT_FFI_LOCAL_BASE_REF:/);
  });

  it('requires the recorded rev to be merged (ancestor of the base) before rewriting', () => {
    expect(HARNESS).toMatch(/assertRevOnBase\(/);
    expect(HARNESS.indexOf('assertRevOnBase(')).toBeLessThan(
      HARNESS.indexOf('localCrateSourceEnv(localRepo'),
    );
  });

  it('assertRevOnBase fails closed on unmerged, malformed and unresolvable input', () => {
    const repo = mkdtempSync(join(tmpdir(), 'knext-ci-anc-'));
    try {
      const g = (...a: string[]) =>
        execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@t', ...a], {
          encoding: 'utf8',
        }).trim();
      g('init', '-q', '-b', 'main');
      g('commit', '-q', '--allow-empty', '-m', 'a');
      const merged = g('rev-parse', 'HEAD');
      g('checkout', '-q', '-b', 'pr');
      g('commit', '-q', '--allow-empty', '-m', 'b');
      const unmerged = g('rev-parse', 'HEAD');
      expect(() => assertRevOnBase(repo, merged, 'main')).not.toThrow();
      expect(() => assertRevOnBase(repo, unmerged, 'main')).toThrow(/not an ancestor/);
      expect(() => assertRevOnBase(repo, merged, undefined)).toThrow(/unset/);
      expect(() => assertRevOnBase(repo, merged, 'nope')).toThrow(/does not resolve/);
      expect(() => assertRevOnBase(repo, 'abc', 'main')).toThrow(/40-hex/);
    } finally {
      rmSync(repo, { recursive: true, force: true });
    }
  });

  it('checks out full history so the recorded revision exists in the clone', () => {
    const job = WORKFLOW.slice(WORKFLOW.indexOf('  crates:\n    name: knext-ffi crates (fmt'));
    const checkout = job.slice(
      job.indexOf('actions/checkout'),
      job.indexOf('Install the pinned Rust'),
    );
    expect(checkout).toMatch(/fetch-depth:\s*0/);
  });

  it('the harness applies the local source only from that variable, never a [patch]', () => {
    expect(HARNESS).toMatch(/process\.env\.KNEXT_FFI_LOCAL_REPO/);
    expect(HARNESS).toMatch(/localCrateSourceEnv\(/);
    expect(HARNESS).not.toMatch(/\[patch/);
  });

  it('rewrites exactly the user-facing git URL to the local clone, via the git CLI', () => {
    const env = localCrateSourceEnv('/work/knext', CRATE_GIT);
    expect(env.GIT_CONFIG_KEY_0).toBe('url.file:///work/knext.insteadOf');
    expect(env.GIT_CONFIG_VALUE_0).toBe(CRATE_GIT);
    expect(env.GIT_CONFIG_COUNT).toBe('1');
    expect(env.CARGO_NET_GIT_FETCH_WITH_CLI).toBe('true');
  });

  it('the generated Cargo.toml still uses the git source at the recorded revision', () => {
    const dir = mkdtempSync(join(tmpdir(), 'knext-ci-local-'));
    try {
      const io = { stdout: () => {}, stderr: () => {} };
      expect(runInit({ cwd: dir, io })).toBe(0);
      const toml = readFileSync(join(dir, 'rust', 'Cargo.toml'), 'utf8');
      expect(toml).toContain(`knext-ffi = { git = "${CRATE_GIT}", rev = "${recordedCrateRev()}" }`);
      expect(toml).not.toMatch(/path\s*=|\[patch/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
