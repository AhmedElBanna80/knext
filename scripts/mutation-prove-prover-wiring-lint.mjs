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
    anchor: 'if (imported) return false;',
    replacement: '',
  },
  {
    label: 'a path variable used for anything but a text read no longer counts as executed',
    subject: 'lint',
    anchor: 'if (!c || !isReadCall(c)) return false;',
    replacement: 'if (c && !isReadCall(c)) return false;',
  },
  {
    label: 'text handed to a parser or helper is still called a substring match',
    subject: 'lint',
    anchor: 'if (!isSubstringUse(u)) return false;',
    replacement: '',
  },
  {
    label: 'a string-method text analysis (slice) is no longer recognised as a text check',
    subject: 'lint',
    anchor: "  'slice',\n",
    replacement: '',
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
    anchor: 'return judged > 0;',
    replacement: 'return true;',
  },
  {
    label: 'a describe/it title naming the subject is treated as executing it',
    subject: 'lint',
    anchor:
      "if (direct && TITLE_CALLEES.has(calleeName(direct) ?? '') && direct.arguments[0] === outer)\n      continue;",
    replacement: '',
  },
  {
    label: 'one text-only spec is enough to flag a subject another spec executes (every -> some)',
    subject: 'lint',
    anchor: 'mentioning.every(',
    replacement: 'mentioning.some(',
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
    anchor: "  'replace',\n",
    replacement: '',
  },
  {
    label: 'src.replaceAll(...) is no longer a text-only use',
    subject: 'lint',
    anchor: "  'replaceAll',\n",
    replacement: '',
  },
  {
    label: 'a bash -n spawn of the subject (literal path) counts as executing it again',
    subject: 'lint',
    anchor: 'if (isSyntaxCheckArg(outer)) continue;',
    replacement: '',
  },
  {
    label: 'a bash -n spawn of the subject (path variable) counts as executing it again',
    subject: 'lint',
    anchor: 'if (isSyntaxCheckArg(u)) continue;',
    replacement: '',
  },
  {
    label: 'the -n flag is no longer required: any shell spawn of the subject is a syntax check',
    subject: 'lint',
    anchor: "arr.elements.some((e) => strLit(e) === '-n')",
    replacement: 'true',
  },
  {
    label: 'a -n argument to a non-shell command is treated as a syntax check',
    subject: 'lint',
    anchor: 'return Boolean(shellArg) || shells(arr.elements[0]);',
    replacement: 'return true;',
  },
  {
    label: 'an inline Bun.file(p).text() read is judged without its adapter (no substring match seen)',
    subject: 'lint',
    anchor: '{ inline: readValueEnd(direct) }',
    replacement: '{ inline: direct }',
  },
  {
    label: 'the wiring count ignores the text-only subjects (labelled rows only)',
    subject: 'lint',
    anchor: 'wiring += textOnly.has(key) || declared.has(key) ? r.total : r.labelled;',
    replacement: 'wiring += r.labelled;',
  },
];

const DECLARED = 22;
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
