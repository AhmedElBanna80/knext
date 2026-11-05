/**
 * #2666 — the strict-require check follows every `createRequire` binding, not
 * only same-name literal calls.
 *
 * Before: the analysis saw `createRequire(import.meta.url)` calls through the
 * import's own local name, and a recorded require binding only through a literal
 * call by that name. Every shape below passed silently and left the required
 * package out of the compiled executable:
 *
 *   - aliasing the creator            `const c = e; c(import.meta.url)("pkg")`
 *   - copying/storing/passing a made require   `const s = r; s("pkg")`, `{ x: r }`, `f(r)`
 *   - `import * as m from "module"`            `m.createRequire(import.meta.url)("pkg")`
 *   - a wrapper                                `function mk(u) { return e(u) }`
 *   - a destructured dynamic import            `const { createRequire: e } = await import("node:module")`
 *
 * Each is asserted BOTH ways: it either RESOLVES (the require is recorded, so
 * it is embedded or strict-failed on its own merits) or it is reported as an
 * unrecognised binding (which fails the strict compile). The look-alikes that
 * must NOT be reported (a shadowed name, a `.resolve` probe, an export) are
 * asserted too, because minified output reuses one-letter names everywhere and
 * a scope-blind check would red builds that work today.
 */
import { describe, expect, it } from "bun:test";
import {
    analyzeServerModule,
    importedRequireEscapes,
} from "../adapters/entry-require-staticize.mjs";

const IMPORT = 'import { createRequire as e } from "node:module";\n';
const MARKER = "\0knext-direct-require-call";

function directSpecs(src: string): string[] {
    const a = analyzeServerModule(src);
    return [...(a.literalCalls.get(MARKER) ?? [])];
}

describe("#2666: an aliased creator is followed", () => {
    it("`const c = e; c(import.meta.url)('pkg')` records the require", () => {
        const src =
            IMPORT +
            "const c = e;\nexport const load = () => c(import.meta.url)('pkg-a');\n";
        const a = analyzeServerModule(src);
        expect(a.unrecognizedBinding).toBe(false);
        expect(directSpecs(src)).toEqual(["pkg-a"]);
    });

    it("a chain of aliases is followed to the end", () => {
        const src =
            IMPORT +
            "const c = e, d = c;\nexport const load = () => d(import.meta.url)('pkg-a');\n";
        expect(directSpecs(src)).toEqual(["pkg-a"]);
        expect(analyzeServerModule(src).unrecognizedBinding).toBe(false);
    });

    it("an alias that is re-assigned cannot be followed and is reported", () => {
        const src =
            IMPORT +
            "let c = e;\nc = other;\nexport const load = () => c(import.meta.url)('pkg-a');\n";
        expect(analyzeServerModule(src).unrecognizedBinding).toBe(true);
    });

    it("an alias assigned later than its declaration is reported", () => {
        const src =
            IMPORT +
            "let c;\nc = e;\nexport const load = () => c(import.meta.url)('pkg-a');\n";
        expect(analyzeServerModule(src).unrecognizedBinding).toBe(true);
    });

    it.each([
        ["passed to a call", "use(e);"],
        ["stored in an object", "export const o = { x: e };"],
        ["stored in an array", "export const a = [e];"],
        ["returned", "export function f() { return e; }"],
        ["exported by name", "export { e as makeRequire };"],
        ["exported as the default", "export default e;"],
        ["assigned to a member", "globalThis.mk = e;"],
    ])("the creator itself %s is reported", (_label, use) => {
        expect(
            analyzeServerModule(IMPORT + use + "\n").unrecognizedBinding,
        ).toBe(true);
    });
});

