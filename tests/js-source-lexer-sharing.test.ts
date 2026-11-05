/**
 * The source-text guards share ONE comment/string lexer
 * (`packages/kn-next/src/adapters/js-source-lexer.mjs`).
 *
 * Six guards used to carry their own lexer and they disagreed on what a template
 * body, an escaped quote, or a comment gap looks like. This pins the migration: each
 * migrated call site imports the shared lexer and does not grow a hand-rolled
 * comment scanner back. A hand-rolled scanner is recognised by its hallmarks (a
 * `function stripComments` / `maskStringLiterals` definition, or a search for the
 * block-comment terminator), so the check SCANS the source instead of listing
 * call sites by hand.
 *
 * Documented exceptions (not JS lexers, so they do not use this module):
 *   - scripts/lib/crane-pin.mjs `stripFullLineComments`: strips bash `#` comment
 *     lines inside a workflow `run:` block (a shell/YAML concern, not JS).
 *   - scripts/adapter-import-closure.mjs: a tokenizer that needs tokens, not a
 *     stripped string.
 */
import { describe, expect, it } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const LEXER = 'packages/kn-next/src/adapters/js-source-lexer.mjs';

const MIGRATED = [
  'scripts/check-escalation-triggers.mjs',
  'scripts/workflow-script-install-guard.mjs',
  'scripts/lib/prover-anchor-scan.mjs',
  'packages/kn-next/src/adapters/computed-require-scan.mjs',
  'packages/kn-next/src/cli/static-export-guard.ts',
];

const read = (rel: string) => readFileSync(resolve(ROOT, rel), 'utf8');

/** Block-comment terminator search: the hallmark of a hand-rolled comment scanner. */
const HAND_ROLLED_COMMENT_SCAN = /indexOf\(\s*(['"])\*\/\1/;
const OWN_STRIP_DEFINITION = /function\s+stripComments\s*\(/;
const SHARED_IMPORT =
  /import\s*\{[^}]*\bstripComments\b[^}]*\}\s*from\s*(['"])[^'"]*js-source-lexer\.mjs\1/;

describe('shared js-source-lexer: call-site migration', () => {
  it('the lexer module itself exists and owns the comment scanner', () => {
    expect(read(LEXER)).toMatch(HAND_ROLLED_COMMENT_SCAN);
  });

  for (const rel of MIGRATED) {
    it(`${rel} imports the shared lexer`, () => {
      expect(read(rel)).toMatch(SHARED_IMPORT);
    });

    it(`${rel} has no hand-rolled comment scanner of its own`, () => {
      const src = read(rel);
      expect(src).not.toMatch(HAND_ROLLED_COMMENT_SCAN);
      expect(src).not.toMatch(OWN_STRIP_DEFINITION);
    });
  }
});
