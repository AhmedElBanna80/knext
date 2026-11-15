import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import {
    BACKLOG_MAX_ENTRIES,
    createTagBacklog,
} from "../adapters/tag-backlog.js";

/**
 * The one bounded backlog the cache runtime keeps while Redis is unreachable
 * (#2387). The ISR invalidation replay and the `'use cache'` tag replay both use
 * it, and their own suites stay the regression net for the behaviour around it;
 * this file pins the primitive's rules directly, and the scan below keeps it
 * the only one.
 */

describe("createTagBacklog", () => {
    it("deduplicates: recording a name again updates it in place", () => {
        const b = createTagBacklog();
        expect(b.record("tags", ["a"])).toBe(true);
        expect(b.record("tags", ["a"])).toBe(true);
        expect(b.size()).toBe(1);
        expect(b.snapshot("tags")).toEqual([["a", 2]]);
    });

    it("moves the generation once per call, not once per name", () => {
        const b = createTagBacklog();
        b.record("tags", ["a", "b", "c"]);
        expect(b.generation).toBe(1);
        expect(b.snapshot("tags").map(([, g]) => g)).toEqual([1, 1, 1]);
        b.record("tags", []);
        expect(b.generation).toBe(2);
    });

    it("passes the previous value and the generation to the value function", () => {
        const b = createTagBacklog();
        const seen: unknown[] = [];
        b.record("tags", ["a"], (prev, g) => {
            seen.push([prev, g]);
            return { generation: g };
        });
        b.record("tags", ["a"], (prev, g) => {
            seen.push([prev, g]);
            return { generation: g };
        });
        expect(seen).toEqual([
            [undefined, 1],
            [{ generation: 1 }, 2],
        ]);
    });

    it("collapses on the first NEW name past the bound, once, naming the namespace", () => {
        const collapses: string[] = [];
        const b = createTagBacklog({
            max: 3,
            onCollapse: (ns) => collapses.push(ns),
        });
        expect(b.record("tags", ["a", "b", "c"])).toBe(true);
        // A name already held is not new: no collapse at the bound.
        expect(b.record("tags", ["a"])).toBe(true);
        expect(b.collapsed).toBe(false);
        expect(b.record("tags", ["d", "e"])).toBe(false);
        expect(b.collapsed).toBe(true);
        expect(b.size()).toBe(0);
        expect(b.pending()).toBe(true);
        // Collapsed: every later record is refused, and the callback does not repeat.
        expect(b.record("tags", ["f"])).toBe(false);
        expect(b.size()).toBe(0);
        expect(collapses).toEqual(["tags"]);
    });

    it("bounds every namespace together", () => {
        const collapses: string[] = [];
        const b = createTagBacklog({
            namespaces: ["tags", "keys"],
            max: 2,
            onCollapse: (ns) => collapses.push(ns),
        });
        b.record("tags", ["t1"]);
        b.record("keys", ["k1"]);
        expect(b.sizeOf("tags") + b.sizeOf("keys")).toBe(2);
        expect(b.record("keys", ["k2"])).toBe(false);
        expect(collapses).toEqual(["keys"]);
        expect(b.sizeOf("tags") + b.sizeOf("keys")).toBe(0);
    });

    it("refuses an unknown namespace rather than inventing one", () => {
        expect(() => createTagBacklog().record("keys", ["k"])).toThrow(
            /unknown namespace keys/,
        );
    });

    it("hands out copies: a snapshot cannot bypass the bound", () => {
        const b = createTagBacklog({ max: 1 });
        b.record("tags", ["a"]);
        const snap = b.snapshot("tags");
        snap.push(["b", 9]);
        expect(b.size()).toBe(1);
    });

    it("settle removes an entry only when it was not recorded again since", () => {
        const b = createTagBacklog();
        b.record("tags", ["a"]);
        b.record("tags", ["b"], (_p, g) => ({ generation: g }));
        const [[, ga], [, gb]] = b.snapshot("tags") as [
            string,
            number | { generation: number },
        ][];
        b.record("tags", ["a"]); // recorded again while a replay of `a` was in flight
        expect(b.settle("tags", "a", ga as number)).toBe(false);
        expect(b.sizeOf("tags")).toBe(2);
        expect(
            b.settle("tags", "b", (gb as { generation: number }).generation),
        ).toBe(true);
        expect(b.snapshot("tags").map(([n]) => n)).toEqual(["a"]);
    });

    it("a sweep clears the collapse only if nothing was recorded during it, even into a collapsed backlog", () => {
        const b = createTagBacklog({ max: 1 });
        b.record("tags", ["a", "b"]);
        expect(b.collapsed).toBe(true);
        const raced = b.beginSweep();
        b.record("tags", ["c"]); // refused (collapsed), but it still moves the generation
        b.endSweep(raced);
        expect(b.collapsed).toBe(true);
        const clean = b.beginSweep();
        b.endSweep(clean);
        expect(b.collapsed).toBe(false);
        expect(b.pending()).toBe(false);
    });

    it("dropCollapse and clear", () => {
        const b = createTagBacklog({ max: 1 });
        b.record("tags", ["a", "b"]);
        b.dropCollapse();
        expect(b.collapsed).toBe(false);
        b.record("tags", ["c"]);
        b.clear();
        expect(b.pending()).toBe(false);
        expect(b.generation).toBe(0);
    });

    it("defaults to the shared bound", () => {
        expect(BACKLOG_MAX_ENTRIES).toBe(1000);
        expect(createTagBacklog().max).toBe(BACKLOG_MAX_ENTRIES);
    });
});

// ── the scan: one backlog, and every site on it ──────────────────────────────

const ADAPTERS = join(dirname(fileURLToPath(import.meta.url)), "../adapters");
const HOME = "tag-backlog.js";

function walk(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
        const p = join(dir, name);
        if (statSync(p).isDirectory()) return walk(p);
        return /\.(c|m)?(j|t)s$/.test(name) && !name.endsWith(".d.ts")
            ? [p]
            : [];
    });
}

// A cap of this shape: a constant whose name says it bounds a backlog of tags,
// pending work or entries, set to a number.
const CAP =
    /\b(?:const|let|var)\s+(\w*(?:MAX_TAGS|MAX_PENDING|MAX_ENTRIES|BACKLOG_MAX)\w*)\s*=\s*\d/g;

describe("the cache runtime has one bounded tag backlog", () => {
    const files = walk(ADAPTERS).map((p) => ({
        rel: relative(ADAPTERS, p),
        src: readFileSync(p, "utf8"),
    }));

    it("defines its cap in tag-backlog.js only", () => {
        const caps = files.flatMap((f) =>
            [...f.src.matchAll(CAP)].map((m) => `${f.rel}: ${m[1]}`),
        );
        // Both halves: the shared cap is found (so the scan is not vacuous), and it
        // is the only one.
        expect(caps).toEqual([`${HOME}: BACKLOG_MAX_ENTRIES`]);
    });

    it.each([
        ["cache-handler.js", "createTagBacklog"],
        ["use-cache-handler.js", "createTagBacklog"],
        ["cdn-purge/purger.js", "BACKLOG_MAX_ENTRIES"],
    ])("%s takes %s from the shared backlog", (rel, name) => {
        const src = files.find((f) => f.rel === rel)?.src ?? "";
        expect(src).toMatch(
            new RegExp(
                `import \\{[^}]*\\b${name}\\b[^}]*\\} from '\\.{1,2}/tag-backlog\\.js'`,
            ),
        );
    });
});
