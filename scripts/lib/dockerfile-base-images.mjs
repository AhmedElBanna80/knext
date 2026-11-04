/**
 * Dockerfile base-image reference scan — the PR-time (FORM + CONSISTENCY) half
 * of the base-image pin discipline (#2660). Dependency-free ESM.
 *
 * Division of labour, as for action pins (security.md):
 *  - HERE, at PR time: every Dockerfile is DISCOVERED (never enumerated), every
 *    external `FROM` / `COPY --from=<image>` must carry a digest and be
 *    parseable, and one `repo:tag` must map to ONE digest across the tree.
 *    Whether that digest is what the registry serves today is deliberately NOT
 *    asked here: the answer legitimately changes, and freezing it into a
 *    committed assertion reddens every correct bump.
 *  - `scripts/verify-image-pins.mjs`, nightly: resolves each pin against the
 *    registry; an unreachable registry is a failure, never a pass.
 *
 * A reference this scan cannot classify FAILS (`unparseable`) rather than being
 * skipped: a build-arg `FROM ${BASE}` is exactly the shape that escapes a
 * regex-only guard.
 *
 * Exclusions live in `security/dockerfile-base-exclusions.json`. An entry needs
 * `covers`, `justification`, `added` and `expires` (ISO dates) and at least one
 * of `file` / `image`. An expired or malformed entry suppresses nothing and is
 * itself a finding, so an exclusion cannot silently become permanent.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', '.next', '.turbo', '.claude']);
const DOCKERFILE_NAME = /^(Dockerfile[^/]*|[^/]+\.Dockerfile)$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
/** `[registry/]path[:tag][@sha256:…]` — no variable expansion, no whitespace. */
const IMAGE_TOKEN = /^[a-zA-Z0-9][a-zA-Z0-9._\-/:]*(?:@sha256:[0-9a-f]{64})?$/;

/**
 * @typedef {{
 *   file?: string,
 *   image?: string,
 *   digest?: string,
 *   covers: string[],
 *   justification?: string,
 *   added?: string,
 *   expires?: string,
 * }} Exclusion
 * @typedef {{
 *   file: string,
 *   line: number,
 *   image: string,
 *   origin: 'FROM' | 'COPY' | 'RUN',
 *   kind: string,
 *   key?: string,
 *   digest?: string,
 * }} Ref
 * @typedef {{
 *   reason: string,
 *   detail?: string,
 *   file?: string,
 *   line?: number,
 *   image?: string,
 *   entry?: Exclusion,
 * }} Finding
 */

export const EXCLUSION_FILE = 'security/dockerfile-base-exclusions.json';
export const KNOWN_CHECKS = [
  'unpinned',
  'unparseable',
  'tag-digest-conflict',
  'registry-resolution',
];

/** Every Dockerfile-shaped file under `root`, repo-relative and sorted. */
export function discoverDockerfiles(root) {
  const base = resolve(root);
  const found = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const child = join(dir, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (DOCKERFILE_NAME.test(entry.name)) found.push(relative(base, child));
    }
  };
  walk(base);
  return found.sort();
}

/** Canonical `registry/path[:tag]`, Docker Hub defaults applied. */
function normalizeKey(nameAndTag) {
  const slash = nameAndTag.indexOf('/');
  const first = slash === -1 ? '' : nameAndTag.slice(0, slash);
  const hasRegistry = first.includes('.') || first.includes(':') || first === 'localhost';
  let registry = hasRegistry ? first : 'registry-1.docker.io';
  let path = hasRegistry ? nameAndTag.slice(slash + 1) : nameAndTag;
  let tag = '';
  const colon = path.lastIndexOf(':');
  if (colon > path.lastIndexOf('/')) {
    tag = path.slice(colon);
    path = path.slice(0, colon);
  }
  if (registry === 'docker.io') registry = 'registry-1.docker.io';
  if (registry === 'registry-1.docker.io' && !path.includes('/')) path = `library/${path}`;
  return `${registry}/${path}${tag}`;
}

