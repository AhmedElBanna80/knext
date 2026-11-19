import { parse } from 'yaml';

/**
 * Z7 pin-skew check. z7-rotation-weekly.yml calls the Z7 lane on integration/v2 at a
 * pinned SHA. The pin must be bumped whenever v2's Z7 workflow YAML changes; this module
 * makes that mechanical by comparing the YAML at the pin with the YAML at the branch tip.
 * Data only: file contents are fetched and compared as text, never executed.
 *
 * Fail-closed: an unparseable pin, a failed fetch or an empty body is a failure.
 */

export const CALLER_FILE = '.github/workflows/z7-rotation-weekly.yml';

const USES_RE =
  /^\s*uses:\s*([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)\/(\.github\/workflows\/[A-Za-z0-9_.-]+\.ya?ml)@([0-9a-f]{40})\s*#\s*(\S+)\s*$/m;

/**
 * Reads the pinned reusable-workflow reference from the caller file text.
 * @param {string} text
 * @returns {{repo: string, path: string, sha: string, branch: string}}
 */
export function parsePin(text) {
  const matches = [...String(text).matchAll(new RegExp(USES_RE, 'gm'))];
  if (matches.length !== 1) {
    throw new Error(
      `expected exactly one SHA-pinned reusable-workflow uses: line with a branch comment, found ${matches.length}`,
    );
  }
  const [, repo, path, sha, branch] = matches[0];
  return { repo, path, sha, branch };
}

/** Compact first-difference summary of two texts. */
export function summarizeDiff(pinned, tip) {
  const a = pinned.split('\n');
  const b = tip.split('\n');
  let first = 0;
  while (first < a.length && first < b.length && a[first] === b[first]) first++;
  const setA = new Set(a);
  const setB = new Set(b);
  const removed = a.filter((l) => !setB.has(l)).length;
  const added = b.filter((l) => !setA.has(l)).length;
  return `${a.length} lines at pin, ${b.length} at tip; first difference at line ${first + 1}; ${removed} pinned line(s) absent from tip, ${added} tip line(s) absent from pin`;
}

function deepEqual(x, y) {
  if (x === y) return true;
  if (x === null || y === null || typeof x !== 'object' || typeof y !== 'object') return false;
  if (Array.isArray(x) !== Array.isArray(y)) return false;
  const kx = Object.keys(x);
  const ky = Object.keys(y);
  return kx.length === ky.length && kx.every((k) => Object.hasOwn(y, k) && deepEqual(x[k], y[k]));
}

/**
 * @param {{pinned: string, tip: string}} yaml
 * @returns {{ok: boolean, reason: string}}
 */
export function evaluateSkew({ pinned, tip }) {
  if (typeof pinned !== 'string' || pinned.trim() === '') {
    return { ok: false, reason: 'YAML at the pinned SHA is empty or missing' };
  }
  if (typeof tip !== 'string' || tip.trim() === '') {
    return { ok: false, reason: 'YAML at the branch tip is empty or missing' };
  }
  let a;
  let b;
  try {
    a = parse(pinned);
    b = parse(tip);
  } catch (e) {
    return { ok: false, reason: `YAML unparseable: ${e instanceof Error ? e.message : e}` };
  }
  if (a === null || typeof a !== 'object' || b === null || typeof b !== 'object') {
    return { ok: false, reason: 'YAML did not parse to a mapping' };
  }
  if (deepEqual(a, b)) {
    return {
      ok: true,
      reason: 'Z7 workflow YAML at the pin equals the tip (parsed; comments ignored)',
    };
  }
  return { ok: false, reason: `PIN SKEW: ${summarizeDiff(pinned, tip)}` };
}

/** Fetch a file's raw text at a ref via `gh api` (data only). Throws on any failure. */
export function fetchFileAt({ gh, repo, path, ref }) {
  return gh([
    'api',
    '-H',
    'Accept: application/vnd.github.raw+json',
    `repos/${repo}/contents/${path}?ref=${encodeURIComponent(ref)}`,
  ]);
}

/**
 * @param {{callerText: string, gh: (args: string[]) => string}} args
 */
export function checkPinSkew({ callerText, gh }) {
  const pin = parsePin(callerText);
  const pinned = fetchFileAt({ gh, repo: pin.repo, path: pin.path, ref: pin.sha });
  const tip = fetchFileAt({ gh, repo: pin.repo, path: pin.path, ref: pin.branch });
  return { pin, ...evaluateSkew({ pinned, tip }) };
}
