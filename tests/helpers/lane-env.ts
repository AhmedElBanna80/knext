import { join } from 'node:path';

/**
 * The nightly mutation-prover lane's OWN environment variables, and the hermetic env a runner under test
 * must get instead.
 *
 * A spec that drives `scripts/run-mutation-provers.mjs` in a throwaway repo runs INSIDE the lane (a prover
 * grades it), where `PROVER_LANE_SHA` is the plan's pinned sha and `GITHUB_ACTIONS` is `true`. Leaking
 * either into the runner under test makes it fatal on the HEAD check (the throwaway repo's HEAD is not the
 * plan's sha) or turns its CI-only cleanup on. ONE list, shared by every such spec.
 */
export const LANE_ENV: readonly string[] = [
  'PROVER_LANE_SHA',
  'PROVER_LANE_REF',
  'KNEXT_PROVER_TIMEOUT_MS',
  'KNEXT_LANE_RESTORE_AFTER_KILL',
  'KNEXT_LANE_CARGO_TARGET_DIR',
  'KNEXT_RUST_CODEGEN_DIR',
  'CARGO_TARGET_DIR',
  'GITHUB_ACTIONS',
  'KNEXT_LANE_CLEANUP',
  'KNEXT_LANE_MIN_FREE_DISK_MIB',
  'KNEXT_LANE_MIN_AVAIL_MEM_MIB',
  'KNEXT_LANE_SOFT_FREE_DISK_MIB',
  'KNEXT_LANE_KILL_AVAIL_MEM_MIB',
  'KNEXT_LANE_MEMINFO_PATH',
  'KNEXT_LANE_SAMPLE_MS',
  'KNEXT_LANE_WATCH_MS',
  'KNEXT_LANE_EXTRAS_CMD',
];

/** `ambient` minus every lane variable, then `extra` on top. */
export function hermeticLaneEnv(
  extra: Record<string, string> = {},
  ambient: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string | undefined> = { ...ambient };
  for (const k of LANE_ENV) delete env[k];
  return { ...env, ...extra } as Record<string, string>;
}

/** The env the fixture runner gets: the ambient env minus the lane's own variables, plus the restore opt-in. */
export function runnerEnv(): Record<string, string> {
  return hermeticLaneEnv({ KNEXT_LANE_RESTORE_AFTER_KILL: '1', GITHUB_ACTIONS: '' });
}

/** THE spawn site of the runner under test in a throwaway repo (one place, so the env scrub cannot be skipped at one of several). */
export function spawnLaneRunner(dir: string) {
  return Bun.spawn(['node', join(dir, 'scripts', 'run-mutation-provers.mjs')], {
    cwd: dir,
    env: runnerEnv(),
    stdout: 'ignore',
    stderr: 'ignore',
  });
}
