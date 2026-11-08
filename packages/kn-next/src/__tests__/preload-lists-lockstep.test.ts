/**
 * preload-lists-lockstep — the preload set is stated in three places that
 * nothing ties together:
 *
 *   1. the Node spawn           node-server.ts  `--require` preloads that load
 *                               on every runtime
 *   2. the Bun spawn            node-server.ts  the same, plus the preloads
 *                               appended inside `if (process.versions.bun)`
 *   3. the compiled executable  standalone-compile.mjs  `PRELOAD_NAMES`
 *
 * They are maintained by hand. Add a preload to one list and forget another
 * and one serving shape silently loses a safeguard (the body-size cap, the
 * Cache-Control rules, the public-origin redirect rewrite) while the other two
 * keep it, so the compat suite, the kind drills and production no longer run
 * the same server.
 *
 * Each list is derived from the SOURCE as text. A list that cannot be read, or
 * a `--require` the scanner cannot attribute to a named file, FAILS the guard
 * rather than being skipped: the number of `"--require"` tokens in each region
 * of node-server.ts must equal the number of entries the scanner attributed, so
 * an inline `resolve(...)`, a string literal or a spread cannot slip past it.
 * Differences that are deliberate are named in the two tables below, not
 * tolerated implicitly. Every named file must also exist beside the adapters.
 *
 * Scope: the lists are compared as SETS. Load ORDER is not checked (the compiled
 * executable deliberately runs the ARP primer first and the spawn lists order
 * differently), so this guard says "the same preloads run", not "in the same
 * order".
 *
 * The guard is mutation-proved twice: in-file, against mutated copies of the
 * real sources (the `drift` cases), and by editing the real files and checking
 * this file's exit code.
 */

import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const ADAPTERS = resolve(__dirname, "..", "adapters");
const NODE_SERVER = readFileSync(resolve(ADAPTERS, "node-server.ts"), "utf8");
const COMPILE = readFileSync(
    resolve(ADAPTERS, "standalone-compile.mjs"),
    "utf8",
);

/**
 * In the compiled executable's list but deliberately NOT in node-server.ts's
 * `--require` list, with the reason. There is no supervisor in the compiled
 * stage, so these are baked in instead of spawned / gated differently.
 */
const COMPILE_ONLY: Record<string, string> = {
    "arp-primer.cjs":
        "node-server.ts runs the ARP primer in-process in the supervisor, not as a --require; the compiled exec has no supervisor so it is the first preload",
    "standalone-self-contained-supervisor.cjs":
        "folds the SIGTERM drain and metrics sidecar into the self-contained exec; on disk-mode cells that role is a separate process (knext-standalone-entry.mjs), and node-server.ts never --requires it",
};

/**
 * In node-server.ts but only on some runtimes. `bunOnly` is appended inside
 * the `process.versions.bun` block; the compiled executable is a Bun binary,
 * so it must carry them too.
 */
const BUN_ONLY: readonly string[] = ["bun-keepalive-guard.cjs"];

/** Index of the `}` that closes the `{` at `open`. */
function matchBrace(src: string, open: number): number {
    let depth = 0;
    for (let i = open; i < src.length; i++) {
        if (src[i] === "{") depth++;
        else if (src[i] === "}" && --depth === 0) return i;
    }
    throw new Error("unbalanced braces in node-server.ts");
}

/** `const <var> = resolve(import.meta.dirname, "<file>.cjs")` bindings. */
function fileBindings(src: string): Map<string, string> {
    const out = new Map<string, string>();
    const re =
        /const\s+(\w+)\s*=\s*resolve\(\s*import\.meta\.dirname,\s*["']([^"']+\.cjs)["']\s*,?\s*\)/g;
    for (let m = re.exec(src); m; m = re.exec(src)) out.set(m[1], m[2]);
    return out;
}

