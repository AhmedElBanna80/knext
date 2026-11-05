import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The single reader of this CLI's own version: the nearest `package.json` above
 * `from` that IS `@getknext/core`. Walked, not a fixed `../../`: the bundler
 * splits the lazily-imported dispatch modules into chunks at `dist/` (one level
 * above `dist/cli/`), while the source sits at `src/cli/` — a fixed relative
 * path is right for one and wrong for the other (it read `0.0.0` from the bin,
 * which every peer range refuses).
 *
 * Tri-state by design: a version, or `undefined` when no readable manifest with
 * a version is found. It never invents `0.0.0`. Callers decide what unreadable
 * means: build identity fails closed, the `version` subcommand and `doctor`
 * print `unknown`. (A fallback string hashed into a build stamp makes every CLI
 * version stamp identically.)
 *
 * `from` is a `file:` URL or a filesystem path; it defaults to this module.
 */
export function readCoreVersion(
    from: string = import.meta.url,
): string | undefined {
    let dir = dirname(from.startsWith("file:") ? fileURLToPath(from) : from);
    for (;;) {
        try {
            const pkg = JSON.parse(
                readFileSync(join(dir, "package.json"), "utf-8"),
            ) as { name?: string; version?: string };
            if (
                pkg.name === "@getknext/core" &&
                typeof pkg.version === "string" &&
                pkg.version
            ) {
                return pkg.version;
            }
        } catch {
            // no (readable) manifest at this level
        }
        const parent = dirname(dir);
        if (parent === dir) return undefined;
        dir = parent;
    }
}

/** What an unreadable CLI version is called wherever it is shown to a person. */
export const UNKNOWN_CORE_VERSION = "unknown";

/**
 * For the peer-range checks (`ffi`/`gRPC` dispatch): an unreadable version
 * becomes `0.0.0`, which satisfies no peer range, so the check refuses rather
 * than passes. Do not use this for anything that is hashed, compared for
 * equality, or displayed — use {@link readCoreVersion}.
 */
export function coreVersion(from: string = import.meta.url): string {
    return readCoreVersion(from) ?? "0.0.0";
}
