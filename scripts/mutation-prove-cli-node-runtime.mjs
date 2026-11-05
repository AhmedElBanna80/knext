#!/usr/bin/env node
/**
 * Mutation proof for #899's Bun-free CLI static-closure guard.
 *
 * WHAT #899 CLAIMED, AND WHY IT NEEDS PROVING
 * -------------------------------------------
 * The published `kn-next` bin must run under plain Node — `npx kn-next` cannot
 * assume Bun on PATH. `cli-node-runtime.test.ts` pins that: it walks the static
 * closure of `src/cli/*.ts` plus every relative import reachable from it and
 * asserts the closure imports no `bun`/`bun:*` module, touches no `Bun.` global,
 * and carries the `#!/usr/bin/env node` shebang on every executable entry.
 *
 * The exemption this file removes claimed the guard's SURVIVING assertions are
 * NEGATIVE (deleted seam files must stay deleted) and therefore low-value to
 * prove. That reads only half the spec. The three assertions above are POSITIVE
 * source-closure scans — they FIRE when a Bun-ism is reintroduced, which is the
 * regression that would break `npx kn-next` under Node — and those are exactly
 * what this prover exercises: it INJECTS each Bun-ism into a closure source file
 * (`src/cli/deploy.ts`, the published bin's entry) and shows the guard reddens.
 * The `dist/`-gated built-bin assertions in the same spec stay covered by
 * install-smoke; this prover deliberately targets the source scans, not those.
 *
 * THE THREE MUTATIONS reintroduce each forbidden Bun surface; the negative
 * control adds the word "bun" in the ONE shape the guard sanctions (a string
 * literal — `runtime: "bun"` config, spawning the external `bun` binary), which
 * must stay GREEN.
 *
 * DISCIPLINE (`.claude/rules/workflow.md`): exit codes only; green baseline; a
 * canary red first; anchors exactly once or abort; clean tree between mutations.
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGuardProver } from './lib/guard-prover.mjs';
import { jsStillParses } from './lib/parse-validity.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = 'packages/kn-next/src/__tests__/cli-node-runtime.test.ts';

const MUTATIONS = [
  {
    id: 'M1',
    expect: 'red',
    claim:
      "a `bun` module import is reintroduced into the CLI closure — the closure guard's " +
      '"no file imports the bun module" assertion must fall, because this is what breaks ' +
      '`npx kn-next` under plain Node',
    subject: 'cli',
    validate: jsStillParses,
    anchor: 'import { readFileSync, writeSync } from "node:fs";',
    replacement: 'import { readFileSync, writeSync } from "node:fs"; import "bun";',
  },
  {
    id: 'M2',
    expect: 'red',
    claim:
      'a `Bun.` global reference is reintroduced — the "no file touches the Bun global" assertion ' +
      'must fall; a bare Node has no Bun global, so this would throw at runtime',
    subject: 'cli',
    validate: jsStillParses,
    anchor: 'import { join } from "node:path";',
    replacement: 'import { join } from "node:path"; const _v = Bun.version;',
  },
  {
    id: 'M3',
    expect: 'red',
    claim:
      'the published bin entry shebang is flipped node -> bun — the "every executable CLI entry has ' +
      'the node shebang" assertion must fall; a bun shebang makes the installed bin require Bun on PATH',
    subject: 'cli',
    validate: jsStillParses,
    anchor: '#!/usr/bin/env node',
    replacement: '#!/usr/bin/env bun',
  },
];

/**
 * NEGATIVE CONTROL. The guard's own note is explicit: the WORD "bun" is fine —
 * `runtime: "bun"` config, bytecode labels, spawning the external `bun` binary.
 * Only the Bun MODULE surface and the Bun GLOBAL are forbidden. Adding a plain
 * string literal "bun" must leave the guard GREEN; a guard that reddened on it
 * would forbid the sanctioned uses and be the first one disabled.
 */
const NEGATIVE = {
  id: 'M4',
  expect: 'green',
  claim:
    'the sanctioned word "bun" appears as a bare string literal — not a module import or a global',
  subject: 'cli',
  validate: jsStillParses,
  anchor: 'import { join } from "node:path";',
  replacement: 'import { join } from "node:path"; const _rt = "bun";',
};

const ALL = [...MUTATIONS, NEGATIVE];

const prover = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: SPEC,
  subjects: {
    cli: 'packages/kn-next/src/cli/deploy.ts',
  },
});

console.log(`=== mutation proof: ${SPEC} (#899 Bun-free CLI closure) ===`);
prover.preflight(ALL);
declareMutations(ALL.length);
prover.baseline();

// The canary injects a `bun:*` builtin import into the closure, so the guard's
// module-import scan must fall. If the runner cannot see that, nothing below is
// worth reading.
prover.proveCanSeeRed({
  subject: 'cli',
  anchor: 'import { createLogger } from "../utils/logger";',
  replacement: 'import { createLogger } from "../utils/logger"; import "bun:sqlite";',
});

console.log('\n=== mutations ===');
for (const m of ALL) {
  prover.run(m);
  recordMutation();
}

prover.finish(ALL.length);
