#!/usr/bin/env node
/**
 * Mutation proof for the Z7 caller watchdog (D3) and the protected-ref check (D4),
 * guarded by `tests/z7-watchdog-protected-refs.test.ts`. Each mutation removes one
 * fail-closed behaviour; the spec must go RED. Shared harness: anchors must occur
 * exactly once (abort otherwise), restoration is content-addressed, judged on exit
 * codes only.
 *
 * Usage: node scripts/mutation-prove-z7-watchdog-protected-refs.mjs
 */

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { resolveSpecRunner } from './lib/ci-blocking-gate-proof.mjs';
import { mutate, restore, snapshot } from './lib/mutation-harness.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SPEC = 'tests/z7-watchdog-protected-refs.test.ts';
const SPEC_SHA = 'tests/action-pin-own-repo-sha-branch.test.ts';

const PROOF = {
  subjects: {
    watchdog: 'scripts/lib/z7-watchdog.mjs',
    refs: 'scripts/lib/protected-refs.mjs',
    workflow: '.github/workflows/z7-watchdog-nightly.yml',
    pins: 'scripts/verify-action-pins.mjs',
  },
};

const RUNNER = resolveSpecRunner(REPO_ROOT);

function specPasses(spec) {
  const r = spawnSync(RUNNER.command, [...RUNNER.args, ...RUNNER.runArgs(spec)], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return r.status === 0;
}

const MUTATIONS = [
  {
    label: 'zero scheduled runs after the grace passes still does not alert (grace never expires)',
    subject: 'watchdog',
    spec: SPEC,
    anchor: 'if (nowMs < firstExpectedMs + graceMs) {',
    replacement: 'if (true) {',
  },
  {
    label: 'the grace is removed (zero runs before the first due run alerts)',
    subject: 'watchdog',
    spec: SPEC,
    anchor: 'if (nowMs < firstExpectedMs + graceMs) {',
    replacement: 'if (false) {',
  },
  {
    label: 'the dated first-expected constant is moved far into the past',
    subject: 'watchdog',
    spec: SPEC,
    anchor: "Date.parse('2026-11-22T03:23:00Z')",
    replacement: "Date.parse('2020-01-01T00:00:00Z')",
  },
  {
    label: 'manual (dispatch) runs count as scheduled runs',
    subject: 'watchdog',
    spec: SPEC,
    anchor: "r.event === 'schedule' && r.head_branch === 'main'",
    replacement: "r.head_branch === 'main'",
  },
  {
    label: 'other-branch runs count as main runs',
    subject: 'watchdog',
    spec: SPEC,
    anchor: "r.event === 'schedule' && r.head_branch === 'main'",
    replacement: "r.event === 'schedule'",
  },
  {
    label: 'the runs query no longer scopes to branch=main&event=schedule',
    subject: 'watchdog',
    spec: SPEC,
    anchor: '?branch=main&event=schedule&per_page',
    replacement: '?per_page',
  },
  {
    label: 'pagination stops after the first page',
    subject: 'watchdog',
    spec: SPEC,
    anchor: 'if (payload.workflow_runs.length < perPage ||',
    replacement: 'if (true ||',
  },
  {
    label: 'exceeding the page cap returns a partial list instead of throwing',
    subject: 'watchdog',
    spec: SPEC,
    anchor: 'throw new Error(`more than ${maxPages}',
    replacement: 'return all; throw new Error(`more than ${maxPages}',
  },
  {
    label: 'a non-success latest run (cancelled/failure/startup_failure) is ignored',
    subject: 'watchdog',
    spec: SPEC,
    anchor: "if (!IN_FLIGHT.has(latest.status) && latest.conclusion !== 'success') {",
    replacement: 'if (false) {',
  },
  {
    label: 'the in-flight status set is emptied (an in-flight latest run is judged failed)',
    subject: 'watchdog',
    spec: SPEC,
    anchor: "new Set(['queued', 'in_progress', 'waiting', 'requested', 'pending'])",
    replacement: 'new Set([])',
  },
  {
    label: 'the in-flight exemption is dropped from the latest-run check',
    subject: 'watchdog',
    spec: SPEC,
    anchor: '!IN_FLIGHT.has(latest.status) && ',
    replacement: '',
  },
  {
    label: 'the recency sort is dropped (array order decides the latest run)',
    subject: 'watchdog',
    spec: SPEC,
    anchor: '[...runs].sort((a, b) => stamp(b) - stamp(a))',
    replacement: '[...runs]',
  },
  {
    label: 'the staleness window is disabled (an old success counts forever)',
    subject: 'watchdog',
    spec: SPEC,
    anchor: 'if (!lastSuccess || stamp(lastSuccess) < cutoff) {',
    replacement: 'if (!lastSuccess) {',
  },
  {
    label: 'an unparseable timestamp no longer fails closed',
    subject: 'watchdog',
    spec: SPEC,
    anchor: 'if (runs.some((r) => !Number.isFinite(stamp(r)))) {',
    replacement: 'if (false) {',
  },
  {
    label: 'a malformed runs payload no longer throws',
    subject: 'watchdog',
    spec: SPEC,
    anchor: 'if (!payload || !Array.isArray(payload.workflow_runs)) {',
    replacement: 'if (false) {',
  },
  {
    label:
      'the `protected === true` positive arm is dropped (a protected branch reads as unverifiable)',
    subject: 'refs',
    spec: SPEC,
    anchor: 'if (body?.protected === true) {',
    replacement: 'if (false) {',
  },
  {
    label: 'an UNPROTECTED branch is not reported',
    subject: 'refs',
    spec: SPEC,
    anchor: 'else if (body?.protected === false) {',
    replacement: 'else if (false) {',
  },
  {
    label: 'a branch API error is swallowed instead of UNVERIFIABLE',
    subject: 'refs',
    spec: SPEC,
    anchor: 'findings.push(`branch ${ref}: UNVERIFIABLE (${errText(e).split',
    replacement: '0 && findings.push(`branch ${ref}: UNVERIFIABLE (${errText(e).split',
  },
  {
    label: 'a tag shadowing a protected branch name is not reported',
    subject: 'refs',
    spec: SPEC,
    anchor: 'findings.push(`tag ${ref}: EXISTS',
    replacement: '0 && findings.push(`tag ${ref}: EXISTS',
  },
  {
    label: 'a non-404 tag lookup error is treated as absent',
    subject: 'refs',
    spec: SPEC,
    anchor: 'if (!isNotFound(e)) {',
    replacement: 'if (false) {',
  },
  {
    label: 'isNotFound loosens to any \'not found\' text ("command not found" reads as 404)',
    subject: 'refs',
    spec: SPEC,
    anchor: '/\\(HTTP 404\\)|\\bHTTP 404\\b/.test',
    replacement: '/\\(HTTP 404\\)|\\bHTTP 404\\b|not found/i.test',
  },
  {
    label: 'an empty ref set passes',
    subject: 'refs',
    spec: SPEC,
    anchor: 'if (checked === 0) findings.push',
    replacement: 'if (false) findings.push',
  },
  {
    label: 'the exception never expires (the expiry check is deleted)',
    subject: 'refs',
    spec: SPEC,
    anchor: 'if (nowMs >= expires)',
    replacement: 'if (false)',
  },
  {
    label: "the exception's 30-day cap is deleted",
    subject: 'refs',
    spec: SPEC,
    anchor: 'if (expires - granted > EXCEPTION_MAX_DAYS * DAY_MS) {',
    replacement: 'if (false) {',
  },
  {
    label: "the exception's reason check is deleted",
    subject: 'refs',
    spec: SPEC,
    anchor: 'if (exception.reason !== EXCEPTION_REASON)',
    replacement: 'if (false)',
  },
  {
    label: 'the exception no longer gates the issue step',
    subject: 'workflow',
    spec: SPEC,
    anchor: "        if: steps.exception.outputs.active != 'true'\n",
    replacement: '',
  },
  {
    label: 'the z7 alert loses its cancelled arm',
    subject: 'workflow',
    spec: SPEC,
    anchor: "|| needs.z7-watchdog.result == 'cancelled'",
    replacement: '',
  },
  {
    label: 'the protected-refs alert loses its cancelled arm',
    subject: 'workflow',
    spec: SPEC,
    anchor: "|| needs.protected-refs.result == 'cancelled'",
    replacement: '',
  },
  {
    label: 'the z7 alert loses its schedule-event gate',
    subject: 'workflow',
    spec: SPEC,
    anchor: "github.event_name == 'schedule' &&\n      (needs.z7-watchdog",
    replacement: '(needs.z7-watchdog',
  },
  {
    label: 'the protected-refs alert loses its schedule-event gate',
    subject: 'workflow',
    spec: SPEC,
    anchor: "github.event_name == 'schedule' &&\n      (needs.protected-refs",
    replacement: '(needs.protected-refs',
  },
  {
    label: 'the z7 alert loses always() so it never runs after a failed needs',
    subject: 'workflow',
    spec: SPEC,
    anchor: "always() &&\n      github.event_name == 'schedule' &&\n      (needs.z7-watchdog",
    replacement: "github.event_name == 'schedule' &&\n      (needs.z7-watchdog",
  },
  {
    label: 'the two checks share one alert issue title',
    subject: 'workflow',
    spec: SPEC,
    anchor: "title='Protected-ref check RED'",
    replacement: "title='Z7 weekly caller watchdog RED'",
  },
  {
    label: 'own-repo SHA pin: the 40-hex SHA requirement is dropped',
    subject: 'pins',
    spec: SPEC_SHA,
    anchor: "if (!/^[0-9a-f]{40}$/.test(ref ?? '')) return undefined;",
    replacement: '',
  },
  {
    label: 'own-repo SHA pin: the own-repo path-shape check is dropped',
    subject: 'pins',
    spec: SPEC_SHA,
    anchor: "if (!isOwnRepoReusableWorkflow(action, 'main')) return undefined;",
    replacement: '',
  },
  {
    label: 'own-repo SHA pin: any branch comment is accepted, not only PROTECTED_REFS',
    subject: 'pins',
    spec: SPEC_SHA,
    anchor: 'return PROTECTED_REFS.has(branch) ? branch : undefined;',
    replacement: 'return branch || undefined;',
  },
  {
    label: 'own-repo SHA pin: the branch resolution accepts any compare status',
    subject: 'pins',
    spec: SPEC_SHA,
    anchor: "['identical', 'ahead'].includes(res.body?.status)",
    replacement: 'true',
  },
  {
    label: 'own-repo SHA pin: the nightly never resolves the branch comment',
    subject: 'pins',
    spec: SPEC_SHA,
    anchor: 'if (pin.branchPin) {',
    replacement: 'if (false) {',
  },
];

const DECLARED = 37;
declareMutations(DECLARED);

if (MUTATIONS.length !== DECLARED) {
  console.error(`FATAL: declared ${DECLARED} mutations, table has ${MUTATIONS.length}`);
  process.exit(1);
}

console.log('Baseline: every spec must be GREEN before anything is mutated.');
if (![SPEC, SPEC_SHA].every((sp) => specPasses(sp))) {
  console.error('FATAL: baseline is not green to begin with');
  process.exit(1);
}
console.log('   ok baseline green\n');

const decorative = [];
for (const m of MUTATIONS) {
  console.log(`── mutation: ${m.label}`);
  const snap = snapshot(resolve(REPO_ROOT, PROOF.subjects[m.subject]));
  try {
    mutate(snap, m.anchor, m.replacement);
    if (specPasses(m.spec)) {
      console.log('   x DECORATION: the spec stayed GREEN with the behaviour removed');
      decorative.push(m.label);
    } else {
      console.log('   ok went RED as required');
    }
    recordMutation();
  } finally {
    restore(snap);
  }
  if (!specPasses(m.spec)) {
    console.error(`   FATAL: ${m.spec} did not go green again after restore`);
    process.exit(1);
  }
}

console.log(
  `\n${MUTATIONS.length - decorative.length} caught, ${decorative.length} decorative, of ${MUTATIONS.length}.`,
);
if (decorative.length > 0) {
  for (const label of decorative) console.error(`DECORATIVE: ${label}`);
  process.exit(1);
}
