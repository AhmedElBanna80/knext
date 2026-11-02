/**
 * app-data-embed.mjs / app-data-alias.mjs: the planner, the literal-path
 * scanner, the fs-import rewrite and the runtime alias, in isolation. The
 * compile-level behaviour (a real executable run from an empty directory) is
 * vinext-compile-self-contained-data.test.ts.
 */
import { afterAll, describe, expect, it } from "bun:test";
import {
    mkdirSync,
    mkdtempSync,
    realpathSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { installEmbeddedDataAlias } from "../adapters/app-data-alias.mjs";
import {
    dataPathsMissing,
    planAppData,
    rewriteFsImports,
    scanDataLiterals,
} from "../adapters/app-data-embed.mjs";

const temps: string[] = [];
afterAll(() => {
    for (const d of temps) rmSync(d, { recursive: true, force: true });
});
function app(files: Record<string, string>): string {
    const root = realpathSync(mkdtempSync(join(tmpdir(), "knext-appdata-")));
    temps.push(root);
    for (const [rel, body] of Object.entries(files)) {
        mkdirSync(dirname(join(root, rel)), { recursive: true });
        writeFileSync(join(root, rel), body);
    }
    return root;
}

const ROOT = "/app";
const ENTRY_DIR = "/app/.output/server";
const scan = (src: string) => scanDataLiterals(src, ROOT, ENTRY_DIR);

describe("scanDataLiterals: literal project paths", () => {
    it("every-argument-literal joins, with any spelling of the callee", () => {
        expect(scan('join(process.cwd(),"app/x/data.json")')).toEqual([
            "/app/app/x/data.json",
        ]);
        expect(scan("path.resolve( process.cwd() , 'a', 'b.json' )")).toEqual([
            "/app/a/b.json",
        ]);
        expect(scan("t.default.join(process.cwd(),`c/d.txt`)")).toEqual([
            "/app/c/d.txt",
        ]);
    });

    it("a leading slash is relative to cwd, as path.join reads it", () => {
        expect(scan('join(process.cwd(), "/x.json")')).toEqual(["/app/x.json"]);
    });

    it("templates and concatenation", () => {
        expect(scan("`${process.cwd()}/content/post.md`")).toEqual([
            "/app/content/post.md",
        ]);
        expect(scan('process.cwd() + "/content/post.md"')).toEqual([
            "/app/content/post.md",
        ]);
    });

    it("a path that stops being literal yields only what is certain (a directory prefix)", () => {
        expect(scan("`${process.cwd()}/posts/${slug}.md`")).toEqual([
            "/app/posts",
        ]);
        expect(scan("`${process.cwd()}/posts/a-${slug}`")).toEqual([
            "/app/posts",
        ]);
        expect(scan('join(process.cwd(), "app", name)')).toEqual(["/app/app"]);
        // the tail is computed: "da" is not a complete name
        expect(scan('join(process.cwd(), "app", "da" + "ta.json")')).toEqual([
            "/app/app",
        ]);
        expect(scan('process.cwd() + "/a" + name')).toEqual([]);
    });

    it("process.cwd() as anything but the first argument is not a path root", () => {
        expect(scan('join(base, process.cwd(), "x.json")')).toEqual([]);
        expect(scan('const a = process.cwd(), b = "x.json"')).toEqual([]);
    });

    it("new URL(literal, import.meta.url) resolves against the ENTRY directory", () => {
        expect(scan('new URL("../../my-data.json", import.meta.url)')).toEqual([
            "/app/my-data.json",
        ]);
        expect(scan("new URL('./sub/x.bin',import.meta.url)")).toEqual([
            "/app/.output/server/sub/x.bin",
        ]);
    });

    it("URLs with a scheme, absolute paths and computed ones are not read", () => {
        expect(scan('new URL("https://x.test/a", import.meta.url)')).toEqual(
            [],
        );
        expect(scan('new URL("/abs.json", import.meta.url)')).toEqual([]);
        expect(scan("new URL(name, import.meta.url)")).toEqual([]);
        expect(scan('new URL("../x.json", base)')).toEqual([]);
    });
});

describe("rewriteFsImports", () => {
    const P = "knext-embedded:";
    it("named, default, namespace, dynamic and promises forms", () => {
        const src = [
            'import { readFileSync as r } from "node:fs";',
            "import fs from 'fs';",
            'import * as fp from "node:fs/promises";',
            'const m = await import("fs/promises");',
        ].join("\n");
        const { contents, count } = rewriteFsImports(src, P);
        expect(count).toBe(4);
        expect(contents).toContain('from "knext-embedded:fs-facade"');
        expect(contents).toContain("from 'knext-embedded:fs-facade'");
        expect(contents).toContain('from "knext-embedded:fs-promises-facade"');
        expect(contents).toContain(
            'import("knext-embedded:fs-promises-facade")',
        );
    });

    it("leaves lookalikes and other modules alone", () => {
        const src =
            'import a from "fs-extra"; import b from "node:fsx"; import c from "graceful-fs"; import d from "node:path"; const s = "fs";';
        const { contents, count } = rewriteFsImports(src, P);
        expect(count).toBe(0);
        expect(contents).toBe(src);
    });
});

describe("dataPathsMissing: an exact, NUL-delimited name in the executable", () => {
    const nul = (...names: string[]) => Buffer.from(`\0${names.join("\0")}\0`);
    const bin = nul(
        "/$bunfs/root/data/a.json",
        "/$bunfs/root/./my-data.json",
        "/$bunfs/root/LICENSE.",
    );
    it("names the files the executable does not carry", () => {
        expect(
            dataPathsMissing(bin, [
                { rel: "data/a.json" },
                { rel: "my-data.json" },
                { rel: "LICENSE" },
                { rel: "data/gone.json" },
            ]),
        ).toEqual(["data/gone.json"]);
    });
    it("a binary carrying none reports all", () => {
        expect(
            dataPathsMissing(Buffer.from("nothing"), [
                { rel: "a" },
                { rel: "b/c" },
            ]),
        ).toEqual(["a", "b/c"]);
    });
    it("a longer name that merely starts with the planned one does not count", () => {
        expect(
            dataPathsMissing(nul("/$bunfs/root/data/a.json.bak"), [
                { rel: "data/a.json" },
            ]),
        ).toEqual(["data/a.json"]);
    });
    it("the path as a JavaScript string constant (quoted) is not an embedded file", () => {
        const code = Buffer.from('var P="/$bunfs/root/data/a.json";var Q=1');
        expect(dataPathsMissing(code, [{ rel: "data/a.json" }])).toEqual([
            "data/a.json",
        ]);
    });
    it("a name that only ends in NUL (quoted constant, then a terminator) is not an embedded file", () => {
        const code = Buffer.from('x"/$bunfs/root/data/a.json\0y');
        expect(dataPathsMissing(code, [{ rel: "data/a.json" }])).toEqual([
            "data/a.json",
        ]);
    });

    it("a path that is the tail of another is not found", () => {
        expect(
            dataPathsMissing(nul("/$bunfs/root/x/data/a.json"), [
                { rel: "data/a.json" },
            ]),
        ).toEqual(["data/a.json"]);
    });
});

describe("planAppData", () => {
    it("a node_modules-wide sweep is not implied by a root glob; naming node_modules opts in", () => {
        const root = app({
            "data/a.json": "{}",
            "node_modules/pkg/x.json": "{}",
            "node_modules/pkg/package.json": "{}",
        });
        const swept = planAppData({ root, includes: ["./**/*.json"] });
        expect(swept.files.map((f) => f.rel)).toEqual(["data/a.json"]);
        const named = planAppData({
            root,
            includes: ["./node_modules/pkg/*.json"],
        });
        expect(named.files.map((f) => f.rel)).toEqual([
            "node_modules/pkg/package.json",
            "node_modules/pkg/x.json",
        ]);
    });

    it("an exact secret-looking path is allowed when named; a glob over it is not", () => {
        const root = app({
            "conf/.env.production": "T=1",
            "conf/ok.json": "{}",
        });
        expect(
            planAppData({ root, includes: ["conf/.env.production"] }).files,
        ).toHaveLength(1);
        expect(() => planAppData({ root, includes: ["conf/*"] })).toThrow(
            /look like secrets/,
        );
    });

    it("a literal path wins over glob reading (bracket route directories)", () => {
        const root = app({ "app/[id]/data.json": "{}" });
        const plan = planAppData({ root, includes: ["app/[id]/data.json"] });
        expect(plan.files.map((f) => f.rel)).toEqual(["app/[id]/data.json"]);
    });

    it("a directory pattern embeds its files recursively", () => {
        const root = app({ "d/a.txt": "a", "d/n/b.txt": "b" });
        expect(
            planAppData({ root, includes: ["./d"] }).files.map((f) => f.rel),
        ).toEqual(["d/a.txt", "d/n/b.txt"]);
    });

    it("'..' and an unreachable absolute pattern fail", () => {
        const root = app({ "a.txt": "a" });
        expect(() => planAppData({ root, includes: ["../a.txt"] })).toThrow(
            /outside the app root/,
        );
        expect(() =>
            planAppData({ root, includes: [resolve(root, "..", "x")] }),
        ).toThrow(/outside the app root/);
    });

    it("a symlink that leaves the root fails the build", () => {
        const outside = app({ "leak.txt": "x" });
        const root = app({});
        mkdirSync(join(root, "d"));
        symlinkSync(join(outside, "leak.txt"), join(root, "d/leak.txt"));
        expect(() => planAppData({ root, includes: ["d/*"] })).toThrow(
            /outside the app root[\s\S]*d\/leak\.txt/,
        );
    });

    it("candidates: directories, missing files, .output and node_modules are skipped, secrets are logged", () => {
        const root = app({
            "ok.txt": "1",
            "dir/x.txt": "2",
            ".env": "S=1",
            ".output/server/chunk.mjs": "//",
            "node_modules/p/i.js": "//",
        });
        const plan = planAppData({
            root,
            includes: [],
            candidates: [
                join(root, "ok.txt"),
                join(root, "dir"),
                join(root, "missing.txt"),
                join(root, ".env"),
                join(root, ".output/server/chunk.mjs"),
                join(root, "node_modules/p/i.js"),
                join(dirname(root), "elsewhere.txt"),
            ],
        });
        expect(plan.files.map((f) => f.rel)).toEqual(["ok.txt"]);
        expect(plan.files[0].declared).toBe(false);
        expect(plan.skipped.map((s) => s.rel).sort()).toEqual([
            ".env",
            ".output/server/chunk.mjs",
            "node_modules/p/i.js",
        ]);
    });

    it("a declared file that is also a candidate is declared once", () => {
        const root = app({ "x.txt": "1" });
        const plan = planAppData({
            root,
            includes: ["x.txt"],
            candidates: [join(root, "x.txt")],
        });
        expect(plan.files).toHaveLength(1);
        expect(plan.files[0].declared).toBe(true);
    });

    it("a total over the warning threshold is reported, not fatal", () => {
        const root = app({});
        writeFileSync(join(root, "big.bin"), Buffer.alloc(65 * 1024 * 1024));
        const plan = planAppData({ root, includes: ["big.bin"] });
        expect(plan.files).toHaveLength(1);
        expect(plan.warnings.join(" ")).toMatch(/65\.0 MiB/);
    });
});

describe("installEmbeddedDataAlias", () => {
    const target = "/$bunfs/root/data/a.json";
    const files = [{ rel: "data/a.json", path: target }];

    it("maps exactly the embedded paths — absolute, build-root, relative, normalised, URL — and nothing else", () => {
        const root = app({});
        const map = installEmbeddedDataAlias(files, {
            appRoot: "/build/machine/app",
            cwd: root,
        }) as (p: unknown) => unknown;
        expect(map(join(root, "data/a.json"))).toBe(target);
        expect(map("/build/machine/app/data/a.json")).toBe(target);
        expect(map(join(root, "data/../data/a.json"))).toBe(target);
        expect(map(new URL(`file://${join(root, "data/a.json")}`))).toBe(
            target,
        );
        expect(map(join(root, "data/b.json"))).toBe(join(root, "data/b.json"));
        expect(map(join(root, "data"))).toBe(join(root, "data"));
        expect(map(42)).toBe(42);
        expect(map("")).toBe("");
    });

    it("the real disk wins: a file that exists at the path is read as it is, the embedded copy is the fallback", () => {
        const root = app({ "data/a.json": "runtime" });
        const buildRoot = app({ "data/a.json": "runtime-on-build-path" });
        const map = installEmbeddedDataAlias(files, {
            appRoot: buildRoot,
            cwd: root,
        }) as (p: unknown) => unknown;
        expect(map(join(root, "data/a.json"))).toBe(join(root, "data/a.json"));
        expect(map(join(buildRoot, "data/a.json"))).toBe(
            join(buildRoot, "data/a.json"),
        );
        expect(map(new URL(`file://${join(root, "data/a.json")}`))).toEqual(
            new URL(`file://${join(root, "data/a.json")}`),
        );
        rmSync(join(root, "data/a.json"));
        expect(map(join(root, "data/a.json"))).toBe(target);
    });

    it("a file written at runtime to a previously absent embedded path is read back, not the embedded copy", () => {
        const root = app({});
        const map = installEmbeddedDataAlias(files, {
            appRoot: "/build/machine/app",
            cwd: root,
        }) as (p: unknown) => unknown;
        expect(map(join(root, "data/a.json"))).toBe(target);
        mkdirSync(join(root, "data"), { recursive: true });
        writeFileSync(join(root, "data/a.json"), "fresh");
        expect(map(join(root, "data/a.json"))).toBe(join(root, "data/a.json"));
    });
});