describe("#2666: a made require that is copied, stored or passed is reported", () => {
    const MADE = IMPORT + "var r = e(import.meta.url);\n";

    it("`const s = r; s('pkg')` is reported", () => {
        expect(
            analyzeServerModule(
                MADE + "const s = r;\nexport const l = () => s('pkg-a');\n",
            ).unrecognizedBinding,
        ).toBe(true);
    });

    it.each([
        ["stored in an object", "export const o = { x: r };"],
        ["stored in an array", "export const a = [r];"],
        ["passed to a call", "use(r);"],
        ["returned", "export function f() { return r; }"],
        ["exported as the default", "export default r;"],
        ["spread", "use(...[r]);"],
        ["bound via .bind", "export const b = r.bind(null);"],
        ["called via .call", "export const c = r.call(null, 'pkg-a');"],
    ])("%s is reported", (_label, use) => {
        expect(analyzeServerModule(MADE + use + "\n").unrecognizedBinding).toBe(
            true,
        );
    });

    it.each([
        ["a literal call", "export const l = () => r('pkg-a');"],
        ["a dynamic call", "export const l = (n) => r(n);"],
        ["a resolve probe", "export const l = () => r.resolve('pkg-a');"],
        ["a cache read", "export const l = () => r.cache;"],
        [
            "a named export (the cross-chunk shape)",
            "export { r as __require };",
        ],
        ["a typeof test", "export const t = typeof r;"],
    ])("%s is not a hand-off", (_label, use) => {
        expect(analyzeServerModule(MADE + use + "\n").unrecognizedBinding).toBe(
            false,
        );
    });

    it("the rolldown IIFE binding shape is still a binding, not a hand-off", () => {
        const src =
            IMPORT +
            "var __require = /* #__PURE__ */ (() => e(import.meta.url))();\n" +
            "export const l = () => __require('pkg-a');\n";
        const a = analyzeServerModule(src);
        expect(a.unrecognizedBinding).toBe(false);
        expect(a.requireBindings).toContain("__require");
        expect([...(a.literalCalls.get("__require") ?? [])]).toEqual(["pkg-a"]);
    });
});

describe("#2666: shadowed one-letter names are NOT the require (scope-aware)", () => {
    it("a parameter named like the creator is not a hand-off of it", () => {
        const src =
            IMPORT +
            "var r = e(import.meta.url);\n" +
            "function f(e, r) { use(e, r); return [e, r, { e, r }]; }\n" +
            "export const l = () => r('pkg-a');\n";
        expect(analyzeServerModule(src).unrecognizedBinding).toBe(false);
    });

    it("a block-scoped, catch-scoped and var-scoped redeclaration is not a hand-off", () => {
        const src =
            IMPORT +
            "var r = e(import.meta.url);\n" +
            "function g() { { const e = 1; use(e); } }\n" +
            "function h() { try {} catch (r) { use(r); } }\n" +
            "function k() { var r = 2; return use(r); }\n" +
            "export const l = () => r('pkg-a');\n";
        expect(analyzeServerModule(src).unrecognizedBinding).toBe(false);
    });

    it("a property key, member name and label spelled like the creator are not references", () => {
        const src =
            IMPORT +
            "var r = e(import.meta.url);\n" +
            "export const o = { e: 1, r: 2 };\n" +
            "export const p = o.e + o.r;\n" +
            "e1: for (;;) { break e1; }\n" +
            "export const l = () => r('pkg-a');\n";
        expect(analyzeServerModule(src).unrecognizedBinding).toBe(false);
    });

    it("an outer name used inside a function that does NOT shadow it is still a hand-off", () => {
        const src =
            IMPORT +
            "var r = e(import.meta.url);\n" +
            "function f(x) { return use(r, x); }\n";
        expect(analyzeServerModule(src).unrecognizedBinding).toBe(true);
    });

    it("a function declared AFTER its use still shadows (hoisting)", () => {
        const src =
            IMPORT +
            "var r = e(import.meta.url);\n" +
            "export function f() { return r; function r() {} }\n" +
            "export const l = () => r('pkg-a');\n";
        expect(analyzeServerModule(src).unrecognizedBinding).toBe(false);
    });
});