function classify(image, file, line, stages, origin) {
  const base = { file, line, image, origin };
  if (origin === 'FROM' && image === 'scratch') return { ...base, kind: 'scratch' };
  if (stages.has(image) || (origin === 'COPY' && /^\d+$/.test(image))) {
    return { ...base, kind: 'stage' };
  }
  if (!IMAGE_TOKEN.test(image)) return { ...base, kind: 'unparseable' };
  const [nameAndTag, digest] = image.split('@');
  const key = normalizeKey(nameAndTag);
  if (!digest) return { ...base, kind: 'unpinned', key };
  return { ...base, kind: 'pinned', key, digest: DIGEST.test(digest) ? digest : undefined };
}

/**
 * Instructions with backslash continuations joined, each tagged with the
 * physical line it STARTS on. Blank and comment lines are dropped, including
 * inside a continuation (Docker ignores them there too).
 */
function* logicalLines(text) {
  let pending = '';
  let start = 0;
  for (const [index, raw] of text.split('\n').entries()) {
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    if (pending === '') start = index + 1;
    if (trimmed.endsWith('\\')) {
      pending += `${trimmed.slice(0, -1)} `;
      continue;
    }
    yield { line: (pending + trimmed).trim(), number: start };
    pending = '';
  }
  if (pending !== '') yield { line: pending.trim(), number: start };
}

/**
 * Every external-image reference in one Dockerfile's text, in order.
 * @param {string} text
 * @param {string} file
 * @returns {Ref[]}
 */
export function parseDockerfileRefs(text, file) {
  const refs = [];
  const stages = new Set();
  for (const { line, number } of logicalLines(text)) {
    const from = /^FROM\s+(.*)$/i.exec(line);
    if (from) {
      const tokens = from[1].split(/\s+/).filter((t) => !t.startsWith('--'));
      const image = tokens[0];
      if (image === undefined) {
        refs.push({ file, line: number, image: '', origin: 'FROM', kind: 'unparseable' });
        continue;
      }
      refs.push(classify(image, file, number, stages, 'FROM'));
      const alias = /\bAS\s+([\w.-]+)/i.exec(from[1]);
      if (alias) stages.add(alias[1]);
      continue;
    }
    const copy = /^COPY\s+.*?--from=(\S+)/i.exec(line);
    if (copy && !stages.has(copy[1])) {
      refs.push(classify(copy[1], file, number, stages, 'COPY'));
    }
    // `RUN --mount=type=bind,from=<image>` pulls an image exactly as COPY --from does.
    if (/^RUN\s/i.test(line)) {
      for (const mount of line.matchAll(/--mount=(\S+)/gi)) {
        const source = /(?:^|,)from=([^,\s]+)/i.exec(mount[1]);
        if (source && !stages.has(source[1])) {
          refs.push(classify(source[1], file, number, stages, 'RUN'));
        }
      }
    }
  }
  return refs.filter((r) => r.kind !== 'stage' && r.kind !== 'scratch');
}

const isoDate = (value) =>
  typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}$/.test(value) &&
  !Number.isNaN(Date.parse(value));

/** Why an exclusion entry is unusable, or undefined when it is well-formed. */
export function exclusionProblem(entry) {
  if (!entry || typeof entry !== 'object') return 'not an object';
  if (!entry.file && !entry.image) return 'needs `file` and/or `image`';
  if (!Array.isArray(entry.covers) || entry.covers.length === 0) return 'needs non-empty `covers`';
  const unknown = entry.covers.filter((c) => !KNOWN_CHECKS.includes(c));
  if (unknown.length) return `unknown check(s) in \`covers\`: ${unknown.join(', ')}`;
  // A registry-resolution exclusion would otherwise hide ANY digest on the tag, so
  // it must name the exact file and the exact digest it tolerates (#2665).
  if (entry.covers.includes('registry-resolution')) {
    if (!entry.file) return 'a registry-resolution exclusion needs an exact `file`';
    if (!DIGEST.test(entry.digest ?? '')) {
      return 'a registry-resolution exclusion needs the exact `digest` it tolerates';
    }
  }
  if (typeof entry.justification !== 'string' || entry.justification.trim() === '') {
    return 'needs a `justification`';
  }
  if (!isoDate(entry.added)) return 'needs an ISO `added` date';
  if (!isoDate(entry.expires)) return 'needs an ISO `expires` date';
  return undefined;
}

