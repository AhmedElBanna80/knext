#!/usr/bin/env node
/**
 * CLI for the Z7 caller watchdog (D3). Exits 1 on any finding or API failure.
 * Env: GITHUB_REPOSITORY, GH_TOKEN (actions: read), Z7_MAX_AGE_DAYS (default 9).
 */
import { execFileSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { DEFAULT_MAX_AGE_DAYS, evaluateZ7Runs, fetchZ7Runs } from './lib/z7-watchdog.mjs';

const gh = (args) =>
  execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

function main() {
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo) throw new Error('GITHUB_REPOSITORY is not set');
  const days = Number(process.env.Z7_MAX_AGE_DAYS ?? DEFAULT_MAX_AGE_DAYS);
  if (!Number.isFinite(days) || days <= 0) throw new Error('Z7_MAX_AGE_DAYS must be > 0');
  const verdict = evaluateZ7Runs(fetchZ7Runs({ gh, repo }), Date.now(), days);
  if (!verdict.ok) {
    console.error(`::error::Z7 watchdog RED: ${verdict.reason}`);
    process.exit(1);
  }
  console.log(`Z7 watchdog green: ${verdict.reason}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    main();
  } catch (e) {
    console.error(
      `::error::Z7 watchdog could not verify (fail closed): ${e instanceof Error ? e.message : e}`,
    );
    process.exit(1);
  }
}
