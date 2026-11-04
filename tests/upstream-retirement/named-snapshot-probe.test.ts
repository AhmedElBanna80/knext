/**
 * The `bun-esm-builtin-named-snapshot` probe must be able to go red. Node's
 * `module.syncBuiltinESMExports()` updates a static named binding of a patched
 * builtin; Bun 1.4.2's does nothing. Running the SAME fixture under both shows the
 * verdict flips with the runtime's behaviour, not with an artefact of the fixture.
 */
import { describe, expect, it } from 'bun:test';
import { bunOnPath, sandbox } from './probe-kit';
import { NAMED_SNAPSHOT_FIXTURE, namedSnapshotVerdict } from './registry';

function run(cmd: string): string {
  const box = sandbox('named-snapshot-flip');
  try {
    box.write({ 'main.mjs': NAMED_SNAPSHOT_FIXTURE });
    return box.run([cmd, 'main.mjs'], box.dir).result;
  } finally {
    box.dispose();
  }
}

describe('bun-esm-builtin-named-snapshot probe', () => {
  it('under Node the named binding follows the sync, so the verdict is "not still broken"', () => {
    const node = Bun.which('node');
    expect(node, 'node must be on PATH for the flip proof').not.toBeNull();
    const verdict = namedSnapshotVerdict(run(node as string));
    expect(verdict.conclusive).toBe(true);
    expect(verdict.stillBroken).toBe(false);
    expect(verdict.evidence).toContain('→ patched');
  });

  it('under the pinned Bun it is still broken (the shim is needed)', () => {
    const verdict = namedSnapshotVerdict(run(bunOnPath()));
    expect(verdict.conclusive).toBe(true);
    expect(verdict.stillBroken).toBe(true);
  });

  it('a runtime whose sync throws, or whose default export is not patched, is inconclusive rather than a verdict', () => {
    expect(
      namedSnapshotVerdict(JSON.stringify({ control: 'x', named: 'x', syncError: null }))
        .conclusive,
    ).toBe(false);
    expect(
      namedSnapshotVerdict(JSON.stringify({ control: 'patched', named: 'x', syncError: 'boom' }))
        .conclusive,
    ).toBe(false);
  });
});
