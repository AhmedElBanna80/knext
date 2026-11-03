#!/usr/bin/env node
/**
 * docker-hub-mirror-guard.mjs — #2106.
 *
 * Anonymous Docker Hub pulls from shared GitHub runners hit the unauthenticated
 * rate limit (`toomanyrequests`), which reds jobs unrelated to the PR under test.
 * The fix needs no secret: route Docker Hub through `mirror.gcr.io`, a
 * pull-through mirror that serves the SAME digests, so every `@sha256` pin stays
 * valid (verified against the pinned oven/bun, node, alpine and redis digests).
 *
 * Mechanism (jev pick 0.94 over rewriting every ref 0.06 / per-job secret 0.00):
 * the composite action `.github/actions/docker-hub-mirror` sets the docker
 * daemon's `registry-mirrors` and writes a buildkitd config for the buildx
 * `docker-container` driver (which ignores daemon mirrors). A job that pulls must
 * run that step BEFORE its first pulling step. `services:` / `container:`
 * images are pulled by the runner before any step, so they cannot use a step:
 * their image must carry the `mirror.gcr.io/` prefix (or another registry host).
 *
 * This scanner FAILS CLOSED the same way `workflow-script-install-guard.mjs`
 * does: a job that pulls and does not mirror is a violation; there is no skip.
 *
 * DEFERRED (frozen) workflows: `test-e2e-deploy.yml` and `compat-vinext.yml` are
 * in the v1.0 credential fingerprint set; editing them moves the fingerprints.
 * They are listed in DEFERRED_FROZEN and skipped, and the test asserts each is
 * STILL frozen, so the deferral cannot outlive the credential window silently.
 * TODO(#2650): apply the mirror to them once the credential window closes (the
 * compat shards' Docker Hub pulls live in the frozen scripts/e2e-deploy*.sh).
 *
 * Skipping is not silence (#2650): every deferred file carries a pinned BASELINE of its
 * known unmirrored pull sites (UNMIRRORED_BASELINE). `baselineDrift` is red when a NEW
 * pull appears (a fresh anonymous Docker Hub pull in a file the scan skips) AND when a
 * baselined pull disappears (stale baseline: the mirror work landed, so the deferral and
 * its entry must go in the same change). DEFERRAL_TRACKER names the open tracking issue
 * and each file's removal condition.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const MIRROR_HOST = 'mirror.gcr.io';
export const MIRROR_ACTION = './.github/actions/docker-hub-mirror';

/**
 * Derived copy of the frozen `test-e2e-deploy.yml` (its header declares it equals
 * derive(test-e2e-deploy.yml) plus declared substitutions, and a test enforces
 * that), whose pulls happen inside the frozen `scripts/e2e-deploy*.sh`. Editing it
 * alone would break the derivation. TODO(#2650): apply with the frozen pair.
 */
export const DEFERRED_DERIVED = Object.freeze(['.github/workflows/compat-credential-v1.3.yml']);

/**
 * `bun-base-build.yml` pins an EXACT reviewed step order/run text for its
 * submit/download/verify/sign chain (`tests/bun-base-supply-chain.test.ts`); adding
 * a step is a signing-chain change that needs its own review. Its one pull is
 * `docker run alpine` in the verify step. TODO(#2650): mirror it under that review.
 */
export const DEFERRED_PINNED = Object.freeze(['.github/workflows/bun-base-build.yml']);

/**
 * `anonymous-install-nightly.yml` is audited to hold NO credential and NO extra action or
 * step (`auditAnonymousWorkflowJob` allowlists exactly checkout + one run command), so a
 * mirror step cannot be added without weakening that audit. It does not need one: its
 * script talks to registries over `fetch` and never invokes docker (the only
 * `docker pull` text in it is a doc comment). A test asserts the script imports no
 * `child_process`, so this exemption cannot outlive that fact.
 */
export const EXEMPT_NO_DOCKER_PULL = Object.freeze([
  '.github/workflows/anonymous-install-nightly.yml',
]);

export const DEFERRED_FROZEN = Object.freeze([
  '.github/workflows/test-e2e-deploy.yml',
  '.github/workflows/compat-vinext.yml',
]);

/**
 * Open tracker for every DEFERRED_* / baseline entry below, and what closes it.
 * @type {Readonly<{ issue: number, closes: string, removal: Readonly<Record<string, string>> }>}
 */
