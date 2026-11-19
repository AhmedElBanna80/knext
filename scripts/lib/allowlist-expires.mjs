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

/** The ONLY keys an npm-audit allowlist entry may carry; the `$schema-note` and its invariant test read this. */
export const NPM_ALLOWLIST_KEYS = new Set(['id', 'justification', 'added', 'expires']);

/**
 * Reject an entry carrying a key outside NPM_ALLOWLIST_KEYS: a misspelled
 * `expires` would otherwise be ignored and the entry would never expire.
 *
 * @param {{id: string}} e
 * @returns {void}
 */
export function assertNpmAllowlistKeys(e) {
  const unknown = Object.keys(e).filter((k) => !NPM_ALLOWLIST_KEYS.has(k));
  if (unknown.length > 0) {
    throw new Error(
      `allowlist entry ${e.id} has unknown key(s) ${unknown.join(', ')}; allowed: [${[...NPM_ALLOWLIST_KEYS].join(', ')}]`,
    );
  }
}
