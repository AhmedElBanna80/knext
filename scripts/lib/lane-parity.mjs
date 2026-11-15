/**
 * Lane parity for the CI guard files (#2170).
 *
 * A guard fix that lands on one release lane and not the others is defect class
 * D: `integration/v2` once ran ~33 commits behind main and lacked both the R0
 * guard fix and the freeze-guard fix, and nothing noticed. This compares each
 * guard file in the manifest (`.github/lane-parity.json`) on THIS lane against
 * the same path on every other lane. A file must be byte-identical, or the
 * difference must be RECORDED: an entry naming both blobs and a reason.
 *
 * An entry pins both blob ids, so it explains exactly one pair of contents. When
 * either side changes, the entry is out of date and the check is red again until
 * someone ports the change or records the new difference. An entry for a file
 * that is identical again is stale and also red: an allowlist that only grows
 * stops meaning anything.
 *
 * Pure: everything that touches git comes in through `readBlob`.
 */

/**
 * @typedef {{ path: string, lane: string, here: string, there: string | null, reason: string, issue?: string }} Divergence
 * @typedef {{ self: string, lanes: string[], files: string[], divergences: Divergence[] }} Manifest
 * @typedef {{ kind: string, path?: string, lane?: string, message: string, here?: string | null, there?: string | null }} Finding
 */

/** Validate the manifest's shape; returns findings (never throws on bad data). */
export function validateManifest(manifest) {
  const out = [];
  const bad = (message) => out.push({ kind: 'manifest', message });
  if (!manifest || typeof manifest !== 'object')
    return [{ kind: 'manifest', message: 'manifest is not an object' }];
  if (typeof manifest.self !== 'string' || manifest.self === '') bad('`self` must name this lane');
  if (!Array.isArray(manifest.lanes) || manifest.lanes.length < 2)
    bad('`lanes` must list at least two lanes');
  else if (!manifest.lanes.includes(manifest.self))
    bad(`\`lanes\` does not include \`self\` (${manifest.self})`);
  if (!Array.isArray(manifest.files) || manifest.files.length === 0)
    bad('`files` must list at least one guard file');
  else if (new Set(manifest.files).size !== manifest.files.length)
    bad('`files` lists a path twice');
  if (!Array.isArray(manifest.divergences)) bad('`divergences` must be an array');
  if (out.length > 0) return out;
  const seen = new Set();
  for (const d of manifest.divergences) {
    const id = `${d?.path} @ ${d?.lane}`;
    if (!manifest.files.includes(d?.path))
      bad(`divergence for ${id}: the path is not in \`files\``);
    if (!manifest.lanes.includes(d?.lane) || d?.lane === manifest.self)
      bad(`divergence for ${id}: the lane is not another lane in \`lanes\``);
    if (typeof d?.reason !== 'string' || d.reason.trim().length < 10)
      bad(`divergence for ${id}: \`reason\` must say why (10 characters or more)`);
    // A known gap (a fix not yet ported) must name where the port is tracked, so
    // a recorded difference never quietly turns a class-D gap into a green.
    if (/^UNPORTED/.test(d?.reason ?? '') && !/^#\d+$/.test(d?.issue ?? ''))
      bad(`divergence for ${id}: an UNPORTED difference must name its tracking \`issue\` (#N)`);
    if (d?.issue !== undefined && !/^#\d+$/.test(d.issue))
      bad(`divergence for ${id}: \`issue\` must look like #N`);
    if (typeof d?.here !== 'string')
      bad(`divergence for ${id}: \`here\` must be this lane's blob id`);
    if (d?.there !== null && typeof d?.there !== 'string')
      bad(
        `divergence for ${id}: \`there\` must be the other lane's blob id, or null when the file is absent there`,
      );
    if (seen.has(id)) bad(`divergence for ${id} is recorded twice`);
    seen.add(id);
  }
  return out;
}

/**
 * @param {object} args
 * @param {Manifest} args.manifest
 * @param {(lane: string, path: string) => string | null} args.readBlob
 *   The blob id of `path` on `lane` (`args.manifest.self` means this checkout),
 *   or null when the path does not exist there. Throws when the lane cannot be
 *   read at all; the caller must fail closed.
 * @returns {Finding[]}
 */
export function checkLaneParity({ manifest, readBlob }) {
  const invalid = validateManifest(manifest);
  if (invalid.length > 0) return invalid;
  const findings = [];
  const recorded = new Map(manifest.divergences.map((d) => [`${d.path}\0${d.lane}`, d]));
  const others = manifest.lanes.filter((l) => l !== manifest.self);

  for (const path of manifest.files) {
    const here = readBlob(manifest.self, path);
    if (here === null) {
      findings.push({
        kind: 'missing-here',
        path,
        message: `${path} is listed but does not exist on ${manifest.self}`,
      });
      continue;
    }
    for (const lane of others) {
      const there = readBlob(lane, path);
      const key = `${path}\0${lane}`;
      const entry = recorded.get(key);
      if (there === here) {
        if (entry)
          findings.push({
            kind: 'stale',
            path,
            lane,
            here,
            there,
            message: `${path} is identical on ${lane} again: remove its divergence entry`,
          });
        continue;
      }
      if (!entry) {
        findings.push({
          kind: 'unexplained',
          path,
          lane,
          here,
          there,
          message:
            there === null
              ? `${path} exists here but not on ${lane}, and no divergence is recorded`
              : `${path} differs from ${lane}, and no divergence is recorded`,
        });
        continue;
      }
      if (entry.here !== here || entry.there !== there) {
        findings.push({
          kind: 'out-of-date',
          path,
          lane,
          here,
          there,
          message: `${path} vs ${lane}: the recorded difference is for other contents (recorded ${entry.here} / ${entry.there}); port the change or record the new one`,
        });
      }
    }
  }
  return findings;
}
