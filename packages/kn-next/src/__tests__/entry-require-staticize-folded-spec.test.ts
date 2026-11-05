/**
 * #2614 follow-up — `createRequire(import.meta.url)(SPEC)` where SPEC is the
 * literal-join idiom (`['io', 'redis'].join('')`, how @getknext/lib hides ioredis
 * from bundlers) AND folds to exactly `ioredis` is a DELIBERATE runtime load whose
 * call is dead under Bun. It is reported by name, never embedded and never
 * strict-failed.
 *
 * The exemption is exactly that name. Every other folded value (`sharp`, a
 * relative or absolute path, `node:fs`) and every specifier the analysis cannot
 * fold (an env read, a parameter, a name bound or written twice, a non-string
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
            "a non-string array element (would fold to ioredis if skipped)",
            "const SPEC = ['io', name, 'redis'].join('');\nexport const f = () => createRequire(import.meta.url)(SPEC);\n",
        ],
        [
            "a non-empty join separator",
            "const SPEC = ['io', 'redis'].join('/');\nexport const f = () => createRequire(import.meta.url)(SPEC);\n",
        ],
        [
            "a folded name that is not ioredis (sharp)",
            "const SPEC = ['sha', 'rp'].join('');\nexport const f = () => createRequire(import.meta.url)(SPEC);\n",
        ],
        [
            "a folded relative path",
            "const SPEC = ['./', 'plugins/x.js'].join('');\nexport const f = () => createRequire(import.meta.url)(SPEC);\n",
        ],
        [
            "a folded parent-relative path",
            "const SPEC = ['../', '../secret'].join('');\nexport const f = () => createRequire(import.meta.url)(SPEC);\n",
        ],
        [
            "a folded absolute path",
            "const SPEC = ['/etc/', 'x'].join('');\nexport const f = () => createRequire(import.meta.url)(SPEC);\n",
        ],
        [
            "a folded builtin (node:fs)",
            "const SPEC = ['node', ':fs'].join('');\nexport const f = () => createRequire(import.meta.url)(SPEC);\n",
        ],
        [
            "ioredis with a path suffix (startsWith / includes would accept it)",
            "const SPEC = ['io', 'redis/foo'].join('');\nexport const f = () => createRequire(import.meta.url)(SPEC);\n",
        ],
        [
            "ioredis with a leading space (trim / endsWith would accept it)",
            "const SPEC = [' io', 'redis'].join('');\nexport const f = () => createRequire(import.meta.url)(SPEC);\n",
        ],
        [
            "ioredis with a trailing space (trim / startsWith would accept it)",
            "const SPEC = ['io', 'redis '].join('');\nexport const f = () => createRequire(import.meta.url)(SPEC);\n",
        ],
        [
            "IOREDIS (a case-insensitive match would accept it)",
            "const SPEC = ['IO', 'REDIS'].join('');\nexport const f = () => createRequire(import.meta.url)(SPEC);\n",
        ],
        [
            "node:ioredis (stripping node: / endsWith would accept it)",
            "const SPEC = ['node:', 'ioredis'].join('');\nexport const f = () => createRequire(import.meta.url)(SPEC);\n",
        ],
        [
            "an inline folded name that is not ioredis",
            "export const f = () => createRequire(import.meta.url)(['sha', 'rp'].join(''));\n",
        ],
        [
            "a name changed by ++",
            "let SPEC = ['io', 'redis'].join('');\nSPEC++;\nexport const f = () => createRequire(import.meta.url)(SPEC);\n",
        ],
        [
            "a name that is a for-of target",
            "let SPEC = ['io', 'redis'].join('');\nfor (SPEC of xs) {}\nexport const f = () => createRequire(import.meta.url)(SPEC);\n",
        ],
        [
            "a name that is a for-in target",
            "let SPEC = ['io', 'redis'].join('');\nfor (SPEC in xs) {}\nexport const f = () => createRequire(import.meta.url)(SPEC);\n",
        ],
        [
            "a name shadowed by a catch parameter",
            "const SPEC = ['io', 'redis'].join('');\ntry { f(); } catch (SPEC) { g(SPEC); }\nexport const f2 = () => createRequire(import.meta.url)(SPEC);\n",
        ],
        [
            "a name assigned through object destructuring",
            "let SPEC = ['io', 'redis'].join('');\n({ SPEC } = obj);\nexport const f = () => createRequire(import.meta.url)(SPEC);\n",
        ],
        [
            "a name assigned through array destructuring",
            "let SPEC = ['io', 'redis'].join('');\n[SPEC] = arr;\nexport const f = () => createRequire(import.meta.url)(SPEC);\n",
        ],
        [
            "a name re-declared by an object destructuring declaration",
            "const SPEC = ['io', 'redis'].join('');\nfunction g(o) { const { SPEC } = o; return SPEC; }\nexport const f = () => createRequire(import.meta.url)(SPEC);\n",
        ],
        [
            "a name re-declared by a renamed object-pattern property",
            "const SPEC = ['io', 'redis'].join('');\nfunction g(o) { const { k: SPEC } = o; return SPEC; }\nexport const f = () => createRequire(import.meta.url)(SPEC);\n",
        ],
        [
            "a name re-declared by an object rest element",
            "const SPEC = ['io', 'redis'].join('');\nfunction g(o) { const { ...SPEC } = o; return SPEC; }\nexport const f = () => createRequire(import.meta.url)(SPEC);\n",
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
