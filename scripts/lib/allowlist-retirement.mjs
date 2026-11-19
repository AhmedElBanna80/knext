/**
 * Advisory-allowlist RETIREMENT probe: pure logic.
 *
 * The three security allowlists (`precompile-closure`, `npm-audit`, `osv`) are
 * accepted risk with an exit condition. This probe says when the exit condition
 * is MET, and goes red only on an ACTIONABLE finding:
 *
 *   RETIRE (red)       the advisory is withdrawn upstream, or a patched version is
 *                      REACHABLE NOW: the installed/locked version is in the
 *                      vulnerable range and every parent that declares the package
 *                      accepts the patched version (so a lock refresh or a direct
 *                      bump gets it).
 *   INFO (not red)     a patch exists but cannot be reached: a parent pins an
 *                      older range (ESM-only fix, deliberately pinned fixture,
 *                      waiting on an upstream parent), or the package/version/
 *                      lockfile could not be resolved. Listed so it stays visible.
 *   ERROR (red)        the advisory API failed after bounded retries. Fail closed.
 *
 * VENDORED advisories: an entry may declare `vendoredIn` (the host package, the
 * vendored file's path inside its tarball, the patched ranges of the vendored
 * package). Lockfile parents cannot see such a copy, so the probe resolves the
 * newest STABLE host release in the declared range, reads the vendored version out
 * of that tarball (data only, nothing executed) and goes RETIRE when it is patched,
 * INFO otherwise. A registry or tarball failure is an ERROR (fail closed).
 *
 * `scripts/verify-allowlist-retirement.mjs` is the thin network wrapper; all of
 * this is unit-tested offline (`tests/allowlist-retirement.test.ts`).
 */

import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';

export const ALLOWLIST_FILES = [
  'security/precompile-closure-allowlist.json',
  'security/npm-audit-allowlist.json',
  'security/osv-allowlist.json',
];

/**
 * A lockfile that is frozen ON PURPOSE: a test fixture or the musl native-addon
 * probe lockfiles. Its pin is the thing under test and is exempt from bumps, so a
 * reachable patch there is information, not an action.
 */
export function isPinnedFixtureLockfile(rel) {
  return /(^|\/)(fixtures|musl-native-lockfiles)\//.test(String(rel));
}

/** Lockfiles searched for entries that name no lockfile of their own. */
export const DEFAULT_LOCKFILES = ['bun.lock', 'examples/bun-exec/bun.lock', 'package-lock.json'];

/**
 * Which allowlists a root is probed for. Default: all of them. A root that
 * legitimately lacks one (main has no OSV gate) names the files it HAS via a
 * comma list; every name must be a known allowlist, and every named file is then
 * REQUIRED (a missing one throws in `collectEntries`: never a silent skip).
 */
export function resolveAllowlistFiles(spec) {
  if (spec === undefined || String(spec).trim() === '') return ALLOWLIST_FILES;
  const names = String(spec)
    .split(',')
    .map((n) => n.trim())
    .filter(Boolean);
  for (const n of names) {
    if (!ALLOWLIST_FILES.includes(n)) throw new Error(`unknown allowlist file \`${n}\``);
  }
  if (names.length === 0) throw new Error('ALLOWLIST_FILES names no allowlist');
  return names;
}

/** Read every allowlist; a malformed file/entry THROWS (never silently skipped). */
export function collectEntries(repoRoot, files = ALLOWLIST_FILES) {
  const entries = [];
  for (const file of files) {
    const doc = JSON.parse(readFileSync(resolve(repoRoot, file), 'utf8'));
    if (!Array.isArray(doc.allow)) throw new Error(`${file}: \`allow\` is not an array`);
    for (const e of doc.allow) {
      if (typeof e?.id !== 'string' || e.id.length === 0) {
        throw new Error(`${file}: entry without a string \`id\``);
      }
      entries.push({
        file,
        id: e.id,
        package: e.package,
        version: e.version,
        lockfile: e.lockfile,
        vendoredIn:
          e.vendoredIn === undefined
            ? undefined
            : validateVendoredIn(e.vendoredIn, file, e.id, (rel, field) =>
                readDeclaredRange(repoRoot, rel, field),
              ),
      });
    }
  }
  return entries;
}

// ── versions and ranges ──────────────────────────────────────────────────────

function parts(v) {
  return String(v)
    .split(/[-+]/)[0]
    .split('.')
    .map((n) => Number.parseInt(n, 10) || 0);
}

