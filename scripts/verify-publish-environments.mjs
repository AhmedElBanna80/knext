#!/usr/bin/env node
/**
 * Read-only verifier for the publish environments (#2035 items (c) and (d)).
 *
 * Environment settings are founder/admin actions; this is the code side. It
 * exits 1 until BOTH hold:
 *   - `npm-publish` and `npm-publish-latest` each carry a custom deployment
 *     branch policy whose branch entries are EXACTLY the publish-lane allowlist
 *     (`PUBLISH_LANES`): no glob, no extra branch, no tag entry, none missing.
 *   - `npm-publish-latest` exists with a `required_reviewers` rule.
 *
 * It only issues GET requests (`gh api`), never mutates settings, and fails
 * closed: an unreadable API or state file is a non-zero exit, never a pass.
 *
 * Usage:
 *   node scripts/verify-publish-environments.mjs [--repo owner/name]
 *   node scripts/verify-publish-environments.mjs --state <file.json>   (offline)
 *
 * NOTE: release.yml must not name `npm-publish-latest` until this exits 0:
 * a job naming a missing environment auto-creates it with no protection.
 */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PUBLISH_LANES } from './publish-lane-guard.mjs';

const ENVS = ['npm-publish', 'npm-publish-latest'];
const EXPECTED = [...PUBLISH_LANES.keys()].map((r) => r.replace(/^refs\/heads\//, ''));

/** @returns {string[]} problems; empty = configured correctly. */
export function evaluatePublishEnvironments(state) {
  const problems = [];
  const envs = Array.isArray(state?.environments) ? state.environments : null;
  if (!envs) return ['state has no environments array'];
  for (const name of ENVS) {
    const e = envs.find((x) => x.name === name);
    if (!e) {
      problems.push(`environment ${name} does not exist`);
      continue;
    }
    if (e.deployment_branch_policy?.custom_branch_policies !== true) {
      problems.push(`${name}: no custom branch policy (any ref may deploy)`);
    }
    if (
      name === 'npm-publish-latest' &&
      !(e.protection_rules ?? []).some((r) => r.type === 'required_reviewers')
    ) {
      problems.push(`${name}: no required reviewer`);
    }
    const entries = state.policies?.[name];
    if (!Array.isArray(entries)) {
      problems.push(`${name}: branch policies not readable`);
      continue;
    }
    const names = [];
    for (const p of entries) {
      if (p.type && p.type !== 'branch') problems.push(`${name}: non-branch policy ${p.name}`);
      if (/[*?[\]]/.test(p.name)) problems.push(`${name}: glob policy ${p.name}`);
      names.push(p.name);
    }
    for (const want of EXPECTED) {
      if (!names.includes(want)) problems.push(`${name}: missing lane ${want}`);
    }
    for (const got of names) {
      if (!EXPECTED.includes(got) && !/[*?[\]]/.test(got)) {
        problems.push(`${name}: branch ${got} is not on the publish-lane allowlist`);
      }
    }
  }
  return problems;
}

function gh(path) {
  return JSON.parse(execFileSync('gh', ['api', path, '--paginate'], { encoding: 'utf8' }));
}

function loadLive(repo) {
  const envs = gh(`repos/${repo}/environments`).environments ?? [];
  const policies = {};
  for (const name of ENVS) {
    if (!envs.some((e) => e.name === name)) continue;
    try {
      policies[name] =
        gh(`repos/${repo}/environments/${name}/deployment-branch-policies`).branch_policies ?? [];
    } catch (err) {
      // GitHub answers 404 when the env has no custom branch policy at all; that
      // is a finding (reported by the evaluator), not an unreadable API.
      if (!/Not Found|404/.test(String(err.stderr ?? err.message))) throw err;
      policies[name] = [];
    }
  }
  return { environments: envs, policies };
}

function main(argv) {
  try {
    const i = argv.indexOf('--state');
    const r = argv.indexOf('--repo');
    const state =
      i >= 0
        ? JSON.parse(readFileSync(argv[i + 1], 'utf8'))
        : loadLive(r >= 0 ? argv[r + 1] : 'getknext-dev/knext');
    const problems = evaluatePublishEnvironments(state);
    for (const p of problems) console.error(`FAIL ${p}`);
    if (problems.length === 0) console.log('publish environments: OK');
    return problems.length === 0 ? 0 : 1;
  } catch (err) {
    console.error(`FAIL could not verify (fail-closed): ${err.message}`);
    return 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
