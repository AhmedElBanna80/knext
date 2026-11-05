// Format a string with the repo's own biome config (needs node_modules).
// Lives outside scripts/lib on purpose: the prover-lane guard keeps shared
// helpers free of process spawns.
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

export function biomeFormat(raw, { repoRoot, filePath }) {
  const r = spawnSync(
    resolve(repoRoot, 'node_modules/.bin/biome'),
    ['format', `--stdin-file-path=${filePath}`],
    { cwd: repoRoot, input: raw, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 },
  );
  if (r.error || r.status !== 0) {
    throw new Error(
      `biomeFormat: biome format failed (${r.error?.message ?? `exit ${r.status}: ${r.stderr}`}) — install dependencies so node_modules/.bin/biome exists`,
    );
  }
  return r.stdout;
}
