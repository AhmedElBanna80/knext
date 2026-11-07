/**
 * The oven-sh/bun#45007 retirement probe (#2805, ADR-0072 action item 4).
 *
 * Bun 1.4.2 rejects an assignment to a `const` at LOAD time, even in code that
 * never runs; Node defers it to a runtime TypeError. knext carries a Bun
 * refusal (`turbopack-fragments-guard.ts` + its doctor row) and two compat
 * ledger entries for it. This probe is what turns red on its own when a stock
 * Bun first ships the fix (oven-sh/bun#45010), and its red names everything
 * that has to go in that one change.
 *
 * Every verdict is read from EXIT CODES, never from output.
 */
import { describe, expect, it } from 'bun:test';
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MARKER_ROOTS, scanMarkers } from './marker-scan';
import { bunOnPath, REPO_ROOT } from './probe-kit';
import {
  CONST_ASSIGN_EXIT,
  CONST_ASSIGN_RETIRE,
  constAssignProbe,
  constAssignVerdict,
  REGISTRY,
  upstreamFixedMessage,
} from './registry';

const ID = 'bun-45007-const-assign';
const TIMEOUT = 60_000;
const entry = () => {
  const e = REGISTRY.find((x) => x.id === ID);
  if (!e) throw new Error(`no ${ID} registry entry`);
  return e;
};
const nodeOnPath = () => {
  const node = Bun.which('node');
  if (!node) throw new Error('no `node` on PATH');
  return node;
};

describe('bun-45007-const-assign: the registry entry', () => {
  it('is registered against the stock Bun, citing the issue and its fix', () => {
    const e = entry();
    expect(e.upstream).toBe('oven-sh/bun#45007');
    expect(e.fixedBy?.ref).toBe('oven-sh/bun#45010');
    expect(e.against).toBe('bun');
    expect(e.issue).toBe('#2805');
  });
});

describe('bun-45007-const-assign: the verdict (exit codes only)', () => {
  const { OK, TYPE_ERROR, OTHER_ERROR } = CONST_ASSIGN_EXIT;

  it('fixed only when the repro loads AND the executed assignment throws a TypeError', () => {
    expect(constAssignVerdict({ load: 0, assign: TYPE_ERROR }).stillBroken).toBe(false);
  });

  it('a load-time failure is still broken (Bun 1.4.2 today)', () => {
    expect(constAssignVerdict({ load: 1, assign: OTHER_ERROR }).stillBroken).toBe(true);
  });

  it('a Bun that silently ignores the assignment is NOT fixed', () => {
    expect(constAssignVerdict({ load: 0, assign: OK }).stillBroken).toBe(true);
  });

  it('loading but throwing something other than a TypeError is NOT fixed', () => {
    expect(constAssignVerdict({ load: 0, assign: OTHER_ERROR }).stillBroken).toBe(true);
  });

  it('a TypeError without a clean load is NOT fixed', () => {
    expect(constAssignVerdict({ load: 1, assign: TYPE_ERROR }).stillBroken).toBe(true);
  });

  it('an exit code outside the harness contract is inconclusive, never a verdict', () => {
    expect(() => constAssignVerdict({ load: null, assign: TYPE_ERROR })).toThrow(/inconclusive/);
    expect(() => constAssignVerdict({ load: 0, assign: 99 })).toThrow(/inconclusive/);
    expect(() => constAssignVerdict({ load: 0, assign: null })).toThrow(/inconclusive/);
  });

  it('a load exit outside {0, 1} (a crash, e.g. 139) is inconclusive, not "still broken"', () => {
    expect(() => constAssignVerdict({ load: 139, assign: OTHER_ERROR })).toThrow(/inconclusive/);
    expect(() => constAssignVerdict({ load: 2, assign: OTHER_ERROR })).toThrow(/inconclusive/);
  });
});

describe('bun-45007-const-assign: the live probe', () => {
  it(
    'reports still broken on the stock Bun on PATH',
    async () => {
      const probe = await entry().repro();
      expect(probe.stillBroken).toBe(true);
    },
    TIMEOUT,
  );

  it(
    'the same oracle reads Node (runtime TypeError, never a load error) as fixed — the probe can flip',
    () => {
      const probe = constAssignProbe({ subject: nodeOnPath(), control: nodeOnPath() });
      expect(probe.stillBroken).toBe(false);
    },
    TIMEOUT,
  );

  it(
    'a control runtime that does not show the fixed behaviour makes the probe inconclusive',
    () => {
      expect(() => constAssignProbe({ subject: bunOnPath(), control: bunOnPath() })).toThrow(
        /inconclusive/,
      );
    },
    TIMEOUT,
  );

  it(
    'a subject whose harness cannot import a clean module is inconclusive, not "still broken"',
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'knext-45007-fake-'));
      try {
        const fake = join(dir, 'fake-runtime');
        // Looks exactly like Bun 1.4.2 on the repro (load 1, harness 43), so only
        // the harness check can tell it apart: a clean module also fails.
        writeFileSync(
          fake,
          `#!/bin/sh\ncase "$1" in repro.js) exit 1 ;; *) exit ${CONST_ASSIGN_EXIT.OTHER_ERROR} ;; esac\n`,
        );
        chmodSync(fake, 0o755);
        expect(() => constAssignProbe({ subject: fake, control: nodeOnPath() })).toThrow(
          /inconclusive/,
        );
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
    TIMEOUT,
  );
});

describe('bun-45007-const-assign: the red names everything to delete in one change', () => {
  const MANIFEST = 'test/deploy-tests-manifest.knext.json';

  it('the upstream-fixed message names the guard, its doctor row and both ledger entries', () => {
    const msg = upstreamFixedMessage(entry(), { stillBroken: false, evidence: 'e' });
    for (const item of [
      'packages/kn-next/src/cli/turbopack-fragments-guard.ts',
      'packages/kn-next/src/cli/doctor/checks/turbopack-fragments.ts',
      MANIFEST,
      '$knextUpstreamRuntimeDefects',
      'test/e2e/app-dir/treeshake-mw/mw.test.ts',
      'test/e2e/app-dir/turbopack-tree-shaking-chunkgroup/turbopack-tree-shaking-chunkgroup.test.ts',
    ]) {
      expect(msg).toContain(item);
    }
  });

  it('what it names exists: both files, and exactly the two #45007 ledger entries', () => {
    expect(existsSync(join(REPO_ROOT, CONST_ASSIGN_RETIRE.guard))).toBe(true);
    expect(existsSync(join(REPO_ROOT, CONST_ASSIGN_RETIRE.doctorRow))).toBe(true);
    const manifest = JSON.parse(readFileSync(join(REPO_ROOT, MANIFEST), 'utf8'));
    const ledger = (manifest.$knextUpstreamRuntimeDefects ?? []) as {
      test: string;
      upstream?: { issue?: string };
    }[];
    const tests = ledger
      .filter((d) => d.upstream?.issue === 'oven-sh/bun#45007')
      .map((d) => d.test);
    expect(tests.sort()).toEqual([...CONST_ASSIGN_RETIRE.ledgerTests].sort());
    expect(tests).toHaveLength(2);
  });

  it('the guard carries the shim marker, inside a scanned root', () => {
    expect(MARKER_ROOTS).toContain('packages/kn-next/src/cli');
    const hits = MARKER_ROOTS.flatMap((root) =>
      scanMarkers(join(REPO_ROOT, root), REPO_ROOT).markers.filter((m) => m.id === ID),
    );
    expect(hits.map((m) => m.file)).toEqual([CONST_ASSIGN_RETIRE.guard]);
  });
});
