#!/usr/bin/env node
/**
 * Mutation proof for the operator's half of the zone identity token
 * (packages/kn-next-operator), with no cluster and no envtest: what a function
 * pod may carry of the zone's identity, and the order a signing key rotates in.
 *
 * Until now the only mutation proof of either was the hand-run, cluster-bound
 * `packages/grpc/e2e/z7-identity-kind/mutation-prove-operator.sh` (about an
 * hour, a kind cluster, and nothing the nightly lane runs): a unit guard here
 * going soft would have gone unnoticed until someone ran it by hand. Every row
 * breaks ONE rule in the operator source and must turn the NAMED unit guard red.
 *
 *   F*  the function pod spec (backendservice_render.go): the function mounts NO
 *       private key, and its JWKS is a directory VOLUME, never a subPath and
 *       never env, so a rotated key set reaches a running pod.
 *         F1 the JWKS is mounted through a subPath (the kubelet never updates a
 *            subPath mount, so a rotation would not reach a warm pod);
 *         F2 the JWKS reaches the function through env (configMapKeyRef);
 *         F3 the JWKS is inlined into an env value;
 *         F4 the zone's signing-key Secret is a volume of the function;
 *         F5 the zone's signing key reaches the function as an env secretKeyRef;
 *         F6 every function mounts one SHARED JWKS instead of its own zone's.
 *   O*  the rotation order (zone_signing_key.go): publish the new public key,
 *       wait the propagation bound, only then switch signing, retire the old key
 *       after the overlap, never project the staged key into the zone's pod.
 *         O1 the propagation bound is not waited (signing switches in the pass
 *            that publishes the key: the order the warm-pod test says must fail);
 *         O2 the staged key is left out of the JWKS (a switch to a key no
 *            verifier knows);
 *         O3 the previous key is left out of the JWKS (no overlap);
 *         O4 the overlap is zero;
 *         O5 the previous key is retired without waiting the overlap;
 *         O6 the staged key is projected into the zone's pod;
 *         O7 the publish time is never stamped (the wait counts from nothing);
 *         O8 a switch does not keep the old key as previous;
 *         O9 a retirement keeps the previous key.
 *
 * Besides the rows: a CANARY (F1, graded first, must go red or the harness
 * cannot see red) and a NEUTRAL control per family (the same value spelled
 * differently) that must stay GREEN, or a runner that fails for any mutation
 * would certify the whole table.
 *
 * Verdicts are by EXIT CODE only, every anchor must occur exactly once
 * (preflight first), every distinct guard set must be green on the unmutated
 * tree, every row is BUILD-CHECKED first (a row is killed by a failing
 * assertion, never by a compile error), and every restore is content-verified
 * by the harness. Each row names the guard that must kill it, so a row that
 * some unrelated test happens to redden does not count.
 *
 * NOT A JS TEST SUITE: the guards are Go tests, so there is no vitest runner to
 * resolve. Path-listed in `NON_JS_TEST_SUITE_PROVERS` (`lib/prover-lane.mjs`);
 * spawns only `go`, run in `packages/kn-next-operator`.
 *
 * What this does not prove: that a running cluster honours the render and the
 * rotation (the Z7 kind lane in CI checks the pods it gets, and the cluster-bound
 * operator prover re-checks the same rules against a live operator).
 *
 * KNEXT_PROVER_ROWS=F,O1 runs only the rows whose id starts with one of the
 * comma-separated prefixes, while iterating on one family; the declared count
 * follows the selection. Unset (the nightly lane), the whole table runs.
 *
 * Exit 0 = every row went red as required; 1 = a row survived; 2 = the prover
 * could not run (anchor drift, red baseline, a mutation that does not compile).
 *
 * Usage:  node scripts/mutation-prove-2051-z7-operator-guards.mjs
 */

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertTreeClean } from './lib/guard-prover.mjs';
import { mutate, restore, snapshot } from './lib/mutation-harness.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const NAME = 'mutation-prove-2051-z7-operator-guards';
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// The Go module (the commands' cwd), not a mutation subject.
const OPERATOR_MODULE = `${REPO_ROOT}/packages/kn-next-operator`;
// biome-ignore format: one-line resolve() for the anchor-drift scan
const RENDER = resolve(REPO_ROOT, 'packages/kn-next-operator/internal/controller/backendservice_render.go');
// biome-ignore format: one-line resolve() for the anchor-drift scan
const PLANNER = resolve(REPO_ROOT, 'packages/kn-next-operator/internal/controller/zone_signing_key.go');

