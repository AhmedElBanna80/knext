#!/usr/bin/env node
/**
 * Mutation proof for what a zone function's pod spec may carry of the zone's
 * identity (the operator's render, packages/kn-next-operator): the function
 * mounts NO private key, and its JWKS is a directory VOLUME, never a subPath
 * and never an env var, so a rotated key set reaches a running pod.
 *
 * The guards are plain `go test` unit tests (no cluster, no envtest). Until now
 * the only mutation proof of these properties was the hand-run, cluster-bound
 * `packages/grpc/e2e/z7-identity-kind/mutation-prove-operator.sh`; nothing the
 * nightly lane runs would have noticed a guard here going soft. Every row
 * breaks ONE rule in `backendservice_render.go` and must turn a guard red:
 *
 *   F1  the JWKS is mounted through a subPath (the kubelet never updates a
 *       subPath mount, so a rotation would not reach a warm pod);
 *   F2  the JWKS reaches the function through env (configMapKeyRef);
 *   F3  the JWKS is inlined into an env value;
 *   F4  the zone's signing-key Secret is a volume of the function;
 *   F5  the zone's signing key reaches the function as an env secretKeyRef.
 *
 * Besides the rows: a CANARY (F1, graded first, must go red or the harness
 * cannot see red) and a NEUTRAL control (the same volume name, spelled as a
 * concatenation) that must stay GREEN, or a runner that fails for any mutation
 * would certify the whole table.
 *
 * Verdicts are by EXIT CODE only, every anchor must occur exactly once
 * (preflight first), the baseline must be green, every row is BUILD-CHECKED
 * first (a row is killed by a failing assertion, never by a compile error), and
 * every restore is content-verified by the harness.
 *
 * NOT A JS TEST SUITE: the guards are Go tests, so there is no vitest runner to
 * resolve. Path-listed in `NON_JS_TEST_SUITE_PROVERS` (`lib/prover-lane.mjs`);
 * spawns only `go`, run in `packages/kn-next-operator`.
 *
 * What this does not prove: that a running cluster honours the render (the Z7
 * kind lane in CI checks the pod it gets); the cluster-bound operator prover
 * covers the operator end of that.
 *
 * Exit 0 = every row went red as required; 1 = a row survived; 2 = the prover
 * could not run (anchor drift, red baseline, a mutation that does not compile).
 *
 * Usage:  node scripts/mutation-prove-2051-function-pod-spec.mjs
 */

import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertTreeClean } from './lib/guard-prover.mjs';
import { mutate, restore, snapshot } from './lib/mutation-harness.mjs';
import { declareMutations, recordMutation } from './lib/prover-report.mjs';

const NAME = 'mutation-prove-2051-function-pod-spec';
const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
// The Go module (the commands' cwd), not a mutation subject.
const OPERATOR_MODULE = `${REPO_ROOT}/packages/kn-next-operator`;
// biome-ignore format: one-line resolve() for the anchor-drift scan
const RENDER = resolve(REPO_ROOT, 'packages/kn-next-operator/internal/controller/backendservice_render.go');

const PROVER = { subjects: { render: RENDER } };

const PKG = './internal/controller/';
// The unit guards for the function pod spec: the JWKS volume and mount (no
// subPath, optional, read-only, the zone's own), the leak scan over every
// channel (volumes, projected, env, envFrom, the spec as JSON), and the shared
// fixture the Z7 kind lane reads.
const GUARDS = [
  'TestRenderMountsTheZoneJWKSUnlessUntrusted',
  'TestFunctionRenderSetsTheVerifierIdentityAndNoPrivateKey',
  'TestSharedZoneIdentityFixture',
].join('|');