function cmp(a, b) {
  const pa = parts(a);
  const pb = parts(b);
  for (let i = 0; i < Math.max(pa.length, pb.length, 3); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Is `version` inside a GitHub `vulnerable_version_range` (`>= 1, < 2` style)?
 * An unparseable range answers TRUE: when unsure, treat the version as affected.
 */
export function versionInRange(version, range) {
  if (!range) return true;
  for (const part of String(range).split(',')) {
    const m = part.trim().match(/^(<=|>=|<|>|=)?\s*([0-9][^\s]*)$/);
    if (!m) return true;
    const d = cmp(version, m[2]);
    const op = m[1] ?? '=';
    const ok =
      op === '<'
        ? d < 0
        : op === '<='
          ? d <= 0
          : op === '>'
            ? d > 0
            : op === '>='
              ? d >= 0
              : d === 0;
    if (!ok) return false;
  }
  return true;
}

/**
 * Does `version` satisfy an npm dependency range (`^1.2.3`, `~1.2`, `>=1 <2`,
 * `1.x`, `a || b`, exact)? Returns true/false, or NULL when the range is not one
 * this small evaluator understands (workspace:, npm:, git, tags): the caller
 * treats NULL as "cannot tell", never as a pass.
 */
export function satisfiesRange(version, range) {
  const r = String(range ?? '').trim();
  if (r === '' || r === '*' || r === 'x' || r === 'latest') return true;
  let unknown = false;
  const alt = r.split('||').map((set) => {
    const toks = set.trim().split(/\s+/).filter(Boolean);
    let ok = true;
    for (const tok of toks) {
      const res = satisfiesComparator(version, tok);
      if (res === null) {
        unknown = true;
        ok = false;
      } else if (!res) ok = false;
    }
    return ok;
  });
  if (alt.some(Boolean)) return true;
  return unknown ? null : false;
}

function satisfiesComparator(version, tok) {
  const m = tok.match(
    /^(\^|~|<=|>=|<|>|=)?v?(\d+|[xX*])(?:\.(\d+|[xX*]))?(?:\.(\d+|[xX*]))?(?:-[\w.-]+)?$/,
  );
  if (!m) return null;
  const op = m[1] ?? '';
  const isX = (s) => s === undefined || /^[xX*]$/.test(s);
  const [maj, min, pat] = [m[2], m[3], m[4]];
  const base = [isX(maj) ? 0 : +maj, isX(min) ? 0 : +min, isX(pat) ? 0 : +pat].join('.');
  const [vM, vm, vp] = parts(version);
  if (op === '' || op === '=') {
    if (isX(maj)) return true;
    if (vM !== +maj) return false;
    if (isX(min)) return true;
    if (vm !== +min) return false;
    return isX(pat) ? true : vp === +pat;
  }
  if (op === '^') {
    if (cmp(version, base) < 0) return false;
    if (+maj > 0 || isX(maj)) return vM === +maj;
    if (isX(min)) return vM === 0;
    if (+min > 0) return vM === 0 && vm === +min;
    return vM === 0 && vm === 0 && (isX(pat) ? true : vp === +pat);
  }
  if (op === '~') {
    if (cmp(version, base) < 0) return false;
    if (isX(min)) return vM === +maj;
    return vM === +maj && vm === +min;
  }
  const d = cmp(version, base);
  return op === '<' ? d < 0 : op === '<=' ? d <= 0 : op === '>' ? d > 0 : d >= 0;
}

// ── vendored advisories ──────────────────────────────────────────────────────

const STABLE = /^\d+\.\d+\.\d+$/;
const NPM_NAME = /^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*$/;
const COMPARATOR = /^(<=|>=|<|>|=)?\s*([0-9][^\s]*)$/;

/**
 * Validate an entry's `vendoredIn`; a malformed declaration THROWS (never a skip).
 * `package`: the host package. `path`: the vendored `package.json`-style file inside
 * the host tarball (relative to the tarball's `package/` root). `field`: dotted path of
 * the version inside that JSON (default `version`). `rangeFrom`: `<file>#<dotted.field>`, the
 * repo's OWN declaration of the host versions it may take (e.g. a package.json peer range);
 * the probe derives the host range from it, so it cannot drift from a hand-written copy.
 * `patched`: STABLE patched ranges of the vendored package (`>= 19.3.1`; a prerelease bound
 * is rejected), any one is a fix. `readRange(file, field)` reads the declared range.
 */
export function validateVendoredIn(v, file, id, readRange) {
  const where = `${file}: ${id}: vendoredIn`;
  const bad = (m) => {
    throw new Error(`${where} ${m}`);
  };
  if (v === null || typeof v !== 'object' || Array.isArray(v)) bad('is not an object');
  if (typeof v.package !== 'string' || !NPM_NAME.test(v.package)) bad('needs an npm `package`');
  if (
    typeof v.path !== 'string' ||
    v.path === '' ||
    v.path.startsWith('/') ||
    v.path.split('/').some((seg) => seg === '..' || seg === '')
  )
    bad('needs a relative `path` inside the tarball (no `..`)');
  if (
    v.field !== undefined &&
    (typeof v.field !== 'string' || !/^[\w$-]+(\.[\w$-]+)*$/.test(v.field))
  )
    bad('`field` must be a dotted key path');
  if (v.range !== undefined) bad('must not hand-write `range`; use `rangeFrom`');
  const from = typeof v.rangeFrom === 'string' ? v.rangeFrom.split('#') : [];
  if (from.length !== 2 || from[0] === '' || !/^[\w$-]+(\.[\w$-]+)*$/.test(from[1]))
    bad('needs `rangeFrom` as "<file>#<dotted.field>"');
  if (typeof readRange !== 'function') bad('cannot derive the host range (no reader)');
  const range = readRange(from[0], from[1]);
  if (typeof range !== 'string' || range.trim() === '')
    bad(`\`rangeFrom\` ${v.rangeFrom} is not a string range`);
  if (satisfiesRange('1.0.0', range) === null) bad('the derived host range is not parseable');
  if (
    !Array.isArray(v.patched) ||
    v.patched.length === 0 ||
    v.patched.some(
      (r) =>
        typeof r !== 'string' ||
        r.split(',').some((part) => {
          const m = part.trim().match(COMPARATOR);
          return !m || !STABLE.test(m[2]);
        }),
    )
  )
    bad('needs a non-empty `patched` array of STABLE comparator ranges (">= 19.3.1")');
  return {
    package: v.package,
    path: v.path,
    field: v.field ?? 'version',
    rangeFrom: v.rangeFrom,
    range,
    patched: v.patched,
  };
}

/** Read a string field of a JSON file under `repoRoot`; the path must stay inside the root. */
export function readDeclaredRange(repoRoot, rel, field) {
  const root = resolve(repoRoot);
  const abs = resolve(root, rel);
  const outside = (p) => {
    const r = relative(root, p);
    return r === '..' || r.startsWith('..') || isAbsolute(r);
  };
  if (isAbsolute(rel) || outside(abs)) throw new Error(`\`${rel}\` is outside the probed root`);
  if (!existsSync(abs)) throw new Error(`rangeFrom file \`${rel}\` does not exist`);
  if (outside(realpathSync(abs).replace(realpathSync(root), root))) {
    throw new Error(`\`${rel}\` resolves outside the probed root (symlink)`);
  }
  return readField(JSON.parse(readFileSync(abs, 'utf8')), field);
}

/** Prerelease-aware compare: `19.3.0-canary-x` sorts BELOW `19.3.0`. */
function cmpPre(a, b) {
  const d = cmp(a, b);
  if (d !== 0) return d;
  const pre = (v) => String(v).split('+')[0].includes('-');
  return Number(!pre(a)) - Number(!pre(b));
}

/** Does `version` (prerelease-aware) satisfy ANY of the comparator-AND `patched` ranges? */
export function satisfiesPatched(version, patched) {
  if (!/^\d+\.\d+\.\d+/.test(String(version)))
    throw new Error(`unparseable vendored version \`${version}\``);
  return patched.some((range) =>
    range.split(',').every((part) => {
      const m = part.trim().match(COMPARATOR);
      if (!m) throw new Error(`unparseable patched range \`${range}\``);
      const d = cmpPre(version, m[2]);
      const op = m[1] ?? '=';
      return op === '<'
        ? d < 0
        : op === '<='
          ? d <= 0
          : op === '>'
            ? d > 0
            : op === '>='
              ? d >= 0
              : d === 0;
    }),
  );
}

/** Newest STABLE (no prerelease) version in `range`; throws when there is none or the range is unreadable. */
export function pickNewestStable(versions, range) {
  let best = null;
  for (const v of versions) {
    if (!STABLE.test(String(v))) continue;
    const ok = satisfiesRange(v, range);
    if (ok === null) throw new Error(`host range \`${range}\` is not one this probe parses`);
    if (ok && (best === null || cmp(v, best) > 0)) best = v;
  }
  if (best === null) throw new Error(`no stable release satisfies \`${range}\``);
  return best;
}

/** Read one regular file out of an in-memory (decompressed) tar. DATA ONLY; nothing is executed. */
export function readTarEntry(tar, wanted) {
  let off = 0;
  while (off + 512 <= tar.length) {
    const head = tar.subarray(off, off + 512);
    if (head.every((b) => b === 0)) break;
    const str = (a, b) => {
      const raw = head.subarray(a, b);
      const z = raw.indexOf(0);
      return raw.subarray(0, z === -1 ? raw.length : z).toString('utf8');
    };
    const size = Number.parseInt(str(124, 136).trim() || '0', 8);
    if (!Number.isFinite(size) || size < 0) throw new Error('corrupt tar header');
    const type = String.fromCharCode(head[156] || 48);
    const prefix = str(345, 500);
    const name = prefix ? `${prefix}/${str(0, 100)}` : str(0, 100);
    const start = off + 512;
    if (type === '0' && name === wanted) {
      if (start + size > tar.length) throw new Error('truncated tar entry');
      return tar.subarray(start, start + size);
    }
    off = start + Math.ceil(size / 512) * 512;
  }
  return null;
}

/** Walk a dotted key path in parsed JSON. */
export function readField(json, field) {
  let cur = json;
  for (const key of field.split('.')) {
    if (cur === null || typeof cur !== 'object' || !(key in cur)) return undefined;
    cur = cur[key];
  }
  return cur;
}

/**
 * @param entry    allowlist entry carrying `vendoredIn`
 * @param resolved `{ hostVersion, vendoredVersion }` read from the newest stable host tarball
 */
export function classifyVendored(entry, resolved) {
  const v = entry.vendoredIn;
  const label = `${v.package}@${resolved.hostVersion} (newest stable in ${v.range}) vendors ${resolved.vendoredVersion} at ${v.path}`;
  if (satisfiesPatched(resolved.vendoredVersion, v.patched)) {
    return {
      level: 'RETIRE',
      reasons: [
        `vendored patch reachable now: ${label}, which satisfies ${v.patched.join(' || ')}`,
      ],
    };
  }
  return {
    level: 'INFO',
    reasons: [`vendored patch not available: ${label}; patched is ${v.patched.join(' || ')}`],
  };
}

// ── lockfiles ────────────────────────────────────────────────────────────────

const DEP_KEYS = ['dependencies', 'optionalDependencies', 'peerDependencies', 'devDependencies'];

function nameFromSpec(spec) {
  const at = String(spec).lastIndexOf('@');
  return at > 0 ? { name: spec.slice(0, at), version: spec.slice(at + 1) } : null;
}

/**
 * Parse a `bun.lock` (JSONC) or `package-lock.json` into
 * `{ packages: [{name, version, deps}], roots: [deps] }`. Returns NULL for a
 * file that cannot be read or understood, so the caller reports INFO, not a pass.
 */
/**
 * @typedef {{ name: string, version: string, deps: Record<string, string> }} LockPackage
 * @typedef {{ packages: LockPackage[], roots: Record<string, string>[] }} ParsedLock
 * @param {string} text
 * @param {'bun' | 'npm'} kind
 * @returns {ParsedLock | null}
 */
export function parseLockfile(text, kind) {
  try {
    if (kind === 'bun') {
      const doc = JSON.parse(text.replace(/,(\s*[}\]])/g, '$1'));
      const packages = [];
      for (const v of Object.values(doc.packages ?? {})) {
        const id = nameFromSpec(v[0]);
        if (!id) continue;
        const meta = v[2] ?? {};
        const deps = {};
        for (const k of DEP_KEYS) Object.assign(deps, meta[k]);
        packages.push({ name: id.name, version: id.version, deps });
      }
      const roots = Object.values(doc.workspaces ?? {}).map((w) => {
        const deps = {};
        for (const k of DEP_KEYS) Object.assign(deps, w[k]);
        return deps;
      });
      return { packages, roots };
    }
    const doc = JSON.parse(text);
    const packages = [];
    const roots = [];
    for (const [path, v] of Object.entries(doc.packages ?? {})) {
      const deps = {};
      for (const k of DEP_KEYS) Object.assign(deps, v[k]);
      if (path === '' || !path.includes('node_modules/')) {
        roots.push(deps);
        continue;
      }
      packages.push({ name: path.split('node_modules/').pop(), version: v.version, deps });
    }
    return { packages, roots };
  } catch {
    return null;
  }
}

