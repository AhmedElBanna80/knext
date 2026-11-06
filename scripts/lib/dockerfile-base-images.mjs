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
 * Scope of the consistency check: `tag-digest-conflict` compares Dockerfile references only.
 * Pins in workflows, templates and GitLab CI are held by their literal-digest tests and the
 * nightly resolver, not by this scan.
 *
 * The reader follows Docker, not a regex: `ONBUILD` triggers, a leading `# escape=` directive,
 * quoted/CSV `--mount` fields, case-insensitive stage names, numeric stage indexes (only when
 * that stage exists) and heredoc bodies (never read as instructions).
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
 *   origin: 'FROM' | 'COPY' | 'RUN' | 'PARSER' | 'SYNTAX',
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
  'unpinned-frontend',
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

/**
 * `ctx.names` holds lower-cased stage names (Docker matches them case-insensitively);
 * `ctx.count` is how many stages have been opened so far, so a numeric `--from=N`
 * is a stage index only when stage N already exists. Otherwise Docker reads it as
 * an image named `N`, and so do we.
 */
function classify(image, file, line, ctx, origin) {
  const base = { file, line, image, origin };
  if (origin === 'FROM' && image === 'scratch') return { ...base, kind: 'scratch' };
  if (
    ctx.names.has(image.toLowerCase()) ||
    (origin !== 'FROM' && /^\d+$/.test(image) && Number(image) < ctx.count)
  ) {
    return { ...base, kind: 'stage' };
  }
  if (!IMAGE_TOKEN.test(image)) return { ...base, kind: 'unparseable' };
  const [nameAndTag, digest] = image.split('@');
  const key = normalizeKey(nameAndTag);
  if (!digest) return { ...base, kind: 'unpinned', key };
  return { ...base, kind: 'pinned', key, digest: DIGEST.test(digest) ? digest : undefined };
}

