#!/usr/bin/env node
/**
 * Mutation proof for the shared tag backlog (issue #2387).
 *
 * `tag-backlog.js` holds the bound, the generation checks and the collapse for
 * the ISR invalidation replay and the `'use cache'` tag replay, and the CDN
 * purge queue takes its cap. One copy means one mutation of it must reach every
 * site that relies on it, so each row below is graded against each site's OWN
 * suite, not against the primitive's unit test:
 *
 *  - ISR     `cache-handler-breaker-invalidation-replay.test.ts`
 *  - UC      `use-cache-breaker-tag-replay.test.ts`
 *  - PURGE   `cdn-purge.test.ts` (the cap only; the queue has no generation)
 *
 * A row that a site's suite does not catch is a real gap in that suite, not a
 * row to drop: the point of the refactor is that a fix (or a break) in the
 * primitive lands everywhere at once.
 *
 * Verdicts are by EXIT CODE only (`scripts/lib/guard-prover.mjs`), every anchor
 * must occur exactly once (preflight first), each baseline must be green, a
 * canary must go red before any green is trusted, and every restore is
 * content-verified.
 *
 * Usage:
 *   node scripts/mutation-prove-2387-tag-backlog.mjs
 */

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createGuardProver } from './lib/guard-prover.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const CAP = {
  id: 'B01',
  subject: 'backlog',
  claim: 'the shared cap collapses after one entry',
  anchor: 'export const BACKLOG_MAX_ENTRIES = 1000;',
  replacement: 'export const BACKLOG_MAX_ENTRIES = 1;',
};
const SETTLE = {
  id: 'B02',
  subject: 'backlog',
  claim: 'a replay removes an entry recorded again while its write was in flight',
  anchor: '      if (generationOf(m.get(name)) !== recordedAt) return false;',
  replacement: '',
};
const SWEEP = {
  id: 'B03',
  subject: 'backlog',
  claim: 'a collapse sweep clears the collapse even when a record landed during it',
  anchor: '      if (generation === startedAt) collapsed = false;',
  replacement: '      collapsed = false;',
};

const SITES = [
  {
    name: 'ISR invalidation replay',
    spec: 'packages/kn-next/src/__tests__/cache-handler-breaker-invalidation-replay.test.ts',
    rows: [CAP, SETTLE, SWEEP],
  },
  {
    name: "'use cache' tag replay",
    spec: 'packages/kn-next/src/__tests__/use-cache-breaker-tag-replay.test.ts',
    rows: [CAP, SETTLE, SWEEP],
  },
  {
    name: 'CDN purge queue',
    spec: 'packages/kn-next/src/__tests__/cdn-purge.test.ts',
    rows: [CAP],
  },
];

// The canary: a backlog that never records anything. Every site loses its
// replay (or its queue bound check never sees an entry), so it must go red.
const CANARY = {
  subject: 'backlog',
  anchor: '      if (collapsed) return false;',
  replacement: '      return false;',
};

// The purge queue does not record through the backlog, so its canary is a
// different cap value (a bound of two), not the B01 row itself.
const PURGE_CANARY = {
  subject: 'backlog',
  anchor: 'export const BACKLOG_MAX_ENTRIES = 1000;',
  replacement: 'export const BACKLOG_MAX_ENTRIES = 2;',
};

const provers = SITES.map((site) => ({
  site,
  prover: createGuardProver({
    repoRoot: REPO_ROOT,
    spec: site.spec,
    subjects: { backlog: 'packages/kn-next/src/adapters/tag-backlog.js' },
  }),
}));

console.log('=== mutation proof: the shared tag backlog (#2387) ===');
for (const { site, prover } of provers) prover.preflight(site.rows);
declareMutations(SITES.reduce((n, s) => n + s.rows.length, 0));

for (const { site, prover } of provers) {
  console.log(`\n=== ${site.name}: ${site.spec} ===`);
  prover.baseline();
  prover.proveCanSeeRed(site.rows.length === 1 ? PURGE_CANARY : CANARY);
  for (const m of site.rows) {
    prover.run({ ...m, expect: 'red' });
    recordMutation();
  }
  prover.finish(site.rows.length);
}
