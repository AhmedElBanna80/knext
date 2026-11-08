/**
 * The published package surface: only the manifest keys that define what
 * consumers can import or run. package.json changes constantly (versions,
 * dependencies, scripts), so comparing the whole file would fire on almost
 * every PR.
 */

export const PUBLIC_MANIFEST_KEYS = ['exports', 'bin', 'files', 'main', 'types', 'typesVersions'];

const PACKAGE_MANIFEST = /^packages\/[^/]+\/package\.json$/;

export function publicSurfaceChanged(before, after) {
  const pick = (o) =>
    JSON.stringify(Object.fromEntries(PUBLIC_MANIFEST_KEYS.map((k) => [k, o?.[k] ?? null])));
  return pick(before) !== pick(after);
}

const UNPARSEABLE = Symbol('unparseable');
function parseManifest(text) {
  if (text === null) return null; // absent on that side is a legitimate answer
  try {
    return JSON.parse(text);
  } catch {
    return UNPARSEABLE;
  }
}

/** The `public-api` finding for the changed manifests, or none. */
export function publicSurfaceFindings(changes, repo) {
  const hits = [];
  let unparseable = false;
  for (const c of changes.filter((x) => PACKAGE_MANIFEST.test(x.path))) {
    const before = parseManifest(repo.show('base', c.path));
    const after = parseManifest(repo.show('head', c.path));
    if (before === UNPARSEABLE || after === UNPARSEABLE) {
      // Fail closed: a manifest that cannot be read cannot be proven surface-neutral.
      unparseable = true;
      hits.push(c.path);
    } else if (publicSurfaceChanged(before, after)) {
      hits.push(c.path);
    }
  }
  if (hits.length === 0) return [];
  return [
    {
      id: 'public-api',
      label: 'the published package surface',
      why:
        `changes ${PUBLIC_MANIFEST_KEYS.join('/')} in a package manifest — what consumers can import or run` +
        (unparseable ? ' (a manifest is UNPARSEABLE, so it cannot be proven unchanged)' : ''),
      paths: hits,
    },
  ];
}
