#!/usr/bin/env node
/**
 * CLI for the protected-ref check (D4): every branch in PROTECTED_REFS must be
 * branch-protected and no tag may share its name. UNVERIFIABLE fails.
 * Env: GITHUB_REPOSITORY, GH_TOKEN (contents: read).
 */
import { execFileSync } from 'node:child_process';
import { appendFileSync, realpathSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { verifyProtectedRefs } from './lib/protected-refs.mjs';
import { PROTECTED_REFS } from './verify-action-pins.mjs';

const gh = (args) =>
  execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo) {
    console.error('::error::GITHUB_REPOSITORY is not set');
    process.exit(1);
  }
  const r = verifyProtectedRefs({ gh, repo, refs: PROTECTED_REFS });
  // Structured result for the alert job: a dated exception may mute ONLY the
  // "branch unprotected" shape; a tag, an UNVERIFIABLE answer or anything else must
  // still file the issue.
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `only_unprotected=${r.onlyUnprotected}\n`);
  }
  if (!r.ok) {
    for (const f of r.findings) console.error(`::error::${f}`);
    process.exit(1);
  }
  console.log(`protected refs OK: ${[...PROTECTED_REFS].join(', ')}`);
}