export function loadLockfileFromDisk(repoRoot, rel) {
  const root = resolve(repoRoot);
  const abs = resolve(root, rel);
  const outside = (p) => {
    const r = relative(root, p);
    return r === '..' || r.startsWith('..') || isAbsolute(r);
  };
  // An entry's `lockfile` is DATA from the probed branch: it must stay inside the root.
  if (isAbsolute(rel) || outside(abs)) {
    throw new Error(`lockfile \`${rel}\` is outside the probed root`);
  }
  if (!existsSync(abs)) return null;
  if (outside(realpathSync(abs).replace(realpathSync(root), root))) {
    throw new Error(`lockfile \`${rel}\` resolves outside the probed root (symlink)`);
  }
  return parseLockfile(readFileSync(abs, 'utf8'), rel.endsWith('.json') ? 'npm' : 'bun');
}

/**
 * Can a patched version `patched` replace the locked `installed` copy of `pkg`?
 * Every parent that declares `pkg` with a range accepting `installed` must also
 * accept `patched`; a root/workspace is a direct bump. @returns
 * {status: 'reachable'|'blocked'|'unknown', detail}
 */
export function reachability(lock, pkg, installed, patched) {
  const ranges = [];
  for (const p of lock.packages) {
    if (p.deps[pkg] !== undefined)
      ranges.push({ by: `${p.name}@${p.version}`, range: p.deps[pkg] });
  }
  for (const deps of lock.roots) {
    if (deps[pkg] !== undefined)
      ranges.push({ by: 'a workspace (direct dependency)', range: deps[pkg] });
  }
  const resolving = [];
  for (const r of ranges) {
    const s = satisfiesRange(installed, r.range);
    if (s === null)
      return { status: 'unknown', detail: `${r.by} declares ${pkg} "${r.range}" (unparseable)` };
    if (s) resolving.push(r);
  }
  if (resolving.length === 0) {
    return {
      status: 'unknown',
      detail: `no declared range in the lockfile resolves to ${pkg}@${installed}`,
    };
  }
  for (const r of resolving) {
    const s = satisfiesRange(patched, r.range);
    if (s === null)
      return { status: 'unknown', detail: `${r.by} declares ${pkg} "${r.range}" (unparseable)` };
    if (!s)
      return {
        status: 'blocked',
        detail: `${r.by} declares ${pkg} "${r.range}", which excludes ${patched}`,
      };
  }
  return { status: 'reachable', detail: `every parent of ${pkg}@${installed} accepts ${patched}` };
}

