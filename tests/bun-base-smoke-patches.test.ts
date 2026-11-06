import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Every patch in infra/bun-base/patches/ carries a behaviour check in smoke-patches.sh, and the
 * bun-base-build workflow runs that script against the patched binary WITH the stock control.
 * A patch with no check would be built, signed and handed to a compat lane on the strength of
 * "it compiled" alone; a check run without the stock control cannot tell a fix from a no-op.
 */
const ROOT = resolve(import.meta.dirname, '..');
const DIR = resolve(ROOT, 'infra/bun-base');
const smoke = readFileSync(resolve(DIR, 'smoke-patches.sh'), 'utf8');
const workflow = readFileSync(resolve(ROOT, '.github/workflows/bun-base-build.yml'), 'utf8');
const patches = readdirSync(resolve(DIR, 'patches')).filter((f) => f.endsWith('.patch'));

/** `# ── <patch name without .patch> (` — the section header each patch's checks sit under. */
const sectionFor = (patch: string) => `# ── ${patch.replace(/\.patch$/, '')} (`;

/** The smoke step's `run:` block, located by its step name. */
function smokeStep(text: string): string {
  const start = text.indexOf('- name: Smoke-test the x64 binary (musl, in Alpine)');
  if (start === -1) return '';
  const next = text.indexOf('\n      - ', start + 1);
  return text.slice(start, next === -1 ? undefined : next);
}

describe('infra/bun-base per-patch smoke', () => {
  it('has a section in smoke-patches.sh for every patch', () => {
    const missing = patches.filter((p) => !smoke.includes(sectionFor(p)));
    expect(missing).toEqual([]);
  });

  it('has no section for a patch that is not there (a stale check reads as coverage)', () => {
    const sections = [...smoke.matchAll(/^# ── (\d{3}-[a-z0-9-]+) \(/gm)].map(
      (m) => `${m[1]}.patch`,
    );
    expect(sections.filter((s) => !patches.includes(s))).toEqual([]);
  });

  it('is run by the workflow smoke step against the patched binary AND the stock control', () => {
    const step = smokeStep(workflow);
    expect(step).toContain('sh /k/smoke-patches.sh /usr/local/bin/bun /stock/bun');
    // The control is pinned in the repo and cross-checked against the release's own sums.
    expect(step).toContain('infra/bun-base/smoke-pins.sha256" | sha256sum -c --strict -');
    expect(step).toContain('SHASUMS256.txt');
  });

  it('pins the stock control as exactly one sha256sum line', () => {
    const pins = readFileSync(resolve(DIR, 'smoke-pins.sha256'), 'utf8')
      .split('\n')
      .filter((l) => l.trim() !== '' && !l.startsWith('#'));
    expect(pins).toHaveLength(1);
    expect(pins[0]).toMatch(/^[0-9a-f]{64} {2}bun-linux-x64-musl\.zip$/);
  });

  it('fails the smoke when a control does not discriminate (both halves asserted)', () => {
    // Each fixed-on-patched check is paired with a broken-on-stock check.
    expect(smoke).toMatch(/\[ "\$p" = 0 \].*\|\| fail/);
    expect(smoke).toMatch(/\[ "\$s" = 1 \][\s\S]*?\|\| fail/);
    expect(smoke).toMatch(/\[ "\$cp" = 0 \].*\|\| fail/);
    expect(smoke).toMatch(/\[ "\$cs" = 1 \] \|\| fail/);
  });
});
