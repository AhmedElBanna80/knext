/**
 * `expires` is MANDATORY on every npm-audit allowlist entry: an entry with no
 * clock is accepted risk that never forces re-justification. Used by
 * `scripts/audit-published.mjs`.
 *
 * @param {{id: string, expires?: unknown}} e
 * @returns {void}
 */
export function assertAllowlistExpires(e) {
  if (typeof e.expires !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(e.expires)) {
    throw new Error(`allowlist entry ${e.id} needs an ISO \`expires\` date (it is required)`);
  }
}