const PROVER = { subjects: { render: RENDER, planner: PLANNER } };

const PKG = './internal/controller/';
// Go source uses tabs.
const T = '\t';

// The unit guards. Plain `go test` functions: no envtest binaries needed.
const POD_SPEC =
  'TestRenderMountsTheZoneJWKSUnlessUntrusted|TestFunctionRenderSetsTheVerifierIdentityAndNoPrivateKey|TestSharedZoneIdentityFixture';
const NEVER_BEFORE_BOUND =
  'TestPlannerNeverSwitchesBeforeThePropagationBound|TestRotationIsCrashSafeAtEveryWrite';
const OVERLAP = 'TestPlannerRetiresOnlyAfterTheOverlap|TestRotationIsCrashSafeAtEveryWrite';
const ZONE_MOUNT = 'TestApplyZoneIdentityMountsTheKeyAsADirectoryVolume';
const CRASH_SAFE = 'TestRotationIsCrashSafeAtEveryWrite';
const OVERLAP_FIXTURE = 'TestPlannerRetiresOnlyAfterTheOverlap|TestSharedZoneIdentityFixture';
// The union of the rotation guards above, for the neutral control.
const ROTATION = [
  ...new Set(
    [NEVER_BEFORE_BOUND, OVERLAP, ZONE_MOUNT, CRASH_SAFE, OVERLAP_FIXTURE].flatMap((s) =>
      s.split('|'),
    ),
  ),
].join('|');

const PUBLIC_KEYS_HEAD = `func (s signingKeySet) publicKeys() []ed25519.PublicKey {\n${T}var out []ed25519.PublicKey\n${T}for _, k := range []*zoneKey{s.current, s.next, s.previous} {`;

