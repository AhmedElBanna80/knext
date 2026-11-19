import { describe, expect, it } from 'bun:test';
import {
  appendFileSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  unlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { parse } from 'yaml';
import { compareProbeFiles } from '../scripts/check-probe-sync.mjs';
import { PROBE_FILES } from '../scripts/record-allowlist-retirement-hash.mjs';

const ROOT = resolve(import.meta.dirname, '..');
function copyTree(): string {
  const dir = mkdtempSync(join(tmpdir(), 'probesync-'));
  for (const p of PROBE_FILES) {
    mkdirSync(dirname(join(dir, p)), { recursive: true });
    copyFileSync(resolve(ROOT, p), join(dir, p));
  }
  return dir;
}

describe('probe sync check (logic)', () => {
  it('identical copies pass', () => {
    const d = copyTree();
    expect(compareProbeFiles(ROOT, d)).toEqual([]);
    rmSync(d, { recursive: true });
  });
  it('names each diverging, missing or symlinked file', () => {
    for (const f of PROBE_FILES) {
      const d = copyTree();
      appendFileSync(join(d, f), '\n// x');
      const r = compareProbeFiles(ROOT, d);
      expect(r.length).toBe(1);
      expect(r[0]).toContain(f);
      unlinkSync(join(d, f));
      expect(compareProbeFiles(ROOT, d)[0]).toContain(`${f}: missing`);
      symlinkSync(resolve(ROOT, f), join(d, f));
      expect(compareProbeFiles(ROOT, d)[0]).toContain(`${f}: not a regular file`);
      rmSync(d, { recursive: true });
    }
  });
});

describe('probe sync check (nightly wiring)', () => {
  const wf = parse(
    readFileSync(resolve(ROOT, '.github/workflows/allowlist-retirement-nightly.yml'), 'utf8'),
  );
  const steps: Record<string, unknown>[] = wf.jobs['probe-allowlists'].steps;
  const idx = steps.findIndex((s) => String(s.run ?? '').includes('check-probe-sync.mjs'));
  it('runs the sync check from main, with target as data, before the probe', () => {
    expect(idx).toBeGreaterThan(-1);
    expect((steps[idx].env as Record<string, string>).PROBE_SYNC_TARGET).toBe('target');
    expect(String(steps[idx].run)).toMatch(/^node scripts\/check-probe-sync\.mjs\s*$/);
    const probe = steps.findIndex((s) =>
      String(s.run ?? '').includes('verify-allowlist-retirement.mjs'),
    );
    expect(idx).toBeLessThan(probe);
    expect(steps[idx]['continue-on-error']).toBeUndefined();
    expect(steps[idx].if).toBeUndefined();
  });
  it('executes nothing from target/', () => {
    for (const s of steps) expect(String(s.run ?? '')).not.toMatch(/target\//);
  });
});
