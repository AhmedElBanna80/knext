#!/usr/bin/env node
/**
 * Mutation proof for the metrics-seam family allowlists.
 *
 * The CDN and 'use cache' counters reach the metrics port through globalThis
 * seams, read by deep-health-lite.ts (the loopback listener the standalone
 * supervisor merges) and by the self-contained supervisor's in-process port.
 * Both readers keep only each seam's named families. Each row below removes or
 * widens one allowlist and REQUIRES seam-family-allowlists.test.ts to go red.
 *
 * Verdicts are by EXIT CODE only (scripts/lib/guard-prover.mjs never parses
 * output), every anchor must occur exactly once (preflight first), the baseline
 * must be green, a canary must go red before any green is trusted, and every
 * restore is content-verified.
 *
 * Usage:  node scripts/mutation-prove-seam-family-allowlists.mjs
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGuardProver } from './lib/guard-prover.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const ROWS = [
  {
    id: 'A01',
    subject: 'lite',
    claim: 'deep-health-lite stops filtering the CDN seam',
    anchor: '    return keepFamilies(readSeam(CDN_METRICS_SEAM), CDN_METRIC_FAMILIES);',
    replacement: '    return readSeam(CDN_METRICS_SEAM);',
  },
  {
    id: 'A02',
    subject: 'lite',
    claim: "deep-health-lite stops filtering the 'use cache' seam",
    anchor:
      '    return keepFamilies(\n        readSeam(USE_CACHE_METRICS_SEAM),\n        USE_CACHE_METRIC_FAMILIES,\n    );',
    replacement: '    return readSeam(USE_CACHE_METRICS_SEAM);',
  },
  {
    id: 'A03',
    subject: 'lite',
    claim: 'the CDN allowlist loses the purge counter',
    anchor: '    "knext_cdn_purge_total",\n] as const);',
    replacement: '] as const);',
  },
  {
    id: 'A04',
    subject: 'selfContained',
    claim: 'the self-contained port stops filtering a seam',
    anchor: '    return keepFamilies(text, families);',
    replacement: "    return text.endsWith('\\n') ? text : `${text}\\n`;",
  },
  {
    id: 'A05',
    subject: 'selfContained',
    claim: "the self-contained 'use cache' allowlist is widened to the CDN one",
    anchor: "const USE_CACHE_METRIC_FAMILIES = Object.freeze(['knext_use_cache_events_total']);",
    replacement:
      "const USE_CACHE_METRIC_FAMILIES = Object.freeze(['knext_use_cache_events_total', 'knext_http_requests_total']);",
  },
];

// The subjects are inline literals, not a shared constant: the lane's
// subject-existence audit reads them from the createGuardProver call.
const prover = createGuardProver({
  repoRoot: REPO_ROOT,
  spec: 'packages/kn-next/src/__tests__/seam-family-allowlists.test.ts',
  subjects: {
    lite: 'packages/kn-next/src/adapters/deep-health-lite.ts',
    selfContained: 'packages/kn-next/src/adapters/standalone-self-contained-supervisor.cjs',
  },
});

console.log('=== mutation proof: seam family allowlists ===');
prover.preflight(ROWS);
declareMutations(ROWS.length);
prover.baseline();
prover.proveCanSeeRed({
  subject: 'lite',
  anchor: '    return keepFamilies(readSeam(CDN_METRICS_SEAM), CDN_METRIC_FAMILIES);',
  replacement: '    return "";',
});
for (const m of ROWS) {
  prover.run({ ...m, expect: 'red' });
  recordMutation();
}
prover.finish(ROWS.length);