const ALL_MUTATIONS = [
  // ── F: the function pod spec ──────────────────────────────────────────────
  {
    id: 'F1',
    claim:
      'the JWKS is mounted through a subPath (a rotated key set would not reach a running pod)',
    subject: 'render',
    anchor:
      '\t\tmounts = append(mounts, corev1.VolumeMount{Name: FunctionJWKSVolumeName, MountPath: ZoneJWKSMountDir, ReadOnly: true})\n',
    replacement:
      '\t\tmounts = append(mounts, corev1.VolumeMount{Name: FunctionJWKSVolumeName, MountPath: ZoneJWKSMountDir + "/" + ZoneJWKSFileName, SubPath: ZoneJWKSFileName, ReadOnly: true})\n',
    test: POD_SPEC,
  },
  {
    id: 'F2',
    claim: 'the JWKS reaches the function through an env var sourced from the ConfigMap',
    subject: 'render',
    anchor: '\t\tEnv:          functionIdentityEnv(bs),\n',
    replacement:
      '\t\tEnv:          append(functionIdentityEnv(bs), corev1.EnvVar{Name: "KNEXT_JWKS", ValueFrom: &corev1.EnvVarSource{ConfigMapKeyRef: &corev1.ConfigMapKeySelector{LocalObjectReference: corev1.LocalObjectReference{Name: ZoneJWKSConfigMapName(bs.Spec.Zone)}, Key: ZoneJWKSFileName}}}),\n',
    test: POD_SPEC,
  },
  {
    id: 'F3',
    claim: 'the JWKS is inlined into an env value',
    subject: 'render',
    anchor: '\t\tEnv:          functionIdentityEnv(bs),\n',
    replacement:
      '\t\tEnv:          append(functionIdentityEnv(bs), corev1.EnvVar{Name: "KNEXT_JWKS", Value: `{"keys":[]}`}),\n',
    test: POD_SPEC,
  },
  {
    id: 'F4',
    claim: "the zone's signing-key Secret is a volume of the function",
    subject: 'render',
    anchor: '\tspec.Volumes = volumes\n',
    replacement:
      '\tspec.Volumes = append(volumes, corev1.Volume{Name: "zone-key", VolumeSource: corev1.VolumeSource{Secret: &corev1.SecretVolumeSource{SecretName: ZoneSigningKeySecretName(bs.Spec.Zone)}}})\n',
    test: POD_SPEC,
  },
  {
    id: 'F5',
    claim: "the zone's signing key reaches the function as an env secretKeyRef",
    subject: 'render',
    anchor: '\t\tEnv:          functionIdentityEnv(bs),\n',
    replacement:
      '\t\tEnv:          append(functionIdentityEnv(bs), corev1.EnvVar{Name: "ZONE_KEY", ValueFrom: &corev1.EnvVarSource{SecretKeyRef: &corev1.SecretKeySelector{LocalObjectReference: corev1.LocalObjectReference{Name: ZoneSigningKeySecretName(bs.Spec.Zone)}, Key: "current.key"}}}),\n',
    test: POD_SPEC,
  },
  {
    id: 'F6',
    claim:
      "every function mounts one SHARED JWKS instead of its own zone's (a token from any zone verifies if its iss check is ever lost)",
    subject: 'render',
    anchor: 'Name: ZoneJWKSConfigMapName(bs.Spec.Zone)},',
    replacement: 'Name: "knext-shared-jwks"},',
    test: POD_SPEC,
  },
  // ── O: the rotation order ─────────────────────────────────────────────────
  {
    id: 'O1',
    claim:
      'the propagation bound is not waited (signing switches in the pass that publishes the new key)',
    subject: 'planner',
    anchor: 'if due := k.nextPublishedAt.Add(cfg.PropagationBound); in.now.Before(due) {',
    replacement: 'if due := k.nextPublishedAt; in.now.Before(due) {',
    test: NEVER_BEFORE_BOUND,
  },
  {
    id: 'O2',
    claim: 'the staged key is left out of the JWKS (signing switches to a key no verifier knows)',
    subject: 'planner',
    anchor: PUBLIC_KEYS_HEAD,
    replacement: PUBLIC_KEYS_HEAD.replace(
      's.current, s.next, s.previous',
      's.current, nil, s.previous',
    ),
    test: NEVER_BEFORE_BOUND,
  },
  {
    id: 'O3',
    claim: 'the previous key is left out of the JWKS (a token signed just before the switch fails)',
    subject: 'planner',
    anchor: PUBLIC_KEYS_HEAD,
    replacement: PUBLIC_KEYS_HEAD.replace(
      's.current, s.next, s.previous',
      's.current, s.next, nil',
    ),
    test: 'TestPlannerRetiresOnlyAfterTheOverlap',
  },
  {
    id: 'O4',
    claim: 'the overlap is zero',
    subject: 'planner',
    anchor: 'ZoneKeyOverlap = time.Hour',
    replacement: 'ZoneKeyOverlap = 0 * time.Hour',
    test: OVERLAP_FIXTURE,
  },
  {
    id: 'O5',
    claim: 'the previous key is retired without waiting the overlap',
    subject: 'planner',
    anchor: 'if due := k.switchedAt.Add(ZoneKeyOverlap); in.now.Before(due) {',
    replacement: 'if due := k.switchedAt; in.now.Before(due) {',
    test: OVERLAP,
  },
  {
    id: 'O6',
    claim: "the staged key is projected into the zone's pod",
    subject: 'planner',
    anchor:
      'for _, k := range []string{signingKeyCurrentKey, signingKeyCurrentKid, signingKeyPreviousKey, signingKeyPreviousKid} {',
    replacement:
      'for _, k := range []string{signingKeyCurrentKey, signingKeyCurrentKid, signingKeyPreviousKey, signingKeyPreviousKid, signingKeyNextKey, signingKeyNextKid} {',
    test: ZONE_MOUNT,
  },
  {
    id: 'O7',
    claim: 'the publish time is never stamped (the propagation wait counts from nothing)',
    subject: 'planner',
    anchor: 'if w.nextFreshlyPublished || k.nextPublishedAt.IsZero() {',
    replacement: 'if false {',
    test: NEVER_BEFORE_BOUND,
  },
  {
    id: 'O8',
    claim: 'a switch does not keep the old key as previous (no overlap at all)',
    subject: 'planner',
    anchor: 'w.keys.previous, w.keys.current, w.keys.next = w.keys.current, w.keys.next, nil',
    replacement: 'w.keys.previous, w.keys.current, w.keys.next = nil, w.keys.next, nil',
    test: CRASH_SAFE,
  },
  {
    id: 'O9',
    claim: 'a retirement keeps the previous key (the old key never leaves the JWKS)',
    subject: 'planner',
    anchor: `case zkRetirePrevious:\n${T}${T}w.keys.previous = nil\n`,
    replacement: 'case zkRetirePrevious:\n',
    test: CRASH_SAFE,
  },
];