const FRONTEND_VERSION = /:\d+\.\d+(?:\.\d+)?@sha256:/;
const PARSER_DIRECTIVE = /^#\s*([a-z]+)\s*=\s*(\S.*?)\s*$/i;
const KNOWN_DIRECTIVES = new Set(['syntax', 'escape', 'check']);
/** A heredoc word as BuildKit reads it: `<<EOF`, `<<-EOF`, `<<"EOF"`, `2<<'EOF'`; not `<<<`. */
const HEREDOC_WORD = /^\d*<<-?(["']?)([^\s<"']+)\1$/;

/** The delimiters of every heredoc started on this logical line (RUN / COPY / ADD only). */
function heredocDelimiters(line) {
  const body = line.replace(/^ONBUILD\s+/i, '');
  if (!/^(?:RUN|COPY|ADD)\s/i.test(body)) return [];
  return body
    .split(/\s+/)
    .map((word) => HEREDOC_WORD.exec(word)?.[2])
    .filter((word) => word !== undefined);
}

/**
 * Instructions with escape-character continuations joined, each tagged with the
 * physical line it STARTS on. Blank and comment lines are dropped, including
 * inside a continuation (Docker ignores them there too). Honours a leading
 * `# escape=` parser directive, and skips heredoc bodies so their contents are not
 * read as instructions. A construct it cannot read yields `{ error, number }`.
 */
function* logicalLines(text) {
  const raw = text.split('\n');
  let escapeChar = '\\';
  let directives = true;
  let pending = '';
  let start = 0;
  for (let index = 0; index < raw.length; index++) {
    const trimmed = raw[index].trim();
    if (directives) {
      const directive = PARSER_DIRECTIVE.exec(trimmed);
      const name = directive?.[1].toLowerCase();
      if (name !== undefined && KNOWN_DIRECTIVES.has(name)) {
        if (name === 'escape') {
          if (directive[2] === '\\' || directive[2] === '`') escapeChar = directive[2];
          else yield { error: trimmed, number: index + 1 };
        }
        // The `# syntax=` frontend is an image BuildKit pulls and RUNS for the build.
        if (name === 'syntax') yield { syntax: directive[2], number: index + 1 };
        continue;
      }
      directives = false;
    }
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    if (pending === '') start = index + 1;
    if (trimmed.endsWith(escapeChar)) {
      pending += `${trimmed.slice(0, -1)} `;
      continue;
    }
    const line = (pending + trimmed).trim();
    pending = '';
    yield { line, number: start };
    for (const delimiter of heredocDelimiters(line)) {
      let closed = false;
      while (++index < raw.length) {
        if (raw[index].trim() === delimiter) {
          closed = true;
          break;
        }
      }
      if (!closed) yield { error: `<<${delimiter}`, number: start };
    }
  }
  if (pending !== '') yield { line: pending.trim(), number: start };
}

/**
 * The leading `--flag` words of an instruction's arguments, whitespace-split with
 * quotes kept in place (as BuildKit does, so a quoted mount field survives intact).
 * `ok: false` when a quote is left open: the flags cannot be read.
 */
function leadingFlags(args) {
  const flags = [];
  let position = 0;
  for (;;) {
    while (position < args.length && /\s/.test(args[position])) position++;
    if (!args.startsWith('--', position)) return { flags, ok: true };
    let word = '';
    let quote = '';
    while (position < args.length && (quote !== '' || !/\s/.test(args[position]))) {
      const ch = args[position++];
      word += ch;
      if (quote === '' && (ch === '"' || ch === "'")) quote = ch;
      else if (ch === quote) quote = '';
    }
    if (quote !== '') return { flags, ok: false };
    flags.push(word);
  }
}

/** `--mount` value fields as Go's encoding/csv reads them (strict quotes); null when malformed. */
function csvFields(value) {
  const fields = [];
  let position = 0;
  for (;;) {
    let field = '';
    if (value[position] === '"') {
      position++;
      for (;;) {
        if (position >= value.length) return null;
        if (value[position] !== '"') field += value[position++];
        else if (value[position + 1] === '"') {
          field += '"';
          position += 2;
        } else {
          position++;
          break;
        }
      }
      if (position < value.length && value[position] !== ',') return null;
    } else {
      while (position < value.length && value[position] !== ',') {
        if (value[position] === '"') return null;
        field += value[position++];
      }
    }
    fields.push(field);
    if (position >= value.length) return fields;
    position++;
  }
}

const unquote = (value) => /^(["'])(.*)\1$/.exec(value)?.[2] ?? value;

/**
 * Every external-image reference in one Dockerfile's text, in order.
 * @param {string} text
 * @param {string} file
 * @returns {Ref[]}
 */
export function parseDockerfileRefs(text, file) {
  const refs = [];
  const ctx = { names: new Set(), count: 0 };
  const unreadable = (number, image, origin) =>
    refs.push({ file, line: number, image, origin, kind: 'unparseable' });
  for (const item of logicalLines(text)) {
    const { number } = item;
    if (item.error !== undefined) {
      unreadable(number, item.error, 'PARSER');
      continue;
    }
    if (item.syntax !== undefined) {
      refs.push(classify(item.syntax, file, number, ctx, 'SYNTAX'));
      continue;
    }
    // ONBUILD triggers pull the same images when a child build fires them.
    const line = item.line.replace(/^ONBUILD\s+/i, '');
    const from = /^FROM\s+(.*)$/i.exec(line);
    if (from) {
      const tokens = from[1].split(/\s+/).filter((t) => !t.startsWith('--'));
      const image = tokens[0];
      if (image === undefined) {
        unreadable(number, '', 'FROM');
      } else {
        refs.push(classify(image, file, number, ctx, 'FROM'));
      }
      const alias = /\bAS\s+([\w.-]+)/i.exec(from[1]);
      if (alias) ctx.names.add(alias[1].toLowerCase());
      ctx.count++;
      continue;
    }
    const copy = /^COPY\s+(.*)$/i.exec(line);
    if (copy) {
      const { flags, ok } = leadingFlags(copy[1]);
      if (!ok) unreadable(number, copy[1].slice(0, 80), 'COPY');
      for (const flag of flags) {
        const source = /^--from=(.*)$/i.exec(flag);
        if (source) refs.push(classify(unquote(source[1]), file, number, ctx, 'COPY'));
      }
    }
    // `RUN --mount=type=bind,from=<image>` pulls an image exactly as COPY --from does.
    const run = /^RUN\s+(.*)$/i.exec(line);
    if (run) {
      const { flags, ok } = leadingFlags(run[1]);
      if (!ok) unreadable(number, run[1].slice(0, 80), 'RUN');
      for (const flag of flags) {
        const mount = /^--mount=(.*)$/i.exec(flag);
        if (!mount) continue;
        const fields = csvFields(mount[1]);
        if (fields === null) {
          unreadable(number, mount[1], 'RUN');
          continue;
        }
        for (const field of fields) {
          const equals = field.indexOf('=');
          if (equals !== -1 && field.slice(0, equals).trim().toLowerCase() === 'from') {
            refs.push(classify(field.slice(equals + 1), file, number, ctx, 'RUN'));
          }
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
      // A `# syntax=` frontend executes during every build, so it gets its own check name.
      reason = ref.origin === 'SYNTAX' ? 'unpinned-frontend' : 'unpinned';
      detail =
        ref.origin === 'SYNTAX'
          ? 'build frontend (# syntax=) without an @sha256 digest; pin docker/dockerfile:<version>@sha256:<digest>'
          : 'external image without an @sha256 digest';
    } else if (ref.kind === 'pinned' && !ref.digest) {
      reason = 'unparseable';
      detail = 'malformed digest (need sha256:<64 hex>)';
    } else if (
      ref.kind === 'pinned' &&
      ref.origin === 'SYNTAX' &&
      !FRONTEND_VERSION.test(ref.image)
    ) {
      // A bare major (`:1`) or `:latest` beside a digest hides which release was pinned.
      reason = 'unpinned-frontend';
      detail =
        'build frontend (# syntax=) needs a specific version tag, e.g. docker/dockerfile:1.28@sha256:<digest>';
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
