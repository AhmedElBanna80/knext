/**
 * The Rust crates lane's wrapper harness shows its four loader controls go red by weakening the
 * rendered loader in memory (crates/harness/loader-weakenings.ts, ffi-generated-red.ts). The weakening
 * needs the loader's text to still hold its anchor exactly once; this is where a change to the loader
 * that moves one is found, instead of first in the lane (which needs cargo and root).
 */

import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { failedControls, judge, WEAKENINGS, weaken } from '../crates/harness/loader-weakenings';
import { blob, KITCHEN_SINK } from '../packages/ffi/src/__tests__/helpers';
import { scanManifest } from '../packages/ffi/src/manifest';
import { renderModule } from '../packages/ffi/src/render';

const ROOT = resolve(import.meta.dir, '..');
const loader = renderModule(scanManifest(blob(KITCHEN_SINK)), {
  libName: 'fixture',
  crate: 'rust',
});

describe('the weakenings the harness red check applies to the rendered loader', () => {
  for (const [id, w] of Object.entries(WEAKENINGS)) {
    it(`${id} (${w.claim}): its anchor occurs exactly once, and the weakened text differs`, () => {
      expect(loader.split(w.anchor).length - 1).toBe(1);
      const weakened = weaken(loader, id);
      expect(weakened).not.toBe(loader);
      expect(weakened).toContain(w.replacement);
      expect(weakened).not.toContain(w.anchor);
    });
  }

  it('a weakening whose anchor is not found, or is found twice, is refused, never applied as a no-op', () => {
    expect(() => weaken('nothing here', 'W01')).toThrow('does not occur exactly once');
    const w = WEAKENINGS.W01 as { anchor: string };
    expect(() => weaken(`${w.anchor}${w.anchor}`, 'W01')).toThrow('does not occur exactly once');
    expect(() => weaken(loader, 'W99')).toThrow('names no weakening');
  });
});

describe('the verdict on a weakened harness run', () => {
  const FAIL = (n: number) => `ffi-generated: FAIL: control ${n}: something\n  expected x\n`;

  it('reads the controls a run failed from its own labels, once each, sorted', () => {
    expect(
      failedControls(`${FAIL(4)}${FAIL(1)}${FAIL(1)}ffi-generated: 3 check(s) failed\n`),
    ).toEqual({ controls: [1, 4], unlabelled: 0 });
    expect(failedControls('ffi-generated: FAIL: the child process failed\n')).toEqual({
      controls: [],
      unlabelled: 1,
    });
  });

  it('accepts exactly the controls each weakening lists, with exit code 1', () => {
    expect(judge('W01', 1, FAIL(1) + FAIL(3) + FAIL(4))).toEqual([]);
    expect(judge('W02', 1, FAIL(4))).toEqual([]);
    expect(judge('W03', 1, FAIL(2))).toEqual([]);
    expect(judge('W04', 1, FAIL(1))).toEqual([]);
  });

  it('refuses a run that exited 0 (the weakened loader passed), or 10 (it could not run), or any other code', () => {
    expect(judge('W02', 0, '')[0]).toContain('passed every control');
    expect(judge('W02', 10, FAIL(4))[0]).toContain('could not run');
    expect(judge('W02', null, FAIL(4))[0]).toContain('could not run');
  });

  it('refuses a control that did not go red, an extra one, and a failure without a label', () => {
    expect(judge('W01', 1, FAIL(1) + FAIL(4))[0]).toContain('[1,4] went red');
    expect(judge('W02', 1, FAIL(4) + FAIL(2))[0]).toContain('[2,4] went red');
    expect(judge('W03', 1, FAIL(2) + FAIL(3))[0]).toContain('[2,3] went red');
    expect(judge('W03', 1, FAIL(1))[0]).toContain('[1] went red');
    expect(judge('W04', 1, `${FAIL(1)}ffi-generated: FAIL: calls\n`)[0]).toContain(
      'no control label',
    );
    expect(judge('W99', 1, '')[0]).toContain('no such weakening');
  });

  it('the harness labels every control check, so a red run can be attributed', () => {
    const text = readFileSync(resolve(ROOT, 'crates/harness/ffi-generated.ts'), 'utf8');
    for (const n of [1, 2, 3, 4]) {
      expect(text, `control ${n} has no labelled check`).toContain(`control ${n}:`);
    }
  });
});
