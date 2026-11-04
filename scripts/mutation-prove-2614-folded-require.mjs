#!/usr/bin/env node
/**
 * Mutation proof for the folded-specifier exemption of the strict require check
 * (#2614): a `createRequire(import.meta.url)(SPEC)` whose SPEC folds to a package
 * name from string literals (`['io', 'redis'].join('')`, the deliberately hidden
 * ioredis loader in @getknext/lib) is reported as "deliberately not bundled" and
 * does not fail a strict build. Everything the analysis cannot fold still does.
 *
 * Two guards, each with its own spec:
 *   - `entry-require-staticize-folded-spec.test.ts` — the analysis: what folds
 *     (inline, once-written name, hoisted-then-assigned) and what must not
 *     (env read, parameter, name bound or written twice, compound assignment,
 *     non-string element, non-empty separator, empty array).
 *   - `vinext-compile-og-strict-require.test.ts` — the compile script's exit
 *     code: the ioredis shape builds under KNEXT_COMPILE_STRICT_REQUIRES=1 and is
 *     named; an unfoldable name still aborts.
 *
 * Exit 0 = every row went red; non-zero otherwise (see guard-prover.mjs).
 *
 * Usage:
 *   node scripts/mutation-prove-2614-folded-require.mjs
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGuardProver } from './lib/guard-prover.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const FOLD_SPEC = 'packages/kn-next/src/__tests__/entry-require-staticize-folded-spec.test.ts';
const COMPILE_SPEC = 'packages/kn-next/src/__tests__/vinext-compile-og-strict-require.test.ts';
const EMBED_SPEC = 'packages/kn-next/src/__tests__/compile-embed.test.ts';

// The analysis rows. Each anchor is a whole line (or two) so it occurs once.
const FOLD = [
  {
    id: 'F01',
    subject: 'analyze',
    claim: 'folding is accepted for a name written twice (any write that folds wins)',
    anchor: '        folded = writes.length === 1 ? foldJoin(writes[0]) : null;',
    replacement:
      '        folded = writes.length >= 1 ? (writes.map(foldJoin).find((f) => f === FOLDED_RUNTIME_PACKAGE) ?? null) : null;',
  },
  {
    id: 'F02',
    subject: 'analyze',
    claim: 'folding is accepted for a name bound twice (could be a parameter)',
    anchor:
      '        if (facts.bound.get(arg.name) !== 1 || facts.reassigned.has(arg.name)) return null;',
    replacement: '        if (facts.reassigned.has(arg.name)) return null;',
  },
  {
    id: 'F03',
    subject: 'analyze',
    claim: 'the reassigned-name set is ignored (every write form other than a plain assignment)',
    anchor:
      '        if (facts.bound.get(arg.name) !== 1 || facts.reassigned.has(arg.name)) return null;',
    replacement: '        if (facts.bound.get(arg.name) !== 1) return null;',
  },
  {
    id: 'F04',
    subject: 'analyze',
    claim: 'the join separator check is removed (join("/") folds)',
    anchor: '        literalSpec(node.arguments[0]) !== ""\n',
    replacement: '        false\n',
  },
  {
    id: 'F05',
    subject: 'analyze',
    claim: 'a non-string array element is skipped instead of refusing the fold',
    anchor: '        if (part === null) return null;\n        out += part;',
    replacement: '        if (part === null) continue;\n        out += part;',
  },
  {
    id: 'F07',
    subject: 'analyze',
    claim: 'the inline literal-join argument no longer folds',
    anchor: '        folded = foldJoin(arg);',
    replacement: '        folded = null;',
  },
  {
    id: 'F08',
    subject: 'analyze',
    claim: 'a name bound once no longer folds (the bundler-output shape is lost)',
    anchor: '    if (arg.type === "Identifier") {\n        if (facts.bound',
    replacement: '    if (false) {\n        if (facts.bound',
  },
  {
    id: 'F09',
    subject: 'analyze',
    claim: 'a hoisted declaration assigned once is not counted as a write (writes stay empty)',
    anchor: '                    write(node.left.name, node.right);',
    replacement: '                    void node.right;',
  },
  {
    id: 'X01',
    subject: 'analyze',
    claim: 'the exact-name check is removed (sharp, a path, node:fs fold and are exempted)',
    anchor: '    return folded === FOLDED_RUNTIME_PACKAGE ? folded : null;',
    replacement: '    return folded;',
  },
  {
    id: 'P01',
    subject: 'analyze',
    claim: 'the exact-name check becomes startsWith (ioredis/foo is exempted)',
    anchor: '    return folded === FOLDED_RUNTIME_PACKAGE ? folded : null;',
    replacement: '    return folded?.startsWith(FOLDED_RUNTIME_PACKAGE) ? folded : null;',
  },
  {
    id: 'P02',
    subject: 'analyze',
    claim: 'the exact-name check becomes includes (ioredis/foo, node:ioredis are exempted)',
    anchor: '    return folded === FOLDED_RUNTIME_PACKAGE ? folded : null;',
    replacement: '    return folded?.includes(FOLDED_RUNTIME_PACKAGE) ? folded : null;',
  },
  {
    id: 'P03',
    subject: 'analyze',
    claim: 'the exact-name check becomes endsWith (node:ioredis, " ioredis" are exempted)',
    anchor: '    return folded === FOLDED_RUNTIME_PACKAGE ? folded : null;',
    replacement: '    return folded?.endsWith(FOLDED_RUNTIME_PACKAGE) ? folded : null;',
  },
  {
    id: 'P04',
    subject: 'analyze',
    claim: 'the exact-name check becomes case-insensitive (IOREDIS is exempted)',
    anchor: '    return folded === FOLDED_RUNTIME_PACKAGE ? folded : null;',
    replacement: '    return folded?.toLowerCase() === FOLDED_RUNTIME_PACKAGE ? folded : null;',
  },
  {
    id: 'P05',
    subject: 'analyze',
    claim: 'the exact-name check trims first (" ioredis", "ioredis " are exempted)',
    anchor: '    return folded === FOLDED_RUNTIME_PACKAGE ? folded : null;',
    replacement: '    return folded?.trim() === FOLDED_RUNTIME_PACKAGE ? folded : null;',
  },
  {
    id: 'P06',
    subject: 'analyze',
    claim: 'the exact-name check strips a node: prefix (node:ioredis is exempted)',
    anchor: '    return folded === FOLDED_RUNTIME_PACKAGE ? folded : null;',
    replacement:
      '    return folded?.replace(/^node:/, "") === FOLDED_RUNTIME_PACKAGE ? folded : null;',
  },
  {
    id: 'U01',
    subject: 'analyze',
    claim: 'a name changed by ++ is still folded',
    anchor:
      '                if (node.argument.type === "Identifier") reassigned.add(node.argument.name);',
    replacement: '                void node.argument;',
  },
  {
    id: 'U02',
    subject: 'analyze',
    claim: 'a for-in/for-of target is not counted as a write',
    anchor: '                if (node.left.type !== "VariableDeclaration") {',
    replacement: '                if (false) {',
  },
  {
    id: 'U03',
    subject: 'analyze',
    claim: 'a catch parameter does not count as a second binding',
    anchor: '            case "CatchClause":\n                patternNames(node.param, names);',
    replacement: '            case "CatchClause":\n                void node.param;',
  },
  {
    id: 'U04',
    subject: 'analyze',
    claim: 'object-pattern properties bind no names (destructured shadow or write unseen)',
    anchor: 'p.type === "RestElement" ? p.argument : p.value',
    replacement: 'null',
  },
  {
    id: 'U05',
    subject: 'analyze',
    claim: 'an object rest element binds no name',
    anchor: 'p.type === "RestElement" ? p.argument : p.value',
    replacement: 'p.value',
  },
  {
    id: 'U06',
    subject: 'analyze',
    claim: 'array-pattern elements bind no names',
    anchor: '            for (const el of node.elements) patternNames(el, into);',
    replacement: '            void node.elements;',
  },
  {
    id: 'U07',
    subject: 'analyze',
    claim: 'a compound or destructuring assignment target is not counted as a write',
    anchor:
      '                } else {\n                    patternNames(node.left, names);\n                    for (const n of names) reassigned.add(n);\n                }',
    replacement: '                } else {\n                    void node.left;\n                }',
  },
  {
    id: 'S01',
    subject: 'staticize',
    claim: 'the exemption is ignored: a folded call is a non-literal require again',
    anchor: '                if (site.dynamic && typeof site.folded === "string") {',
    replacement: '                if (false) {',
  },
  {
    id: 'S02',
    subject: 'staticize',
    claim: 'a folded package is dropped from the analysis (never reported)',
    anchor: '                    foldedRuntimeRequires.add(site.folded);',
    replacement: '                    void site.folded;',
  },
  {
    id: 'E01',
    subject: 'analyze',
    claim: 'the exemption is removed entirely (the analyser never folds)',
    anchor: '                ? foldSpecifier(parent.arguments[0], getFacts())',
    replacement: '                ? null',
  },
];

// The compile-level rows: the build's exit code is the gate.
const STANDALONE = [
  {
    id: 'N01',
    subject: 'embed',
    claim: 'the unembedded report drops a folded-only module (the load vanishes without trace)',
    anchor: '|| foldedRuntimeRequires.length > 0)',
    replacement: ')',
  },
  {
    id: 'N02',
    subject: 'embed',
    claim: 'the summary line names nothing',
    anchor: '  if (byPackage.size === 0) return null;',
    replacement: '  return null;',
  },
  {
    id: 'N03',
    subject: 'standalone',
    claim: 'the standalone compile never asks for the summary',
    anchor: '    const folded = foldedRuntimeSummary(dynamic);',
    replacement: '    const folded = null;',
  },
  {
    id: 'N04',
    subject: 'standalone',
    claim: 'the standalone compile computes the summary but never prints it',
    anchor: '    if (folded) console.warn(',
    replacement: '    if (false) console.warn(',
  },
];

const COMPILE = [
  {
    id: 'E01c',
    subject: 'analyze',
    claim: 'the exemption is removed entirely: the ioredis build case goes red',
    anchor: '                ? foldSpecifier(parent.arguments[0], getFacts())',
    replacement: '                ? null',
  },
  {
    id: 'C01',
    subject: 'compile',
    claim: 'a folded require is promoted to a strict failure',
    anchor:
      '    (PLAN.unresolved.size > 0 || PLAN.dynamic.length > 0 || PLAN.unrecognized.length > 0)\n) {',
    replacement:
      '    (PLAN.unresolved.size > 0 || PLAN.dynamic.length > 0 || PLAN.unrecognized.length > 0 || PLAN.foldedRuntime.size > 0)\n) {',
  },
  {
    id: 'C02',
    subject: 'compile',
    claim: 'the deliberately-not-bundled warning is never printed',
    anchor: 'if (PLAN.foldedRuntime.size > 0) {',
    replacement: 'if (false) {',
  },
  {
    id: 'C03',
    subject: 'staticize',
    claim: 'an unfoldable runtime name no longer fails strict (exemption widened to all dynamic)',
    anchor: '                } else if (site.dynamic) {',
    replacement: '                } else if (false) {',
  },
];

const fold = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: FOLD_SPEC,
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

const embed = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: EMBED_SPEC,
  subjects: {
    embed: 'packages/kn-next/src/adapters/compile-embed.mjs',
    standalone: 'packages/kn-next/src/adapters/standalone-compile.mjs',
  },
});

console.log(
  '=== mutation proof: folded-specifier exemption of the strict require check (#2614) ===',
);
fold.preflight(FOLD);
compile.preflight(COMPILE);
embed.preflight(STANDALONE);
declareMutations(FOLD.length + COMPILE.length + STANDALONE.length);

console.log(`\n=== analysis rows: ${FOLD_SPEC} ===`);
fold.baseline();
fold.proveCanSeeRed({
  subject: 'analyze',
  anchor: 'export const FOLDED_RUNTIME_PACKAGE = "ioredis";',
  replacement: 'export const FOLDED_RUNTIME_PACKAGE = "ioredix";',
});
for (const m of FOLD) {
  fold.run({ ...m, expect: 'red' });
  recordMutation();
}
fold.finish(FOLD.length);

console.log(`\n=== compile rows: ${COMPILE_SPEC} ===`);
compile.baseline();
compile.proveCanSeeRed({
  subject: 'analyze',
  anchor: '                ? foldSpecifier(parent.arguments[0], getFacts())',
  replacement: '                ? null',
});
for (const m of COMPILE) {
  compile.run({ ...m, expect: 'red' });
  recordMutation();
}
compile.finish(COMPILE.length);

console.log(`\n=== standalone-path rows: ${EMBED_SPEC} ===`);
embed.baseline();
embed.proveCanSeeRed({
  subject: 'embed',
  anchor: '  if (byPackage.size === 0) return null;',
  replacement: '  return null;',
});
for (const m of STANDALONE) {
  embed.run({ ...m, expect: 'red' });
  recordMutation();
}
embed.finish(STANDALONE.length);
