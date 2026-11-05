/**
 * #2614 — the strict-require build (`KNEXT_COMPILE_STRICT_REQUIRES=1`) runs the
 * whole compile script over a hand-built `.output/server`, so the exit code is
 * the real gate: it must reach Bun.build for the next/og shape, and must still
 * abort before Bun.build for a handed-on create and for an unresolvable require.
 *
 * Both halves are asserted on the exit code and the named failure, never on a
 * log line alone.
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

const OG_IMPORT =
    'import { createRequire } from "module";\nvar require2 = createRequire("/");\n';

// rolldown's per-chunk init: the create's value is discarded, behind a base64
// font literal (a `/` inside a string) that defeats the old backward scan.
const OG_DISCARDED =
    "var init_font = __esmMin(() => { " +
    'init_font("AAAA/BBBB=="), createRequire(import.meta.url), init_y(); });\n';

/** Build `.output/server/index.mjs` from `body`, then compile it in strict mode. */
function strictCompile(body: string) {
    const dir = mkdtempSync(join(tmpdir(), "knext-2614-strict-"));
    try {
        const root = realpathSync(dir);
        const serverDir = join(root, ".output", "server");
        mkdirSync(serverDir, { recursive: true });
        writeFileSync(join(serverDir, "package.json"), '{"type":"module"}\n');
        writeFileSync(
            join(serverDir, "index.mjs"),
            OG_IMPORT + body + "export default {};\n",
        );
        const arch = process.arch === "arm64" ? "arm64" : "x64";
        const target =
            process.platform === "darwin"
                ? `bun-darwin-${arch}`
                : `bun-linux-${arch}`;
        const env = { ...process.env, KNEXT_COMPILE_STRICT_REQUIRES: "1" };
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

describe("#2614: strict compile accepts the next/og shape and still refuses real gaps", () => {
    it("a provably discarded createRequire behind bundled base64 data reaches Bun.build", () => {
        const r = strictCompile(OG_DISCARDED);
        const out = r.stdout + r.stderr;
        expect(out).not.toContain("unrecognised createRequire");
        expect(r.status, out).toBe(0);
    }, 150_000);

    it("a createRequire whose value is handed on still aborts the strict build", () => {
        const r = strictCompile(
            OG_DISCARDED +
                'use("AAAA/BBBB", createRequire(import.meta.url));\n',
        );
        const out = r.stdout + r.stderr;
        expect(r.status, out).toBe(1);
        expect(out).toContain(
            "unrecognised createRequire(import.meta.url) binding",
        );
    }, 150_000);

    it("a deliberate runtime load of a literal-assembled package name (ioredis) passes strict and is named", () => {
        const r = strictCompile(
            OG_DISCARDED +
                "const IOREDIS = ['io', 'redis'].join('');\n" +
                "export const load = () => createRequire(import.meta.url)(IOREDIS);\n",
        );
        const out = r.stdout + r.stderr;
        expect(r.status, out).toBe(0);
        expect(out).toContain("ioredis");
        expect(out).toContain("deliberately not bundled");
    }, 150_000);

    it.each([
        ["sharp", "['sha', 'rp'].join('')"],
        ["a relative path", "['./', 'plugins/x.js'].join('')"],
        ["a parent-relative path", "['../', '../secret'].join('')"],
        ["an absolute path", "['/etc/', 'x'].join('')"],
        ["node:fs", "['node', ':fs'].join('')"],
        ["ioredis with a path suffix", "['io', 'redis/foo'].join('')"],
        ["ioredis with a leading space", "[' io', 'redis'].join('')"],
        ["ioredis with a trailing space", "['io', 'redis '].join('')"],
        ["IOREDIS in capitals", "['IO', 'REDIS'].join('')"],
        ["node:ioredis", "['node:', 'ioredis'].join('')"],
    ])(
        "a literal-assembled name that is not ioredis (%s) still aborts the strict build",
        (_label, expr) => {
            const r = strictCompile(
                OG_DISCARDED +
                    `const PKG = ${expr};\n` +
                    "export const load = () => createRequire(import.meta.url)(PKG);\n",
            );
            const out = r.stdout + r.stderr;
            expect(r.status, out).toBe(1);
            expect(out).toContain("non-literal package name");
            expect(out).not.toContain("deliberately not bundled");
        },
        150_000,
    );

    it("a runtime load of a name the build cannot fold still aborts the strict build", () => {
        const r = strictCompile(
            OG_DISCARDED +
                "const PKG = process.env.PKG;\n" +
                "export const load = () => createRequire(import.meta.url)(PKG);\n",
        );
        const out = r.stdout + r.stderr;
        expect(r.status, out).toBe(1);
        expect(out).toContain("non-literal package name");
    }, 150_000);

    it("an unresolvable package required through the binding still aborts the strict build", () => {
        const r = strictCompile(
            OG_DISCARDED +
                "var __require = (() => createRequire(import.meta.url))();\n" +
                'export const load = () => __require("no-such-pkg-2614");\n',
        );
        const out = r.stdout + r.stderr;
        expect(r.status, out).toBe(1);
        expect(out).toContain("no-such-pkg-2614");
        expect(out).toContain("do not resolve");
    }, 150_000);
});