const MUTATIONS = [
  {
    id: 'F1',
    claim:
      'the JWKS is mounted through a subPath (a rotated key set would not reach a running pod)',
    subject: 'render',
    anchor:
      '\t\tmounts = append(mounts, corev1.VolumeMount{Name: FunctionJWKSVolumeName, MountPath: ZoneJWKSMountDir, ReadOnly: true})\n',
    replacement:
      '\t\tmounts = append(mounts, corev1.VolumeMount{Name: FunctionJWKSVolumeName, MountPath: ZoneJWKSMountDir + "/" + ZoneJWKSFileName, SubPath: ZoneJWKSFileName, ReadOnly: true})\n',
  },
  {
    id: 'F2',
    claim: 'the JWKS reaches the function through an env var sourced from the ConfigMap',
    subject: 'render',
    anchor: '\t\tEnv:          functionIdentityEnv(bs),\n',
    replacement:
      '\t\tEnv:          append(functionIdentityEnv(bs), corev1.EnvVar{Name: "KNEXT_JWKS", ValueFrom: &corev1.EnvVarSource{ConfigMapKeyRef: &corev1.ConfigMapKeySelector{LocalObjectReference: corev1.LocalObjectReference{Name: ZoneJWKSConfigMapName(bs.Spec.Zone)}, Key: ZoneJWKSFileName}}}),\n',
  },
  {
    id: 'F3',
    claim: 'the JWKS is inlined into an env value',
    subject: 'render',
    anchor: '\t\tEnv:          functionIdentityEnv(bs),\n',
    replacement:
      '\t\tEnv:          append(functionIdentityEnv(bs), corev1.EnvVar{Name: "KNEXT_JWKS", Value: `{"keys":[]}`}),\n',
  },
  {
    id: 'F4',
    claim: "the zone's signing-key Secret is a volume of the function",
    subject: 'render',
    anchor: '\tspec.Volumes = volumes\n',
    replacement:
      '\tspec.Volumes = append(volumes, corev1.Volume{Name: "zone-key", VolumeSource: corev1.VolumeSource{Secret: &corev1.SecretVolumeSource{SecretName: ZoneSigningKeySecretName(bs.Spec.Zone)}}})\n',
  },
  {
    id: 'F5',
    claim: "the zone's signing key reaches the function as an env secretKeyRef",
    subject: 'render',
    anchor: '\t\tEnv:          functionIdentityEnv(bs),\n',
    replacement:
      '\t\tEnv:          append(functionIdentityEnv(bs), corev1.EnvVar{Name: "ZONE_KEY", ValueFrom: &corev1.EnvVarSource{SecretKeyRef: &corev1.SecretKeySelector{LocalObjectReference: corev1.LocalObjectReference{Name: ZoneSigningKeySecretName(bs.Spec.Zone)}, Key: "current.key"}}}),\n',
  },
];

// A mutation that changes NOTHING about behaviour (the same volume name, spelled
// as a concatenation): every guard must stay green.
const NEUTRAL = {
  id: 'N01',
  claim: 'control: the same JWKS volume name, spelled as a concatenation, changes nothing',
  subject: 'render',
  anchor: '\t\t\tName: FunctionJWKSVolumeName,\n',
  replacement: '\t\t\tName: FunctionJWKSVolumeName + "",\n',
};

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

/** The guards. -count=1: never trust a cached verdict for a mutated tree. */
const guardExit = () => run(['test', '-count=1', '-run', `^(${GUARDS})$`, PKG]);

/** The mutated tree must still COMPILE its tests, or the row proves nothing. */
const buildsExit = () => run(['test', '-count=1', '-run', '^$', PKG], { showErrors: true });

/** Plant one mutation, return the guards' exit code; the subject is restored either way. */
function grade(m) {
  assertTreeClean(REPO_ROOT, `before ${m.id}`);
  const snap = snapshot(PROVER.subjects[m.subject]);
  let built;
  let code;
  try {
    mutate(snap, m.anchor, m.replacement);
    built = buildsExit();
    code = built === 0 ? guardExit() : undefined;
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
console.log(`${NAME}: ${MUTATIONS.length} mutations declared (+ canary and neutral control)`);

// Preflight: every anchor occurs exactly once BEFORE anything expensive runs.
for (const m of [...MUTATIONS, NEUTRAL]) {
  const count =
    snapshot(PROVER.subjects[m.subject]).bytes.toString('utf8').split(m.anchor).length - 1;
  if (count !== 1) {
    console.error(
      `${NAME}: ${m.id}'s anchor occurs ${count} times in ${PROVER.subjects[m.subject]}; aborting`,
    );
    process.exit(2);
  }
}

// Green baseline on a clean tree: the guards, and the package compiling its tests.
assertTreeClean(REPO_ROOT, 'baseline');
if (buildsExit() !== 0) {
  console.error(`${NAME}: baseline does not compile; fix the tree first`);
  process.exit(2);
}
const base = guardExit();
if (base !== 0) {
  console.error(`${NAME}: baseline RED (exit ${base}); fix the tree first`);
  process.exit(2);
}
console.log(`${NAME}: baseline green`);

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

// The neutral control must stay green.
const neutral = grade(NEUTRAL);
if (neutral !== 0) {
  console.error(
    `${NAME}: the neutral control went RED (exit ${neutral}); the runner is not trustworthy`,
  );
  process.exit(2);
}
console.log(`control ok: ${NEUTRAL.id} stays green — ${NEUTRAL.claim}`);

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