// Optional: run one family of rows while iterating, for example
// KNEXT_PROVER_ROWS=F,O1. A comma list of id prefixes. Unset, the whole table
// runs, which is what the nightly lane does; the declared count follows the
// selection so a partial run reports honestly.
const ROW_FILTER = (process.env.KNEXT_PROVER_ROWS ?? '').split(',').filter(Boolean);
const MUTATIONS =
  ROW_FILTER.length === 0
    ? ALL_MUTATIONS
    : ALL_MUTATIONS.filter((m) => ROW_FILTER.some((prefix) => m.id.startsWith(prefix)));
if (MUTATIONS.length === 0) {
  console.error(`${NAME}: KNEXT_PROVER_ROWS=${ROW_FILTER.join(',')} selects no row`);
  process.exit(2);
}

// Mutations that change NOTHING about behaviour (the same value, spelled
// differently): every guard of their family must stay green.
const NEUTRALS = [
  {
    id: 'N01',
    claim: 'control: the same JWKS volume name, spelled as a concatenation, changes nothing',
    subject: 'render',
    anchor: '\t\t\tName: FunctionJWKSVolumeName,\n',
    replacement: '\t\t\tName: FunctionJWKSVolumeName + "",\n',
    test: POD_SPEC,
  },
  {
    id: 'N02',
    claim: 'control: the same one-hour overlap, spelled as 60 minutes, changes nothing',
    subject: 'planner',
    anchor: 'ZoneKeyOverlap = time.Hour',
    replacement: 'ZoneKeyOverlap = 60 * time.Minute',
    test: ROTATION,
  },
];

// --- the go driver ---------------------------------------------------------

function run(args, { showErrors = false } = {}) {
  const r = spawnSync('go', args, {
    cwd: OPERATOR_MODULE,
    // stderr is kept ONLY to explain a failed build check to a human; no
    // verdict ever reads it (verdicts are exit codes).
    stdio: ['ignore', 'ignore', showErrors ? 'pipe' : 'ignore'],
    timeout: 1_800_000,
  });
  if (r.error || r.status === null) {
    console.error(`${NAME}: cannot run go: ${r.error?.message ?? r.signal}`);
    process.exit(2);
  }
  if (showErrors && r.status !== 0) console.error(String(r.stderr ?? '').slice(-2000));
  return r.status;
}

/** A row's guard. -count=1: never trust a cached verdict for a mutated tree. */
const guardExit = (test) => run(['test', '-count=1', '-run', `^(${test})$`, PKG]);

