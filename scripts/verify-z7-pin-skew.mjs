#!/usr/bin/env node
/**
 * CLI for the Z7 pin-skew check. Exits 1 on skew, unparseable pin or fetch failure.
 * Env: GH_TOKEN (contents: read). Reads the pin from the caller file; nothing hardcoded.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { CALLER_FILE, checkPinSkew } from './lib/z7-pin-skew.mjs';

const gh = (args) =>
  execFileSync('gh', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 16 * 1024 * 1024,
  });

function main() {
  const callerText = readFileSync(process.env.Z7_CALLER_FILE ?? CALLER_FILE, 'utf8');
  const r = checkPinSkew({ callerText, gh });
  if (!r.ok) {
    console.error(`::error::Z7 pin skew RED: ${r.reason}`);
    console.error(`pinned ${r.pin.sha} vs tip of ${r.pin.branch} (${r.pin.path})`);
    process.exit(1);
  }
  console.log(`Z7 pin skew green: ${r.reason}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    main();
  } catch (e) {
    console.error(
      `::error::Z7 pin skew could not verify (fail closed): ${e instanceof Error ? e.message : e}`,
    );
    process.exit(1);
  }
}
