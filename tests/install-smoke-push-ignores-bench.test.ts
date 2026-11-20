import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { parse } from 'yaml';

/**
 * Measurement branches (`bench/**`) are pushed repeatedly by the cold-start
 * lanes; each push must NOT start an Install smoke run. GitHub forbids
 * `branches` and `branches-ignore` on the same event, so the push trigger
 * uses `branches-ignore` alone (which still matches every other branch).
 * pull_request / merge_group stay unfiltered (merge-queue-triggers.test.ts).
 */
const raw = readFileSync(
  resolve(import.meta.dirname, '..', '.github/workflows/install-smoke.yml'),
  'utf8',
);
const doc = parse(raw) as Record<string, unknown>;
const on = (doc.on ?? (doc as Record<string, unknown>)[true as unknown as string]) as Record<
  string,
  Record<string, unknown> | null
>;

describe('install-smoke push trigger', () => {
  const push = on.push as Record<string, unknown>;

  it('ignores bench/** pushes', () => {
    expect(push['branches-ignore']).toContain('bench/**');
  });

  it('does not combine branches with branches-ignore (invalid)', () => {
    expect('branches' in push).toBe(false);
  });

  it('still covers ordinary branches (nothing else is ignored)', () => {
    expect(push['branches-ignore']).toEqual(['bench/**']);
  });

  it('keeps pull_request and merge_group unfiltered', () => {
    expect(on.pull_request ?? null).toBeNull();
    expect(on.merge_group ?? null).toBeNull();
  });
});
