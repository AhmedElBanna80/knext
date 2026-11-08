/**
 * Triggers decided by the changed path alone. Precision matters: a guard that
 * fires on routine work gets worked around, so each rule is as narrow as the
 * surface it protects.
 */

export const SUPPLY_CHAIN_WHY =
  'changes the supply chain — a security invariant (security.md): credentials, scan allowlists, SBOM/audit, or what a credential-bearing workflow runs';

/** Any `*_types.go` under an `api/` directory, at any depth. */
const CRD_TYPES = /(^|\/)api\/(.+\/)?[^/]+_types\.go$/;

/** `packages/<pkg>/src/cli.ts` or anything under `packages/<pkg>/src/cli/`. */
const CLI_SURFACE = /^packages\/[^/]+\/src\/(cli\.[cm]?[jt]s|cli\/.+)$/;

export function isTestPath(p) {
  return /(^|\/)__tests__\//.test(p) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(p);
}

/** Supply-chain paths that need no content to recognise. */
export function isStaticSupplyChainPath(p) {
  if (p.startsWith('security/')) return true;
  if (p === 'scripts/audit-published.mjs') return true;
  // `packages/ffi/src/supply-chain.ts` today; any package's supply-chain module.
  return /^packages\/[^/]+\/src\/(.+\/)?supply-chain\.[cm]?[jt]s$/.test(p) && !isTestPath(p);
}

export const TRIGGERS = [
  {
    id: 'adr',
    label: 'an ADR',
    // A NEW ADR is the output of an escalation, not a reason for one, and
    // `docs/adr/gates/` is measurement data: neither fires.
    match: (p, status) =>
      p.startsWith('docs/adr/') && !p.startsWith('docs/adr/gates/') && status !== 'A',
    why: 'changes or removes an existing ADR — workflow.md: a change that contradicts or would require amending an ADR',
  },
  {
    id: 'crd',
    label: 'a CRD type',
    // Every `*_types.go` under any `api/` tree, a new one included.
    match: (p) => CRD_TYPES.test(p),
    why: 'changes a CRD type, which is the operator/CLI compatibility surface (upgrade order is load-bearing: operator/CRD first, then CLI)',
  },
  {
    id: 'config-schema',
    label: 'the knext.config.ts schema',
    match: (p) => p === 'packages/kn-next/src/config.ts',
    why: 'changes the public config schema every consuming app is written against',
  },
  {
    id: 'cli-surface',
    label: 'the CLI surface',
    // Every package's CLI, not only core's.
    match: (p) => CLI_SURFACE.test(p) && !isTestPath(p),
    why: 'changes a CLI, which is a published entry point (`knext` and its package verbs)',
  },
  {
    id: 'crates',
    label: 'the Rust crates',
    // Source, Cargo.lock, deny.toml and the toolchain pin: FFI surface and supply chain.
    match: (p) => p.startsWith('crates/'),
    why: 'changes the Rust crates — FFI surface and the cargo supply chain (lockfile, deny policy, toolchain pin)',
  },
  {
    id: 'supply-chain',
    label: 'the supply chain',
    match: (p) => isStaticSupplyChainPath(p),
    why: SUPPLY_CHAIN_WHY,
  },
];

/** Classify changed files into fired path triggers. Pure. */
export function classifyPaths(changes) {
  const fired = [];
  for (const t of TRIGGERS) {
    const hits = changes.filter((c) => t.match(c.path, c.status)).map((c) => c.path);
    if (hits.length > 0) fired.push({ id: t.id, label: t.label, why: t.why, paths: hits });
  }
  return fired;
}
