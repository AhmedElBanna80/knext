/**
 * #2614 follow-up — a `createRequire(import.meta.url)(SPEC)` whose SPEC is a
 * module-level constant assembled from string literals
 * (`['io', 'redis'].join('')`, the idiom @getknext/lib uses so no bundler can
 * follow ioredis) is a DELIBERATE runtime load of a known package, not an
 * unknown one. It is reported by name, never embedded and never strict-failed.
 *
 * The exemption is as narrow as the idiom: a specifier the analysis cannot fold
 * to a string (an env read, a parameter, a name declared twice, a non-string
 * element) is still a non-literal require and still fails the strict build.
 * Both halves are asserted.
 */
import { describe, expect, it } from "bun:test";
import { analyzeServerModule } from "../adapters/entry-require-staticize.mjs";

const IMPORT = 'import { createRequire } from "node:module";\n';
const MARKER = "\0knext-direct-require-call";

describe("a constant specifier assembled from literals is a named deliberate load", () => {
    it("a module-level `[...].join('')` const is folded and not a non-literal require", () => {
        const src =
            IMPORT +
            "const SPEC = ['io', 'redis'].join('');\n" +
            "export function load() { return createRequire(import.meta.url)(SPEC); }\n";
        const a = analyzeServerModule(src);
        expect(a.foldedRuntimeRequires).toEqual(["ioredis"]);
        expect(a.nonLiteralCallees.has(MARKER)).toBe(false);
        expect(a.requireBindings).not.toContain(MARKER);
        expect(a.unrecognizedBinding).toBe(false);
    });

    it("folds the same constant inside a multi-declaration (bundler output) and the getter-url form", () => {
        const src =
            IMPORT +
            "var a = 1, Oe$3 = [`io`, `redis`].join(``), b = 2;\n" +
            "function ke() { let ew = createRequire({get value(){return r.url}}.value)(Oe$3); return ew.default ?? ew; }\n";
        const a = analyzeServerModule(src);
        expect(a.foldedRuntimeRequires).toEqual(["ioredis"]);
        expect(a.nonLiteralCallees.has(MARKER)).toBe(false);
    });

    it("folds a hoisted declaration assigned once inside a lazy init (rolldown's shape)", () => {
        const src =
            IMPORT +
            "let Te, Oe, Ae;\n" +
            "var init_x = __esmMin(() => { Te = !0, Oe = ['io', 'redis'].join(''), Ae = 5; });\n" +
            "function ke() { return createRequire(import.meta.url)(Oe); }\n";
        const a = analyzeServerModule(src);
        expect(a.foldedRuntimeRequires).toEqual(["ioredis"]);
        expect(a.nonLiteralCallees.has(MARKER)).toBe(false);
    });

    it("folds an inline array-join argument", () => {
        const src =
            IMPORT +
            "export const f = () => createRequire(import.meta.url)(['io', 'redis'].join(''));\n";
        expect(analyzeServerModule(src).foldedRuntimeRequires).toEqual([
            "ioredis",
        ]);
    });
});

describe("anything the analysis cannot fold stays a non-literal require (the strict gate holds)", () => {
    const cases: [string, string][] = [
        [
            "an env read",
            "const SPEC = process.env.PKG;\nexport const f = () => createRequire(import.meta.url)(SPEC);\n",
        ],
        [
            "a function parameter",
            "export const f = (SPEC) => createRequire(import.meta.url)(SPEC);\n",
        ],
        [
            "a name declared twice (could be either)",
            "const SPEC = ['io', 'redis'].join('');\nexport const f = (SPEC) => createRequire(import.meta.url)(SPEC);\n",
        ],
        [
            "a non-string array element",
            "const SPEC = ['io', name].join('');\nexport const f = () => createRequire(import.meta.url)(SPEC);\n",
        ],
        [
            "a non-empty join separator",
            "const SPEC = ['io', 'redis'].join('/');\nexport const f = () => createRequire(import.meta.url)(SPEC);\n",
        ],
        [
            "an empty array (folds to no package at all)",
            "const SPEC = [].join('');\nexport const f = () => createRequire(import.meta.url)(SPEC);\n",
        ],
        [
            "a hoisted name assigned twice",
            "let SPEC;\nSPEC = ['io', 'redis'].join('');\nSPEC = process.env.PKG;\nexport const f = () => createRequire(import.meta.url)(SPEC);\n",
        ],
        [
            "a compound assignment",
            "let SPEC = ['io', 'redis'].join('');\nSPEC += 'x';\nexport const f = () => createRequire(import.meta.url)(SPEC);\n",
        ],
        [
            "a reassigned name",
            "let SPEC = ['io', 'redis'].join('');\nSPEC = process.env.PKG;\nexport const f = () => createRequire(import.meta.url)(SPEC);\n",
        ],
    ];
    it.each(cases)("%s", (_label, body) => {
        const a = analyzeServerModule(IMPORT + body);
        expect(a.foldedRuntimeRequires).toEqual([]);
        expect(a.nonLiteralCallees.has(MARKER)).toBe(true);
    });
});
