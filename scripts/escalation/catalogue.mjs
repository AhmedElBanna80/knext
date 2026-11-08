/**
 * Every trigger the check can fire: its id, the label a report shows, and why it
 * is trigger-class. One catalogue, so a trigger's wording lives in one place no
 * matter which module detects it.
 */

const entry = (id, label, why) => Object.freeze({ id, label, why });

export const CATALOGUE = Object.freeze({
  adr: entry(
    'adr',
    'an ADR',
    'changes or removes an existing ADR — workflow.md: a change that contradicts or would require amending an ADR',
  ),
  crd: entry(
    'crd',
    'a CRD type',
    'changes a CRD type, which is the operator/CLI compatibility surface (upgrade order is load-bearing: operator/CRD first, then CLI)',
  ),
  'config-schema': entry(
    'config-schema',
    'the knext.config.ts schema',
    'changes the public config schema every consuming app is written against',
  ),
  'cli-surface': entry(
    'cli-surface',
    'the CLI surface',
    'changes a CLI, which is a published entry point (`knext` and its package verbs)',
  ),
  crates: entry(
    'crates',
    'the Rust crates',
    'changes the Rust crates — FFI surface and the cargo supply chain (lockfile, deny policy, toolchain pin)',
  ),
  'supply-chain': entry(
    'supply-chain',
    'the supply chain',
    'changes the supply chain — a security invariant (security.md): credentials, scan allowlists, SBOM/audit, or what a credential-bearing workflow runs',
  ),
  'public-api': entry(
    'public-api',
    'the published package surface',
    'changes exports/bin/files/main/types/typesVersions in a package manifest — what consumers can import or run',
  ),
});

/** A finding for trigger `id` over `paths`, with an optional note on the reason. */
export function finding(id, paths, note = '') {
  if (!Object.hasOwn(CATALOGUE, id)) throw new Error(`unknown escalation trigger "${id}"`);
  const t = CATALOGUE[id];
  return { id: t.id, label: t.label, why: t.why + note, paths };
}