describe("#2666: `import * as m from 'module'` is followed", () => {
    it.each([
        ["namespace", 'import * as m from "node:module";\n'],
        ["default", 'import m from "module";\n'],
        ["`default as`", 'import { default as m } from "node:module";\n'],
    ])("%s import: `m.createRequire(import.meta.url)('pkg')` records the require", (_label, imp) => {
        const src =
            imp +
            "export const load = () => m.createRequire(import.meta.url)('pkg-a');\n";
        const a = analyzeServerModule(src);
        expect(a.unrecognizedBinding).toBe(false);
        expect(directSpecs(src)).toEqual(["pkg-a"]);
    });

    it("a made require through the namespace is a tracked binding", () => {
        const src =
            'import * as m from "module";\n' +
            "var r = m.createRequire(import.meta.url);\n" +
            "export const l = () => r('pkg-a');\n";
        const a = analyzeServerModule(src);
        expect(a.requireBindings).toContain("r");
        expect([...(a.literalCalls.get("r") ?? [])]).toEqual(["pkg-a"]);
        expect(a.unrecognizedBinding).toBe(false);
    });

    it.each([
        ["the namespace passed on", "use(m);"],
        ["the namespace stored", "export const ns = m;"],
        ["the namespace spread", "export const s = { ...m };"],
        ["a computed member", "export const c = m['createRequire'];"],
        [
            "`m.createRequire` taken without being called",
            "export const c = m.createRequire;",
        ],
        ["`m.default` (a second namespace)", "export const d = m.default;"],
    ])("%s is reported", (_label, use) => {
        const src = 'import * as m from "node:module";\n' + use + "\n";
        expect(analyzeServerModule(src).unrecognizedBinding).toBe(true);
    });

    it("other members of the namespace are not a hand-off", () => {
        const src =
            'import * as m from "node:module";\n' +
            "export const b = m.builtinModules;\n" +
            "export const t = m.isBuiltin('fs');\n" +
            "export const l = () => m.createRequire(import.meta.url)('pkg-a');\n";
        expect(analyzeServerModule(src).unrecognizedBinding).toBe(false);
    });

    it("an unrelated module namespace is ignored", () => {
        const src =
            'import * as p from "node:path";\nexport const x = [p, "createRequire"];\n';
        expect(analyzeServerModule(src).unrecognizedBinding).toBe(false);
    });
});

describe("#2666: a wrapper around the creator is followed", () => {
    it("`function mk(u) { return e(u) }` is reported (the anchor is unknown)", () => {
        const src =
            IMPORT +
            "function mk(u) { return e(u); }\nexport const l = () => mk(import.meta.url)('pkg-a');\n";
        expect(analyzeServerModule(src).unrecognizedBinding).toBe(true);
    });

    it("an arrow wrapper is reported too", () => {
        const src = IMPORT + "export const mk = (u) => e(u);\n";
        expect(analyzeServerModule(src).unrecognizedBinding).toBe(true);
    });

    it("an anchor held in a variable is followed to import.meta.url", () => {
        const src =
            IMPORT +
            "const u = import.meta.url;\nexport const l = () => e(u)('pkg-a');\n";
        const a = analyzeServerModule(src);
        expect(a.unrecognizedBinding).toBe(false);
        expect(directSpecs(src)).toEqual(["pkg-a"]);
    });

    it("an anchor derived from import.meta by another expression is reported", () => {
        const src =
            IMPORT +
            "export const l = () => e(new URL('.', import.meta.url).href)('pkg-a');\n";
        expect(analyzeServerModule(src).unrecognizedBinding).toBe(true);
    });

    it("a create anchored elsewhere (a literal, the cwd) is not derived from import.meta and stays unreported", () => {
        const src =
            IMPORT +
            "var a = e('/');\nvar b = e(process.cwd() + '/');\nexport { a, b };\n";
        expect(analyzeServerModule(src).unrecognizedBinding).toBe(false);
    });
});

describe("#2666: a destructured dynamic import of createRequire is followed", () => {
    it("`const { createRequire: e } = await import('node:module')` records the require", () => {
        const src =
            'const { createRequire: e } = await import("node:module");\n' +
            "export const l = e(import.meta.url)('pkg-a');\n";
        const a = analyzeServerModule(src);
        expect(a.unrecognizedBinding).toBe(false);
        expect(directSpecs(src)).toEqual(["pkg-a"]);
    });

    it("the shorthand `const { createRequire } = await import('module')` is followed", () => {
        const src =
            'const { createRequire } = await import("module");\n' +
            "export const l = createRequire(import.meta.url)('pkg-a');\n";
        expect(directSpecs(src)).toEqual(["pkg-a"]);
    });

    it("a namespace from a dynamic import is followed", () => {
        const src =
            'const m = await import("node:module");\n' +
            "export const l = m.createRequire(import.meta.url)('pkg-a');\n";
        expect(directSpecs(src)).toEqual(["pkg-a"]);
    });

    it("a dynamic-import creator that is passed on is reported", () => {
        const src =
            'const { createRequire: e } = await import("node:module");\nuse(e);\n';
        expect(analyzeServerModule(src).unrecognizedBinding).toBe(true);
    });

    it("any other use of a dynamic `import('module')` in a createRequire module is reported", () => {
        const src =
            'import("node:module").then((m) => use(m.createRequire));\n';
        expect(analyzeServerModule(src).unrecognizedBinding).toBe(true);
    });

    it("an `import('node:path')` in the same module is ignored", () => {
        const src =
            IMPORT +
            "var r = e(import.meta.url);\nexport const p = import('node:path');\nexport const l = () => r('pkg-a');\n";
        expect(analyzeServerModule(src).unrecognizedBinding).toBe(false);
    });
});

