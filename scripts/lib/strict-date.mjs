/**
 * ONE strict parser for the calendar dates that govern allowlist expiry.
 *
 * `^\d{4}-\d{2}-\d{2}$` alone accepts `2026-13-45`, which parses to an Invalid
 * Date; every `Invalid Date <= now` is false, so such an entry would suppress an
 * advisory FOREVER. A lexical string compare has the mirror hole: `9999-99-99`
 * sorts after every real date. So a date is accepted only if it is a string in
 * `YYYY-MM-DD` form, `Date.parse` is finite, AND it round-trips to the same
 * string (which rejects `2026-02-30`, a day JS silently rolls into March).
 */

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** @param {unknown} value @returns {number | null} UTC midnight in ms, or null when not a real date */
export function parseStrictIsoDate(value) {
  if (typeof value !== 'string' || !ISO_DATE.test(value)) return null;
  const ms = Date.parse(`${value}T00:00:00Z`);
  if (!Number.isFinite(ms)) return null;
  if (new Date(ms).toISOString().slice(0, 10) !== value) return null;
  return ms;
}

/** @returns {number} ms; THROWS `<label> needs a real YYYY-MM-DD date` otherwise */
export function requireStrictIsoDate(value, label) {
  const ms = parseStrictIsoDate(value);
  if (ms === null) {
    throw new Error(
      `${label} needs a real YYYY-MM-DD calendar date (got ${JSON.stringify(value)})`,
    );
  }
  return ms;
}

/** Is `expires` strictly before `today` (an ISO date)? Both are parsed, never string-compared. */
export function expiresBefore(expires, today) {
  return requireStrictIsoDate(expires, 'expires') < requireStrictIsoDate(today, 'today');
}
