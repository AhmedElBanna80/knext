/**
 * Triggers decided by the changed path alone. Precision matters: a guard that
 * fires on routine work gets worked around, so each rule is as narrow as the
 * surface it protects.
 */

import { CATALOGUE, finding } from './catalogue.mjs';

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
    ...CATALOGUE['adr'],
    // A NEW ADR is the output of an escalation, not a reason for one, and
    // `docs/adr/gates/` is measurement data: neither fires.
    match: (p, status) =>
      p.startsWith('docs/adr/') && !p.startsWith('docs/adr/gates/') && status !== 'A',
  },
  {
    ...CATALOGUE['crd'],
    // Every `*_types.go` under any `api/` tree, a new one included.
    match: (p) => CRD_TYPES.test(p),
  },
  {
    ...CATALOGUE['config-schema'],
    match: (p) => p === 'packages/kn-next/src/config.ts',
  },
  {
    ...CATALOGUE['cli-surface'],
    // Every package's CLI, not only core's.
    match: (p) => CLI_SURFACE.test(p) && !isTestPath(p),
  },
  {
    ...CATALOGUE['crates'],
    // Source, Cargo.lock, deny.toml and the toolchain pin: FFI surface and supply chain.
    match: (p) => p.startsWith('crates/'),
  },
  {
    ...CATALOGUE['supply-chain'],
    match: (p) => isStaticSupplyChainPath(p),
  },
];

/** Classify changed files into fired path triggers. Pure. */
export function classifyPaths(changes) {
  const fired = [];
  for (const t of TRIGGERS) {
    const hits = changes.filter((c) => t.match(c.path, c.status)).map((c) => c.path);
    if (hits.length > 0) fired.push(finding(t.id, hits));
  }
  return fired;
}
