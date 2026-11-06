/**
 * The zone-functions quickstart is the entry page for a Beta feature. Pin the
 * two security statements a reader must not lose, the Beta marking, and the
 * absence of any invented cold-chain figure.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const DOCS = resolve(import.meta.dirname, 'content/docs');
const text = readFileSync(resolve(DOCS, 'zone-functions-quickstart.mdx'), 'utf8').replace(
  /\s*\n\s*/g,
  ' ',
);

describe('zone-functions quickstart', () => {
  it('states the flannel caveat for NetworkPolicy', () => {
    expect(text).toContain('flannel');
    expect(text).toContain('does not enforce NetworkPolicy');
    expect(text).toContain('defense in depth');
    expect(text).toContain('The token is the authoritative control.');
  });

  it('states the 60 second replay window', () => {
    expect(text).toContain('expires 60 seconds after it is minted');
    expect(text).toContain('replayed once to a different replica');
  });

  it('is marked Beta and v2 only', () => {
    expect(text).toContain('Beta, v2 only.');
  });

  it('states the rollout order and that there is no public write', () => {
    expect(text).toContain('function before zone');
    expect(text).toContain('There is no public write.');
    expect(text).not.toContain('PUBLIC_MUTATION');
  });

  it('says cold-chain numbers are not published and gives no figure', () => {
    const section = text.split('## Cold-chain numbers')[1] ?? '';
    expect(section).toContain('Cold-chain numbers are not yet published.');
    expect(section).not.toMatch(/\d/);
  });

  it('is in the navigation', () => {
    const meta = readFileSync(resolve(DOCS, 'meta.json'), 'utf8');
    expect(meta).toContain('"zone-functions-quickstart"');
  });
});