describe("#2666: hand-offs in the importing chunk (the multi-chunk shape)", () => {
    it("`const s = n; s('pkg')` on an imported require binding is an escape", () => {
        expect(
            importedRequireEscapes(
                'import { n as __require } from "./rolldown-runtime.mjs";\nconst s = __require;\nexport const l = () => s("pkg-a");\n',
                ["__require"],
            ),
        ).toBe(true);
    });

    it.each([
        ["a literal call", 'export const l = () => __require("pkg-a");'],
        ["a dynamic call", "export const l = (n) => __require(n);"],
        [
            "a resolve probe",
            'export const l = () => __require.resolve("pkg-a");',
        ],
    ])("%s is not an escape", (_label, use) => {
        expect(
            importedRequireEscapes(
                'import { n as __require } from "./rolldown-runtime.mjs";\n' +
                    use +
                    "\n",
                ["__require"],
            ),
        ).toBe(false);
    });

    it.each([
        ["stored", "export const o = { x: __require };"],
        ["passed", "use(__require);"],
        ["re-exported by name", "export { __require as r2 };"],
    ])("an imported binding %s is an escape", (_label, use) => {
        expect(
            importedRequireEscapes(
                'import { n as __require } from "./rolldown-runtime.mjs";\n' +
                    use +
                    "\n",
                ["__require"],
            ),
        ).toBe(true);
    });

    it("a local that shadows the imported name is not the binding", () => {
        expect(
            importedRequireEscapes(
                'import { n as __require } from "./rolldown-runtime.mjs";\n' +
                    "export function f(__require) { return use(__require); }\n",
                ["__require"],
            ),
        ).toBe(false);
    });

    it("an unparseable importer fails closed", () => {
        expect(importedRequireEscapes("var x = {{ ;", ["__require"])).toBe(
            true,
        );
    });

    it("no names to check is never an escape", () => {
        expect(importedRequireEscapes("var x = {{ ;", [])).toBe(false);
    });
});

describe("#2666: the analysis stays fast and bounded", () => {
    it("a module that does not mention createRequire never spawns the analyzer (an unusable analyzer path is not touched)", () => {
        const src = "export const x = 1;\n".repeat(1000);
        expect(
            analyzeServerModule(src, "/nonexistent/analyzer.mjs")
                .unrecognizedBinding,
        ).toBe(false);
    });

    it("a tree too deep to analyse fails closed: a hand-off in the same module is never read as clean", () => {
        const deep = `${"[".repeat(50000)}0${"]".repeat(50000)}`;
        const src = `${IMPORT}var r = e(import.meta.url);\nexport const d = ${deep};\nuse(r);\n`;
        expect(analyzeServerModule(src).unrecognizedBinding).toBe(true);
    });
});

