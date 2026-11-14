/**
 * Triggers decided by the changed path alone. Precision matters: a guard that
 * fires on routine work gets worked around, so each rule is as narrow as the
 * surface it protects.
 */

import { finding } from './catalogue.mjs';

/** Any `*_types.go` under an `api/` directory, at any depth. */
const CRD_TYPES = /(^|\/)api\/(.+\/)?[^/]+_types\.go$/;

/** `packages/<pkg>/src/cli.ts` or anything under `packages/<pkg>/src/cli/`. */
const CLI_SURFACE = /^packages\/[^/]+\/src\/(cli\.[cm]?[jt]s|cli\/.+)$/;

/** The operator's command line: `cmd/main.go` (its flags) and the `cmd/` tools. */
const OPERATOR_CMD = /^packages\/kn-next-operator\/cmd\/.+\.go$/;

/**
 * What the operator may write to the cluster, and the gate in front of every
 * write: its RBAC, admission policy, webhooks and the webhook serving cert
 * (`certmanager/`; the webhook is failurePolicy=Fail, so a broken cert blocks writes).
 */
const OPERATOR_WRITE_SURFACE =
  /^packages\/kn-next-operator\/config\/(rbac|admission|webhook|certmanager)\//;

/**
 * The parts of the install bundle (`config/default/`) that decide the same thing:
 * whether `../rbac` / `../admission` are included at all, the admission-policy
 * patches and the webhook wiring.
 */
const OPERATOR_BUNDLE_WRITE_SURFACE =
  /^packages\/kn-next-operator\/config\/default\/(kustomization\.yaml|[^/]*(admission|webhook)[^/]*)$/;

/**
 * The operator Deployment: its `serviceAccountName` is the identity the admission
 * policy confines, and `WRITE_POLICY_NAME` names that policy. Change either and
 * the policy can stop matching the running operator.
 */
const OPERATOR_MANAGER = 'packages/kn-next-operator/config/manager/manager.yaml';

/**
 * Not part of what a template ships: test modules, helpers and vectors (`tests.rs`,
 * `*_tests.rs`, `tests/`, `testkit.rs`, `testutil.rs`, `testvectors.rs`,
 * `testvectors/`), the `e2e/` suites, Markdown and `.gitignore`.
 * `.dockerignore` still fires: it decides what goes into the image.
 */
const TEMPLATE_NON_SURFACE =
  /(^|\/)(tests|testkit|testutil|testvectors|e2e)(\/|\.rs$)|_tests\.rs$|\.md$|(^|\/)\.gitignore$/;

export function isTestPath(p) {
  return (
    /(^|\/)__tests__\//.test(p) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(p) || /_test\.go$/.test(p)
  );
}

/** Supply-chain paths that need no content to recognise. */
export function isStaticSupplyChainPath(p) {
  if (p.startsWith('security/')) return true;
  if (p === 'scripts/audit-published.mjs') return true;
  // `packages/ffi/src/supply-chain.ts` today; any package's supply-chain module.
  return /^packages\/[^/]+\/src\/(.+\/)?supply-chain\.[cm]?[jt]s$/.test(p) && !isTestPath(p);
}

/** Each path trigger: a catalogue id and the rule that matches a changed path. */
export const TRIGGERS = [
  {
    id: 'adr',
    // A NEW ADR is the output of an escalation, not a reason for one, and
    // `docs/adr/gates/` is measurement data: neither fires.
    match: (p, status) =>
      p.startsWith('docs/adr/') && !p.startsWith('docs/adr/gates/') && status !== 'A',
  },
  {
    id: 'crd',
    // Every `*_types.go` under any `api/` tree, a new one included.
    match: (p) => CRD_TYPES.test(p),
  },
  {
    id: 'config-schema',
    match: (p) => p === 'packages/kn-next/src/config.ts',
  },
  {
    id: 'cli-surface',
    // Every package's CLI, not only core's.
    match: (p) => CLI_SURFACE.test(p) && !isTestPath(p),
  },
  {
    id: 'crates',
    // Source, Cargo.lock, deny.toml and the toolchain pin: FFI surface and supply chain.
    match: (p) => p.startsWith('crates/'),
  },
  {
    id: 'supply-chain',
    match: (p) => isStaticSupplyChainPath(p),
  },
  {
    id: 'operator-flags',
    // Go sources only: `cmd/EGM.md` describes the flags, it does not change them.
    match: (p) => OPERATOR_CMD.test(p) && !isTestPath(p),
  },
  {
    id: 'cluster-write-surface',
    match: (p) =>
      OPERATOR_WRITE_SURFACE.test(p) ||
      OPERATOR_BUNDLE_WRITE_SURFACE.test(p) ||
      p === OPERATOR_MANAGER,
  },
  {
    id: 'templates',
    // The root function templates (Go, Rust). `packages/kn-next/templates/` is
    // the CLI's own scaffold and is not covered here.
    match: (p) => p.startsWith('templates/') && !isTestPath(p) && !TEMPLATE_NON_SURFACE.test(p),
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