export const isExpired = (entry, today) => Date.parse(entry.expires) < today.getTime();

/**
 * @param {string} root
 * @returns {Exclusion[]}
 */
export function loadExclusions(root) {
  const path = resolve(root, EXCLUSION_FILE);
  if (!existsSync(path)) return [];
  return JSON.parse(readFileSync(path, 'utf8')).allow ?? [];
}

/**
 * Does an UNEXPIRED, well-formed exclusion cover `check` for this reference?
 * `ref` is `{ file, key?, image?, digest? }`; an entry carrying `digest` matches only that digest.; `image` may be written `repo:tag` or in
 * canonical `registry/path:tag` form.
 * @param {Exclusion[]} exclusions
 * @param {string} check
 * @param {{ file?: string, key?: string, image?: string, digest?: string }} ref
 * @param {Date} [today]
 */
export function isExcluded(exclusions, check, ref, today = new Date()) {
  return exclusions.some((entry) => {
    if (exclusionProblem(entry) || isExpired(entry, today)) return false;
    if (!entry.covers.includes(check)) return false;
    if (entry.file && entry.file !== ref.file) return false;
    if (entry.digest && entry.digest !== ref.digest) return false;
    if (entry.image) {
      const wanted = entry.image;
      const names = [ref.key, ref.image?.split('@')[0]].filter(Boolean);
      if (!names.some((n) => n === wanted || n === normalizeKey(wanted))) return false;
    }
    return true;
  });
}

/**
 * Scan every Dockerfile under `root`.
 * Returns `{ files, refs, findings }`; an empty `findings` is the only pass.
 * @param {string} root
 * @param {{ exclusions?: Exclusion[], today?: Date }} [options]
 * @returns {{ files: string[], refs: Ref[], findings: Finding[] }}
 */
export function checkDockerfiles(root, { exclusions = [], today = new Date() } = {}) {
  const files = discoverDockerfiles(root);
  if (files.length === 0) {
    return {
      files,
      refs: [],
      findings: [{ reason: 'no-dockerfiles', detail: `no Dockerfile found under ${root}` }],
    };
  }
  const findings = [];
  for (const entry of exclusions) {
    const problem = exclusionProblem(entry);
    if (problem) {
      findings.push({ reason: 'exclusion-invalid', detail: problem, entry });
    } else if (isExpired(entry, today)) {
      findings.push({
        reason: 'exclusion-expired',
        detail: `expired ${entry.expires}: ${entry.file ?? ''} ${entry.image ?? ''}`.trim(),
        entry,
      });
    }
  }

  const refs = files.flatMap((file) =>
    parseDockerfileRefs(readFileSync(resolve(root, file), 'utf8'), file),
  );
  for (const ref of refs) {
    let reason;
    let detail;
    if (ref.kind === 'unparseable') {
      reason = 'unparseable';
      detail = 'cannot be resolved statically (variable or malformed reference); pin it literally';
    } else if (ref.kind === 'unpinned') {
      reason = 'unpinned';
      detail = 'external image without an @sha256 digest';
    } else if (ref.kind === 'pinned' && !ref.digest) {
      reason = 'unparseable';
      detail = 'malformed digest (need sha256:<64 hex>)';
    }
    if (reason && !isExcluded(exclusions, reason, ref, today)) {
      findings.push({ reason, file: ref.file, line: ref.line, image: ref.image, detail });
    }
  }

  const byKey = new Map();
  for (const ref of refs) {
    if (ref.kind !== 'pinned' || !ref.digest) continue;
    const seen = byKey.get(ref.key) ?? new Map();
    seen.set(ref.digest, [...(seen.get(ref.digest) ?? []), `${ref.file}:${ref.line}`]);
    byKey.set(ref.key, seen);
  }
  for (const [key, digests] of byKey) {
    if (
      digests.size > 1 &&
      !isExcluded(exclusions, 'tag-digest-conflict', { key, file: undefined })
    ) {
      findings.push({
        reason: 'tag-digest-conflict',
        image: key,
        detail:
          `${key} is pinned to ${digests.size} different digests: ` +
          [...digests].map(([d, where]) => `${d} (${where.join(', ')})`).join('; '),
      });
    }
  }
  return { files, refs, findings };
}
