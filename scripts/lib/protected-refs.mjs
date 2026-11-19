/**
 * Protected-ref check (D4). The own-repo reusable-workflow SHA-pin exemption
 * (`isOwnRepoReusableWorkflow`, `PROTECTED_REFS` in verify-action-pins.mjs) is only
 * sound if (a) each exempted branch is actually branch-protected and (b) no TAG
 * shares its name (an ambiguous `main` ref is attacker-steerable).
 *
 * Verdicts are three-valued per check and ONLY a positive answer passes: an API
 * error (the default GITHUB_TOKEN may not read protection) is UNVERIFIABLE and
 * fails. The `protected` flag on the branches API is readable with `contents: read`;
 * the full protection endpoint needs admin and is deliberately not relied on.
 */

const errText = (e) => (e instanceof Error ? e.message : String(e));
// An actual HTTP 404 signal from `gh api` ("... (HTTP 404)"). Bare "not found" is NOT
// enough: "gh: command not found" must be UNVERIFIABLE, not "tag absent".
const isNotFound = (e) => /\(HTTP 404\)|\bHTTP 404\b/.test(errText(e));

/**
 * @param {{gh: (args: string[]) => string, repo: string, refs: Iterable<string>}} p
 * @returns {{ok: boolean, findings: string[], checked: number}}
 */
export function verifyProtectedRefs({ gh, repo, refs }) {
  const findings = [];
  let checked = 0;
  for (const ref of refs) {
    checked++;
    // Branch protection (the `protected` flag).
    try {
      const body = JSON.parse(gh(['api', `repos/${repo}/branches/${ref.replace(/\//g, '%2F')}`]));
      if (body?.protected === true) {
        // ok
      } else if (body?.protected === false) {
        findings.push(`branch ${ref}: UNPROTECTED`);
      } else {
        findings.push(`branch ${ref}: UNVERIFIABLE (no \`protected\` field in the response)`);
      }
    } catch (e) {
      findings.push(`branch ${ref}: UNVERIFIABLE (${errText(e).split('\n')[0]})`);
    }
    // No tag with the branch's name.
    try {
      gh(['api', `repos/${repo}/git/ref/tags/${ref}`]);
      findings.push(`tag ${ref}: EXISTS (shadows the protected branch name)`);
    } catch (e) {
      if (!isNotFound(e)) {
        findings.push(`tag ${ref}: UNVERIFIABLE (${errText(e).split('\n')[0]})`);
      }
    }
  }
  if (checked === 0) findings.push('no protected refs were checked (empty set)');
  return { ok: findings.length === 0, findings, checked };
}

const DAY_MS = 86_400_000;
export const EXCEPTION_MAX_DAYS = 30;
export const EXCEPTION_REASON = 'founder to enable branch protection on the temporary repo';

/**
 * Dated known exception for an UNPROTECTED/UNVERIFIABLE finding. It only decides
 * whether the alert ISSUE is filed; the check itself stays red in the job log.
 * Active only while `now < expires`, with `expires` no more than 30 days after
 * `granted` and the exact reason. Anything malformed is INACTIVE (fail closed).
 * @param {{granted?: string, expires?: string, reason?: string}|undefined} exception
 * @param {number} nowMs
 * @returns {{active: boolean, why: string}}
 */
export function evaluateException(exception, nowMs) {
  if (!exception || typeof exception !== 'object') return { active: false, why: 'no exception' };
  const granted = Date.parse(exception.granted);
  const expires = Date.parse(exception.expires);
  if (!Number.isFinite(granted) || !Number.isFinite(expires)) {
    return { active: false, why: 'granted/expires missing or unparseable' };
  }
  if (exception.reason !== EXCEPTION_REASON) return { active: false, why: 'reason mismatch' };
  if (expires - granted > EXCEPTION_MAX_DAYS * DAY_MS) {
    return { active: false, why: `exception window exceeds ${EXCEPTION_MAX_DAYS} days` };
  }
  if (nowMs >= expires) return { active: false, why: `expired ${exception.expires}` };
  return { active: true, why: `holds until ${exception.expires}` };
}
