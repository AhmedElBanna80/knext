/**
 * Disk mode's runner for the process-start primers (ADR-0066 D3).
 *
 * `node-server.ts` calls this right after its boot-trace mark: it loads the ordered list
 * from `process-start-primers.cjs`, requires each primer it names, and returns
 * `abortPrimers` from the owner module `process-start-abort.cjs`, which the
 * SIGTERM handler calls before draining.
 *
 * Nothing here is ever fatal. A file that cannot be found or loaded is logged
 * once, on stderr, and skipped: the server must start without its primers
 * rather than not at all. The logging itself cannot throw, whatever was
 * thrown at it.
 */

import { resolve } from "node:path";

export interface PrimerRunDeps {
    /** The directory the primer files sit in (dist/adapters, or src/adapters). */
    dir: string;
    /** `createRequire(import.meta.url)` of the caller. */
    requireFrom: (path: string) => unknown;
    fileExists: (path: string) => boolean;
    /** One line, newline included. */
    write: (line: string) => void;
}

export const PRIMER_LIST_FILE = "process-start-primers.cjs";
export const PRIMER_ABORT_FILE = "process-start-abort.cjs";

/** A thrown value as text. Never throws, even for a value whose String() does. */
export function describeError(err: unknown): string {
    try {
        return err instanceof Error ? err.message : String(err);
    } catch {
        return "an unprintable error";
    }
}

function join(dir: string, file: string): string {
    return resolve(dir, file);
}

/**
 * Run every primer in list order and return the abort for SIGTERM.
 *
 * @returns `abortPrimers()`, or a no-op when the owner module cannot be loaded
 *   (the primers still run then; each call is bounded by its own timeout).
 */
export function runProcessStartPrimers(deps: PrimerRunDeps): () => void {
    const say = (line: string): void => {
        try {
            deps.write(`[knext] ${line}\n`);
        } catch {
            // a failing stderr must not stop the server either
        }
    };
    const why = (err?: unknown): string =>
        err === undefined ? "missing" : describeError(err);

    let abortPrimers: () => void = () => {};
    const abortPath = join(deps.dir, PRIMER_ABORT_FILE);
    try {
        const owner = deps.requireFrom(abortPath) as {
            abortPrimers?: unknown;
        };
        if (typeof owner?.abortPrimers === "function") {
            abortPrimers = owner.abortPrimers as () => void;
        } else {
            say(
                `process-start primers cannot be cancelled on SIGTERM: ${abortPath} has no abortPrimers()`,
            );
        }
    } catch (err) {
        say(
            `process-start primers cannot be cancelled on SIGTERM: cannot load ${abortPath} (${why(err)})`,
        );
    }

    const listPath = join(deps.dir, PRIMER_LIST_FILE);
    let names: readonly string[];
    try {
        if (!deps.fileExists(listPath)) {
            say(
                `process-start primers did not run: cannot load ${listPath} (missing)`,
            );
            return abortPrimers;
        }
        const list = deps.requireFrom(listPath) as {
            PROCESS_START_PRIMERS?: unknown;
        };
        if (!Array.isArray(list?.PROCESS_START_PRIMERS)) {
            say(
                `process-start primers did not run: ${listPath} has no PROCESS_START_PRIMERS`,
            );
            return abortPrimers;
        }
        names = list.PROCESS_START_PRIMERS as readonly string[];
    } catch (err) {
        say(
            `process-start primers did not run: cannot load ${listPath} (${why(err)})`,
        );
        return abortPrimers;
    }

    for (const name of names) {
        if (typeof name !== "string" || name === "") {
            say(
                `process-start primer did not run: ${listPath} lists a non-file entry`,
            );
            continue;
        }
        let primerPath = name;
        try {
            primerPath = join(deps.dir, name);
            if (!deps.fileExists(primerPath)) {
                say(
                    `process-start primer did not run: cannot load ${primerPath} (missing)`,
                );
                continue;
            }
            // Each primer's own contract is "never throws"; this catch only
            // guards module resolution (e.g. a corrupted dist file).
            deps.requireFrom(primerPath);
        } catch (err) {
            say(
                `process-start primer did not run: cannot load ${primerPath} (${why(err)})`,
            );
        }
    }
    return abortPrimers;
}