export const DEFERRAL_TRACKER = Object.freeze({
  issue: 2650,
  closes:
    'the credential window closes and the frozen files are mirrored in the same change that updates the fingerprint; DEFERRED_FROZEN / DEFERRED_DERIVED and their UNMIRRORED_BASELINE entries are deleted; bun-base-build.yml (DEFERRED_PINNED) is mirrored under its signing-chain review',
  removal: Object.freeze({
    '.github/workflows/test-e2e-deploy.yml':
      'while credential-frozen (enforced by tests/docker-hub-mirror-guard.test.ts); delete when the window closes and the mirror lands with the fingerprint update',
    '.github/workflows/compat-vinext.yml':
      'while credential-frozen (enforced by tests/docker-hub-mirror-guard.test.ts); delete when the window closes and the mirror lands with the fingerprint update',
    '.github/workflows/compat-credential-v1.3.yml':
      'while a generated derived copy (enforced by tests/docker-hub-mirror-guard.test.ts); re-derive with test-e2e-deploy.yml and delete',
    '.github/workflows/bun-base-build.yml':
      'while its step order is pinned by tests/bun-base-supply-chain.test.ts; delete when the verify step is mirrored under signing-chain review',
  }),
});

/**
 * Known unmirrored pull sites per deferred file, as `<path>: <command>` entries (one per
 * occurrence, comment lines excluded) across the workflow and the scripts it references.
 * Regenerate with `pullSites(file)`; changing an entry is a reviewed decision.
 * Typed as a record keyed by file, not by the literal's four keys: callers (and the
 * guard tests) probe one deferred file at a time, and the literal type would reject that.
 * @type {Readonly<Record<string, readonly string[]>>}
 */
export const UNMIRRORED_BASELINE = Object.freeze({
  '.github/workflows/test-e2e-deploy.yml': Object.freeze([
    'scripts/e2e-deploy.sh: docker run --rm --name "${CONTAINER_NAME}" --network host --user "$(id -u):$(id -g)" -e PORT="${PORT}" -e HOSTNAME="" -e NODE_ENV="production" -e NEXT_DEPLOYMENT_ID="${DEPLOYMENT_ID}" ${PUBLIC_ORIGIN_DOCKER_ARGS[@]+"${PUBLIC_ORIGIN_DOCKER_ARGS[@]}"} -v "${STANDALONE_ROOT}:${CONTAINER_ROOT}" -w "${CONTAINER_WORKDIR}" "${STANDALONE_BUN_IMAGE}" "./$(basename "${SERVER_BOOT_TARGET}")"',
    'scripts/e2e-deploy.sh: docker run --rm --name "${ED_SUITE_CONTAINER}" --network host --user "$(id -u):$(id -g)" -e PORT="${PORT}" -e HOSTNAME="" -e NODE_ENV="production" -e NEXT_DEPLOYMENT_ID="${DEPLOYMENT_ID}" ${PUBLIC_ORIGIN_DOCKER_ARGS[@]+"${PUBLIC_ORIGIN_DOCKER_ARGS[@]}"} -v "${EMPTY_DIR}:${EMPTY_DIR}" -w "${EMPTY_DIR}" "${STANDALONE_BUN_IMAGE}" "./$(basename "${EMPTY_DIR_STAGED}")"',
    'scripts/e2e-deploy.sh: docker run --rm --name "${EMPTY_DIR_CONTAINER}" --network host --user "${EMPTY_DIR_UID_GID}" -e PORT="${EMPTY_DIR_PORT}" -e HOSTNAME="" -e NODE_ENV="production" -e NEXT_DEPLOYMENT_ID="${DEPLOYMENT_ID}" -v "${EMPTY_DIR}:${EMPTY_DIR}" -w "${EMPTY_DIR}" "${STANDALONE_BUN_IMAGE}" "./$(basename "${EMPTY_DIR_STAGED}")"; then',
    'scripts/e2e-deploy.sh: docker run --rm -e "KNEXT_COMPAT_MODE=${KNEXT_COMPAT_MODE:-}" -v "${STANDALONE_ROOT}:${STANDALONE_ROOT}" -v "${SCRIPT_DIR}/e2e-native-rebuild-musl.sh:/e2e-native-rebuild-musl.sh:ro" -v "${SCRIPT_DIR}/lib/musl-lockfile-lookup.sh:/lib/musl-lockfile-lookup.sh:ro" "${MUSL_LOCKFILE_MOUNTS[@]+"${MUSL_LOCKFILE_MOUNTS[@]}"}" "${STANDALONE_BUN_IMAGE}" sh /e2e-native-rebuild-musl.sh "${STANDALONE_ROOT}" /musl-native-lockfiles >&2',
  ]),
  '.github/workflows/compat-vinext.yml': Object.freeze([]),
  '.github/workflows/compat-credential-v1.3.yml': Object.freeze([
    'scripts/e2e-deploy.sh: docker run --rm --name "${CONTAINER_NAME}" --network host --user "$(id -u):$(id -g)" -e PORT="${PORT}" -e HOSTNAME="" -e NODE_ENV="production" -e NEXT_DEPLOYMENT_ID="${DEPLOYMENT_ID}" ${PUBLIC_ORIGIN_DOCKER_ARGS[@]+"${PUBLIC_ORIGIN_DOCKER_ARGS[@]}"} -v "${STANDALONE_ROOT}:${CONTAINER_ROOT}" -w "${CONTAINER_WORKDIR}" "${STANDALONE_BUN_IMAGE}" "./$(basename "${SERVER_BOOT_TARGET}")"',
    'scripts/e2e-deploy.sh: docker run --rm --name "${ED_SUITE_CONTAINER}" --network host --user "$(id -u):$(id -g)" -e PORT="${PORT}" -e HOSTNAME="" -e NODE_ENV="production" -e NEXT_DEPLOYMENT_ID="${DEPLOYMENT_ID}" ${PUBLIC_ORIGIN_DOCKER_ARGS[@]+"${PUBLIC_ORIGIN_DOCKER_ARGS[@]}"} -v "${EMPTY_DIR}:${EMPTY_DIR}" -w "${EMPTY_DIR}" "${STANDALONE_BUN_IMAGE}" "./$(basename "${EMPTY_DIR_STAGED}")"',
    'scripts/e2e-deploy.sh: docker run --rm --name "${EMPTY_DIR_CONTAINER}" --network host --user "${EMPTY_DIR_UID_GID}" -e PORT="${EMPTY_DIR_PORT}" -e HOSTNAME="" -e NODE_ENV="production" -e NEXT_DEPLOYMENT_ID="${DEPLOYMENT_ID}" -v "${EMPTY_DIR}:${EMPTY_DIR}" -w "${EMPTY_DIR}" "${STANDALONE_BUN_IMAGE}" "./$(basename "${EMPTY_DIR_STAGED}")"; then',
    'scripts/e2e-deploy.sh: docker run --rm -e "KNEXT_COMPAT_MODE=${KNEXT_COMPAT_MODE:-}" -v "${STANDALONE_ROOT}:${STANDALONE_ROOT}" -v "${SCRIPT_DIR}/e2e-native-rebuild-musl.sh:/e2e-native-rebuild-musl.sh:ro" -v "${SCRIPT_DIR}/lib/musl-lockfile-lookup.sh:/lib/musl-lockfile-lookup.sh:ro" "${MUSL_LOCKFILE_MOUNTS[@]+"${MUSL_LOCKFILE_MOUNTS[@]}"}" "${STANDALONE_BUN_IMAGE}" sh /e2e-native-rebuild-musl.sh "${STANDALONE_ROOT}" /musl-native-lockfiles >&2',
  ]),
  '.github/workflows/bun-base-build.yml': Object.freeze([
    '.github/workflows/bun-base-build.yml: docker run --rm -v "$PWD/out:/w:ro" -e HEAD="$head" "$ALPINE_IMAGE" sh -euc \'',
  ]),
});

