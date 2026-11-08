#!/usr/bin/env node
/**
 * scripts/oke-verify-preamble.mjs — run before every OKE verify (#2173).
 *
 * Three verify claims were checked against an operator that was not the
 * source. This preamble reads the cluster and prints what is actually there:
 *
 *   1. the running operator image digest (the manager container's imageID),
 *   2. whether the live NextApp CRD knows every field the source CRD has,
 *   3. the generation of the `knext-docs` Knative Service.
 *
 * It fails when any of them does not match the expected release candidate.
 * It only reads (`kubectl get`); it never writes to the cluster.
 *
 * USAGE
 *   node scripts/oke-verify-preamble.mjs --expect-operator-digest sha256:<64 hex>
 *        [--expect-ksvc-generation <n>] [--context <kubectl context>]
 *        [--ksvc knext-docs] [--ksvc-namespace knext-docs]
 *
 * `KUBECTL` overrides the kubectl binary (tests use a stub).
 *
 * Exit 0: everything matches. Exit 1: a mismatch, each one printed.
 * Exit 2: bad arguments, or the cluster could not be read. A read failure is
 * never a pass.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse } from 'yaml';
import { diffCrd } from './lib/crd-schema-diff.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const CRD_PATH = resolve(
  ROOT,
  'packages/kn-next-operator/config/crd/bases/apps.kn-next.dev_nextapps.yaml',
);
export const OPERATOR_NAMESPACE = 'kn-next-operator-system';
export const OPERATOR_SELECTOR = 'control-plane=controller-manager';
export const CRD_NAME = 'nextapps.apps.kn-next.dev';
const DIGEST = /^sha256:[0-9a-f]{64}$/;

/**
 * Compare what the cluster reports with what is expected. Pure: no I/O.
 *
 * `podImageIds` are the manager containers' `imageID`s, one per operator pod.
 * Every pod must run the expected digest, so a half-finished rollout fails.
 * `sourceCrd` is the repo CRD and `liveCrd` the cluster's; a field the source
 * has and the cluster lacks (or a narrowed one) is a mismatch.
 *
 * @returns {{ facts: string[], mismatches: string[] }}
 */
export function evaluatePreamble({ podImageIds, liveCrd, sourceCrd, ksvc }, expect) {
  const facts = [];
  const mismatches = [];

  facts.push(
    `operator imageID: ${podImageIds.length ? podImageIds.join(', ') : '(no operator pod)'}`,
  );
  if (podImageIds.length === 0) {
    mismatches.push(`no operator pod matches ${OPERATOR_SELECTOR} in ${OPERATOR_NAMESPACE}`);
  }
  for (const id of podImageIds) {
    const digest = id.slice(id.lastIndexOf('@') + 1);
    if (digest !== expect.operatorDigest) {
      mismatches.push(
        `operator runs ${digest || '(no digest)'}, expected ${expect.operatorDigest}`,
      );
    }
  }

  const crdGaps = diffCrd(sourceCrd, liveCrd).violations;
  facts.push(
    `CRD ${CRD_NAME}: ${crdGaps.length === 0 ? 'covers every source field' : `${crdGaps.length} gap(s)`}`,
  );
  for (const gap of crdGaps) mismatches.push(`live CRD differs from the source: ${gap}`);

  const generation = ksvc?.metadata?.generation;
  facts.push(
    `ksvc ${expect.ksvcNamespace}/${expect.ksvc} generation: ${generation ?? '(missing)'}`,
  );
  if (typeof generation !== 'number') {
    mismatches.push(`ksvc ${expect.ksvcNamespace}/${expect.ksvc} has no metadata.generation`);
  } else if (expect.ksvcGeneration !== undefined && generation !== expect.ksvcGeneration) {
    mismatches.push(`ksvc generation is ${generation}, expected ${expect.ksvcGeneration}`);
  }

  return { facts, mismatches };
}

/** Parse argv. Throws a usage error string on bad input. */
export function parseArgs(argv) {
  const opts = { ksvc: 'knext-docs', ksvcNamespace: 'knext-docs' };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('--')) throw `${flag} needs a value`;
    i++;
    if (flag === '--expect-operator-digest') opts.operatorDigest = value;
    else if (flag === '--expect-ksvc-generation') {
      if (!/^[1-9][0-9]*$/.test(value))
        throw `--expect-ksvc-generation must be a positive integer, got ${value}`;
      opts.ksvcGeneration = Number(value);
    } else if (flag === '--context') opts.context = value;
    else if (flag === '--ksvc') opts.ksvc = value;
    else if (flag === '--ksvc-namespace') opts.ksvcNamespace = value;
    else throw `unknown flag ${flag}`;
  }
  if (!opts.operatorDigest) throw '--expect-operator-digest is required';
  if (!DIGEST.test(opts.operatorDigest))
    throw `--expect-operator-digest must be sha256:<64 hex>, got ${opts.operatorDigest}`;
  return opts;
}

function kubectlJson(opts, args) {
  const kubectl = process.env.KUBECTL || 'kubectl';
  const ctx = opts.context ? ['--context', opts.context] : [];
  const out = execFileSync(kubectl, [...ctx, 'get', ...args, '-o', 'json'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return JSON.parse(out);
}

/** Read the cluster. Any failure throws, and main() turns it into exit 2. */
export function readCluster(opts) {
  const pods = kubectlJson(opts, ['pods', '-n', OPERATOR_NAMESPACE, '-l', OPERATOR_SELECTOR]);
  const podImageIds = (pods.items ?? []).flatMap((pod) =>
    (pod.status?.containerStatuses ?? [])
      .filter((c) => c.name === 'manager')
      .map((c) => c.imageID ?? ''),
  );
  const liveCrd = kubectlJson(opts, ['crd', CRD_NAME]);
  const ksvc = kubectlJson(opts, ['ksvc', opts.ksvc, '-n', opts.ksvcNamespace]);
  return { podImageIds, liveCrd, ksvc };
}

export function main(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (err) {
    process.stderr.write(`oke-verify-preamble: ${err}\n`);
    return 2;
  }
  let cluster;
  let sourceCrd;
  try {
    sourceCrd = parse(readFileSync(CRD_PATH, 'utf8'));
    cluster = readCluster(opts);
  } catch (err) {
    process.stderr.write(
      `oke-verify-preamble: cannot read the cluster or the source CRD: ${err.message}\n`,
    );
    return 2;
  }
  const expect = {
    operatorDigest: opts.operatorDigest,
    ksvcGeneration: opts.ksvcGeneration,
    ksvc: opts.ksvc,
    ksvcNamespace: opts.ksvcNamespace,
  };
  const { facts, mismatches } = evaluatePreamble({ ...cluster, sourceCrd }, expect);
  for (const fact of facts) process.stdout.write(`${fact}\n`);
  if (mismatches.length === 0) {
    process.stdout.write(
      'oke-verify-preamble: OK, the cluster matches the expected release candidate\n',
    );
    return 0;
  }
  for (const m of mismatches) process.stdout.write(`MISMATCH: ${m}\n`);
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exit(main(process.argv.slice(2)));
}
