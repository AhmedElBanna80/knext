/**
 * Disk mode's primer runner (ADR-0066 D3, #2054): runs the list in order,
 * returns the owner's abortPrimers, and is never fatal. Every way a file can
 * be missing or broken is logged once on stderr and skipped, and the logging
 * itself cannot throw.
 */
import { describe, expect, it } from "bun:test";
import {
    describeError,
    type PrimerRunDeps,
    runProcessStartPrimers,
} from "../adapters/process-start-run";

const DIR = "/srv/adapters";

/** A fake filesystem of modules: path -> exports, or an Error to throw on require. */
function deps(files: Record<string, unknown>) {
    const required: string[] = [];
    const lines: string[] = [];
    const d: PrimerRunDeps = {
        dir: DIR,
        exists: (p) => p in files,
        requireFrom: (p) => {
            if (!(p in files)) throw new Error(`Cannot find module '${p}'`);
            required.push(p);
            const v = files[p];
            if (v instanceof Error) throw v;
            return v;
        },
        write: (l) => lines.push(l),
    };
    return { d, required, lines };
}

const LIST = `${DIR}/process-start-primers.cjs`;
const ABORT = `${DIR}/process-start-abort.cjs`;
const ARP = `${DIR}/arp-primer.cjs`;
const WAKE = `${DIR}/wake-ahead.cjs`;

describe("runProcessStartPrimers", () => {
    it("requires every primer in list order and returns the owner's abortPrimers", () => {
        let aborted = 0;
        const { d, required, lines } = deps({
            [ABORT]: { abortPrimers: () => aborted++ },
            [LIST]: {
                PROCESS_START_PRIMERS: ["arp-primer.cjs", "wake-ahead.cjs"],
            },
            [ARP]: {},
            [WAKE]: {},
        });
        const abort = runProcessStartPrimers(d);
        expect(required).toEqual([ABORT, LIST, ARP, WAKE]);
        expect(lines).toEqual([]);
        abort();
        expect(aborted).toBe(1);
    });

    it("a missing list is logged once and nothing runs", () => {
        const { d, required, lines } = deps({
            [ABORT]: { abortPrimers: () => {} },
        });
        runProcessStartPrimers(d);
        expect(required).toEqual([ABORT]);
        expect(lines).toEqual([
            `[knext] process-start primers did not run: cannot load ${LIST} (missing)\n`,
        ]);
    });

    it("a list that throws is logged with its message", () => {
        const { d, lines } = deps({
            [ABORT]: { abortPrimers: () => {} },
            [LIST]: new Error("bad list"),
        });
        runProcessStartPrimers(d);
        expect(lines).toEqual([
            `[knext] process-start primers did not run: cannot load ${LIST} (bad list)\n`,
        ]);
    });

    it("a list without PROCESS_START_PRIMERS is logged", () => {
        const { d, lines } = deps({
            [ABORT]: { abortPrimers: () => {} },
            [LIST]: {},
        });
        runProcessStartPrimers(d);
        expect(lines).toEqual([
            `[knext] process-start primers did not run: ${LIST} has no PROCESS_START_PRIMERS\n`,
        ]);
    });

    it("a missing or broken primer is logged and the next one still runs", () => {
        const { d, required, lines } = deps({
            [ABORT]: { abortPrimers: () => {} },
            [LIST]: {
                PROCESS_START_PRIMERS: [
                    "arp-primer.cjs",
                    "gone.cjs",
                    "wake-ahead.cjs",
                ],
            },
            [ARP]: new Error("corrupt"),
            [WAKE]: {},
        });
        runProcessStartPrimers(d);
        expect(required).toContain(WAKE);
        expect(lines).toEqual([
            `[knext] process-start primer did not run: cannot load ${ARP} (corrupt)\n`,
            `[knext] process-start primer did not run: cannot load ${DIR}/gone.cjs (missing)\n`,
        ]);
    });

    it("a missing owner module still runs the primers, says SIGTERM cannot cancel them, and returns a no-op", () => {
        const { d, required, lines } = deps({
            [LIST]: { PROCESS_START_PRIMERS: ["wake-ahead.cjs"] },
            [WAKE]: {},
        });
        const abort = runProcessStartPrimers(d);
        expect(required).toEqual([LIST, WAKE]);
        expect(lines.length).toBe(1);
        expect(lines[0]).toContain(
            "process-start primers cannot be cancelled on SIGTERM: cannot load",
        );
        expect(() => abort()).not.toThrow();
    });

    it("a non-string list entry is logged and skipped, and the next one runs", () => {
        const { d, required, lines } = deps({
            [ABORT]: { abortPrimers: () => {} },
            [LIST]: {
                PROCESS_START_PRIMERS: [Symbol("x"), 7, "", "wake-ahead.cjs"],
            },
            [WAKE]: {},
        });
        expect(() => runProcessStartPrimers(d)).not.toThrow();
        expect(required).toContain(WAKE);
        expect(lines.length).toBe(3);
        for (const l of lines) expect(l).toContain("lists a non-file entry");
    });

    it("never throws: an unprintable thrown value and a failing stderr", () => {
        const unprintable = Object.create(null);
        const d: PrimerRunDeps = {
            dir: DIR,
            exists: () => true,
            requireFrom: () => {
                throw unprintable;
            },
            write: () => {
                throw new Error("stderr closed");
            },
        };
        expect(() => runProcessStartPrimers(d)).not.toThrow();
        expect(describeError(unprintable)).toBe("an unprintable error");
    });
});
