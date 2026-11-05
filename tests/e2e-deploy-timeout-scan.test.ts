/**
 * Every bun test file that spawns the REAL `scripts/e2e-deploy.sh` must raise
 * bun's default test timeout at file scope.
 *
 * bun ignores `describe(name, { timeout }, fn)` (see
 * `bun-ignored-timeout-option.test.ts`), so the only honoured knob is
 * `setDefaultTimeout(...)`. A file that shells out to a deploy script without it
 * runs real build + server-boot work under bun's 5000 ms default: it passes on a
 * fast machine and flakes under CI contention for a reason the source does not
 * show.
 *
 * Scan-based on purpose: a new `tests/e2e-deploy.*.test.ts` that forgets the
 * call goes red here instead of silently skipping an enumerated list.
 */

import { describe, expect, it } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { blankNonCode } from '../scripts/lib/blank-non-code.mjs';

const testsDir = dirname(fileURLToPath(import.meta.url));

/** `[DEPLOY_SH]` / `[DEPLOY_SH, ...]` — the script path handed to a spawn call. */
const SPAWNS_DEPLOY_SH = /\[\s*DEPLOY_SH\s*[\],]/;
/** A column-0 call: file scope, not inside a describe/it/hook body. */
const FILE_SCOPE_CALL = /^setDefaultTimeout\(\s*[^)\s]/m;
const IMPORTED_FROM_BUN = /import\s*\{[^}]*\bsetDefaultTimeout\b[^}]*\}\s*from\s*['"]bun:test['"]/;
const FIRST_TOP_LEVEL_DESCRIBE = /^describe(?:\.\w+)?\(/m;

/** Findings for one file's source: empty when it is compliant (or does not spawn the script). */
export function deployTimeoutFindings(source: string): string[] {
  const code = blankNonCode(source);
  if (!SPAWNS_DEPLOY_SH.test(code)) return [];
  const findings: string[] = [];
  if (!IMPORTED_FROM_BUN.test(source))
    findings.push('setDefaultTimeout is not imported from bun:test');
  const call = FILE_SCOPE_CALL.exec(code);
  if (!call) {
    findings.push('no file-scope setDefaultTimeout(...) call');
  } else {
    const describeAt = FIRST_TOP_LEVEL_DESCRIBE.exec(code)?.index ?? Number.POSITIVE_INFINITY;
    if (call.index > describeAt)
      findings.push('setDefaultTimeout is declared after the first describe');
  }
  return findings;
}

function deployTestFiles(): string[] {
  return readdirSync(testsDir)
    .filter((f) => /^e2e-deploy.*\.test\.ts$/.test(f))
    .sort();
}

describe('e2e-deploy tests declare a file-scoped timeout', () => {
  const files = deployTestFiles();
  const spawners = files.filter((f) =>
    SPAWNS_DEPLOY_SH.test(blankNonCode(readFileSync(resolve(testsDir, f), 'utf8'))),
  );

  it('the scan sees the known spawners (a regex that matches nothing proves nothing)', () => {
    expect(spawners).toContain('e2e-deploy.builder-proof.test.ts');
    expect(spawners).toContain('e2e-deploy.contract.test.ts');
    expect(spawners.length).toBeGreaterThanOrEqual(8);
  });

  for (const f of spawners) {
    it(`${f} calls setDefaultTimeout at file scope, before its describe`, () => {
      expect(deployTimeoutFindings(readFileSync(resolve(testsDir, f), 'utf8'))).toEqual([]);
    });
  }

  it('the checker itself rejects a spawner without the call, and accepts one with it', () => {
    const bare = `import { describe } from 'bun:test';\nspawnSync('bash', [DEPLOY_SH]);\ndescribe('x', () => {});\n`;
    expect(deployTimeoutFindings(bare)).not.toEqual([]);
    const ok = `import { describe, setDefaultTimeout } from 'bun:test';\nsetDefaultTimeout(80_000);\nspawnSync('bash', [DEPLOY_SH]);\ndescribe('x', () => {});\n`;
    expect(deployTimeoutFindings(ok)).toEqual([]);
    const inComment = `import { describe, setDefaultTimeout } from 'bun:test';\n// setDefaultTimeout(1)\nspawnSync('bash', [DEPLOY_SH]);\n`;
    expect(deployTimeoutFindings(inComment)).not.toEqual([]);
  });
});
