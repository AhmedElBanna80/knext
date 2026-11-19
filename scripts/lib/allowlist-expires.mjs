import { parseStrictIsoDate } from './strict-date.mjs';

/**
 * `expires` is MANDATORY on every npm-audit allowlist entry and must be a REAL
 * calendar date (see strict-date.mjs): an entry with no clock, or a clock that
 * never fires, is accepted risk that never forces re-justification. Used by
 * `scripts/audit-published.mjs`.
 *
 * @param {{id: string, expires?: unknown}} e
 * @returns {void}
 */
export function assertAllowlistExpires(e) {
  if (parseStrictIsoDate(e.expires) === null) {
    throw new Error(
      `allowlist entry ${e.id} needs a real YYYY-MM-DD \`expires\` date (it is required)`,
    );
  }
}