/** A `mirror.gcr.io/<repo>[:tag][@sha256:...]` token inside shell text. */
const MIRROR_REF_IN_TEXT = /mirror\.gcr\.io\/[\w./-]+(?::[\w.-]+)?(?:@sha256:[0-9a-f]{64})?/g;

/** Pull-capable docker verbs: the long `image`/`container` forms and `create` (pulls a missing image) included. */
const DOCKER_VERB = String.raw`\bdocker\s+(?:(?:image|container)\s+)?(?:build|buildx|pull|run|create|compose|load)\b`;
/** A command/action that makes the runner or buildkit pull from a registry. */
const PULLING = new RegExp(
  `${DOCKER_VERB}|\\bkind\\s+create\\b|docker/build-push-action|docker/setup-buildx-action|helm/kind-action|\\buses:\\s*['"]?docker://`,
);
/** A script a job runs that itself pulls. */
const PULLING_SCRIPT = new RegExp(`${DOCKER_VERB}|\\bkind\\s+create\\b`);
const SCRIPT_REF = /(?:^|[\s"'`(])((?:\.\/)?scripts\/[\w./-]+\.(?:sh|mjs|js|ts)(?![\w]))/g;

const PULL_TOKEN = new RegExp(PULLING.source, 'g');
/** Any `scripts/<file>` reference, including `${{ github.workspace }}/knext/scripts/...`. */
const ANY_SCRIPT_REF = /(?:^|[^\w.-])((?:\.\/)?scripts\/[\w./-]+\.(?:sh|mjs|js|ts)(?![\w]))/g;

const codeOnly = (text) =>
  text
    .split('\n')
    .filter((l) => !/^\s*(?:#|\/\/|\*|\/\*)/.test(l))
    .join('\n');

/** Join shell `\` line continuations so a pull's image on the next line is part of its entry. */
const joinContinuations = (text) => text.replace(/\\\n\s*/g, ' ');

/** `services:` / `container:` images of a workflow, as `<kind>(<job>) <ref>` strings. */
function containerImages(wfText) {
  const out = [];
  const doc = parse(wfText);
  for (const [id, job] of Object.entries(doc?.jobs ?? {})) {
    if (!job || typeof job !== 'object') continue;
    if (job.container) {
      out.push(`container(${id}) ${JSON.stringify(job.container.image ?? job.container)}`);
    }
    for (const [name, svc] of Object.entries(job.services ?? {})) {
      out.push(`services(${id}.${name}) ${JSON.stringify(svc?.image)}`);
    }
  }
  return out;
}

/**
 * Every pulling construct in a workflow and the scripts it references (transitively, with
 * cycle protection), as sorted `<path>: <command and the rest of its line>` entries with
 * multiplicity (comment lines excluded). The entry carries the image token, so swapping the
 * image at a baselined site is drift. `services:` / `container:` images are entries too.
 * A referenced script that does not exist THROWS (fail closed).
 */
export function pullSites(rel, repoRoot = REPO_ROOT) {
  const rawWf = readFileSync(join(repoRoot, rel), 'utf8');
  const paths = new Map([[rel, joinContinuations(codeOnly(rawWf))]]);
  const queue = [rel];
  while (queue.length) {
    const cur = queue.shift();
    for (const m of paths.get(cur).matchAll(ANY_SCRIPT_REF)) {
      const p = m[1].replace(/^\.\//, '');
      if (paths.has(p)) continue;
      const abs = join(repoRoot, p);
      if (!existsSync(abs)) {
        throw new Error(`${cur} references ${p}, which does not exist; cannot scan it for pulls`);
      }
      paths.set(p, joinContinuations(codeOnly(readFileSync(abs, 'utf8'))));
      queue.push(p);
    }
  }
  const out = [];
  for (const [p, text] of paths) {
    for (const line of text.split('\n')) {
      for (const m of line.matchAll(PULL_TOKEN)) {
        out.push(`${p}: ${line.slice(m.index).replace(/\s+/g, ' ').trim()}`);
      }
    }
  }
  if (/\.ya?ml$/.test(rel)) for (const c of containerImages(rawWf)) out.push(`${rel}: ${c}`);
  return out.sort();
}

/** Multiset difference a - b. */
function multisetMinus(a, b) {
  const left = [...b];
  const out = [];
  for (const x of a) {
    const i = left.indexOf(x);
    if (i < 0) out.push(x);
    else left.splice(i, 1);
  }
  return out;
}

/**
 * Deferred files whose real pull sites differ from the pinned baseline.
 * `added` = a new unmirrored pull; `removed` = a baselined pull that is gone (stale).
 * @param {string} [repoRoot]
 * @param {Readonly<Record<string, readonly string[]>>} [baseline]
 * @returns {{ file: string, added: string[], removed: string[] }[]}
 */
export function baselineDrift(repoRoot = REPO_ROOT, baseline = UNMIRRORED_BASELINE) {
  const out = [];
  for (const [file, expected] of Object.entries(baseline)) {
    const actual = pullSites(file, repoRoot);
    const want = [...expected].sort();
    const added = multisetMinus(actual, want);
    const removed = multisetMinus(want, actual);
    if (added.length || removed.length) out.push({ file, added, removed });
  }
  return out;
}

function stepText(step) {
  return `${step.run ?? ''}\n${step.uses ?? ''}\n${JSON.stringify(step.with ?? {})}`;
}

function scriptPulls(text, repoRoot) {
  for (const m of text.matchAll(SCRIPT_REF)) {
    const p = join(repoRoot, m[1].replace(/^\.\//, ''));
    if (existsSync(p) && PULLING_SCRIPT.test(readFileSync(p, 'utf8'))) return true;
  }
  return false;
}

function isMirrorStep(step) {
  if (step.uses === MIRROR_ACTION) return true;
  // Inline form, for jobs that run before any checkout (a local action needs one).
  return (
    typeof step.run === 'string' &&
    step.run.includes(MIRROR_HOST) &&
    /registry-mirrors/.test(step.run)
  );
}

/** Index of the first step that pulls images, or -1. */
export function firstPullIndex(steps, repoRoot = REPO_ROOT) {
  return steps.findIndex((s) => {
    const t = stepText(s);
    return PULLING.test(t) || scriptPulls(t, repoRoot);
  });
}

/** Is a `services:`/`container:` image ref safe? mirror prefix, or a non-Docker-Hub registry host. */
export function imageRefOk(ref) {
  if (typeof ref !== 'string') return true; // expression-only refs are judged by the author
  if (ref.startsWith('${{')) return true;
  const first = ref.split('/')[0];
  // The mirror serves the same digests, so a mirrored ref keeps the digest pin: a bare tag
  // through the mirror is still a mutable pull (security.md: pin images by digest).
  if (ref.startsWith(`${MIRROR_HOST}/`)) return /@sha256:[0-9a-f]{64}$/.test(ref);
  // A registry host has a dot or colon, or is localhost. Otherwise it is Docker Hub.
  return ref.includes('/') && (/[.:]/.test(first) || first === 'localhost');
}

/**
 * @param {string} repoRoot
 * @param {{ deferred?: readonly string[] }} [opts]
 * @returns {{ file: string, job: string, reason: string }[]}
 */
export function findViolations(
  repoRoot = REPO_ROOT,
  {
    deferred = [
      ...DEFERRED_FROZEN,
      ...DEFERRED_DERIVED,
      ...DEFERRED_PINNED,
      ...EXEMPT_NO_DOCKER_PULL,
    ],
  } = {},
) {
  const dir = join(repoRoot, '.github', 'workflows');
  const out = [];
  for (const f of readdirSync(dir).sort()) {
    if (!f.endsWith('.yml') && !f.endsWith('.yaml')) continue;
    const rel = `.github/workflows/${f}`;
    if (deferred.includes(rel)) continue;
    const doc = parse(readFileSync(join(dir, f), 'utf8'));
    for (const [id, job] of Object.entries(doc?.jobs ?? {})) {
      if (!job || job.uses) continue; // reusable-workflow call: judged in the callee
      const containers = [];
      if (job.container) containers.push(job.container.image ?? job.container);
      for (const svc of Object.values(job.services ?? {})) containers.push(svc?.image);
      for (const img of containers) {
        if (!imageRefOk(img)) {
          out.push({
            file: rel,
            job: id,
            reason: `container/service image "${img}" is an anonymous Docker Hub pull; prefix it with ${MIRROR_HOST}/ (digest unchanged)`,
          });
        }
      }
      const steps = Array.isArray(job.steps) ? job.steps : [];
      // A mirrored image named in a run step (`docker run mirror.gcr.io/...`) keeps its pin.
      for (const st of steps) {
        for (const m of String(st.run ?? '').matchAll(MIRROR_REF_IN_TEXT)) {
          if (!/@sha256:[0-9a-f]{64}$/.test(m[0])) {
            out.push({
              file: rel,
              job: id,
              reason: `mirrored image "${m[0]}" in a step has no @sha256 pin`,
            });
          }
        }
      }
      const first = firstPullIndex(steps, repoRoot);
      if (first < 0) continue;
      // The buildx docker-container driver ignores the daemon mirror: its setup
      // step must be handed the buildkitd config (or use the docker driver).
      for (const st of steps) {
        if (!/^docker\/setup-buildx-action@/.test(st.uses ?? '')) continue;
        const w = st.with ?? {};
        if (!w['buildkitd-config'] && !w['buildkitd-config-inline'] && w.driver !== 'docker') {
          out.push({
            file: rel,
            job: id,
            reason:
              'setup-buildx-action has no buildkitd-config (its docker-container driver ignores the daemon mirror)',
          });
        }
      }
      const mirrored = steps.findIndex(isMirrorStep);
      if (mirrored < 0 || mirrored > first) {
        out.push({
          file: rel,
          job: id,
          reason: `pulls images (step ${first + 1}) without a preceding ${MIRROR_ACTION} step`,
        });
      }
    }
  }
  return out;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const v = findViolations();
  for (const d of baselineDrift()) {
    for (const a of d.added) {
      v.push({
        file: d.file,
        job: '-',
        reason: `new unmirrored pull not in the #${DEFERRAL_TRACKER.issue} baseline: ${a}`,
      });
    }
    for (const r of d.removed) {
      v.push({
        file: d.file,
        job: '-',
        reason: `stale #${DEFERRAL_TRACKER.issue} baseline entry (pull gone; remove the deferral): ${r}`,
      });
    }
  }
  for (const x of v) console.error(`::error file=${x.file}::${x.job}: ${x.reason}`);
  process.exit(v.length === 0 ? 0 : 1);
}