// ── classification ───────────────────────────────────────────────────────────

/**
 * @param entry   allowlist entry
 * @param advisory GitHub advisory object
 * @param loadLock (relPath) => parsed lockfile | null
 * @returns {{level: 'RETIRE'|'INFO'|'KEEP', reasons: string[]}}
 */
export function classifyAdvisory(entry, advisory, loadLock = () => null) {
  if (advisory.withdrawn_at) {
    return { level: 'RETIRE', reasons: [`withdrawn upstream on ${advisory.withdrawn_at}`] };
  }
  const patched = (advisory.vulnerabilities ?? []).filter(
    (v) => v.first_patched_version && (!entry.package || v.package?.name === entry.package),
  );
  if (patched.length === 0) return { level: 'KEEP', reasons: [] };

  const lockfiles = entry.lockfile ? [entry.lockfile] : DEFAULT_LOCKFILES;
  const reachable = [];
  const info = [];
  let resolved = false;
  for (const v of patched) {
    const name = v.package?.name;
    const candidates = [];
    for (const lf of lockfiles) {
      const lock = loadLock(lf);
      if (!lock) continue;
      const versions = entry.version
        ? [entry.version]
        : [...new Set(lock.packages.filter((p) => p.name === name).map((p) => p.version))];
      for (const iv of versions) {
        if (versionInRange(iv, v.vulnerable_version_range)) candidates.push({ lock, lf, iv });
      }
    }
    for (const c of candidates) {
      resolved = true;
      const r = reachability(c.lock, name, c.iv, v.first_patched_version);
      const label = `${name}@${c.iv} (${c.lf}) -> ${v.first_patched_version}`;
      if (r.status === 'reachable' && isPinnedFixtureLockfile(c.lf)) {
        info.push(`${label}: reachable, but ${c.lf} is a deliberately pinned fixture`);
      } else if (r.status === 'reachable') reachable.push(`${label}: ${r.detail}`);
      else info.push(`${label}: ${r.status}: ${r.detail}`);
    }
  }
  if (reachable.length > 0)
    return { level: 'RETIRE', reasons: reachable.map((r) => `patch reachable now: ${r}`) };
  if (!resolved) {
    const first = patched[0];
    return {
      level: 'INFO',
      reasons: [
        `${first.package?.name} ${first.vulnerable_version_range ?? ''} has a patched version ${first.first_patched_version}; no locked copy in the vulnerable range was found in ${lockfiles.join(', ')}`.replace(
          /\s+/g,
          ' ',
        ),
      ],
    };
  }
  return { level: 'INFO', reasons: info.map((r) => `patch exists but is not reachable: ${r}`) };
}