/** Variables handed to `--require`, in source order. */
function requiredVars(src: string): string[] {
    const out: string[] = [];
    const re =
        /(?:preloadArgs\.push\(\s*|\?\s*\[\s*)["']--require["']\s*,\s*(\w+)\s*[,\])]/g;
    for (let m = re.exec(src); m; m = re.exec(src)) out.push(m[1]);
    return out;
}

interface PreloadLists {
    /** Preloads node-server.ts passes on every runtime. */
    node: string[];
    /** Preloads node-server.ts passes only under Bun. */
    bunExtra: string[];
    /** `PRELOAD_NAMES` in standalone-compile.mjs, with the SELF_CONTAINED push. */
    compile: string[];
}

function readPreloadLists(
    nodeServerSrc: string,
    compileSrc: string,
): PreloadLists {
    const bindings = fileBindings(nodeServerSrc);

    const gate = nodeServerSrc.indexOf("if (process.versions.bun) {");
    if (gate < 0) throw new Error("no `if (process.versions.bun)` block");
    const open = nodeServerSrc.indexOf("{", gate);
    const close = matchBrace(nodeServerSrc, open);
    const bunBlock = nodeServerSrc.slice(open, close + 1);
    const common =
        nodeServerSrc.slice(0, open) + nodeServerSrc.slice(close + 1);

    const nameOf = (v: string): string => {
        const f = bindings.get(v);
        if (!f) {
            throw new Error(
                `--require ${v} is not bound to a sibling .cjs by resolve(import.meta.dirname, "...")`,
            );
        }
        return f;
    };
    // Every `"--require"` token must have been attributed to a named file; one
    // the regex missed (inline resolve(), literal, spread) fails here.
    const tokens = (src: string): number =>
        (src.match(/["']--require["']/g) ?? []).length;
    const attributed = (src: string): string[] => {
        const vars = requiredVars(src);
        if (vars.length !== tokens(src)) {
            throw new Error(
                `${tokens(src)} "--require" token(s) but only ${vars.length} attributable to a bound .cjs variable`,
            );
        }
        return vars.map(nameOf);
    };
    const node = attributed(common);
    const bunExtra = attributed(bunBlock);

    const block = /const PRELOAD_NAMES = \[([\s\S]*?)\];/.exec(compileSrc)?.[1];
    if (block === undefined) throw new Error("no PRELOAD_NAMES array");
    const compile = [...block.matchAll(/["']([^"']+\.cjs)["']/g)].map(
        (m) => m[1],
    );
    for (const m of compileSrc.matchAll(
        /PRELOAD_NAMES\.push\(\s*["']([^"']+\.cjs)["']\s*\)/g,
    )) {
        compile.push(m[1]);
    }
    return { node, bunExtra, compile };
}

/** Every disagreement between the three lists, as readable lines. */
function preloadDrift(l: PreloadLists): string[] {
    const out: string[] = [];
    const compile = new Set(l.compile);
    const node = new Set(l.node);
    const bun = new Set([...l.node, ...l.bunExtra]);

    for (const n of l.node) {
        if (!compile.has(n)) {
            out.push(
                `${n}: in the Node/Bun spawn but missing from PRELOAD_NAMES`,
            );
        }
    }
    for (const n of l.bunExtra) {
        if (!compile.has(n)) {
            out.push(`${n}: in the Bun spawn but missing from PRELOAD_NAMES`);
        }
        if (node.has(n)) {
            out.push(
                `${n}: listed both unconditionally and under the Bun gate`,
            );
        }
    }
    for (const n of l.compile) {
        if (!bun.has(n) && !(n in COMPILE_ONLY)) {
            out.push(
                `${n}: in PRELOAD_NAMES but in neither spawn list (add it there, or name it in COMPILE_ONLY)`,
            );
        }
    }
    for (const n of Object.keys(COMPILE_ONLY)) {
        if (!compile.has(n))
            out.push(`${n}: COMPILE_ONLY names it but PRELOAD_NAMES lacks it`);
        if (bun.has(n))
            out.push(
                `${n}: COMPILE_ONLY names it but node-server.ts also requires it`,
            );
    }
    if (
        JSON.stringify([...l.bunExtra].sort()) !==
        JSON.stringify([...BUN_ONLY].sort())
    ) {
        out.push(
            `Bun-gated preloads are [${l.bunExtra}], expected exactly [${BUN_ONLY}]`,
        );
    }
    if (new Set(l.compile).size !== l.compile.length) {
        out.push("PRELOAD_NAMES lists a preload twice");
    }
    return out;
}

/** Named preloads with no file in `dir`. */
function missingFiles(names: readonly string[], dir: string): string[] {
    return [...new Set(names)].filter((n) => !existsSync(resolve(dir, n)));
}

const real = readPreloadLists(NODE_SERVER, COMPILE);

/** Replace `from` with `to`, refusing unless `from` occurs exactly once. */
function mutate(src: string, from: string, to: string): string {
    const n = src.split(from).length - 1;
    if (n !== 1) throw new Error(`anchor occurs ${n}x, expected 1: ${from}`);
    return src.replace(from, to);
}

describe("preload lists stay in lockstep (Node, Bun, compiled exec)", () => {
    it("the three shared preloads are on the Node/Bun spawn and the compiled list", () => {
        for (const n of [
            "request-body-cap.cjs",
            "cache-control-normalize.cjs",
            "public-origin.cjs",
        ]) {
            expect(real.node).toContain(n);
            expect(real.compile).toContain(n);
        }
    });

    it("the Bun spawn adds exactly the keep-alive guard, and the compiled exec has it", () => {
        expect(real.bunExtra).toEqual([...BUN_ONLY]);
        for (const n of BUN_ONLY) expect(real.compile).toContain(n);
    });

    it("no list drifts from another", () => {
        expect(preloadDrift(real)).toEqual([]);
    });

    it("every named preload exists beside the adapters", () => {
        expect(
            missingFiles(
                [...real.node, ...real.bunExtra, ...real.compile],
                ADAPTERS,
            ),
        ).toEqual([]);
    });

    it("a named preload with no file is reported", () => {
        expect(missingFiles(["no-such-preload.cjs"], ADAPTERS)).toEqual([
            "no-such-preload.cjs",
        ]);
    });

    describe("reds on drift (the guard is not decoration)", () => {
        const cases: Array<{
            name: string;
            node?: [string, string];
            compile?: [string, string];
        }> = [
            {
                name: "request-body-cap dropped from the compiled list",
                compile: ['  "request-body-cap.cjs",\n', ""],
            },
            {
                name: "public-origin dropped from the compiled list",
                compile: ['  "public-origin.cjs",\n', ""],
            },
            {
                name: "cache-control-normalize dropped from the compiled list",
                compile: ['  "cache-control-normalize.cjs",\n', ""],
            },
            {
                name: "bun-keepalive-guard dropped from the compiled list",
                compile: ['  "bun-keepalive-guard.cjs",\n', ""],
            },
            {
                name: "request-body-cap no longer required by the spawn",
                node: [
                    'preloadArgs.push("--require", requestBodyCapPreload);',
                    "void requestBodyCapPreload;",
                ],
            },
            {
                name: "public-origin no longer required by the spawn",
                node: [
                    'preloadArgs.push("--require", publicOriginPreload);',
                    "void publicOriginPreload;",
                ],
            },
            {
                name: "cache-control-normalize no longer required by the spawn",
                node: ['? ["--require", cacheControlPreload]', "? []"],
            },
            {
                name: "bun-keepalive-guard no longer required by the Bun spawn",
                node: [
                    'preloadArgs.push("--require", bunKeepaliveGuard);',
                    "void bunKeepaliveGuard;",
                ],
            },
            {
                name: "a new preload pushed to the compiled list only",
                compile: [
                    '  "request-body-cap.cjs",\n',
                    '  "request-body-cap.cjs",\n  "new-preload.cjs",\n',
                ],
            },
            {
                name: "a preload duplicated in the compiled list",
                compile: [
                    '  "public-origin.cjs",\n',
                    '  "public-origin.cjs",\n  "public-origin.cjs",\n',
                ],
            },
        ];
        for (const c of cases) {
            it(c.name, () => {
                const n = c.node
                    ? mutate(NODE_SERVER, c.node[0], c.node[1])
                    : NODE_SERVER;
                const k = c.compile
                    ? mutate(COMPILE, c.compile[0], c.compile[1])
                    : COMPILE;
                expect(
                    preloadDrift(readPreloadLists(n, k)).length,
                ).toBeGreaterThan(0);
            });
        }

        it("a --require the scanner cannot attribute to a file fails loudly", () => {
            const n = mutate(
                NODE_SERVER,
                'preloadArgs.push("--require", requestBodyCapPreload);',
                'preloadArgs.push("--require", someOtherVar);',
            );
            expect(() => readPreloadLists(n, COMPILE)).toThrow(/someOtherVar/);
        });

        for (const [name, replacement] of [
            [
                "an inline resolve()",
                'preloadArgs.push("--require", resolve(import.meta.dirname, "new.cjs"));',
            ],
            ["a string literal", 'preloadArgs.push("--require", "x.cjs");'],
            ["a spread", 'preloadArgs.push(...["--require", x]);'],
        ] as const) {
            it(`a --require given as ${name} fails loudly`, () => {
                const n = mutate(
                    NODE_SERVER,
                    'preloadArgs.push("--require", requestBodyCapPreload);',
                    replacement,
                );
                expect(() => readPreloadLists(n, COMPILE)).toThrow(
                    /"--require" token/,
                );
            });
        }
    });
});
