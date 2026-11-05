/**
 * #2666 — the compile script's exit code for the createRequire shapes the
 * analysis used to miss. Each ran green before the fix and left the required
 * package out of the executable.
 *
 * Both halves, on the exit code and the named failure: a shape the analysis can
 * now follow is held to the same standard as a plain call (an unresolvable
 * package aborts the strict build, and is named); a shape it cannot follow
 * aborts the strict build as an unrecognised binding; and in a default build
 * the same gaps only warn.
 */
import { describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
    mkdirSync,
    mkdtempSync,
    realpathSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const COMPILE = resolve(import.meta.dir, "../adapters/vinext-compile.mjs");

/** Compile a hand-built `.output/server` made of `files` (relative path -> source). */
function compile(files: Record<string, string>, strict: boolean) {
    const dir = mkdtempSync(join(tmpdir(), "knext-2666-"));
    try {
        const root = realpathSync(dir);
        const serverDir = join(root, ".output", "server");
        mkdirSync(join(serverDir, "chunks"), { recursive: true });
        writeFileSync(join(serverDir, "package.json"), '{"type":"module"}\n');
        for (const [rel, src] of Object.entries(files)) {
            writeFileSync(join(serverDir, rel), src);
        }
        const arch = process.arch === "arm64" ? "arm64" : "x64";
        const target =
            process.platform === "darwin"
                ? `bun-darwin-${arch}`
                : `bun-linux-${arch}`;
        const env: NodeJS.ProcessEnv = { ...process.env };
        if (strict) env.KNEXT_COMPILE_STRICT_REQUIRES = "1";
        else delete env.KNEXT_COMPILE_STRICT_REQUIRES;
        return spawnSync(
            "bun",
            [
                "run",
                COMPILE,
                "--entry",
                join(serverDir, "index.mjs"),
                "--outfile",
                join(root, "knext-exec"),
                "--target",
                target,
            ],
            { encoding: "utf-8", timeout: 120_000, env, cwd: dirname(COMPILE) },
        );
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
}

const IMPORT = 'import { createRequire as e } from "node:module";\n';
const UNRECOGNISED = "unrecognised createRequire(import.meta.url) binding";
const out = (r: { stdout: string; stderr: string }) => r.stdout + r.stderr;

describe("#2666: a followed shape is held to the standard of a plain call", () => {
    it.each([
        [
            "a plain call (the baseline)",
            `${IMPORT}export const l = () => e(import.meta.url)("no-such-pkg-2666");\n`,
        ],
        [
            "an aliased creator",
            `${IMPORT}const c = e;\nexport const l = () => c(import.meta.url)("no-such-pkg-2666");\n`,
        ],
        [
            "the module namespace",
            'import * as m from "node:module";\nexport const l = () => m.createRequire(import.meta.url)("no-such-pkg-2666");\n',
        ],
        [
            "a destructured dynamic import",
            'const { createRequire: e } = await import("node:module");\nexport const l = () => e(import.meta.url)("no-such-pkg-2666");\n',
        ],
        [
            "an anchor held in a variable",
            `${IMPORT}const u = import.meta.url;\nexport const l = () => e(u)("no-such-pkg-2666");\n`,
        ],
    ])(
        "%s: an unresolvable package aborts the strict build and is named",
        (_label, body) => {
            const r = compile(
                { "index.mjs": `${body}export default {};\n` },
                true,
            );
            expect(r.status, out(r)).toBe(1);
            expect(out(r)).toContain("no-such-pkg-2666");
        },
        150_000,
    );
});

describe("#2666: a shape that cannot be followed aborts the strict build", () => {
    it.each([
        [
            "a copied require",
            `${IMPORT}var r = e(import.meta.url);\nconst s = r;\nexport const l = () => s("pkg-a");\n`,
        ],
        [
            "a stored require",
            `${IMPORT}var r = e(import.meta.url);\nexport const o = { x: r };\n`,
        ],
        ["a passed require", `${IMPORT}var r = e(import.meta.url);\nuse(r);\n`],
        [
            "a wrapper",
            `${IMPORT}function mk(u) { return e(u); }\nexport const l = () => mk(import.meta.url)("pkg-a");\n`,
        ],
        ["a passed creator", `${IMPORT}use(e);\n`],
        [
            "the passed namespace",
            'import * as m from "node:module";\nuse(m);\n',
        ],
    ])(
        "%s",
        (_label, body) => {
            const r = compile(
                { "index.mjs": `${body}export default {};\n` },
                true,
            );
            expect(r.status, out(r)).toBe(1);
            expect(out(r)).toContain(UNRECOGNISED);
        },
        150_000,
    );

    it("a require binding copied in the IMPORTING chunk aborts, naming that chunk", () => {
        const r = compile(
            {
                "chunks/rolldown-runtime.mjs": `${IMPORT}var n = e(import.meta.url);\nexport { n };\n`,
                "chunks/user.mjs":
                    'import { n as __require } from "./rolldown-runtime.mjs";\nconst s = __require;\nexport const l = () => s("pkg-a");\n',
                "index.mjs":
                    'import "./chunks/user.mjs";\nexport default {};\n',
            },
            true,
        );
        expect(r.status, out(r)).toBe(1);
        expect(out(r)).toContain(UNRECOGNISED);
        expect(out(r)).toContain("user.mjs");
    }, 150_000);

    it("a require binding only CALLED in the importing chunk is not flagged", () => {
        const r = compile(
            {
                "chunks/rolldown-runtime.mjs": `${IMPORT}var n = e(import.meta.url);\nexport { n };\n`,
                "chunks/user.mjs":
                    'import { n as __require } from "./rolldown-runtime.mjs";\nexport const l = () => __require.resolve("no-such-pkg-2666");\n',
                "index.mjs":
                    'import "./chunks/user.mjs";\nexport default {};\n',
            },
            true,
        );
        expect(out(r)).not.toContain("unrecognised createRequire");
        expect(r.status, out(r)).toBe(0);
    }, 150_000);

    it("a shadowed one-letter name is not a hand-off: the build reaches Bun.build", () => {
        const r = compile(
            {
                "index.mjs": `${IMPORT}var r = e(import.meta.url);\nfunction f(e, r) { return [e, r]; }\nexport const l = () => f(1, 2);\nexport default {};\n`,
            },
            true,
        );
        expect(out(r)).not.toContain("unrecognised createRequire");
        expect(r.status, out(r)).toBe(0);
    }, 150_000);
});

describe("#2666: a default build only warns", () => {
    it("a copied require warns and the build succeeds", () => {
        const r = compile(
            {
                "index.mjs": `${IMPORT}var r = e(import.meta.url);\nconst s = r;\nexport const l = () => s("pkg-a");\nexport default {};\n`,
            },
            false,
        );
        expect(r.status, out(r)).toBe(0);
        expect(out(r)).toContain(`WARNING: ${UNRECOGNISED}`);
    }, 150_000);
});
