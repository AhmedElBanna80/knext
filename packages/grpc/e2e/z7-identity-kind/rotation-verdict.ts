#!/usr/bin/env bun
/**
 * `bun rotation-verdict.ts <probes.jsonl>`: the verdict of the real-time rotation's
 * property (c), decided from the probes run.sh recorded, so the decision has unit
 * tests that need no cluster (packages/grpc/src/__tests__/z7-rotation-verdict.test.ts).
 *
 * Property (c): a token of the STAGED key is refused by the warm function until the
 * JWKS has propagated to it. Each line of the file is one probe:
 * `{"phase":"pre"|"post","status":401,"code":"unauthenticated"}`. `pre` is a probe
 * sent BEFORE the JWKS publish was confirmed (informational: it cannot show that a
 * refusal outlasted the publish); `post` is one sent AFTER it. The refusal counts
 * only if a `post` probe saw it, so a first `post` probe that is already a 200
 * proves nothing and fails.
 *
 * Exit 0 and one line on stdout when the property holds; exit 1 and the reason on
 * stderr when it does not. Prints no token or key.
 */

import { readFileSync } from 'node:fs';

export interface StaleKeyProbe {
  phase: 'pre' | 'post';
  status: number | null;
  code: string;
}

export type Verdict = { ok: true; postRefusals: number } | { ok: false; reason: string };

const refused = (p: StaleKeyProbe) => p.status === 401 && p.code === 'unauthenticated';

export function staleKeyVerdict(probes: readonly StaleKeyProbe[]): Verdict {
  const pre = probes.filter((p) => p.phase === 'pre');
  const post = probes.filter((p) => p.phase === 'post');
  for (const p of pre) {
    if (!refused(p)) {
      return {
        ok: false,
        reason: `the probe before the publish was confirmed was not refused as unauthenticated (status=${p.status} code=${p.code})`,
      };
    }
  }
  let postRefusals = 0;
  for (const [i, p] of post.entries()) {
    if (p.status === 200) {
      if (postRefusals < 1) {
        return {
          ok: false,
          reason:
            'the warm function accepted the staged key on the first probe after the publish was confirmed: the refusal before propagation was not observed',
        };
      }
      if (i !== post.length - 1) {
        return { ok: false, reason: 'probes continued after the staged key was accepted' };
      }
      return { ok: true, postRefusals };
    }
    if (!refused(p)) {
      return {
        ok: false,
        reason: `a probe after the publish was neither accepted nor refused as unauthenticated (status=${p.status} code=${p.code})`,
      };
    }
    postRefusals++;
  }
  return {
    ok: false,
    reason: `the warm function never accepted the staged key (${postRefusals} refusals after the publish)`,
  };
}

if (import.meta.main) {
  const file = process.argv[2];
  if (!file) {
    console.error('rotation-verdict: usage: rotation-verdict.ts <probes.jsonl>');
    process.exit(64);
  }
  const probes = readFileSync(file, 'utf8')
    .split('\n')
    .filter((l) => l.trim() !== '')
    .map((l) => JSON.parse(l) as StaleKeyProbe);
  const v = staleKeyVerdict(probes);
  if (!v.ok) {
    console.error(`rotation-verdict: ${v.reason}`);
    process.exit(1);
  }
  console.log(`(c) holds: ${v.postRefusals} refusals after the publish, then accepted`);
}