/** The mutated tree must still COMPILE its tests, or the row proves nothing. */
const buildsExit = () => run(['test', '-count=1', '-run', '^$', PKG], { showErrors: true });

/** Plant one mutation, return its guard's exit code; the subject is restored either way. */
function grade(m) {
  assertTreeClean(REPO_ROOT, `before ${m.id}`);
  const snap = snapshot(PROVER.subjects[m.subject]);
  let built;
  let code;
  try {
    mutate(snap, m.anchor, m.replacement);
    built = buildsExit();
    code = built === 0 ? guardExit(m.test) : undefined;
  } finally {
    restore(snap);
  }
  assertTreeClean(REPO_ROOT, `after ${m.id}`);
  if (built !== 0) {
    console.error(
      `${NAME}: ${m.id}'s mutation does not compile (exit ${built}); the row proves nothing`,
    );
    process.exit(2);
  }
  return code;
}

// --- main ---------------------------------------------------------------------

declareMutations(MUTATIONS.length);
console.log(`${NAME}: ${MUTATIONS.length} mutations declared (+ canary and neutral controls)`);

// The controls that apply to the selected rows: a neutral per family present.
const familiesPresent = new Set(MUTATIONS.map((m) => m.subject));
const neutrals = NEUTRALS.filter((n) => familiesPresent.has(n.subject));

// Preflight: every anchor occurs exactly once BEFORE anything expensive runs.
for (const m of [...MUTATIONS, ...neutrals]) {
  const count =
    snapshot(PROVER.subjects[m.subject]).bytes.toString('utf8').split(m.anchor).length - 1;
  if (count !== 1) {
    console.error(
      `${NAME}: ${m.id}'s anchor occurs ${count} times in ${PROVER.subjects[m.subject]}; aborting`,
    );
    process.exit(2);
  }
}

// Green baseline on a clean tree: the package compiling its tests, and every
// distinct guard set passing.
assertTreeClean(REPO_ROOT, 'baseline');
if (buildsExit() !== 0) {
  console.error(`${NAME}: baseline does not compile; fix the tree first`);
  process.exit(2);
}
const seen = new Set();
for (const m of [...MUTATIONS, ...neutrals]) {
  if (seen.has(m.test)) continue;
  seen.add(m.test);
  const code = guardExit(m.test);
  if (code !== 0) {
    console.error(`${NAME}: baseline RED for ${m.id}'s guard (exit ${code}); fix the tree first`);
    process.exit(2);
  }
}
console.log(`${NAME}: baseline green (${seen.size} distinct guard sets)`);

// STEP 0: the harness can SEE red. A real mutation of a real subject, graded by
// the same runner: if it stays green, nothing below means anything.
const canary = grade({ ...MUTATIONS[0], id: 'canary' });
if (canary === 0) {
  console.error(
    `${NAME}: the canary mutation left the guards GREEN; the harness cannot observe red`,
  );
  process.exit(2);
}
console.log(`step 0 ok: the harness sees red (canary exit=${canary})`);

// The neutral controls must stay green.
for (const neutral of neutrals) {
  const code = grade(neutral);
  if (code !== 0) {
    console.error(
      `${NAME}: the neutral control ${neutral.id} went RED (exit ${code}); the runner is not trustworthy`,
    );
    process.exit(2);
  }
  console.log(`control ok: ${neutral.id} stays green — ${neutral.claim}`);
}

let failed = 0;
for (const m of MUTATIONS) {
  const code = grade(m);
  recordMutation();
  const ok = code !== 0;
  if (!ok) failed++;
  console.log(`${ok ? 'KILLED   ' : '*** SURVIVED ***'} ${m.id} exit=${code} — ${m.claim}`);
}

console.log(`${NAME}: ${MUTATIONS.length - failed}/${MUTATIONS.length} rows went red as required`);
process.exit(failed === 0 ? 0 : 1);
