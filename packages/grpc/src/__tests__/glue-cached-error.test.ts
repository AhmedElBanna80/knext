/**
 * A generated query calls its function inside a `'use cache'` function, where
 * Next.js replaces any thrown error with a generic one in production builds.
 * cacheableCall returns the function's ConnectError as a value instead, and
 * unwrapCached rethrows it outside the cache with its code and message.
 */
import { describe, expect, it } from 'bun:test';
import { Code, ConnectError } from '@connectrpc/connect';
import { cacheableCall, markNotSent, QUERY_ERROR_CACHE_LIFE, unwrapCached } from '../glue';

function recorder() {
  const lives: unknown[] = [];
  return { lives, cacheLife: (p: unknown) => void lives.push(p) };
}

describe('cacheableCall and unwrapCached', () => {
  it('a response passes through, and keeps the data cache life', async () => {
    const r = recorder();
    const out = await cacheableCall(async () => ({ value: 'v' }), r.cacheLife);
    expect(unwrapCached(out)).toEqual({ value: 'v' });
    expect(r.lives).toEqual([]);
  });

  it('a definitive answer (NotFound) comes back as a ConnectError with its code, cached like data', async () => {
    const r = recorder();
    const out = await cacheableCall(async () => {
      throw new ConnectError('no item a1', Code.NotFound);
    }, r.cacheLife);
    // A plain value: what the cache stores, and what survives a production build.
    expect(JSON.parse(JSON.stringify(out))).toEqual({
      error: { code: Code.NotFound, message: 'no item a1' },
    });
    expect(r.lives).toEqual([]);
    let thrown: unknown;
    try {
      unwrapCached(out);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(ConnectError);
    expect((thrown as ConnectError).code).toBe(Code.NotFound);
    expect((thrown as ConnectError).rawMessage).toBe('no item a1');
  });

  for (const code of [
    Code.Unavailable,
    Code.DeadlineExceeded,
    Code.ResourceExhausted,
    Code.Unknown,
  ]) {
    it(`a transient answer (${Code[code]}) is cached only briefly`, async () => {
      const r = recorder();
      const out = await cacheableCall(async () => {
        throw new ConnectError('try again', code);
      }, r.cacheLife);
      expect(r.lives).toEqual([QUERY_ERROR_CACHE_LIFE]);
      expect(() => unwrapCached(out)).toThrow('try again');
    });
  }

  for (const code of [
    Code.PermissionDenied,
    Code.InvalidArgument,
    Code.FailedPrecondition,
    Code.Unauthenticated,
  ]) {
    it(`${Code[code]} is a definitive answer: no short cache life`, async () => {
      const r = recorder();
      await cacheableCall(async () => {
        throw new ConnectError('no', code);
      }, r.cacheLife);
      expect(r.lives).toEqual([]);
    });
  }

  it('a refusal the zone raised before sending is kept briefly, whatever its code', async () => {
    // A missing service URL or signing key: fixed by the operator, not by the
    // function, so a 5-minute entry would outlive the fix.
    const r = recorder();
    const out = await cacheableCall(async () => {
      throw markNotSent(new ConnectError('ORDERS_SERVICE_URL is not set', Code.FailedPrecondition));
    }, r.cacheLife);
    expect(r.lives).toEqual([QUERY_ERROR_CACHE_LIFE]);
    expect(() => unwrapCached(out)).toThrow('ORDERS_SERVICE_URL is not set');
  });

  it("an error that is not a function's answer is thrown as before, and not turned into a value", async () => {
    const r = recorder();
    const bug = new TypeError('a bug in the zone');
    let thrown: unknown;
    try {
      await cacheableCall(async () => {
        throw bug;
      }, r.cacheLife);
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBe(bug);
    expect(r.lives).toEqual([]);
  });

  it('the error cache life is shorter than the data life, and valid (expire > revalidate)', () => {
    expect(QUERY_ERROR_CACHE_LIFE.expire).toBeGreaterThan(QUERY_ERROR_CACHE_LIFE.revalidate);
    expect(QUERY_ERROR_CACHE_LIFE.expire).toBeLessThan(60);
  });
});
