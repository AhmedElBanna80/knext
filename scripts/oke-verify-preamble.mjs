#!/usr/bin/env node
/**
 * scripts/oke-verify-preamble.mjs — run before every OKE verify (#2173).
 *
 * Three verify claims were checked against an operator that was not the
 * source. This preamble reads the cluster and prints what is actually there:
 *
 *   1. the image the operator's manager container runs (its `imageID`),
 *   2. whether the live NextApp CRD schema equals the source CRD schema,
 *   3. the generation of the `knext-docs` Knative Service.
 *
 * It fails when any of them does not match the expected release candidate.
 * It only reads (`kubectl get`); it never writes to the cluster. It also reads
 * the source CRD from this checkout (`CRD_PATH`).
 *
 * USAGE
 *   node scripts/oke-verify-preamble.mjs --expect-operator-digest sha256:<64 hex>
 *        [--expect-ksvc-generation <n>] [--context <kubectl context>]
 *        [--ksvc knext-docs] [--ksvc-namespace knext-docs]
 *
 * Without --expect-ksvc-generation the ksvc generation is printed and must
 * exist, but is not compared. `KUBECTL` overrides the kubectl binary (tests
 * use a stub).
 *
 * Exit 0: everything matches. Exit 1: a mismatch, each one printed.
 * Exit 2: bad arguments, or the cluster or source CRD could not be read. A read
 * failure is never a pass.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parse } from 'yaml';
import { CRD_PATH as CRD_RELATIVE_PATH } from './crd-schema-diff.mjs';
import { diffCrd } from './lib/crd-schema-diff.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const CRD_PATH = resolve(ROOT, CRD_RELATIVE_PATH);
export const OPERATOR_NAMESPACE = 'kn-next-operator-system';
export const OPERATOR_SELECTOR = 'control-plane=controller-manager';
export const CRD_NAME = 'nextapps.apps.kn-next.dev';
const DIGEST = /^sha256:[0-9a-f]{64}$/;

/** Stable JSON: object keys sorted, so key order never reads as a difference. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

/**
 * Compare the live CRD's versions with the source's. A version must exist on
 * both sides with an identical schema and the same served/storage flags.
 * `diffCrd` (source as the old side) is added for detail: it names a field the
 * cluster lacks or narrows. Exact equality catches the rest, such as a source
 * pattern, required list or CEL rule the cluster dropped.
 */
export function crdMismatches(sourceCrd, liveCrd) {
  const out = [];
  const versions = (crd) => new Map((crd?.spec?.versions ?? []).map((v) => [v?.name, v]));
  const source = versions(sourceCrd);
  const live = versions(liveCrd);
  if (source.size === 0) out.push('the source CRD has no versions');
  for (const [name, sv] of source) {
    const lv = live.get(name);
    if (!lv) {
      out.push(`version "${name}" is missing from the cluster`);
      continue;
    }
    if (sv.served !== lv.served || sv.storage !== lv.storage) {
      out.push(
        `version "${name}": served/storage differ (source ${sv.served}/${sv.storage}, cluster ${lv.served}/${lv.storage})`,
      );
    }
    if (canonical(sv.schema) !== canonical(lv.schema)) {
      out.push(`version "${name}": the schema differs from the source`);
    }
  }
  for (const name of live.keys()) {
    if (!source.has(name)) out.push(`version "${name}" is on the cluster but not in the source`);
  }
  if (out.length > 0) {
    for (const v of diffCrd(sourceCrd, liveCrd).violations) out.push(v);
  }
  return out;
}

/**
 * Compare what the cluster reports with what is expected. Pure: no I/O.
 *
 * `operatorPods` holds one entry per operator pod: `{ name, imageId }`, where
 * `imageId` is the manager container's `imageID`, or '' when the pod has none
 * yet. Every pod must run the expected digest, so a half-finished rollout or a
 * pod still starting fails.
 *
 * @returns {{ facts: string[], mismatches: string[] }}
 */
export function evaluatePreamble({ operatorPods, liveCrd, sourceCrd, ksvc }, expect) {
  const facts = [];
  const mismatches = [];

  if (operatorPods.length === 0) {
    facts.push('operator imageID: (no operator pod)');
    mismatches.push(`no operator pod matches ${OPERATOR_SELECTOR} in ${OPERATOR_NAMESPACE}`);
  }
  for (const pod of operatorPods) {
    facts.push(`operator pod ${pod.name} imageID: ${pod.imageId || '(none)'}`);
    const at = pod.imageId.lastIndexOf('@');
    const digest = at === -1 ? '' : pod.imageId.slice(at + 1);
    if (digest !== expect.operatorDigest) {
      mismatches.push(
        `operator pod ${pod.name} runs ${digest || '(no digest)'}, expected ${expect.operatorDigest}`,
      );
    }
  }

  const crdProblems = crdMismatches(sourceCrd, liveCrd);
  facts.push(
    `CRD ${CRD_NAME}: ${crdProblems.length === 0 ? 'schema equals the source' : `${crdProblems.length} difference(s)`}`,
  );
  for (const p of crdProblems) mismatches.push(`live CRD: ${p}`);

  const generation = ksvc?.metadata?.generation;
  facts.push(
    `ksvc ${expect.ksvcNamespace}/${expect.ksvc} generation: ${generation ?? '(missing)'}`,
  );
  if (!Number.isInteger(generation)) {
    mismatches.push(
      `ksvc ${expect.ksvcNamespace}/${expect.ksvc} has no integer metadata.generation`,
    );
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
  const operatorPods = (pods.items ?? []).map((pod) => {
    const manager = (pod.status?.containerStatuses ?? []).find((c) => c.name === 'manager');
    return { name: pod.metadata?.name ?? '(unnamed)', imageId: manager?.imageID ?? '' };
  });
  const liveCrd = kubectlJson(opts, ['crd', CRD_NAME]);
  const ksvc = kubectlJson(opts, ['ksvc', opts.ksvc, '-n', opts.ksvcNamespace]);
  return { operatorPods, liveCrd, ksvc };
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
  process.exitCode = main(process.argv.slice(2));
}
