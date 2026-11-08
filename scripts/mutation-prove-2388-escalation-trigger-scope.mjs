#!/usr/bin/env node
/**
 * Mutation proof for the escalation-trigger check (#2388, slimmed). Each mutation
 * removes or widens one rule: the path triggers (every CRD types file, every
 * package CLI, `crates/`, the static supply-chain set), credential detection
 * (named secrets, OIDC, write grants, `toJSON(secrets)`, both sides of a workflow
 * edit), the files a credential workflow names one level deep (`scripts/` and
 * local actions, any existing script path, Makefiles via `-C` / `cd` /
 * `working-directory`, comments ignored), the package manifest surface, and
 * fail-closed parsing of `git diff --name-status`. Each REQUIRES
 * `tests/escalation-triggers.test.ts` to go red. The shared driver
 * (`scripts/lib/guard-prover.mjs`) owns the discipline: verdicts by exit code
 * only, baseline green first, a canary that must go red, anchors that occur
 * exactly once, byte-exact restore.
 *
 * Rows that survived the slimming keep their old ids, so a missing id is a row
 * that tested the removed transitive analysis; new rows took free numbers.
 *
 * Usage: node scripts/mutation-prove-2388-escalation-trigger-scope.mjs
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGuardProver } from './lib/guard-prover.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = 'tests/escalation-triggers.test.ts';

const MUTATIONS = [
  {
    id: 'M1',
    expect: 'red',
    claim:
      'the CRD rule shrinks back to nextapp_types.go — a new or second API types file stops firing',
    subject: 'paths',
    anchor: '    match: (p) => CRD_TYPES.test(p),',
    replacement:
      "    match: (p) => p === 'packages/kn-next-operator/api/v1alpha1/nextapp_types.go',",
  },
  {
    id: 'M2',
    expect: 'red',
    claim: 'the CRD pattern loses its api/ anchor — any *_types.go (controller internals) fires',
    subject: 'paths',
    anchor: 'const CRD_TYPES = /(^|\\/)api\\/(.+\\/)?[^/]+_types\\.go$/;',
    replacement: 'const CRD_TYPES = /_types\\.go$/;',
  },
  {
    id: 'M3',
    expect: 'red',
    claim: "the CLI rule shrinks back to core's src/cli/ — grpc/ffi cli.ts stop firing",
    subject: 'paths',
    anchor: '    match: (p) => CLI_SURFACE.test(p) && !isTestPath(p),',
    replacement: "    match: (p) => p.startsWith('packages/kn-next/src/cli/'),",
  },
  {
    id: 'M4',
    expect: 'red',
    claim: 'the CLI rule stops excluding tests — a test under src/cli/ is mistaken for surface',
    subject: 'paths',
    anchor: '    match: (p) => CLI_SURFACE.test(p) && !isTestPath(p),',
    replacement: '    match: (p) => CLI_SURFACE.test(p),',
  },
  {
    id: 'M5',
    expect: 'red',
    claim: 'the crates rule is dropped — Rust source, Cargo.lock and deny.toml stop firing',
    subject: 'paths',
    anchor: "    match: (p) => p.startsWith('crates/'),",
    replacement: '    match: (p) => false && p,',
  },
  {
    id: 'M6',
    expect: 'red',
    claim: 'security/** stops being supply chain — scan allowlists change unflagged',
    subject: 'paths',
    anchor: "  if (p.startsWith('security/')) return true;\n",
    replacement: '',
  },
  {
    id: 'M7',
    expect: 'red',
    claim: 'scripts/audit-published.mjs stops being supply chain',
    subject: 'paths',
    anchor: "  if (p === 'scripts/audit-published.mjs') return true;\n",
    replacement: '',
  },
  {
    id: 'M8',
    expect: 'red',
    claim:
      'package supply-chain modules (packages/ffi/src/supply-chain.ts, the #2359 miss) stop firing',
    subject: 'paths',
    anchor:
      '  return /^packages\\/[^/]+\\/src\\/(.+\\/)?supply-chain\\.[cm]?[jt]s$/.test(p) && !isTestPath(p);',
    replacement: '  return false && p;',
  },
  {
    id: 'M9',
    expect: 'red',
    claim: 'supply-chain modules stop excluding test fixtures',
    subject: 'paths',
    anchor:
      '  return /^packages\\/[^/]+\\/src\\/(.+\\/)?supply-chain\\.[cm]?[jt]s$/.test(p) && !isTestPath(p);',
    replacement: '  return /^packages\\/[^/]+\\/src\\/(.+\\/)?supply-chain\\.[cm]?[jt]s$/.test(p);',
  },
  {
    id: 'M10',
    expect: 'red',
    claim: 'id-token: write (OIDC federation, keyless signing) stops counting as a credential',
    subject: 'credential',
    anchor: '  if (/id-token\\s*:\\s*[\'"]?write/.test(text)) return true;\n',
    replacement: '',
  },
  {
    id: 'M11',
    expect: 'red',
    claim: 'a secrets[...] index expression (name unknowable) passes instead of failing closed',
    subject: 'credential',
    anchor: '  if (/secrets\\s*\\[/.test(text)) return true;\n',
    replacement: '',
  },
  {
    id: 'M12',
    expect: 'red',
    claim: 'a named secret such as NPM_TOKEN stops counting as a credential',
    subject: 'credential',
    anchor: '    if (!LOW_PRIVILEGE_SECRETS.has(m[1])) return true;',
    replacement: '    if (false && m) return true;',
  },
  {
    id: 'M13',
    expect: 'red',
    claim: 'the low-privilege exemption is ignored — every ci.yml edit (CODECOV_TOKEN) fires',
    subject: 'credential',
    anchor: '    if (!LOW_PRIVILEGE_SECRETS.has(m[1])) return true;',
    replacement: '    if (m) return true;',
  },
  {
    id: 'M14',
    expect: 'red',
    claim: 'only the head side is scanned — DELETING a credential-bearing workflow passes',
    subject: 'credential',
    anchor: "      const sides = [repo.show('base', c.path), repo.show('head', c.path)];",
    replacement: "      const sides = [repo.show('head', c.path)];",
  },
  {
    id: 'M15',
    expect: 'red',
    claim: 'only the base side is scanned — ADDING a secret to a plain workflow passes',
    subject: 'credential',
    anchor: "      const sides = [repo.show('base', c.path), repo.show('head', c.path)];",
    replacement: "      const sides = [repo.show('base', c.path)];",
  },
  {
    id: 'M20',
    expect: 'red',
    claim: 'the manifest rule shrinks back to packages/kn-next — grpc/ffi exports stop firing',
    subject: 'publicSurface',
    anchor: 'const PACKAGE_MANIFEST = /^packages\\/[^/]+\\/package\\.json$/;',
    replacement: 'const PACKAGE_MANIFEST = /^packages\\/kn-next\\/package\\.json$/;',
  },
  {
    id: 'M21',
    expect: 'red',
    claim: 'the manifest rule widens to any package.json — scaffold templates fire',
    subject: 'publicSurface',
    anchor: 'const PACKAGE_MANIFEST = /^packages\\/[^/]+\\/package\\.json$/;',
    replacement: 'const PACKAGE_MANIFEST = /(^|\\/)package\\.json$/;',
  },
  {
    id: 'M22',
    expect: 'red',
    claim: 'an UNPARSEABLE manifest passes instead of failing closed',
    subject: 'publicSurface',
    anchor: '    if (before === UNPARSEABLE || after === UNPARSEABLE) {',
    replacement: '    if (false) {',
  },
  {
    id: 'M23',
    expect: 'red',
    claim: 'the fired reason stops saying the manifest was unparseable',
    subject: 'publicSurface',
    anchor:
      "  const note = unparseable ? ' (a manifest is UNPARSEABLE, so it cannot be proven unchanged)' : '';",
    replacement: "  const note = '';",
  },
  {
    id: 'M24',
    expect: 'red',
    claim: 'an unknown git name-status letter is classified instead of failing',
    subject: 'git',
    anchor: '  if (!status || !GIT_STATUSES.has(status[0])) {',
    replacement: '  if (!status) {',
  },
  {
    id: 'M25',
    expect: 'red',
    claim: 'a name-status line with no path is classified instead of failing',
    subject: 'git',
    anchor: '    if (paths.length < n || paths.some((p) => !p)) {',
    replacement: '    if (false) {',
  },
  {
    id: 'M26',
    expect: 'red',
    claim: 'merging content triggers into path triggers drops new paths for an existing id',
    subject: 'report',
    anchor:
      '    else for (const p of f.paths) if (!existing.paths.includes(p)) existing.paths.push(p);',
    replacement: '    else void existing;',
  },
  {
    id: 'M38',
    expect: 'red',
    claim: 'a rename/copy yields only its destination — moving a file OUT of scope passes',
    subject: 'git',
    anchor: '      .slice(0, n)',
    replacement: '      .slice(n - 1, n)',
  },
  {
    id: 'M39',
    expect: 'red',
    claim: 'the CLI reads C-quoted name-status — a non-ASCII CRD types path never matches',
    subject: 'entry',
    anchor: "git(['diff', '-z', '--name-status',",
    replacement: "git(['diff', '--name-status',",
  },
  {
    id: 'M40',
    expect: 'red',
    claim: 'the NUL-separated (-z) record form is not parsed',
    subject: 'git',
    anchor: "  if (text.includes('\\0')) {",
    replacement: '  if (false) {',
  },
  {
    id: 'M41',
    expect: 'red',
    claim: 'permissions: write-all stops counting as a credential',
    subject: 'credential',
    anchor: '  if (/permissions\\s*:\\s*[\'"]?write-all/.test(text)) return true;\n',
    replacement: '',
  },
  {
    id: 'M42',
    expect: 'red',
    claim: 'packages/contents/attestations: write stop counting as credentials',
    subject: 'credential',
    anchor:
      '  if (/(?:^|[\\s{,])(?:packages|contents|attestations)\\s*:\\s*[\'"]?write\\b/m.test(text)) return true;\n',
    replacement: '',
  },
  {
    id: 'M43',
    expect: 'red',
    claim: 'toJSON(secrets) stops counting as a credential',
    subject: 'credential',
    anchor: '  if (/toJSON\\s*\\(\\s*secrets\\s*\\)/i.test(text)) return true;\n',
    replacement: '',
  },
  {
    id: 'M44',
    expect: 'red',
    claim:
      'the git reader treats a TREE as a file — a local action directory is read as text, so its action.yml is never opened',
    subject: 'git',
    anchor: "      if (type !== 'blob') return null;\n",
    replacement: '',
  },
  {
    id: 'M30',
    expect: 'red',
    claim: 'a file a credential workflow names stops firing',
    subject: 'credential',
    anchor: '      named.has(c.path) ||',
    replacement: '      false ||',
  },
  {
    id: 'M31',
    expect: 'red',
    claim: 'a file under a named local action directory stops firing',
    subject: 'credential',
    anchor: "      [...named].some((n) => n.endsWith('/') && c.path.startsWith(n))",
    replacement: '      false',
  },
  {
    id: 'M32',
    expect: 'red',
    claim:
      'a scripts/ or local-action mention counts only when the file exists, and a named directory stops covering its files',
    subject: 'credential',
    anchor: '      if (!expandDir(p, depth)) out.add(p);',
    replacement: '      if (read(p) !== null) out.add(p);',
  },
  {
    id: 'M33',
    expect: 'red',
    claim: "a local action's action.yml is not read — the scripts it runs stop firing",
    subject: 'credential',
    anchor: '        if (body !== null) scan(body, depth + 1);',
    replacement: '',
  },
  {
    id: 'M34',
    expect: 'red',
    claim: 'make -C dir is ignored — that directory’s Makefile stops firing',
    subject: 'credential',
    anchor:
      '    const dir = /(?:^|\\s)-C\\s*(\\S+)/.exec(m[1])?.[1] ?? /(?:^|\\s)--directory=(\\S+)/.exec(m[1])?.[1];',
    replacement: '    const dir =  /(?:^|\\s)--directory=(\\S+)/.exec(m[1])?.[1];',
  },
  {
    id: 'M35',
    expect: 'red',
    claim:
      'a literal cd target is not a base — make after cd, and cd hack && ./sign.sh, stop firing',
    subject: 'credential',
    anchor:
      '  for (const m of text.matchAll(/(?:^|[\\s;&|(])cd\\s+[\'"]?([\\w./-]+)/gm)) out.push(m[1]);',
    replacement: '',
  },
  {
    id: 'M36',
    expect: 'red',
    claim: 'make loses its word boundary — a make_latest key reads as a make command',
    subject: 'credential',
    anchor: '  for (const m of text.matchAll(/(?:^|[\\s;&|(])make(?![\\w.-])([^\\n;&|]*)/gm)) {',
    replacement: '  for (const m of text.matchAll(/(?:^|[\\s;&|(])make([^\\n;&|]*)/gm)) {',
  },
  {
    id: 'M37',
    expect: 'red',
    claim: 'comments are scanned — a path named only in a comment fires',
    subject: 'credential',
    anchor: "      .map((l) => (/^\\s*#/.test(l) ? '' : l))",
    replacement: '      .map((l) => l)',
  },
  {
    id: 'M45',
    expect: 'red',
    claim: 'an install no longer names its manager’s lockfile and config',
    subject: 'credential',
    anchor: '      for (const p of INSTALL_INPUTS[m]) named.add(p);',
    replacement: '',
  },
  {
    id: 'M46',
    expect: 'red',
    claim: 'a commented-out install still names the lockfile',
    subject: 'credential',
    anchor: '  return [...new Set([...prepare(text).matchAll(INSTALL)].map((m) => m[1]))];',
    replacement: '  return [...new Set([...text.matchAll(INSTALL)].map((m) => m[1]))];',
  },
  {
    id: 'M47',
    expect: 'red',
    claim:
      'the workspace / action-path prefix is not stripped — ${{ github.workspace }}/hack/p.sh is not named',
    subject: 'credential',
    anchor: "  return body.replace(ROOT_PREFIX, '');",
    replacement: '  return body;',
  },
  {
    id: 'M48',
    expect: 'red',
    claim: 'a named scripts/ directory no longer covers its files (only local actions do)',
    subject: 'credential',
    anchor: '    if (files.length === 0 && !action) return false;',
    replacement: '    if (!action) return false;',
  },
  {
    id: 'M49',
    expect: 'red',
    claim: 'the legacy design-gate:cleared label stops acknowledging',
    subject: 'ack',
    anchor: '    return normalized === ACK_LABEL || normalized === LEGACY_ACK_LABEL;',
    replacement: '    return normalized === ACK_LABEL;',
  },
  {
    id: 'M50',
    expect: 'red',
    claim: 'the label is compared without case folding',
    subject: 'ack',
    anchor: '    const normalized = l.trim().toLowerCase();',
    replacement: '    const normalized = l.trim();',
  },
  {
    id: 'M51',
    expect: 'red',
    claim: 'the PR-body acknowledgement line stops counting',
    subject: 'ack',
    anchor: "  return typeof body === 'string' && ACK_BODY_PATTERN.test(body);",
    replacement: '  return false;',
  },
  {
    id: 'M52',
    expect: 'red',
    claim: 'a bare script name (release.sh) is not a path token',
    subject: 'credential',
    anchor: "    if ((p.includes('/') || SCRIPT_FILE.test(p)) && !out.includes(p)) out.push(p);",
    replacement: "    if (p.includes('/') && !out.includes(p)) out.push(p);",
  },
  {
    id: 'M53',
    expect: 'red',
    claim: 'a relative path is resolved from the root only, not from cd / working-directory',
    subject: 'credential',
    anchor: '      for (const p of dirs.map((d) => at(d, t))) if (read(p) !== null) out.add(p);',
    replacement: '      if (read(t) !== null) out.add(t);',
  },
  {
    id: 'M54',
    expect: 'red',
    claim: 'a scripts/ path named only in a comment stops firing',
    subject: 'credential',
    anchor: '    for (const p of referencedPaths(prepare(body, { comments: true }))) {',
    replacement: '    for (const p of referencedPaths(code)) {',
  },
  {
    id: 'M55',
    expect: 'red',
    claim: 'the root package.json stops firing on a dependency change under an install',
    subject: 'credential',
    anchor: "      c.path === 'package.json' &&",
    replacement: "      c.path === 'no-such-file' &&",
  },
  {
    id: 'M56',
    expect: 'red',
    claim: 'the root package.json fires on any change, not only dependency keys',
    subject: 'credential',
    anchor: '  return pick(beforeText) !== pick(afterText);',
    replacement: '  return beforeText !== afterText;',
  },
  {
    id: 'M57',
    expect: 'red',
    claim: 'a finding for an unknown trigger id is built instead of failing',
    subject: 'catalogue',
    anchor:
      '  if (!Object.hasOwn(CATALOGUE, id)) throw new Error(`unknown escalation trigger "${id}"`);',
    replacement: "  if (!Object.hasOwn(CATALOGUE, id)) return { id, label: id, why: '', paths };",
  },
  {
    id: 'M58',
    expect: 'red',
    claim: 'a working-directory is not a base — make under it stops firing',
    subject: 'credential',
    anchor:
      '  for (const m of text.matchAll(/working-directory\\s*:\\s*[\'"]?([^\\s\'"#]+)/g)) out.push(m[1]);',
    replacement: '',
  },
];

const prover = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: SPEC,
  subjects: {
    paths: 'scripts/escalation/paths.mjs',
    credential: 'scripts/escalation/credential-workflows.mjs',
    publicSurface: 'scripts/escalation/public-surface.mjs',
    git: 'scripts/escalation/git.mjs',
    report: 'scripts/escalation/report.mjs',
    ack: 'scripts/escalation/acknowledgement.mjs',
    catalogue: 'scripts/escalation/catalogue.mjs',
    entry: 'scripts/check-escalation-triggers.mjs',
  },
});

console.log(`=== mutation proof: ${SPEC} (escalation-trigger scope, #2388) ===`);
prover.preflight(MUTATIONS);
declareMutations(MUTATIONS.length);
prover.baseline();
prover.proveCanSeeRed({
  subject: 'paths',
  anchor: "    match: (p) => p.startsWith('crates/'),",
  replacement: '    match: (p) => false && p,',
});

console.log('\n=== mutations ===');
for (const m of MUTATIONS) {
  prover.run(m);
  recordMutation();
}
prover.finish(MUTATIONS.length);
