#!/usr/bin/env node
// #1301 — regenerate test/deploy-tests-manifest.smoke.knext.json from the real
// credential manifest. Run this after any edit to
// test/deploy-tests-manifest.knext.json; tests/ci-capacity-budget.test.ts
// reds on drift between the two. Output is run through the repo formatter so the
// committed bytes are exactly what `biome check .` accepts (needs node_modules).
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { renderSmokeManifest } from './lib/smoke-manifest.mjs';

const REPO_ROOT = resolve(import.meta.dirname, '..');
const MAIN_PATH = resolve(REPO_ROOT, 'test/deploy-tests-manifest.knext.json');
const SMOKE_PATH = resolve(REPO_ROOT, 'test/deploy-tests-manifest.smoke.knext.json');

const main = JSON.parse(readFileSync(MAIN_PATH, 'utf8'));
writeFileSync(
  SMOKE_PATH,
  renderSmokeManifest(main, {
    repoRoot: REPO_ROOT,
    filePath: 'test/deploy-tests-manifest.smoke.knext.json',
  }),
);
console.log(`wrote ${SMOKE_PATH}`);
