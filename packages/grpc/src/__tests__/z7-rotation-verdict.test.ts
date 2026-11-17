import { describe, expect, it } from 'bun:test';
import { type StaleKeyProbe, staleKeyVerdict } from '../../e2e/z7-identity-kind/rotation-verdict';

const R = (phase: 'pre' | 'post'): StaleKeyProbe => ({
  phase,
  status: 401,
  code: 'unauthenticated',
});
const OK: StaleKeyProbe = { phase: 'post', status: 200, code: '' };

describe('the real-time rotation property (c): refused until the JWKS propagates', () => {
  it('holds with a pre-publish refusal, post-publish refusals, then acceptance', () => {
    expect(staleKeyVerdict([R('pre'), R('post'), R('post'), OK])).toEqual({
      ok: true,
      postRefusals: 2,
    });
  });

  it('fails when the first probe after the publish is already accepted, whatever came before', () => {
    const v = staleKeyVerdict([R('pre'), OK]);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toContain('first probe after the publish');
  });

  it('fails when no probe was sent after the publish', () => {
    expect(staleKeyVerdict([R('pre')]).ok).toBe(false);
  });

  it('fails when the staged key is never accepted', () => {
    const v = staleKeyVerdict([R('pre'), R('post'), R('post')]);
    expect(v.ok).toBe(false);
    if (!v.ok) expect(v.reason).toContain('never accepted');
  });

  it('fails when a refusal is not unauthenticated', () => {
    const v = staleKeyVerdict([
      R('pre'),
      { phase: 'post', status: 401, code: 'permission_denied' },
      OK,
    ]);
    expect(v.ok).toBe(false);
  });

  it('fails when a refusal is a different status', () => {
    expect(
      staleKeyVerdict([R('pre'), { phase: 'post', status: 500, code: 'unauthenticated' }, OK]).ok,
    ).toBe(false);
  });

  it('fails when the probe before the publish was not refused', () => {
    expect(staleKeyVerdict([{ phase: 'pre', status: 200, code: '' }, R('post'), OK]).ok).toBe(
      false,
    );
  });

  it('fails on an unanswered probe (null status)', () => {
    expect(staleKeyVerdict([R('pre'), { phase: 'post', status: null, code: '' }, OK]).ok).toBe(
      false,
    );
  });

  it('fails when probes continue after the acceptance', () => {
    expect(staleKeyVerdict([R('pre'), R('post'), OK, R('post')]).ok).toBe(false);
  });
});
