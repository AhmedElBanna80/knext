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
const isNotFound = (e) => /\b404\b|not found/i.test(errText(e));

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
