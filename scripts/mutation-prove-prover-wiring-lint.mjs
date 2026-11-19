#!/usr/bin/env node
/**
 * Mutation proof for the prover wiring-row lint (`scripts/lib/prover-wiring-lint.mjs`),
 * guarded by `tests/prover-wiring-rows-lint.test.ts`. Each mutation removes one half of the
 * lint (detecting a text-only row, or accepting the label only when it is really there); the
 * spec must go RED. Anchors occur exactly once (abort otherwise), restoration is
 * content-addressed, verdicts are by exit code.
 *
 * Usage: node scripts/mutation-prove-prover-wiring-lint.mjs
 */

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSpecRunner } from './lib/ci-blocking-gate-proof.mjs';
import { mutate, restore, snapshot } from './lib/mutation-harness.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = 'tests/prover-wiring-rows-lint.test.ts';
const PROOF = {
  subjects: {
    lint: 'scripts/lib/prover-wiring-lint.mjs',
    z11: 'scripts/mutation-prove-s11-1-z11-answering-pod.mjs',
  },
};
const RUNNER = resolveSpecRunner(REPO_ROOT);

function specPasses() {
  const r = spawnSync(RUNNER.command, [...RUNNER.args, ...RUNNER.runArgs(SPEC)], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return r.status === 0;
}

const MUTATIONS = [
  {
    label: 'an imported subject is no longer treated as executed (flagged as text-only)',
    subject: 'lint',
    anchor: "if (imported) kinds.add('executed');",
    replacement: 'void 0;',
  },
  {
    label: 'a path variable used for anything but a text read is skipped instead of judged',
    subject: 'lint',
    anchor: "        if (!spawnedBy(u)) return 'other';",
    replacement: '        if (!spawnedBy(u)) continue;',
  },
  {
    label: 'text handed to a parser or helper is still called a substring match',
    subject: 'lint',
    anchor: "if (!isSubstringUse(u)) return 'other';",
    replacement: '',
  },
  {
    label: 'a string-method text analysis (slice) is no longer recognised as a text check',
    subject: 'lint',
    anchor: "'endsWith',\n  'slice',\n",
    replacement: "'endsWith',\n",
  },
  {
    label: 'one unlabelled row among labelled ones is accepted',
    subject: 'lint',
    anchor: 'r.labelled === r.total',
    replacement: 'r.labelled > 0',
  },
  {
    label: 'the kind label is not required (every row counts as labelled)',
    subject: 'lint',
    anchor: "add(subject, kind === 'wiring');",
    replacement: 'add(subject, true);',
  },
  {
    label: 'the WIRING_SUBJECTS declaration excuses every subject, declared or not',
    subject: 'lint',
    anchor: 'if (declared.has(key)) continue;',
    replacement: 'if (declared.size >= 0) continue;',
  },
  {
    label: 'a helper merely named wiring* labels rows without setting the kind',
    subject: 'lint',
    anchor: 'helperSetsWiringKind(sf, n.expression.text)',
    replacement: 'true',
  },
  {
    label: 'a text read that is never asserted on counts as a substring check (judged > 0 dropped)',
    subject: 'lint',
    anchor: "if (judged > 0) kinds.add('text');",
    replacement: "kinds.add('text');",
  },
  {
    label: 'a describe/it title naming the subject is treated as executing it',
    subject: 'lint',
    anchor: "TITLE_CALLEES.has(calleeName(direct) ?? '')",
    replacement: 'false',
  },
  {
    label: 'one text-only spec is enough to flag a subject another spec executes (every -> some)',
    subject: 'lint',
    anchor: "verdicts.every((v) => v === 'text')",
    replacement: "verdicts.some((v) => v === 'text')",
  },
  {
    label: 'the real z11 prover loses its wiring label on the WR rows',
    subject: 'z11',
    anchor: "const wiringRow = (...args) => ({ ...row(...args), kind: 'wiring' });",
    replacement: 'const wiringRow = (...args) => row(...args);',
  },
  // ---- TD-S12-5a (F6): the evasions, and the row-level split
  {
    label: 'Bun.file(p).text() is no longer a text read (its substring checks go unflagged)',
    subject: 'lint',
    anchor: "n.expression.expression.text === 'Bun';",
    replacement: "n.expression.expression.text === 'NoBun';",
  },
  {
    label: 'a chained pass-through string method no longer climbs to the checked value',
    subject: 'lint',
    anchor: 'TEXT_TRANSFORMS.has(q.name.text)',
    replacement: 'false',
  },
  {
    label: 'src.replace(...) is no longer a text-only use',
    subject: 'lint',
    anchor: "not a parse.\n  'replace',\n",
    replacement: 'not a parse.\n',
  },
  {
    label: 'src.replaceAll(...) is no longer a text-only use',
    subject: 'lint',
    anchor: "'replaceAll',\n]);\n// Methods whose RESULT",
    replacement: ']);\n// Methods whose RESULT',
  },
  {
    label: 'a bash -n spawn of the subject (literal path) counts as executing it again',
    subject: 'lint',
    anchor: "if (sk === 'check') continue;",
    replacement: 'void 0;',
  },
  {
    label: 'a bash -n spawn of the subject (path variable) counts as executing it again',
    subject: 'lint',
    anchor: "if (uk === 'check') continue;",
    replacement: 'void 0;',
  },
  {
    label: 'the -n flag is no longer required: any shell spawn of the subject is a syntax check',
    subject: 'lint',
    anchor: "  return check ? 'check' : 'run';",
    replacement: "  return 'check';",
  },
  {
    label: 'a -n argument to a non-shell command is treated as a syntax check',
    subject: 'lint',
    anchor: 'shells(call.arguments[0])',
    replacement: 'true',
  },
  {
    label: 'a text read through an adapter (Bun.file(p).text()) is treated as a file handle',
    subject: 'lint',
    anchor: 'if (end !== c) return v ? { name: v } : { inline: end };',
    replacement: 'if (end !== c) return v ? { name: v, handle: true } : { inline: c };',
  },
  {
    label: 'the wiring count ignores the text-only subjects (labelled rows only)',
    subject: 'lint',
    anchor: 'wiring += r.total;',
    replacement: 'wiring += r.labelled;',
  },
  // ---- Item 2: bash -n needs -n BEFORE the subject
  {
    label: 'a non-flag argument in front of the subject no longer ends the syntax check',
    subject: 'lint',
    anchor: "if (f === '-' || !/^[-+]/.test(f)) return 'run';",
    replacement: "if (false) return 'run';",
  },
  {
    label:
      'a slice/split/replace result that reaches a call is no longer followed (JSON.parse(x.slice(..)))',
    subject: 'lint',
    anchor: 'return !escapesTextCheck(c);',
    replacement: 'return true;',
  },
  {
    label:
      'a call argument is never an escape (any call, a spawn argument array included, counts as a check)',
    subject: 'lint',
    anchor: "p.expression.text === 'expect') return false;",
    replacement: "p.expression.text === 'expect') return false;\n      return false;",
  },
  {
    label: 'a predicate or index method result (indexOf, includes, test) is followed as text',
    subject: 'lint',
    anchor: '      SUBSTRING_METHODS.has(p.name.text)\n    ) {\n      return false;',
    replacement: '      false\n    ) {\n      return false;',
  },
  {
    label: 'a .length of a text result is followed as text (it is a number)',
    subject: 'lint',
    anchor: "p.name.text === 'length')",
    replacement: "p.name.text === 'NOLENGTH')",
  },
  {
    label: 'a comparison of a text result is followed as text (it is a boolean)',
    subject: 'lint',
    anchor: 'COMPARISON_OPERATORS.has(p.operatorToken.kind)',
    replacement: 'false',
  },
  {
    label: 'a text method on an array of lines (filter, join, ...) is no longer followed',
    subject: 'lint',
    anchor: 'ARRAY_TEXT_METHODS.has(p.name.text))',
    replacement: 'false)',
  },
  {
    label: 'a value returned from a named helper is not followed to its call sites',
    subject: 'lint',
    anchor: 'if (ts.isReturnStatement(p) || (ts.isArrowFunction(p) && p.body === cur)) {',
    replacement: 'if (false) {',
  },
  {
    label: 'a for-of loop over a text result is not followed to its loop variable',
    subject: 'lint',
    anchor: 'if (ts.isForOfStatement(p) && p.expression === cur) {',
    replacement: 'if (false) {',
  },
  {
    label: 'a use of a binding counts a same-named binding in another scope (no shadowing check)',
    subject: 'lint',
    anchor: '!shadowed(n)',
    replacement: 'true',
  },
  // ---- Item 4: Bun.file handles and read aliases
  {
    label: 'f.text() on a Bun.file handle is no longer a text read',
    subject: 'lint',
    anchor: "read.name.text === 'text'",
    replacement: "read.name.text === 'NOTEXT'",
  },
  {
    label: 'an aliased read function (const rf = readFileSync) is no longer a text read',
    subject: 'lint',
    anchor: "aliases.has(calleeName(n) ?? '')",
    replacement: 'false',
  },
  {
    label: 'a Bun.file handle bound to a variable is treated as already read text',
    subject: 'lint',
    anchor: 'handle: isBunFile(c)',
    replacement: 'handle: false',
  },
  // ---- Attribution (item 1)
  {
    label: 'a path handed to nothing that runs it is counted as executed (behavioural), not other',
    subject: 'lint',
    anchor: "if (!spawnedBy(u)) return 'other';",
    replacement: "kinds.add('executed');",
  },
  {
    label:
      'a subject with a text-only spec and an executing spec is behavioural, not unattributed (some, not every)',
    subject: 'lint',
    anchor: "verdicts.every((v) => v === 'executed')",
    replacement: "verdicts.some((v) => v === 'executed')",
  },
  {
    label: 'an unattributed row is counted as behavioural (only executed subjects should be)',
    subject: 'lint',
    anchor: "if (kind === 'executed') behavioural += unlabelled;",
    replacement: 'behavioural += unlabelled;',
  },
  {
    label:
      'a subject no spec names (or a mixed one) defaults to executed (behavioural), not unattributed',
    subject: 'lint',
    anchor: "let kind = 'unattributed';",
    replacement: "let kind = 'executed';",
  },
  {
    label: 'a subject no spec names is counted as text-only (wiring) because no spec disagrees',
    subject: 'lint',
    anchor: "verdicts.length > 0 && verdicts.every((v) => v === 'text')",
    replacement: "verdicts.every((v) => v === 'text')",
  },
  {
    label: 'item 1: a spec with executed and text uses collapses to executed (mixed is lost)',
    subject: 'lint',
    anchor: "return kinds.size === 1 ? [...kinds][0] : 'mixed';",
    replacement:
      "return kinds.has('executed') ? 'executed' : kinds.size === 1 ? [...kinds][0] : 'mixed';",
  },
  {
    label: 'item 1: an import specifier is counted as a use of the subject again',
    subject: 'lint',
    anchor:
      'if (parent && (ts.isImportDeclaration(parent) || ts.isExportDeclaration(parent))) continue;',
    replacement: '',
  },
  {
    label: 'item 2: an unknown bash option is treated as a run, not unattributed',
    subject: 'lint',
    anchor: "    if (sk === 'unknown') return 'other';",
    replacement: '',
  },
  {
    label: 'item 2: bash -o does not consume its argument (the -n after it is missed)',
    subject: 'lint',
    anchor: '        i += 1;\n        break;',
    replacement: '        break;',
  },
  {
    label: 'item 2: bash --rcfile does not consume its argument',
    subject: 'lint',
    anchor:
      '      i += 1; // --rcfile X: the argument is the next word, and it is before the subject',
    replacement: '',
  },
  {
    label:
      'item 3: a value passed to a local asserting helper escapes (the helper is not followed)',
    subject: 'lint',
    anchor: '      return !helperChecksArg(p, cur);',
    replacement: '      return true;',
  },
  {
    label: 'item 3: a value handed to an asserting helper is no longer a substring use',
    subject: 'lint',
    anchor:
      '  if (cur.parent && ts.isCallExpression(cur.parent) && helperChecksArg(cur.parent, cur))\n    return true;',
    replacement: '',
  },
  {
    label:
      'item 3: the helper cycle guard is removed (mutually calling helpers are followed forever)',
    subject: 'lint',
    anchor: '  if (helpersInFlight.has(fn)) return false;',
    replacement: '',
  },
  {
    label:
      'item 3: a spec that imports the subject by module path no longer names it (its executed verdict is lost)',
    subject: 'lint',
    anchor: '      .filter((x) => namesSubject(x.text, path, x.p))',
    replacement: '      .filter(() => true)',
  },
  {
    label: 'ROUND 3 item 1: the bare name is matched as a raw substring (data.mjs names a.mjs)',
    subject: 'lint',
    anchor:
      'if (new RegExp(`(?<![\\\\w./-])${esc(base)}(?![\\\\w-])`).test(specSource)) return true;',
    replacement: 'if (specSource.includes(base)) return true;',
  },
  {
    label:
      'ROUND 3 item 1: a relative specifier names the subject by its stem, not its resolved path (../other/render names lib/render)',
    subject: 'lint',
    anchor: '    return specifierTargets(lit, specPath).includes(subjectPath);',
    replacement:
      "    return lit.split('/').pop().replace(/\\.[^.]+$/, '') === subjectPath.split('/').pop().replace(/\\.[^.]+$/, '');",
  },
  {
    label: 'ROUND 3 item 3a: the last -n/+n setting is ignored (a later +n leaves the check on)',
    subject: 'lint',
    anchor: "if (c === 'n')\n        check = m[1] === '-';",
    replacement: "if (c === 'n')\n        check = check || m[1] === '-';",
  },
  {
    label:
      'ROUND 3 item 1: namesSubject never checks quoted literals (a relative import is not seen)',
    subject: 'lint',
    anchor: '    if (refersTo(m[2], subjectPath, specPath)) return true;',
    replacement: '    if (false) return true;',
  },
  {
    label:
      'ROUND 3 item 1: classifyPair ignores the spec path and resolves relative imports from the repo root',
    subject: 'lint',
    anchor:
      'function specifierTargets(spec, specPath) {\n  const t = posix.normalize(posix.join(posix.dirname(specPath), spec));',
    replacement:
      "function specifierTargets(spec, specPath) {\n  const t = posix.normalize(posix.join('.', spec));",
  },
  {
    label: 'a .js/.mjs specifier no longer names its .ts/.mts source (ROUND 4 item 1)',
    subject: 'lint',
    anchor: '    ...twins,\n',
    replacement: '',
  },
  {
    label: 'bash -o noexec is ignored, so a syntax-only -o noexec counts as a run (ROUND 4 item 2)',
    subject: 'lint',
    anchor: "if (c === 'o' && before[i + 1] === 'noexec') check = m[1] === '-';",
    replacement: "if (false) check = m[1] === '-';",
  },
  {
    label: 'a later +o noexec does not turn the -o noexec check off (ROUND 4 item 2)',
    subject: 'lint',
    anchor: "if (c === 'o' && before[i + 1] === 'noexec') check = m[1] === '-';",
    replacement: "if (c === 'o' && before[i + 1] === 'noexec') check = true;",
  },
  {
    label:
      'a neutral -o value (pipefail) is treated as unknown instead of ignored (ROUND 4 item 2)',
    subject: 'lint',
    anchor: "if (c === 'o' && before[i + 1] === 'noexec') check = m[1] === '-';",
    replacement:
      "if (c === 'o' && before[i + 1] !== 'noexec') return 'unknown';\n        if (c === 'o' && before[i + 1] === 'noexec') check = m[1] === '-';",
  },
];

const DECLARED = 58;
declareMutations(DECLARED);
if (MUTATIONS.length !== DECLARED) {
  console.error(`FATAL: declared ${DECLARED} mutations, table has ${MUTATIONS.length}`);
  process.exit(1);
}
if (!specPasses()) {
  console.error('FATAL: baseline is not green to begin with');
  process.exit(1);
}
const decorative = [];
for (const m of MUTATIONS) {
  console.log(`── mutation: ${m.label}`);
  const snap = snapshot(resolve(REPO_ROOT, PROOF.subjects[m.subject]));
  try {
    mutate(snap, m.anchor, m.replacement);
    if (specPasses()) {
      console.log('   x DECORATION: the spec stayed GREEN with the behaviour removed');
      decorative.push(m.label);
    } else console.log('   ok went RED as required');
    recordMutation();
  } finally {
    restore(snap);
  }
  if (!specPasses()) {
    console.error('   FATAL: spec did not go green again after restore');
    process.exit(1);
  }
}
console.log(`\n${MUTATIONS.length - decorative.length} caught, ${decorative.length} decorative.`);
if (decorative.length > 0) {
  for (const label of decorative) console.error(`DECORATIVE: ${label}`);
  process.exit(1);
}
