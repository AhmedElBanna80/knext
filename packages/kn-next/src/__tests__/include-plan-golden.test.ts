/**
 * The runtime-neutral planner must reproduce the ORIGINAL (Bun.Glob) planner
 * exactly. `fixtures/include-plan-golden/golden.json` is the base planner's
 * output on a fixed fixture (generation command: see `run-cases.mjs`'s header);
 * the new planner must match it byte-for-byte under node AND under bun.
 *
 * The vectors cover what the two globbers are known to disagree on: `**` into a
 * symlinked directory (in the root and out of it), a leading `./`, `[...]`
 * classes, dotfiles with `*` and `**`, case sensitivity, ordering, the entry
 * matched by its own include glob, and the exclude matcher (dot-permissive, a
 * literal `./`, case-sensitive).
 */

import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { BUN_BIN, NODE_BIN } from "../../../../tests/helpers/runtime-binaries";

const DIR = join(import.meta.dir, "fixtures", "include-plan-golden");
const RUNNER = join(DIR, "run-cases.mjs");
const PLANNER = join(import.meta.dir, "..", "adapters", "include-plan.mjs");
const golden = JSON.parse(readFileSync(join(DIR, "golden.json"), "utf8")) as {
    fn: string;
    include: string[];
    exclude?: string[];
    relpaths?: string[];
    error?: string;
}[];

function plans(bin: string) {
    const r = spawnSync(bin, [RUNNER, PLANNER], { encoding: "utf8" });
    expect(r.status, `${bin}: ${r.stderr}`).toBe(0);
    return JSON.parse(r.stdout) as typeof golden;
}

describe("the new planner reproduces the original Bun.Glob planner", () => {
    it("the golden is non-trivial and covers both successes and refusals", () => {
        expect(golden.length).toBeGreaterThan(30);
        expect(golden.some((c) => c.error)).toBe(true);
        expect(golden.some((c) => c.relpaths?.length)).toBe(true);
    });

    it("under node: identical to the golden, case by case", () => {
        const got = plans(NODE_BIN);
        expect(got.length).toBe(golden.length);
        for (const [i, g] of golden.entries()) {
            expect(got[i], JSON.stringify(g.include)).toEqual(g);
        }
    });

    // Bun is only present when bun runs the suite; say so rather than skip silently.
    it.skipIf(!BUN_BIN)(
        "under bun: identical to the golden, case by case",
        () => {
            const got = plans(BUN_BIN as string);
            expect(got.length).toBe(golden.length);
            for (const [i, g] of golden.entries()) {
                expect(got[i], JSON.stringify(g.include)).toEqual(g);
            }
        },
    );

    it("the specific vectors the two globbers disagree on hold", () => {
        const at = (fn: string, include: string[], exclude?: string[]) =>
            golden.find(
                (c) =>
                    c.fn === fn &&
                    JSON.stringify(c.include) === JSON.stringify(include) &&
                    JSON.stringify(c.exclude) === JSON.stringify(exclude),
            );
        // case-sensitive: `case*` matches nothing even though Case.js exists
        expect(at("planIncludes", ["lib/case*.js"])?.error).toMatch(
            /no file matches/,
        );
        // a wildcard never matches a dot entry; an explicit `.` does
        expect(at("planIncludes", ["lib/*.js"])?.relpaths).not.toContain(
            "lib/.hidden.js",
        );
        expect(at("planIncludes", ["lib/.*.js"])?.relpaths).toEqual([
            "lib/.hidden.js",
        ]);
        // the leading ./ is echoed (original behaviour)
        expect(at("planIncludes", ["./lib/*.js"])?.relpaths?.[0]).toBe(
            "./lib/Case.js",
        );
        // `**` does not enter a symlinked dir, but a pattern NAMING it does
        expect(at("planIncludes", ["lib/**/*.js"])?.relpaths).not.toContain(
            "lib/linkdir/s.js",
        );
        expect(at("planIncludes", ["lib/linkdir/**"])?.relpaths).toEqual([
            "lib/linkdir/s.js",
        ]);
        // ...and one that leaves the root is refused by the real-path guard
        expect(at("planIncludes", ["lib/outdir/**"])?.error).toMatch(
            /outside the app root/,
        );
        // an exclude's leading ./ is literal: it excludes nothing
        expect(
            at("planEmbed", ["lib/**/*.js"], ["./lib/a.js"])?.relpaths,
        ).toContain("lib/a.js");
    });
});
