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
        b.bump();
        expect(b.add("tags", "a")).toBe(true);
        b.bump();
        expect(b.add("tags", "a")).toBe(true);
        expect(b.size()).toBe(1);
        expect(b.entries("tags").get("a")).toBe(2);
    });

    it("passes the previous value and the generation to the value function", () => {
        const b = createTagBacklog();
        const seen: unknown[] = [];
        b.bump();
        b.add("tags", "a", (prev, g) => {
            seen.push([prev, g]);
            return { generation: g, n: 1 };
        });
        b.bump();
        b.add("tags", "a", (prev, g) => {
            seen.push([prev, g]);
            return { generation: g, n: 2 };
        });
        expect(seen).toEqual([
            [undefined, 1],
            [{ generation: 1, n: 1 }, 2],
        ]);
    });

    it("collapses on the first NEW name past the bound, once, naming the namespace", () => {
        const collapses: string[] = [];
        const b = createTagBacklog({
            max: 3,
            onCollapse: (ns) => collapses.push(ns),
        });
        b.bump();
        for (const t of ["a", "b", "c"]) expect(b.add("tags", t)).toBe(true);
        // A name already held is not new: no collapse at the bound.
        expect(b.add("tags", "a")).toBe(true);
        expect(b.collapsed).toBe(false);
        expect(b.add("tags", "d")).toBe(false);
        expect(b.collapsed).toBe(true);
        expect(b.size()).toBe(0);
        expect(b.pending()).toBe(true);
        // Collapsed: every later record is refused, and the callback does not repeat.
        expect(b.add("tags", "e")).toBe(false);
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
        b.bump();
        expect(b.add("tags", "t1")).toBe(true);
        expect(b.add("keys", "k1")).toBe(true);
        expect(b.add("keys", "k2")).toBe(false);
        expect(collapses).toEqual(["keys"]);
        expect(b.entries("tags").size + b.entries("keys").size).toBe(0);
    });

    it("refuses an unknown namespace rather than inventing one", () => {
        expect(() => createTagBacklog().add("keys", "k")).toThrow(
            /unknown namespace keys/,
        );
    });

    it("settle removes an entry only when it was not recorded again since", () => {
        const b = createTagBacklog();
        const g1 = b.bump();
        b.add("tags", "a");
        b.add("tags", "b", (_p, g) => ({ generation: g }));
        b.bump();
        b.add("tags", "a"); // recorded again while a replay of g1 was in flight
        expect(b.settle("tags", "a", g1)).toBe(false);
        expect(b.entries("tags").has("a")).toBe(true);
        expect(b.settle("tags", "b", g1)).toBe(true);
        expect(b.entries("tags").has("b")).toBe(false);
    });

    it("a sweep clears the collapse only if nothing was recorded during it", () => {
        const b = createTagBacklog({ max: 1 });
        b.bump();
        b.add("tags", "a");
        b.add("tags", "b");
        expect(b.collapsed).toBe(true);
        const raced = b.beginSweep();
        b.bump(); // a record lands mid-sweep
        b.endSweep(raced);
        expect(b.collapsed).toBe(true);
        const clean = b.beginSweep();
        b.endSweep(clean);
        expect(b.collapsed).toBe(false);
        expect(b.pending()).toBe(false);
    });

    it("dropCollapse and clear", () => {
        const b = createTagBacklog({ max: 1 });
        b.bump();
        b.add("tags", "a");
        b.add("tags", "b");
        b.dropCollapse();
        expect(b.collapsed).toBe(false);
        b.bump();
        b.add("tags", "c");
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
const CAP = /\bconst\s+(\w*(?:MAX_TAGS|MAX_PENDING|MAX_ENTRIES)\w*)\s*=\s*\d/g;

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
