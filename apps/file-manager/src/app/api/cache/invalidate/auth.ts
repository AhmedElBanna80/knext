import { timingSafeEqual } from 'node:crypto';

/**
 * Bearer-token authorization for the cache-invalidation endpoint (B1, security.md:
 * "No unauthenticated mutating endpoints").
 *
 * - **Fail-closed:** if no token is configured (`CACHE_INVALIDATE_TOKEN` unset/empty),
 *   NOTHING is authorized — an unconfigured deployment rejects all invalidations rather
 *   than leaving the endpoint open.
 * - **Constant-time** comparison (`timingSafeEqual`) so the token can't be recovered via
 *   response-timing. Length is checked first (timingSafeEqual requires equal-length buffers);
 *   a length mismatch is an immediate reject, which does not leak the secret.
 *
 * The token is provisioned via a K8s Secret → `CACHE_INVALIDATE_TOKEN` env var; never hardcoded.
 */
export function isAuthorized(
  authHeader: string | null | undefined,
  expectedToken: string | undefined,
): boolean {
  if (!expectedToken) {
    return false; // fail closed: unconfigured = deny all
  }
  if (!authHeader) {
    return false;
  }
  const prefix = 'Bearer ';
  if (!authHeader.startsWith(prefix)) {
    return false;
  }
  const provided = Buffer.from(authHeader.slice(prefix.length));
  const expected = Buffer.from(expectedToken);
  if (provided.length !== expected.length) {
    return false;
  }
  return timingSafeEqual(provided, expected);
}