/**
 * Probe every entry. `fetchAdvisory(id)` returns the advisory or THROWS; a throw
 * is an ERROR (fail closed), never a pass and never a skip.
 */
/**
 * @param {any[]} entries
 * @param {(id: string) => Promise<any>} fetchAdvisory
 * @param {{ loadLock?: (rel: string) => any, resolveVendored?: ((v: any) => Promise<{ hostVersion: string, vendoredVersion: string }>) | null }} [opts]
 */
export async function probeEntries(
  entries,
  fetchAdvisory,
  { loadLock = () => null, resolveVendored = null } = {},
) {
  const findings = [];
  const informational = [];
  const errors = [];
  const cache = new Map();
  const locks = new Map();
  const vendored = new Map();
  const cachedLock = (rel) => {
    if (!locks.has(rel)) locks.set(rel, loadLock(rel));
    return locks.get(rel);
  };
  for (const entry of entries) {
    try {
      if (!cache.has(entry.id)) cache.set(entry.id, await fetchAdvisory(entry.id));
      let { level, reasons } = classifyAdvisory(entry, cache.get(entry.id), cachedLock);
      if (entry.vendoredIn && level !== 'RETIRE') {
        if (!resolveVendored)
          throw new Error('entry declares vendoredIn but no vendored resolver was supplied');
        const key = JSON.stringify(entry.vendoredIn);
        if (!vendored.has(key)) vendored.set(key, await resolveVendored(entry.vendoredIn));
        const vc = classifyVendored(entry, vendored.get(key));
        reasons = [...reasons, ...vc.reasons];
        if (vc.level === 'RETIRE') level = 'RETIRE';
        else if (level === 'KEEP') level = 'INFO';
      }
      const row = { file: entry.file, id: entry.id, package: entry.package, reasons };
      if (level === 'RETIRE') findings.push(row);
      else if (level === 'INFO') informational.push(row);
    } catch (error) {
      errors.push({
        file: entry.file,
        id: entry.id,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { findings, informational, errors, checked: entries.length };
}

/** Red ONLY on a RETIRE finding, an API error, or an empty entry set. INFO never fails. */
/** @param {{ findings: unknown[], errors: unknown[], checked: number }} result */
export function exitCodeFor({ findings, errors, checked }) {
  return findings.length > 0 || errors.length > 0 || checked === 0 ? 1 : 0;
}

/**
 * @typedef {{ file: string, id: string, package?: string, reasons: string[] }} ProbeRow
 * @typedef {{ findings: ProbeRow[], informational?: ProbeRow[], errors: { file: string, id: string, message: string }[], checked: number }} ProbeResult
 */

/** @param {ProbeResult} result */
export function renderReport({ findings, informational = [], errors, checked }) {
  const tag = (f) => `${f.id} (${f.file}${f.package ? `, ${f.package}` : ''})`;
  const lines = [`Checked ${checked} allowlist entries.`];
  for (const f of findings) lines.push(`RETIRE ${tag(f)}: ${f.reasons.join('; ')}`);
  for (const e of errors) lines.push(`ERROR ${e.id} (${e.file}): ${e.message}`);
  if (checked === 0)
    lines.push('ERROR: no allowlist entries were found; refusing to pass vacuously.');
  if (informational.length > 0) {
    lines.push(`\nInformational (${informational.length}; does NOT fail the run):`);
    for (const f of informational) lines.push(`INFO ${tag(f)}: ${f.reasons.join('; ')}`);
  }
  if (findings.length === 0 && errors.length === 0 && checked > 0)
    lines.push('\nOK: no entry is actionably retirable.');
  return lines.join('\n');
}
