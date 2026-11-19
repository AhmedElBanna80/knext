#!/usr/bin/env node
/**
 * Mutation prover for `scripts/prepush-check.mjs` and its lib.
 *
 * The guard is `tests/prepush-check.test.ts`. Each row plants one regression and
 * requires the guard to go RED, by exit code:
 *
 *   P1  allowlist detection starts matching nested directories.
 *   P2  the reader scan stops skipping the mutation provers.
 *   P3  a reader missing from the registry is silently accepted.
 *   R1-R4  the scan stops following imports / counts comments / skips workflows / sees only .mjs.
 *   D1-D3  workflow-derived targets drop --closure / count comments / are unused.
 *   U1-U3  the diff basis drops uncommitted or untracked files, or stops flagging them.
 *   B1-B3  continuation lines are not joined / a bare invocation passes / is kept runnable.
 *   I1-I4  invocation edges, package.json scripts, composite actions are not followed or scanned;
 *          manifest prose counts.
 *   S1-S2  directory-level readers (readdir/glob over security, `security/*`) are missed.
 *   L1-L2  the leak scan stops falling back to covering tests, or stops saying it did not run.
 *   P4  the leak snapshot diff reports nothing.
 *   P5  the static scan ignores each file's baseline.
 *   P6  the static scan looks beyond tests/**.
 *   P7  `**` stops crossing directories.
 *   P8  the out-of-scope filter inverts.
 *   C1  a non-zero gate exit stops failing.
 *   C2  a missing gate tool is downgraded to a warning without the flag.
 *   C3  a tmpdir leak stops failing.
 *   C4  a repo-root leak stops failing.
 *   C5  an unknown reader stops failing.
 *   C6  an out-of-scope file stops failing.
 *   C7  the static scan finding stops failing.
 *   C8  an undeclared scope starts failing instead of warning.
 *   N1  negative control: a heading changes.
 *
 *   node scripts/mutation-prove-prepush-check.mjs
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGuardProver } from './lib/guard-prover.mjs';
import { MUTATION_MARKER } from './lib/mutation-harness.mjs';
import { jsStillParses } from './lib/parse-validity.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = 'tests/prepush-check.test.ts';

const MUTATIONS = [
  {
    id: 'P1',
    claim: 'gate-input detection matches nested directories',
    subject: 'lib',
    anchor: 'export const GATE_INPUT_RE = /^security\\/[^/]+\\.(?:json|ya?ml)$/;',
    replacement: 'export const GATE_INPUT_RE = /^security\\/.+\\.(?:json|ya?ml)$/;',
  },
  {
    id: 'P2',
    claim: 'gate scan stops skipping the mutation provers',
    subject: 'lib',
    anchor: String.raw`&& !/\/mutation-prove-[^/]*$/.test(f)`,
    replacement: '',
  },
  {
    id: 'P3',
    claim: 'an unregistered reader is silently accepted',
    subject: 'lib',
    anchor: '!reg.gates.includes(r) && !(r in reg.other)',
    replacement: 'false',
  },
  {
    id: 'R1',
    claim: 'the scan stops following imports (a reader via a lib is missed)',
    subject: 'lib',
    anchor: 'if (edgesOf(f, text.get(f)).some((t) => reads.has(t))) {',
    replacement: 'if (false) {',
  },
  {
    id: 'R2',
    claim: 'comments count as reads',
    subject: 'lib',
    anchor: "if (!f.endsWith('package.json')) return stripComments(raw);",
    replacement: "if (!f.endsWith('package.json')) return raw;",
  },
  {
    id: 'R3',
    claim: 'workflows are not scanned',
    subject: 'lib',
    anchor:
      "for (const f of walk(root, '.github/workflows')) if (/\\.ya?ml$/.test(f)) files.push(f);",
    replacement: 'void 0;',
  },
  {
    id: 'R4',
    claim: 'the scan only sees .mjs',
    subject: 'lib',
    anchor: 'const SCRIPT_EXT = /\\.(?:mjs|cjs|js|ts|sh)$/;',
    replacement: 'const SCRIPT_EXT = /\\.mjs$/;',
  },
  {
    id: 'D1',
    claim: 'derived targets drop --closure',
    subject: 'lib',
    anchor: '/^--(?:app|closure|shape)$/',
    replacement: '/^--(?:app|shape)$/',
  },
  {
    id: 'D2',
    claim: 'workflow comments count when deriving targets',
    subject: 'lib',
    anchor:
      "const joined = joinContinuations(stripComments(readFileSync(join(root, wfDir, f), 'utf8')));",
    replacement: "const joined = joinContinuations(readFileSync(join(root, wfDir, f), 'utf8'));",
  },
  {
    id: 'D3',
    claim: 'workflow-derived args are not used',
    subject: 'lib',
    anchor: 'fromWorkflows ? deriveWorkflowArgSets(root, script) : entry.runs',
    replacement: '[]',
  },
  {
    id: 'U1',
    claim: 'uncommitted changes drop out of the basis',
    subject: 'cli',
    anchor: 'const changed = [...new Set([...committed, ...uncommitted])].sort();',
    replacement: 'const changed = [...new Set(committed)].sort();',
  },
  {
    id: 'U2',
    claim: 'untracked files drop out of the uncommitted set',
    subject: 'cli',
    anchor: "...lines(['ls-files', '-o', '--exclude-standard']),",
    replacement: '',
  },
  {
    id: 'U3',
    claim: 'uncommitted changes are no longer flagged',
    subject: 'cli',
    anchor: 'uncommitted file(s) included in every check',
    replacement: 'file(s) included',
  },
  {
    id: 'L1',
    claim: 'source-only changes no longer fall back to covering tests',
    subject: 'cli',
    anchor: 'tests = testsCovering(root, changed, allTests).slice(0, MAX_COVERING_TESTS);',
    replacement: 'tests = [];',
  },
  {
    id: 'L2',
    claim: 'an unexercised leak scan stops saying so',
    subject: 'cli',
    anchor: "'leak scan NOT exercised:",
    replacement: "'leak scan ok:",
  },
  {
    id: 'B1',
    claim: 'YAML continuation lines are no longer joined',
    subject: 'lib',
    anchor:
      "const joined = joinContinuations(stripComments(readFileSync(join(root, wfDir, f), 'utf8')));",
    replacement: "const joined = stripComments(readFileSync(join(root, wfDir, f), 'utf8'));",
  },
  {
    id: 'B2',
    claim: 'a bare closure-audit invocation no longer fails the check',
    subject: 'lib',
    anchor: 'for (const b of bareInvocations(root, script)) {',
    replacement: 'for (const b of []) {',
  },
  {
    id: 'B3',
    claim: 'a bare invocation is kept as a runnable argument set',
    subject: 'lib',
    anchor:
      "if (args.some((a) => a === '--app' || a === '--closure')) sets.set(args.join(' '), args);",
    replacement: "sets.set(args.join(' '), args);",
  },
  {
    id: 'I1',
    claim: 'invocations (node/bash/sh/bun) stop being edges',
    subject: 'lib',
    anchor: 'for (const m of joinContinuations(text).matchAll(INVOKE)) {',
    replacement: 'for (const m of []) {',
  },
  {
    id: 'I2',
    claim: 'package.json prose keys count as reads',
    subject: 'lib',
    anchor: "if (!f.endsWith('package.json')) return stripComments(raw);",
    replacement: 'return stripComments(raw);',
  },
  {
    id: 'I3',
    claim: 'package.json manifests are not scanned',
    subject: 'lib',
    anchor: 'for (const m of manifests) if (existsSync(join(root, m))) files.push(m);',
    replacement: 'void manifests;',
  },
  {
    id: 'I4',
    claim: 'composite actions are not scanned',
    subject: 'lib',
    anchor: "for (const f of walk(root, '.github/actions')) {",
    replacement: 'for (const f of []) {',
  },
  {
    id: 'S1',
    claim: 'directory-level readers are ignored',
    subject: 'lib',
    anchor: '|| DIR_READ.some((r) => r.test(text.get(f)))',
    replacement: '',
  },
  {
    id: 'S2',
    claim: 'the shell `security/*` pattern is no longer recognised',
    subject: 'lib',
    anchor: '/\\bsecurity\\/\\*/,',
    replacement: '/\\bsecurity\\/\\*NEVER/,',
  },
  {
    id: 'P4',
    claim: 'the leak snapshot diff reports nothing',
    subject: 'lib',
    anchor: 'return [...after].filter((e) => !was.has(e)).sort();',
    replacement:
      'return [...after].filter((e) => !was.has(e) && !was.has(e)).filter(() => false).sort();',
  },
  {
    id: 'P5',
    claim: 'the static scan ignores each file baseline',
    subject: 'lib',
    anchor: 'if (n > allowed) out.push',
    replacement: 'if (n > 0) out.push',
  },
  {
    id: 'P6',
    claim: 'the static scan looks beyond tests/**',
    subject: 'lib',
    anchor: "!f.startsWith('tests/') || ",
    replacement: '',
  },
  {
    id: 'P7',
    claim: '`**` stops crossing directories',
    subject: 'lib',
    anchor: "} else re += '.*';",
    replacement: "} else re += '[^/]*';",
  },
  {
    id: 'P8',
    claim: 'the out-of-scope filter inverts',
    subject: 'lib',
    anchor: 'files.filter((f) => !res.some((r) => r.test(f)))',
    replacement: 'files.filter((f) => res.some((r) => r.test(f)))',
  },
  {
    id: 'C1',
    claim: 'a non-zero gate exit stops failing',
    subject: 'cli',
    anchor: 'if (status !== 0) failures.push(`${label}: exit ${status}`);',
    replacement: 'if (status !== 0) warnings.push(`${label}: exit ${status}`);',
  },
  {
    id: 'C2',
    claim: 'a missing gate tool is a warning even without the flag',
    subject: 'cli',
    anchor: 'not on PATH`;\n          (opts.allowMissingTools ? warnings : failures).push(msg);',
    replacement: 'not on PATH`;\n          warnings.push(msg);',
  },
  {
    id: 'C3',
    claim: 'a tmpdir leak stops failing',
    subject: 'cli',
    anchor: 'for (const e of leakedTmp) failures.push(',
    replacement: 'for (const e of leakedTmp) warnings.push(',
  },
  {
    id: 'C4',
    claim: 'a repo-root leak stops failing',
    subject: 'cli',
    anchor: 'for (const e of leakedRepo) failures.push(',
    replacement: 'for (const e of leakedRepo) warnings.push(',
  },
  {
    id: 'C5',
    claim: 'an unknown reader stops failing',
    subject: 'cli',
    anchor: 'for (const u of unknown) {\n      failures.push(',
    replacement: 'for (const u of unknown) {\n      warnings.push(',
  },
  {
    id: 'C6',
    claim: 'an out-of-scope file stops failing',
    subject: 'cli',
    anchor: 'for (const f of outOfScope(changed, globs)) failures.push(',
    replacement: 'for (const f of outOfScope(changed, globs)) warnings.push(',
  },
  {
    id: 'C7',
    claim: 'the static scan finding stops failing',
    subject: 'cli',
    anchor: 'for (const f of findings) {\n    failures.push(',
    replacement: 'for (const f of findings) {\n    warnings.push(',
  },
  {
    id: 'C8',
    claim: 'an undeclared scope fails locally instead of warning',
    subject: 'cli',
    anchor: '} else warnings.push(msg);',
    replacement: '} else failures.push(msg);',
  },
  // --- S13-4: every security/ input maps to a gate; CI enforces scope; nearest-fork base ---
  {
    id: 'G1',
    claim: 'gate-input detection drops yaml inputs',
    subject: 'lib',
    anchor: 'export const GATE_INPUT_RE = /^security\\/[^/]+\\.(?:json|ya?ml)$/;',
    replacement: 'export const GATE_INPUT_RE = /^security\\/[^/]+\\.json$/;',
  },
  {
    id: 'G2',
    claim: 'gate-input detection narrows back to *allowlist* files',
    subject: 'lib',
    anchor: 'export const GATE_INPUT_RE = /^security\\/[^/]+\\.(?:json|ya?ml)$/;',
    replacement: 'export const GATE_INPUT_RE = /^security\\/[^/]*allowlist[^/]*\\.json$/;',
  },
  {
    id: 'G3',
    claim: 'an input nothing gates is no longer unmapped',
    subject: 'lib',
    anchor:
      'if (!(allowlist in registry) || (reg.gates.length === 0 && testReaders.length === 0)) {',
    replacement: 'if (false) {',
  },
  {
    id: 'G4',
    claim: 'a test that names the input no longer counts as its gate',
    subject: 'lib',
    anchor:
      'if (!(allowlist in registry) || (reg.gates.length === 0 && testReaders.length === 0)) {',
    replacement: 'if (!(allowlist in registry) || reg.gates.length === 0) {',
  },
  {
    id: 'G13',
    claim: 'an input missing from the registry is accepted when a test names it',
    subject: 'lib',
    anchor:
      'if (!(allowlist in registry) || (reg.gates.length === 0 && testReaders.length === 0)) {',
    replacement: 'if (reg.gates.length === 0 && testReaders.length === 0) {',
  },
  {
    id: 'G5',
    claim: 'the guard own test file counts as a reader of every input',
    subject: 'lib',
    anchor: ' && !SELF_TESTS.has(f))',
    replacement: ')',
  },
  {
    id: 'G6',
    claim: 'a comment naming the input counts as a test reader',
    subject: 'lib',
    anchor: "stripComments(readFileSync(join(root, f), 'utf8')).includes(name)",
    replacement: "readFileSync(join(root, f), 'utf8').includes(name)",
  },
  {
    id: 'G7',
    claim: 'the naming tests are found but never handed back to run',
    subject: 'lib',
    anchor: 'for (const t of testReaders) tests.add(t);',
    replacement: 'void 0;',
  },
  {
    id: 'G8',
    claim: 'an unmapped input is a warning, not a failure',
    subject: 'cli',
    anchor: 'for (const u of unmapped) {\n      failures.push(',
    replacement: 'for (const u of unmapped) {\n      warnings.push(',
  },
  {
    id: 'G9',
    claim: '--skip-gates also skips the input-to-gate mapping check',
    subject: 'cli',
    anchor: 'if (allowlists.length === 0)\n    say(',
    replacement: 'if (allowlists.length === 0 || opts.skipGates)\n    say(',
  },
  {
    id: 'G10',
    claim: 'the tests that name a changed input are never run',
    subject: 'cli',
    anchor: 'runGates(runs, gateTests);',
    replacement: 'runGates(runs, []);',
  },
  {
    id: 'G11',
    claim: 'a failing naming test stops failing',
    subject: 'cli',
    anchor: 'if (status !== 0) failures.push(`gate tests',
    replacement: 'if (status !== 0) warnings.push(`gate tests',
  },
  {
    id: 'G12',
    claim: 'bun missing is no longer UNVERIFIED for the naming tests',
    subject: 'cli',
    anchor: "if (!deps.onPath('bun')) {",
    replacement: 'if (false) {',
  },
  {
    id: 'S1',
    claim: 'CI scope also reads --scope and commit trailers (rewritable)',
    subject: 'cli',
    anchor: 'if (opts.requireScope) {\n    // CI: the PR body',
    replacement: 'if (false) {\n    // CI: the PR body',
  },
  {
    id: 'S2',
    claim: 'a missing Scope line in CI only warns',
    subject: 'cli',
    anchor: "if (opts.requireScope) {\n      failures.push(\n        'no `Scope:",
    replacement: "if (false) {\n      failures.push(\n        'no `Scope:",
  },
  {
    id: 'S3',
    claim: 'a match-everything scope in CI only warns',
    subject: 'cli',
    anchor: '(opts.requireScope ? failures : warnings).push(msg);',
    replacement: 'warnings.push(msg);',
  },
  {
    id: 'S4',
    claim: 'the match-everything check is never made',
    subject: 'cli',
    anchor: 'if (broad.length > 0) {',
    replacement: 'if (false) {',
  },
  {
    id: 'S5',
    claim: 'a CRLF PR body is no longer parsed',
    subject: 'lib',
    anchor: ".replace(/\\r\\n?/g, '\\n')",
    replacement: '',
  },
  {
    id: 'S6',
    claim: 'globs that only together cover everything pass',
    subject: 'lib',
    anchor: 'return covers(globs) ? [...globs] : [];',
    replacement: 'return [];',
  },
  {
    id: 'S7',
    claim: 'a single match-everything glob is not isolated from narrow ones',
    subject: 'lib',
    anchor: 'const alone = globs.filter((g) => covers([g]));',
    replacement: 'const alone = [];',
  },
  {
    id: 'S8',
    claim: 'the .github canary is dropped, so a scope short of .github reads as everything',
    subject: 'lib',
    anchor: "  '.github/x/y',\n",
    replacement: '',
  },
  {
    id: 'B1',
    claim: 'the default base picks the farthest fork point',
    subject: 'lib',
    anchor: 'score[0] < bestScore[0] ||',
    replacement: 'score[0] > bestScore[0] ||',
  },
  {
    id: 'B2',
    claim: 'a fork-point tie no longer prefers the ref with fewer own commits',
    subject: 'lib',
    anchor: '(score[0] === bestScore[0] && score[1] < bestScore[1])',
    replacement: 'false',
  },
  {
    id: 'B3',
    claim: 'the default base is the first ref that exists (the old fixed order)',
    subject: 'cli',
    anchor: 'opts.base ?? pickBase(BASES, (b) => distanceFrom(root, b));',
    replacement: 'opts.base ?? BASES.find((b) => distanceFrom(root, b));',
  },
  {
    id: 'B4',
    claim: 'main is not a candidate base',
    subject: 'cli',
    anchor: "'origin/integration/v2', 'personal/main', 'origin/main'];",
    replacement: "'origin/integration/v2', 'origin/main'];",
  },
  // The CI workflow, mutated as text (not JS, so no parse check).
  {
    id: 'W1',
    claim: 'the CI job stops requiring a scope',
    subject: 'wf',
    validate: () => true,
    anchor: '--require-scope',
    replacement: '--skip-tests',
  },
  {
    id: 'W2',
    claim: 'the CI job no longer re-runs when the PR body is edited',
    subject: 'wf',
    validate: () => true,
    anchor: 'types: [opened, synchronize, reopened, edited]',
    replacement: 'types: [opened, synchronize, reopened]',
  },
  {
    id: 'W3',
    claim: 'the CI job is made non-blocking',
    subject: 'wf',
    validate: () => true,
    anchor: '    timeout-minutes: 10\n',
    replacement: '    timeout-minutes: 10\n    continue-on-error: true\n',
  },
  {
    id: 'W4',
    claim: 'the PR body is interpolated into the shell script',
    subject: 'wf',
    validate: () => true,
    anchor: '          git fetch --no-tags origin',
    replacement:
      '          echo "${{ github.event.pull_request.body }}" >/dev/null\n          git fetch --no-tags origin',
  },
  {
    id: 'N1',
    expect: 'green',
    claim: 'negative control: a heading changes',
    subject: 'cli',
    anchor: "say('\\n=== 4. scope report ===');",
    replacement: "say('\\n=== 4. scope and area report ===');",
  },
].map((m) => ({
  expect: 'red',
  validate: jsStillParses,
  ...m,
  // A block comment, never the harness's default line comment: most anchors end
  // mid-line, and a trailing `//` marker would swallow the rest of the line.
  replacement: `${m.replacement} /* ${MUTATION_MARKER} */`,
}));

const CANARY = {
  subject: 'lib',
  anchor: 'export const changedGateInputs = (files) => files.filter((f) => GATE_INPUT_RE.test(f));',
  replacement: 'export const changedGateInputs = (files) => [];',
};

const prover = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: SPEC,
  subjects: {
    lib: 'scripts/lib/prepush-check.mjs',
    cli: 'scripts/prepush-check.mjs',
    wf: '.github/workflows/prepush-check.yml',
  },
});

console.log('=== mutation proof: prepush-check ===');
prover.preflight([...MUTATIONS, { id: 'canary', ...CANARY }]);
declareMutations(MUTATIONS.length);
prover.baseline();
prover.proveCanSeeRed(CANARY);
for (const m of MUTATIONS) {
  prover.run(m);
  recordMutation();
}
prover.finish(MUTATIONS.length);