describe("#2666: optional calls and builtin-module accessors are never silent", () => {
    it("an optional call through a made require is reported, not dropped", () => {
        const src = `${IMPORT}const r = e(import.meta.url);\nexport const l = () => r?.("pkg-a");\n`;
        expect(analyzeServerModule(src).unrecognizedBinding).toBe(true);
    });

    it("a plain call through a made require is still followed (other half)", () => {
        const src = `${IMPORT}const r = e(import.meta.url);\nexport const l = () => r("pkg-a");\n`;
        const a = analyzeServerModule(src);
        expect(a.unrecognizedBinding).toBe(false);
        expect(a.literalCalls.get("r")).toEqual(new Set(["pkg-a"]));
    });

    it("the direct optional form stays recorded", () => {
        const src = `${IMPORT}export const l = () => e(import.meta.url)?.("pkg-a");\n`;
        expect(directSpecs(src)).toEqual(["pkg-a"]);
    });

    it("a creator under `default` of a dynamic import is reported", () => {
        const src = `const { default: { createRequire: c } } = await import("node:module");\nexport const l = () => c(import.meta.url)("pkg-a");\n`;
        expect(analyzeServerModule(src).unrecognizedBinding).toBe(true);
    });

    it("`process.getBuiltinModule('node:module').createRequire` is reported", () => {
        const src = `export const l = () => process.getBuiltinModule("node:module").createRequire(import.meta.url)("pkg-a");\n`;
        expect(analyzeServerModule(src).unrecognizedBinding).toBe(true);
    });

    it("`process.getBuiltinModule` of an unrelated builtin is quiet (other half)", () => {
        const src = `export const l = () => process.getBuiltinModule("node:fs");\nconst createRequire = 1;\n`;
        expect(analyzeServerModule(src).unrecognizedBinding).toBe(false);
    });
});
/**
 * The three shapes the real file-manager vinext bundle contains (CI red on the
 * self-contained e2e): each is a use that cannot hide a package, so reporting it
 * made every strict build of a real app fail. Both halves asserted: the benign
 * form is quiet, the look-alike that does hide a load is still reported.
 */
describe("#2666: shapes real bundles contain are understood, their look-alikes are not", () => {
    const MADE = `${IMPORT}var r = e(import.meta.url);\n`;

    it("reading `r.main` (the require.main probe) is understood", () => {
        const src = `${MADE}export const m = r.main === void 0;\n`;
        expect(analyzeServerModule(src).unrecognizedBinding).toBe(false);
    });

    it.each([
        [
            "`r.main.require(...)` loads through it",
            "export const l = r.main.require('pkg-a');",
        ],
        ["`r.main` is passed on", "use(r.main);"],
        ["`r[name]` is a computed read", "export const l = r['main'];"],
    ])("%s is still reported", (_label, use) => {
        expect(analyzeServerModule(`${MADE}${use}\n`).unrecognizedBinding).toBe(
            true,
        );
    });

    const POLYFILL =
        "k = (ew => typeof r < 'u' ? r : typeof Proxy < 'u' ? new Proxy(ew, { get: (ew, tw) => (typeof r < 'u' ? r : ew)[tw] }) : ew)(function (ew) { if (typeof r < 'u') return r.apply(this, arguments); throw Error('Dynamic require of ' + ew); });\n";

    it("the bundler's `__require` feature-detect polyfill forwards the binding: it is followed, not reported", () => {
        const src = `${MADE}var k;\n${POLYFILL}export const l = () => k('pkg-a');\n`;
        const a = analyzeServerModule(src);
        expect(a.unrecognizedBinding).toBe(false);
        expect(a.literalCalls.get("k")).toEqual(new Set(["pkg-a"]));
    });

    it("a forwarded binding that is then handed on is still reported", () => {
        const src = `${MADE}var k;\n${POLYFILL}use(k);\n`;
        expect(analyzeServerModule(src).unrecognizedBinding).toBe(true);
    });

    it("the binding passed into a call that is not the polyfill shape is still reported", () => {
        const src = `${MADE}var k;\nk = wrap(typeof r < 'u' ? r : null);\nexport const l = () => k('pkg-a');\n`;
        expect(analyzeServerModule(src).unrecognizedBinding).toBe(true);
    });

    it("`const [{ createRequire: c }, p] = await Promise.all([import('node:module'), import('node:path')])` is followed", () => {
        const src = `export async function f() {\n  const [{ createRequire: c }, p] = await Promise.all([import('node:module'), import('node:path')]);\n  return c(import.meta.url)('pkg-a');\n}\n`;
        const a = analyzeServerModule(src);
        expect(a.unrecognizedBinding).toBe(false);
        expect(directSpecs(src)).toEqual(["pkg-a"]);
    });

    it("a Promise.all import of module whose result is not destructured is still reported", () => {
        const src = `export async function f() {\n  const all = await Promise.all([import('node:module')]);\n  return all;\n}\n`;
        expect(analyzeServerModule(src).unrecognizedBinding).toBe(true);
    });
});
