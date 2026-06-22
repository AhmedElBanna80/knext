/**
 * #94 RUM ingest — security layer 4: a tiny in-process token-bucket limiter.
 *
 * The ingest route is a same-origin, cluster-local beacon sink, but it still
 * mutates metric state, so it must be bounded. This limiter:
 *   - caps request rate per key (a bucket refills over time),
 *   - bounds the bucket MAP itself (maxKeys) so a flood of distinct keys can't
 *     grow memory unbounded — oldest keys are evicted (FIFO).
 *
 * Pure / injectable clock so it is deterministically testable.
 */

interface Bucket {
  tokens: number;
  last: number; // ms timestamp of last refill
}

export interface TokenBucketOptions {
  capacity: number; // max tokens (burst)
  refillPerSecond: number; // tokens added per second
  maxKeys: number; // bound on number of tracked buckets
  now?: () => number; // injectable clock (ms)
}

export interface TokenBucketLimiter {
  allow(key: string): boolean;
  size(): number;
}

export function createTokenBucketLimiter(opts: TokenBucketOptions): TokenBucketLimiter {
  const { capacity, refillPerSecond, maxKeys } = opts;
  const now = opts.now ?? Date.now;
  // Map preserves insertion order → cheap FIFO eviction of the oldest key.
  const buckets = new Map<string, Bucket>();

  function allow(key: string): boolean {
    const t = now();
    let bucket = buckets.get(key);

    if (!bucket) {
      // Evict oldest entries until we are under the cap, then insert.
      while (buckets.size >= maxKeys) {
        const oldest = buckets.keys().next().value;
        if (oldest === undefined) break;
        buckets.delete(oldest);
      }
      bucket = { tokens: capacity, last: t };
      buckets.set(key, bucket);
    } else {
      // Refill based on elapsed time.
      const elapsedSec = (t - bucket.last) / 1000;
      if (elapsedSec > 0 && refillPerSecond > 0) {
        bucket.tokens = Math.min(capacity, bucket.tokens + elapsedSec * refillPerSecond);
        bucket.last = t;
      } else if (elapsedSec > 0) {
        bucket.last = t;
      }
    }

    if (bucket.tokens >= 1) {
      bucket.tokens -= 1;
      return true;
    }
    return false;
  }

  return {
    allow,
    size: () => buckets.size,
  };
}
