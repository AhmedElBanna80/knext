#!/usr/bin/env node
/**
 * Mutation proof for the scope-aware createRequire binding tracking of the strict
 * require check (#2666): an aliased creator, `import * as m from "module"`, a
 * destructured dynamic import, a made require that is copied/stored/passed, a
 * wrapper, and a require binding copied in an IMPORTING chunk each either resolve
 * or are reported as an unrecognised binding. Shadowed one-letter names and the
 * understood uses (a call, `.resolve`, a named export) must stay quiet.
 *
 * Two guards, each with its own spec:
 *   - `entry-require-staticize-bindings.test.ts` — the analysis, both halves per
 *     shape (followed vs reported, and the look-alikes that must NOT be reported).
 *   - `vinext-compile-bindings-strict.test.ts` — the compile script's exit code:
 *     a followed shape is held to the standard of a plain call, an unfollowable
 *     one aborts the strict build, and a default build only warns.
 *
 * Exit 0 = every row went red; non-zero otherwise (see guard-prover.mjs).
 *
 * Usage:
 *   node scripts/mutation-prove-2666-create-require-bindings.mjs
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGuardProver } from './lib/guard-prover.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const UNIT_SPEC = 'packages/kn-next/src/__tests__/entry-require-staticize-bindings.test.ts';
const COMPILE_SPEC = 'packages/kn-next/src/__tests__/vinext-compile-bindings-strict.test.ts';

// The analysis rows. Each anchor is a whole line so it occurs once.
const UNIT = [
  {
    id: 'U01',
    subject: 'analyze',
    claim: 'an alias of the creator (`const c = e`) is no longer followed',
    anchor: '    followAliases(creators);',
    replacement: '    void creators;',
  },
  {
    id: 'U02',
    subject: 'analyze',
    claim: 'the module namespace / default import is no longer tracked',
    anchor: '                namespaces.add(binding); // default and namespace imports',
    replacement: '                void binding;',
  },
  {
    id: 'U03',
    subject: 'analyze',
    claim: 'a creator that is copied, stored, passed or returned is no longer reported',
    anchor:
      '                sites.push({ kind: "handed" }); // copied, stored, passed, returned, exported',
    replacement: '                void 0;',
  },
  {
    id: 'U04',
    subject: 'analyze',
    claim: 'a made require that is copied, stored or passed is no longer reported',
    anchor:
      '    return binding.refs.some((ref) => !isUnderstoodRequireUse(ref, parents, allowExport));',
    replacement: '    return false;',
  },
  {
    id: 'U05',
    subject: 'analyze',
    claim: 'a wrapper (an anchor derived from a parameter or import.meta) is no longer reported',
    anchor: '        } else if (call.arguments.some((a) => mayDeriveFromImportMeta(a, scopes))) {',
    replacement: '        } else if (false) {',
  },
  {
    id: 'U06',
    subject: 'analyze',
    claim: 'a parameter is no longer treated as an unknown anchor (the wrapper shape passes)',
    anchor: '            if (binding.kind === "param") return true;',
    replacement: '            if (false) return true;',
  },
  {
    id: 'U07',
    subject: 'analyze',
    claim: 'scope resolution is lost: every name resolves to the module-level binding (shadowing)',
    anchor:
      '        while (scope && !(binding = scope.names.get(ref.node.name))) scope = scope.parent;',
    replacement:
      '        while (scope?.parent) scope = scope.parent;\n        binding = scope?.names.get(ref.node.name);',
  },
  {
    id: 'U08',
    subject: 'analyze',
    claim: 'a dynamic `import("module")` that is not destructured is no longer reported',
    anchor:
      '        if (spec !== null && CREATE_REQUIRE_SOURCES.has(spec) && !handledImports.has(imp)) {',
    replacement: '        if (false) {',
  },
  {
    id: 'U09',
    subject: 'analyze',
    claim: 'an exported alias (`export const c = e`) is followed instead of reported',
    anchor:
      '                if (parents.get(parents.get(parent))?.type === "ExportNamedDeclaration") continue;\n',
    replacement: '',
  },
  {
    id: 'U10',
    subject: 'analyze',
    claim:
      'an IMPORTED require binding that is re-exported is accepted (a named export is only understood where the plan follows it)',
    anchor: '    if (ref.role === "export") return allowExport;',
    replacement: '    if (ref.role === "export") return true;',
  },
  {
    id: 'U11',
    subject: 'analyze',
    claim: '`m.default` (a second namespace) is no longer reported',
    anchor: '                sites.push({ kind: "handed" }); // a second namespace',
    replacement: '                void 0;',
  },
  {
    id: 'U12',
    subject: 'analyze',
    claim: 'a single-value alias of the creator is accepted without the single-value check',
    anchor: '                if (isSingleValue(alias) && !set.has(alias)) {',
    replacement: '                if (alias && !set.has(alias)) {',
  },
  {
    id: 'U13',
    subject: 'staticize',
    claim:
      'the pre-filter forgets modules that only import `module` (a passed namespace is missed)',
    anchor: '    if (mentionsCreateRequire(src)) {',
    replacement: '    if (src.includes("createRequire")) {',
  },
  {
    id: 'U14',
    subject: 'staticize',
    claim: 'an importing chunk that copies a required binding is never reported',
    anchor: '    return result.escapes;',
    replacement: '    return false;',
  },
  {
    id: 'U15',
    subject: 'analyze',
    claim:
      'an optional call through a made require (`r?.("pkg")`) is accepted as an understood use',
    anchor:
      '    if (parent.type === "CallExpression" && parent.callee === ref.node) return !parent.optional;',
    replacement:
      '    if (parent.type === "CallExpression" && parent.callee === ref.node) return true;',
  },
  {
    id: 'U16',
    subject: 'analyze',
    claim: 'a creator under `default` of a dynamic import of `module` is no longer reported',
    anchor:
      '                    sites.push({ kind: "handed" }); // `default` re-exposes the module, not followed',
    replacement: '                    void 0;',
  },
  {
    id: 'U17',
    subject: 'analyze',
    claim: '`getBuiltinModule("node:module")` is no longer reported',
    anchor:
      '        if (spec === null || CREATE_REQUIRE_SOURCES.has(spec)) sites.push({ kind: "handed" });',
    replacement: '        void spec;',
  },
];

// The compile-script rows.
const COMPILE = [
  {
    id: 'C01',
    subject: 'compile',
    claim: 'the plan stops checking require bindings imported from a sibling chunk',
    anchor: '            importedNames.length > 0 &&',
    replacement: '            false &&',
  },
  {
    id: 'C02',
    subject: 'staticize',
    claim: 'an importing chunk that copies a required binding is never reported',
    anchor: '    return result.escapes;',
    replacement: '    return false;',
  },
  {
    id: 'C03',
    subject: 'analyze',
    claim: 'an aliased creator is no longer followed (the package is silently not checked)',
    anchor: '    followAliases(creators);',
    replacement: '    void creators;',
  },
  {
    id: 'C04',
    subject: 'analyze',
    claim: 'a made require that is copied, stored or passed is no longer reported',
    anchor:
      '    return binding.refs.some((ref) => !isUnderstoodRequireUse(ref, parents, allowExport));',
    replacement: '    return false;',
  },
  {
    id: 'C05',
    subject: 'analyze',
    claim: 'the module namespace is no longer tracked',
    anchor: '                namespaces.add(binding); // default and namespace imports',
    replacement: '                void binding;',
  },
  {
    id: 'C06',
    subject: 'analyze',
    claim: 'a wrapper is no longer reported',
    anchor: '        } else if (call.arguments.some((a) => mayDeriveFromImportMeta(a, scopes))) {',
    replacement: '        } else if (false) {',
  },
  {
    id: 'C07',
    subject: 'analyze',
    claim: 'scope resolution is lost: a shadowed one-letter name is read as the require',
    anchor:
      '        while (scope && !(binding = scope.names.get(ref.node.name))) scope = scope.parent;',
    replacement:
      '        while (scope?.parent) scope = scope.parent;\n        binding = scope?.names.get(ref.node.name);',
  },
];

const unit = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: UNIT_SPEC,
  subjects: {
    analyze: 'packages/kn-next/src/adapters/create-require-analyze.mjs',
    staticize: 'packages/kn-next/src/adapters/entry-require-staticize.mjs',
    compile: 'packages/kn-next/src/adapters/vinext-compile.mjs',
  },
});
const compile = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: COMPILE_SPEC,
  subjects: {
    analyze: 'packages/kn-next/src/adapters/create-require-analyze.mjs',
    staticize: 'packages/kn-next/src/adapters/entry-require-staticize.mjs',
    compile: 'packages/kn-next/src/adapters/vinext-compile.mjs',
  },
});

console.log(
  '=== mutation proof: createRequire binding tracking of the strict require check (#2666) ===',
);
unit.preflight(UNIT);
compile.preflight(COMPILE);
declareMutations(UNIT.length + COMPILE.length);

console.log(`\n=== analysis rows: ${UNIT_SPEC} ===`);
unit.baseline();
unit.proveCanSeeRed({
  subject: 'analyze',
  anchor:
    '    if (parent.type === "CallExpression" && parent.callee === ref.node) return !parent.optional;',
  replacement: '    if (parent.type === "CallExpression") return false;',
});
for (const m of UNIT) {
  unit.run({ ...m, expect: 'red' });
  recordMutation();
}
unit.finish(UNIT.length);

console.log(`\n=== compile rows: ${COMPILE_SPEC} ===`);
compile.baseline();
compile.proveCanSeeRed({
  subject: 'staticize',
  anchor: '    return result.escapes;',
  replacement: '    return true;',
});
for (const m of COMPILE) {
  compile.run({ ...m, expect: 'red' });
  recordMutation();
}
compile.finish(COMPILE.length);
