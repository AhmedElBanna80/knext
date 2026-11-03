#!/usr/bin/env node
/**
 * scripts/lib/e2e-vinext-base-path.mjs — reads the Next `basePath` out of a
 * fixture's `next.config.*`, for the vinext lane's empty-dir static probe.
 *
 * Why this exists (#2615): the standalone lane reads `basePath` from
 * `.next/required-server-files.json` (e2e-read-base-path.mjs). vinext writes no
 * such manifest, so the vinext lane never knew the basePath and probed
 * `/data.txt` of an app that serves `<basePath>/data.txt` — five compat
 * fixtures failed the pre-check for a harness reason, not a product one.
 *
 * Same contract as e2e-read-base-path.mjs, on purpose:
 *   * no config file, or a config without `basePath`, is a LEGITIMATE empty
 *     basePath (exit 0, prints nothing);
 *   * a config that exists but cannot be loaded, or whose `basePath` is not a
 *     string, FAILS LOUD (exit 1, message on stderr). A silent "" would turn
 *     into "the empty-dir boot did not answer" with nothing pointing back here.
 *
 * Runs under bun (the vinext lane requires it anyway), so a `.ts` config
 * loads too. A function config is called with Next's build phase, as Next does.
 *
 * ENV-DEPENDENCE (deliberate, and the one way this can disagree with the build):
 * the config is EVALUATED here, in this process's environment, so a config that
 * computes `basePath` from `process.env` answers by the env THIS process has.
 * e2e-deploy-vinext.sh runs it in the same shell, after the exports, that ran
 * `vite build`, so it sees the same variables, with one exception: the build is
 * launched with an inline `NODE_ENV=production`, which this process would not
 * have. That one is mirrored below (only when NODE_ENV is unset; an explicit
 * value is respected). A variable set inline for the build command alone would
 * still be invisible here, which shows up as the static probe asking the wrong
 * path and failing loud, never as a silent pass. Tested against real upstream
 * configs and env-computed ones in tests/e2e-empty-dir.test.ts.
 *
 * Usage: bun e2e-vinext-base-path.mjs <app dir>
 */
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

// Same set, same order of preference, as vinext's own config discovery.
const CONFIG_FILES = [
  'next.config.ts',
  'next.config.mjs',
  'next.config.js',
  'next.config.cjs',
  'next.config.mts',
  'next.config.cts',
];

const appDir = process.argv[2];
if (!appDir) {
  process.stderr.write('usage: e2e-vinext-base-path.mjs <app dir>\n');
  process.exit(2);
}

const configPath = CONFIG_FILES.map((f) => join(resolve(appDir), f)).find((p) => existsSync(p));
if (!configPath) process.exit(0);

// Mirror the build's inline NODE_ENV=production (see ENV-DEPENDENCE above).
process.env.NODE_ENV ??= 'production';

let config;
try {
  const mod = await import(pathToFileURL(configPath).href);
  config = mod.default ?? mod;
  if (typeof config === 'function') {
    config = await config('phase-production-build', { defaultConfig: {} });
  }
} catch (err) {
  process.stderr.write(`ERROR: could not load ${configPath} to read basePath: ${err.message}\n`);
  process.exit(1);
}

const basePath = config?.basePath;
if (basePath === undefined || basePath === null) process.exit(0);
if (typeof basePath !== 'string') {
  process.stderr.write(
    `ERROR: ${configPath} has a non-string basePath (${typeof basePath}) — refusing to guess a probe path\n`,
  );
  process.exit(1);
}
process.stdout.write(basePath);
