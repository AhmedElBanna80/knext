/**
 * #2614 — the strict-require pre-compile check must accept the `createRequire`
 * shape rolldown emits when `next/og` (`@vercel/og`) is merged into the server
 * output, and must keep refusing every create whose value is actually handed on.
 *
 * Root cause: the old analysis proved a statement-level (discarded) create by a
 * backward character scan that gives up on any string, regex-or-division `/`,
 * or 4 KB of preceding text. The merged @vercel/og bundle carries base64 font
 * literals ahead of rolldown's per-chunk init sequence, so a provably discarded
 * create was reported as an unrecognised binding and, under the strict build,
 * aborted the compile before Bun.build ran (12 compat files).
 *
 * The analysis now proves the position from an acorn AST (see
 * create-require-analyze.mjs), so these are asserted in BOTH directions: the
 * discarded shape passes, and a handed-on create (returned, passed, stored) or a
 * module the parser cannot read still fails closed. A real `require` the
 * analysis can see is still recorded, so an unresolvable package still fails the
 * strict build (see vinext-compile-og-strict-require.test.ts).
 */
import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeServerModule } from "../adapters/entry-require-staticize.mjs";

// The real @vercel/og 1.0.3 `dist/index.node.js` line: a static import of
// createRequire from "module". Rolldown keeps it at the top of the merged bundle.
const OG_IMPORT =
    'import { createRequire } from "module";\nvar require2 = createRequire("/");\n';

// Sibling expressions that defeat the old backward scan: a string literal
// holding `/` (base64 font data), a division, and a call past its 4 KB window.
const SIBLINGS: [string, string][] = [
    [
        "a string literal with a slash (base64 font data)",
        'init_font("AAAA/BBBB==")',
    ],
    ["a division", "init_a(x / y)"],
    [
        "a call longer than the old 4 KB window",
        `init_font(${"a,".repeat(3000)}z)`,
    ],
];

describe("#2614: a provably discarded create behind next/og's bundled siblings is not a gap", () => {
    it.each(
        SIBLINGS,
    )("behind %s (rolldown per-chunk init sequence)", (_label, sibling) => {
        const src =
            OG_IMPORT +
            `var init_font = __esmMin(() => { ${sibling}, createRequire(import.meta.url), init_y(); });\n`;
        expect(analyzeServerModule(src).unrecognizedBinding).toBe(false);
    });

    it.each(SIBLINGS)("as a bare statement behind %s", (_label, sibling) => {
        const src =
            OG_IMPORT +
            `function init() { ${sibling}; createRequire(import.meta.url); }\n`;
        expect(analyzeServerModule(src).unrecognizedBinding).toBe(false);
    });

    it("keeps the static @vercel/og import as the module's createRequire alias", () => {
        expect(analyzeServerModule(OG_IMPORT).aliases).toEqual([
            "createRequire",
        ]);
    });
});

describe("#2614: a create whose value IS handed on stays a gap (no blanket allowlist)", () => {
    it.each(SIBLINGS)("returned behind %s", (_label, sibling) => {
        const src =
            OG_IMPORT +
            `function load() { ${sibling}; return createRequire(import.meta.url); }\n`;
        expect(analyzeServerModule(src).unrecognizedBinding).toBe(true);
    });

    it.each(
        SIBLINGS,
    )("the last element of a sequence assigned behind %s", (_label, sibling) => {
        const src =
            OG_IMPORT +
            `var r = (${sibling}, createRequire(import.meta.url));\n`;
        expect(analyzeServerModule(src).unrecognizedBinding).toBe(true);
    });

    it.each(SIBLINGS)("passed as an argument behind %s", (_label, sibling) => {
        const src =
            OG_IMPORT + `use(${sibling}, createRequire(import.meta.url));\n`;
        expect(analyzeServerModule(src).unrecognizedBinding).toBe(true);
    });
});

describe("#2614: a real require reached through a recognised binding is still recorded", () => {
    it("an unresolvable package required via the binding stays in the literal calls", () => {
        const src =
            OG_IMPORT +
            'var init_font = __esmMin(() => { init_font("AAAA/BBBB"), createRequire(import.meta.url), init_y(); });\n' +
            "var __require = (() => createRequire(import.meta.url))();\n" +
            'var load = () => __require("no-such-pkg-2614");\n';
        const a = analyzeServerModule(src);
        expect(a.unrecognizedBinding).toBe(false);
        expect(a.requireBindings).toContain("__require");
        expect([...(a.literalCalls.get("__require") ?? [])]).toEqual([
            "no-such-pkg-2614",
        ]);
    });
});

describe("#2614: a module the parser cannot read fails closed when it creates a require", () => {
    it("reports an unrecognised binding rather than assuming it is clean", () => {
        expect(
            analyzeServerModule(
                OG_IMPORT + "var x = {{ createRequire(import.meta.url);",
            ).unrecognizedBinding,
        ).toBe(true);
    });

    it("a module with no createRequire at all is never reported", () => {
        expect(analyzeServerModule("var x = {{ ;").unrecognizedBinding).toBe(
            false,
        );
    });
});

describe("#2614: an analyzer that is missing or fails THROWS, it never reads as clean", () => {
    const CREATE = OG_IMPORT + "use(createRequire(import.meta.url));";

    it("a missing analyzer script throws, naming the path it looked for", () => {
        const missing = join(tmpdir(), "knext-2614-no-such-analyzer.mjs");
        expect(() => analyzeServerModule(CREATE, missing)).toThrow(
            /createRequire analyzer is missing/,
        );
    });

    it("an analyzer that exits non-zero throws rather than returning an empty analysis", () => {
        const dir = mkdtempSync(join(tmpdir(), "knext-2614-analyzer-"));
        const crashing = join(dir, "crash.mjs");
        writeFileSync(crashing, "process.exit(3);\n");
        try {
            expect(() => analyzeServerModule(CREATE, crashing)).toThrow(
                /exited 3/,
            );
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it("a module with no createRequire never spawns the analyzer, so a missing one is not an error", () => {
        const missing = join(tmpdir(), "knext-2614-no-such-analyzer.mjs");
        expect(
            analyzeServerModule("var x = 1;", missing).unrecognizedBinding,
        ).toBe(false);
    });
});
