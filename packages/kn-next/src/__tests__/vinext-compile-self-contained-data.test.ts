/**
 * `vinext-compile.mjs --self-contained 1`: the app's data files ride inside the
 * binary.
 *
 * Three families of file are read at request time and are not part of the
 * module graph, so nothing used to carry them into the executable (the binary
 * then answered 500 from an empty directory):
 *
 *   - files declared in `outputFileTracingIncludes` (next.config);
 *   - project files an app names by literal path, `join(process.cwd(), "a/b.json")`
 *     or `new URL("../x.json", import.meta.url)`;
 *   - files inside a package Nitro traced into the `.output/server/node_modules`
 *     sidecar, which a binary with no sidecar cannot resolve.
 *
 * Every binary here is copied ALONE into a fresh empty directory and run with
 * that directory as cwd, so the build tree cannot answer for it. Both halves
 * are asserted: what is declared is readable (absolute and relative path
 * spellings, sync and promise APIs), and what is not declared is neither
 * readable nor present in the executable's bytes. A declared include that
 * cannot be embedded fails the build.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { spawnSync } from "node:child_process";
import {
    chmodSync,
    cpSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    realpathSync,
    rmSync,
    statSync,
    symlinkSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const COMPILE = resolve(import.meta.dir, "../adapters/vinext-compile.mjs");

const temps: string[] = [];
afterAll(() => {
    for (const d of temps) {
        try {
            chmodSync(d, 0o755);
        } catch {}
        rmSync(d, { recursive: true, force: true });
    }
});
function temp(prefix: string): string {
    // realpath: macOS tmpdir is a /var -> /private/var symlink.
    const d = realpathSync(mkdtempSync(join(tmpdir(), prefix)));
    temps.push(d);
    return d;
}
function write(path: string, body: string | Uint8Array): void {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, body);
}

const A_MARK = "KNEXT_DATA_A_5d3f1c";
const B_MARK = "KNEXT_DATA_B_91ab7e";
const ABS_MARK = "KNEXT_DATA_ABS_c40e22";
const SECRET_PRIVATE_MARK = "KNEXT_DATA_PRIVATE_8f6d03";
const DISCOVERED_MARK = "KNEXT_DATA_DISCOVERED_2e9b55";
const URL_MARK = "KNEXT_DATA_URL_70c1ab";

/**
 * The probes: one entry prints a JSON `RESULT` line of what each read gave.
 * `BUILD_ROOT` is the absolute path the app had at build time.
 */
function probeEntry(work: string, body: string): string {
    return `globalThis.__nitro_main__ = import.meta.url;
import fs, { readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
const BUILD_ROOT = ${JSON.stringify(work)};
const out = {};
const t = (k, f) => { try { out[k] = String(f()).slice(0, 80); } catch (e) { out[k] = "ERR " + e.code; } };
(async () => {
${body}
console.log("RESULT " + JSON.stringify(out));
})();
`;
}

interface App {
    work: string;
}

function baseApp(entryBody: string, config?: string): App {
    const work = temp("knext-2616-app-");
    write(join(work, ".output/server/index.mjs"), probeEntry(work, entryBody));
    write(join(work, ".output/public/index.html"), "<html/>\n");
    write(
        join(work, "package.json"),
        JSON.stringify({ name: "app", private: true, type: "module" }),
    );
    if (config !== undefined) write(join(work, "next.config.mjs"), config);
    return { work };
}

function compile(
    work: string,
    extra: string[] = [],
    env: Record<string, string> = {},
): ReturnType<typeof spawnSync> & { exe: string } {
    const exe = join(work, "knext-2616-exec");
    const r = spawnSync(
        process.execPath,
        [
            COMPILE,
            "--entry",
            join(work, ".output/server/index.mjs"),
            "--outfile",
            exe,
            "--self-contained",
            "1",
            ...extra,
        ],
        { cwd: work, encoding: "utf8", env: { ...process.env, ...env } },
    );
    return Object.assign(r, { exe });
}

/** Copy ONLY the binary into an empty directory and run it from there. */
function runAlone(exe: string): {
    status: number | null;
    stderr: string;
    stdout: string;
    dir: string;
    result: Record<string, string>;
} {
    const dir = temp("knext-2616-empty-");
    const target = join(dir, "server");
    cpSync(exe, target);
    const r = spawnSync(target, [], {
        cwd: dir,
        encoding: "utf8",
        timeout: 60_000,
        env: {
            PATH: process.env.PATH ?? "",
            HOME: process.env.HOME ?? "",
        } as unknown as NodeJS.ProcessEnv,
    });
    const line = String(r.stdout)
        .split("\n")
        .find((l) => l.startsWith("RESULT "));
    return {
        status: r.status,
        stderr: String(r.stderr),
        stdout: String(r.stdout),
        dir,
        result: line ? JSON.parse(line.slice("RESULT ".length)) : {},
    };
}

const DECLARED_READS = `
t("cwdAbs", () => readFileSync(join(process.cwd(), "data/a.json"), "utf8"));
t("relative", () => fs.readFileSync("data/a.json", "utf8"));
t("dotRelative", () => readFileSync("./data/nested/b.txt", "utf8"));
t("buildAbs", () => readFileSync(BUILD_ROOT + "/data/a.json", "utf8"));
t("exists", () => fs.existsSync(join(process.cwd(), "data/a.json")));
t("statSize", () => fs.statSync(join(process.cwd(), "data/a.json")).size > 0);
t("excluded", () => readFileSync(join(process.cwd(), "private", "no" + "tes.txt"), "utf8"));
t("excludedRel", () => readFileSync(["private", "no" + "tes.txt"].join("/"), "utf8"));
{
    try { out.promise = (await readFile(join(process.cwd(), "data/a.json"), "utf8")).slice(0, 80); }
    catch (e) { out.promise = "ERR " + e.code; }
    try { out.promiseRel = (await fs.promises.readFile("data/nested/b.txt", "utf8")).slice(0, 80); }
    catch (e) { out.promiseRel = "ERR " + e.code; }
}
`;

function declaredIncludeApp(patterns: string): App {
    const app = baseApp(
        DECLARED_READS,
        `export default { outputFileTracingIncludes: { "/": ${patterns} } };\n`,
    );
    write(join(app.work, "data/a.json"), `{"mark":"${A_MARK}"}\n`);
    write(join(app.work, "data/nested/b.txt"), `${B_MARK}\n`);
    write(join(app.work, "private/notes.txt"), `${SECRET_PRIVATE_MARK}\n`);
    return app;
}

describe("self-contained: a declared outputFileTracingIncludes data file", () => {
    let build: ReturnType<typeof compile>;
    beforeAll(() => {
        build = compile(declaredIncludeApp('["./data/**/*"]').work);
    }, 180_000);

    it("builds", () => {
        expect(build.status, String(build.stderr)).toBe(0);
    }, 180_000);

    it("is readable from an empty directory by absolute-from-cwd, relative and build-time-absolute paths", () => {
        const r = runAlone(build.exe);
        expect(r.status, r.stderr).toBe(0);
        expect(r.result.cwdAbs).toContain(A_MARK);
        expect(r.result.relative).toContain(A_MARK);
        expect(r.result.dotRelative).toContain(B_MARK);
        expect(r.result.buildAbs).toContain(A_MARK);
        expect(r.result.exists).toBe("true");
        expect(r.result.statSize).toBe("true");
    }, 120_000);

    it("is readable through the promise API too", () => {
        const r = runAlone(build.exe);
        expect(r.result.promise).toContain(A_MARK);
        expect(r.result.promiseRel).toContain(B_MARK);
    }, 120_000);

    it("a file the config did not declare is NOT readable and NOT in the executable", () => {
        const r = runAlone(build.exe);
        expect(r.result.excluded).toBe("ERR ENOENT");
        expect(r.result.excludedRel).toBe("ERR ENOENT");
        const bytes = readFileSync(build.exe);
        expect(bytes.indexOf(SECRET_PRIVATE_MARK)).toBe(-1);
        expect(bytes.indexOf("private/notes.txt")).toBe(-1);
        // and the declared ones ARE there (the other half)
        expect(bytes.indexOf(A_MARK)).toBeGreaterThan(-1);
    }, 120_000);

    it("leaves nothing beside the binary", () => {
        const r = runAlone(build.exe);
        expect(existsSync(join(r.dir, "data"))).toBe(false);
    }, 120_000);

    it("the executable grows by about the embedded bytes, not by a multiple of them", () => {
        const plain = baseApp(DECLARED_READS);
        write(join(plain.work, "data/a.json"), "{}\n");
        const without = compile(plain.work);
        expect(without.status, String(without.stderr)).toBe(0);

        const big = declaredIncludeApp('["./data/**/*"]');
        const payload = Buffer.alloc(2 * 1024 * 1024, 0x61);
        write(join(big.work, "data/big.bin"), payload);
        const withBig = compile(big.work);
        expect(withBig.status, String(withBig.stderr)).toBe(0);

        const delta = statSync(withBig.exe).size - statSync(without.exe).size;
        expect(delta).toBeGreaterThanOrEqual(payload.length);
        // one copy of the payload, plus a few KiB of table and the two small files
        expect(delta).toBeLessThan(payload.length + 64 * 1024);
        expect(String(withBig.stdout)).toMatch(
            /self-contained: embedding \d+ app data file\(s\)/,
        );
    }, 240_000);
});

describe("self-contained: every way an app imports fs", () => {
    it("named and namespace imports, fs/promises, require('fs') and a dynamic import all see the embedded file", () => {
        const app = baseApp(
            `const { createRequire } = await import("node:module");
const req = createRequire(import.meta.url);
const abs = join(process.cwd(), "data/a.json");
t("require", () => req("node:fs").readFileSync(abs, "utf8"));
t("requireBare", () => req("fs").readFileSync("data/a.json", "utf8"));
const ns = await import("node:fs");
t("dynamic", () => ns.readFileSync(abs, "utf8"));
const { readFile: rf } = await import("node:fs/promises");
try { out.dynPromises = (await rf(abs, "utf8")).slice(0, 80); } catch (e) { out.dynPromises = "ERR " + e.code; }
const { promises } = await import("node:fs");
try { out.fsPromises = (await promises.readFile(abs, "utf8")).slice(0, 80); } catch (e) { out.fsPromises = "ERR " + e.code; }
t("accessOk", () => { fs.accessSync(abs); return "ok"; });
t("statMissing", () => fs.statSync(join(process.cwd(), "data/none.json")));`,
            'export default { outputFileTracingIncludes: { "/": ["./data/*.json"] } };\n',
        );
        write(join(app.work, "data/a.json"), `{"mark":"${A_MARK}"}\n`);
        const b = compile(app.work);
        expect(b.status, String(b.stderr)).toBe(0);
        const r = runAlone(b.exe);
        expect(r.result.require).toContain(A_MARK);
        expect(r.result.requireBare).toContain(A_MARK);
        expect(r.result.dynamic).toContain(A_MARK);
        expect(r.result.dynPromises).toContain(A_MARK);
        expect(r.result.fsPromises).toContain(A_MARK);
        expect(r.result.accessOk).toBe("ok");
        expect(r.result.statMissing).toBe("ERR ENOENT");
    }, 180_000);

    it("a write to an embedded file's path still goes to the real disk", () => {
        const app = baseApp(
            `fs.mkdirSync(join(process.cwd(), "data"), { recursive: true });
t("write", () => { fs.writeFileSync(join(process.cwd(), "data/new.txt"), "fresh"); return "ok"; });
t("readBack", () => readFileSync(join(process.cwd(), "data/new.txt"), "utf8"));
t("embedded", () => readFileSync(join(process.cwd(), "data/a.json"), "utf8"));`,
            'export default { outputFileTracingIncludes: { "/": ["./data/a.json"] } };\n',
        );
        write(join(app.work, "data/a.json"), `{"mark":"${A_MARK}"}\n`);
        const b = compile(app.work);
        expect(b.status, String(b.stderr)).toBe(0);
        const r = runAlone(b.exe);
        expect(r.result.write).toBe("ok");
        expect(r.result.readBack).toBe("fresh");
        expect(r.result.embedded).toContain(A_MARK);
        expect(readFileSync(join(r.dir, "data/new.txt"), "utf8")).toBe("fresh");
    }, 180_000);

    it("a file written at runtime over an embedded path is read back as written, and the embedded copy is only the fallback", () => {
        const app = baseApp(
            `const p = join(process.cwd(), "data/a.json");
t("before", () => readFileSync(p, "utf8"));
fs.mkdirSync(join(process.cwd(), "data"), { recursive: true });
fs.writeFileSync(p, "RUNTIME_VERSION");
t("after", () => readFileSync(p, "utf8"));
t("afterRel", () => readFileSync("data/a.json", "utf8"));
out.afterPromise = await fs.promises.readFile(p, "utf8");
fs.unlinkSync(p);
t("afterDelete", () => readFileSync(p, "utf8"));`,
            'export default { outputFileTracingIncludes: { "/": ["./data/a.json"] } };\n',
        );
        write(join(app.work, "data/a.json"), `{"mark":"${A_MARK}"}\n`);
        const b = compile(app.work);
        expect(b.status, String(b.stderr)).toBe(0);
        const r = runAlone(b.exe);
        expect(r.result.before).toContain(A_MARK);
        expect(r.result.after).toBe("RUNTIME_VERSION");
        expect(r.result.afterRel).toBe("RUNTIME_VERSION");
        expect(r.result.afterPromise).toBe("RUNTIME_VERSION");
        expect(r.result.afterDelete).toContain(A_MARK);
    }, 180_000);

    it("a symlink inside the app root is embedded once and read by the link's name and by the target's", () => {
        const app = baseApp(
            `t("viaLink", () => readFileSync(join(process.cwd(), "data/link.json"), "utf8"));
t("viaTarget", () => readFileSync(join(process.cwd(), "real/a.json"), "utf8"));`,
            'export default { outputFileTracingIncludes: { "/": ["./data/*"] } };\n',
        );
        write(join(app.work, "real/a.json"), `{"mark":"${A_MARK}"}\n`);
        mkdirSync(join(app.work, "data"), { recursive: true });
        symlinkSync(
            join(app.work, "real/a.json"),
            join(app.work, "data/link.json"),
        );
        const b = compile(app.work);
        expect(b.status, String(b.stderr)).toBe(0);
        const r = runAlone(b.exe);
        expect(r.result.viaLink).toContain(A_MARK);
        expect(r.result.viaTarget).toContain(A_MARK);
    }, 180_000);

    it("the build machine's absolute path never shadows a runtime file", () => {
        const app = baseApp(
            `const abs = BUILD_ROOT + "/data/a.json";
t("embeddedFallback", () => readFileSync(abs, "utf8"));
fs.mkdirSync(BUILD_ROOT + "/data", { recursive: true });
fs.writeFileSync(abs, "RUNTIME_AT_BUILD_PATH");
t("runtimeWins", () => readFileSync(abs, "utf8"));`,
            'export default { outputFileTracingIncludes: { "/": ["./data/a.json"] } };\n',
        );
        write(join(app.work, "data/a.json"), `{"mark":"${A_MARK}"}\n`);
        const b = compile(app.work);
        expect(b.status, String(b.stderr)).toBe(0);
        // the build tree is gone: the absolute path can only be answered by the executable
        rmSync(join(app.work, "data"), { recursive: true, force: true });
        const r = runAlone(b.exe);
        expect(r.result.embeddedFallback).toContain(A_MARK);
        expect(r.result.runtimeWins).toBe("RUNTIME_AT_BUILD_PATH");
    }, 180_000);

    it("an entry with no fs import of its own (only require) still gets the alias", () => {
        const app = baseApp("");
        write(
            join(app.work, ".output/server/index.mjs"),
            `import { createRequire } from "node:module";
const req = createRequire(import.meta.url);
let out;
try { out = req("node:fs").readFileSync(req("node:path").join(process.cwd(), "data/a.json"), "utf8").slice(0, 80); }
catch (e) { out = "ERR " + e.code; }
console.log("RESULT " + JSON.stringify({ viaRequire: out }));
`,
        );
        write(join(app.work, "data/a.json"), `{"mark":"${A_MARK}"}\n`);
        write(
            join(app.work, "next.config.mjs"),
            'export default { outputFileTracingIncludes: { "/": ["./data/a.json"] } };\n',
        );
        const b = compile(app.work);
        expect(b.status, String(b.stderr)).toBe(0);
        expect(runAlone(b.exe).result.viaRequire).toContain(A_MARK);
    }, 180_000);

    it("an app with no data to embed gets no fs facade and no alias (the entry is unchanged)", () => {
        const app = baseApp(
            't("x", () => readFileSync(new URL(import.meta.url), "utf8").length);',
        );
        const b = compile(app.work);
        expect(b.status, String(b.stderr)).toBe(0);
        const bytes = readFileSync(b.exe);
        expect(bytes.indexOf("__knextDataAlias")).toBe(-1);
    }, 120_000);
});

describe("self-contained: absolute include patterns", () => {
    it("an absolute pattern inside the app root is embedded", () => {
        const app = baseApp(
            `t("abs", () => readFileSync(join(process.cwd(), "assets/abs.txt"), "utf8"));`,
        );
        write(join(app.work, "assets/abs.txt"), `${ABS_MARK}\n`);
        write(
            join(app.work, "next.config.mjs"),
            `export default { outputFileTracingIncludes: { "/": [${JSON.stringify(join(app.work, "assets/abs.txt"))}] } };\n`,
        );
        const b = compile(app.work);
        expect(b.status, String(b.stderr)).toBe(0);
        expect(runAlone(b.exe).result.abs).toContain(ABS_MARK);
    }, 180_000);

    it("an absolute pattern OUTSIDE the app root fails the build", () => {
        const outside = temp("knext-2616-outside-");
        write(join(outside, "x.txt"), "outside\n");
        const app = baseApp(
            "",
            `export default { outputFileTracingIncludes: { "/": [${JSON.stringify(join(outside, "x.txt"))}] } };\n`,
        );
        const b = compile(app.work);
        expect(b.status).toBe(1);
        expect(String(b.stderr)).toMatch(
            /outputFileTracingIncludes[\s\S]*outside the app root/,
        );
        expect(existsSync(b.exe)).toBe(false);
    }, 120_000);
});

describe("self-contained: config shapes", () => {
    it("reads a function-exported config and the legacy experimental key", () => {
        const app = baseApp(DECLARED_READS);
        write(join(app.work, "data/a.json"), `{"mark":"${A_MARK}"}\n`);
        write(join(app.work, "data/nested/b.txt"), `${B_MARK}\n`);
        write(
            join(app.work, "next.config.mjs"),
            'export default async (phase) => ({ experimental: { outputFileTracingIncludes: { "/": ["./data/**/*"] } } });\n',
        );
        const b = compile(app.work);
        expect(b.status, String(b.stderr)).toBe(0);
        expect(runAlone(b.exe).result.cwdAbs).toContain(A_MARK);
    }, 180_000);

    it("a next.config that cannot be loaded does not stop a build that has no includes to read", () => {
        const app = baseApp(
            "",
            'import "not-installed-pkg-xyz";\nthrow new Error("config boom");\n',
        );
        const b = compile(app.work);
        expect(b.status, String(b.stderr)).toBe(0);
        expect(String(b.stderr)).toMatch(
            /could not load next\.config\.mjs[\s\S]*not-installed-pkg-xyz[\s\S]*does not mention outputFileTracingIncludes/,
        );
    }, 120_000);

    it("a next.config that cannot declare includes is not executed a second time", () => {
        const app = baseApp(
            "",
            'import path from "node:path";\nconsole.log("CONFIG_RAN_MARK_7731");\nexport default { reactStrictMode: true };\n',
        );
        const b = compile(app.work);
        expect(b.status, String(b.stderr)).toBe(0);
        expect(String(b.stdout) + String(b.stderr)).not.toContain(
            "CONFIG_RAN_MARK_7731",
        );
    }, 120_000);

    it("a next.config that declares includes is executed (once) to read them", () => {
        const app = baseApp(
            "",
            'console.log("CONFIG_RAN_MARK_9902");\nexport default { outputFileTracingIncludes: { "/": ["./data/a.json"] } };\n',
        );
        write(join(app.work, "data/a.json"), "{}\n");
        const b = compile(app.work);
        expect(b.status, String(b.stderr)).toBe(0);
        expect(String(b.stdout).split("CONFIG_RAN_MARK_9902").length - 1).toBe(
            1,
        );
    }, 120_000);

    it("a next.config that mentions outputFileTracingIncludes but cannot be loaded FAILS the build instead of embedding nothing", () => {
        const app = baseApp(
            "",
            'const includes = { "/": ["./data/**/*"] };\nthrow new Error("config boom");\nexport default { outputFileTracingIncludes: includes };\n',
        );
        const b = compile(app.work);
        expect(b.status).toBe(1);
        expect(String(b.stderr)).toMatch(
            /could not load next\.config\.mjs[\s\S]*config boom/,
        );
    }, 120_000);

    it("a next.config that pulls in another module and cannot be loaded FAILS the build (the includes may live there)", () => {
        const app = baseApp(
            "",
            'import shared from "./shared-config.mjs";\nexport default { ...shared };\n',
        );
        write(
            join(app.work, "shared-config.mjs"),
            'throw new Error("shared boom");\n',
        );
        const b = compile(app.work);
        expect(b.status).toBe(1);
        expect(String(b.stderr)).toMatch(/could not load next\.config\.mjs/);
    }, 120_000);

    it("no next.config and no includes: builds, embeds no data", () => {
        const app = baseApp('t("x", () => 1);');
        const b = compile(app.work);
        expect(b.status, String(b.stderr)).toBe(0);
        expect(String(b.stdout)).not.toMatch(/app data file/);
    }, 120_000);
});

describe("self-contained: a declared include that cannot be embedded fails the build", () => {
    function failing(
        patterns: string,
        setup: (work: string) => void,
    ): ReturnType<typeof compile> {
        const app = baseApp(
            "",
            `export default { outputFileTracingIncludes: { "/": ${patterns} } };\n`,
        );
        setup(app.work);
        return compile(app.work);
    }

    it("a pattern that matches nothing", () => {
        const b = failing('["./nope/**/*"]', () => {});
        expect(b.status).toBe(1);
        expect(String(b.stderr)).toMatch(
            /outputFileTracingIncludes: no file matches '\.\/nope\/\*\*\/\*'/,
        );
        expect(existsSync(b.exe)).toBe(false);
    }, 120_000);

    it("a match that resolves through a symlink outside the app root", () => {
        const outside = temp("knext-2616-link-");
        write(join(outside, "leak.txt"), "leak\n");
        const b = failing('["./data/**/*"]', (work) => {
            mkdirSync(join(work, "data"), { recursive: true });
            symlinkSync(join(outside, "leak.txt"), join(work, "data/leak.txt"));
        });
        expect(b.status).toBe(1);
        expect(String(b.stderr)).toMatch(
            /outside the app root[\s\S]*data\/leak\.txt/,
        );
    }, 120_000);

    it("a secret-looking file matched by a glob", () => {
        const b = failing('["./conf/*"]', (work) => {
            write(join(work, "conf/.env.production"), "TOKEN=x\n");
            write(join(work, "conf/ok.json"), "{}\n");
        });
        expect(b.status).toBe(1);
        expect(String(b.stderr)).toMatch(
            /look like secrets: conf\/\.env\.production/,
        );
    }, 120_000);

    it("a symlink with an innocent name that points at a secret is refused, and the secret is not in the build", () => {
        const b = failing('["./data/*"]', (work) => {
            write(join(work, "vault/.env"), `TOKEN=${SECRET_PRIVATE_MARK}\n`);
            mkdirSync(join(work, "data"), { recursive: true });
            symlinkSync(
                join(work, "vault/.env"),
                join(work, "data/readme.txt"),
            );
        });
        expect(b.status).toBe(1);
        expect(String(b.stderr)).toMatch(
            /look like secrets[\s\S]*data\/readme\.txt/,
        );
        expect(existsSync(b.exe)).toBe(false);
    }, 120_000);

    it("a broad sweep embeds the data and none of .git", () => {
        const app = baseApp(
            `t("a", () => readFileSync(join(process.cwd(), "data/a.json"), "utf8"));`,
            'export default { outputFileTracingIncludes: { "/": ["./data/**/*", "./.git/**/*"] } };\n',
        );
        write(join(app.work, "data/a.json"), `{"mark":"${A_MARK}"}\n`);
        write(
            join(app.work, ".git/config"),
            `[remote] ${SECRET_PRIVATE_MARK}\n`,
        );
        const b = compile(app.work);
        expect(b.status).toBe(1);
        expect(String(b.stderr)).toMatch(/never embedded[\s\S]*\.git/);
    }, 120_000);

    it("a native addon cannot be embedded as data", () => {
        const b = failing('["./native-data/*"]', (work) => {
            write(join(work, "native-data/x.node"), "addon");
        });
        expect(b.status).toBe(1);
        expect(String(b.stderr)).toMatch(
            /native addons cannot be embedded[\s\S]*native-data\/x\.node/,
        );
    }, 120_000);

    it("a file inside a package Nitro traced into the sidecar (the twoslash shape)", () => {
        const b = failing('["./node_modules/typescript/lib/**/*"]', (work) => {
            write(
                join(work, "node_modules/typescript/package.json"),
                '{"name":"typescript","version":"1.0.0","main":"lib/typescript.js"}',
            );
            write(
                join(work, "node_modules/typescript/lib/typescript.js"),
                "module.exports = {};\n",
            );
            write(
                join(work, "node_modules/typescript/lib/lib.d.ts"),
                "declare const x: 1;\n",
            );
            // Nitro's trace of the same package:
            write(
                join(
                    work,
                    ".output/server/node_modules/typescript/package.json",
                ),
                '{"name":"typescript","version":"1.0.0"}',
            );
            write(
                join(
                    work,
                    ".output/server/node_modules/typescript/lib/lib.d.ts",
                ),
                "declare const x: 1;\n",
            );
        });
        expect(b.status).toBe(1);
        const err = String(b.stderr);
        expect(err).toMatch(/typescript/);
        expect(err).toMatch(/traced into \.output\/server\/node_modules/);
        expect(err).toMatch(/cannot resolve/);
        expect(existsSync(b.exe)).toBe(false);
    }, 120_000);

    it("an included data file in a package that is NOT a traced sidecar is embedded", () => {
        const app = baseApp(
            `t("pkg", () => readFileSync(join(process.cwd(), "node_modules/dict/words.txt"), "utf8"));`,
            'export default { outputFileTracingIncludes: { "/": ["./node_modules/dict/words.txt"] } };\n',
        );
        write(
            join(app.work, "node_modules/dict/package.json"),
            '{"name":"dict","version":"1.0.0"}',
        );
        write(join(app.work, "node_modules/dict/words.txt"), `${B_MARK}\n`);
        const b = compile(app.work);
        expect(b.status, String(b.stderr)).toBe(0);
        expect(runAlone(b.exe).result.pkg).toContain(B_MARK);
    }, 180_000);
});

describe("self-contained: project files named by literal path", () => {
    it("process.cwd()-joined literal (bracket route directory) is embedded without any config", () => {
        const app = baseApp(
            `t("page", () => readFileSync(join(process.cwd(), "app/dashboard/deployments/[id]/data.json"), "utf8"));
t("partial", () => readFileSync(join(process.cwd(), "app", "da" + "ta.json"), "utf8"));`,
        );
        write(
            join(app.work, "app/dashboard/deployments/[id]/data.json"),
            `{"mark":"${DISCOVERED_MARK}"}\n`,
        );
        write(join(app.work, "app/data.json"), '{"mark":"never-named"}\n');
        const b = compile(app.work);
        expect(b.status, String(b.stderr)).toBe(0);
        const r = runAlone(b.exe);
        expect(r.result.page).toContain(DISCOVERED_MARK);
        // a join with a non-literal tail names a directory, not a file: nothing guessed
        expect(r.result.partial).toBe("ERR ENOENT");
        expect(readFileSync(b.exe).indexOf("never-named")).toBe(-1);
    }, 180_000);

    it("a template-literal process.cwd() path is embedded", () => {
        const app = baseApp(
            't("tpl", () => readFileSync(`${process.cwd()}/content/post.md`, "utf8"));',
        );
        write(join(app.work, "content/post.md"), `${DISCOVERED_MARK}\n`);
        const b = compile(app.work);
        expect(b.status, String(b.stderr)).toBe(0);
        expect(runAlone(b.exe).result.tpl).toContain(DISCOVERED_MARK);
    }, 180_000);

    it("new URL('../../x.json', import.meta.url) in the server output resolves inside the binary", () => {
        const app = baseApp(
            `t("url", () => readFileSync(new URL("../../my-data.json", import.meta.url), "utf8"));`,
        );
        write(join(app.work, "my-data.json"), `{"mark":"${URL_MARK}"}\n`);
        const b = compile(app.work);
        expect(b.status, String(b.stderr)).toBe(0);
        expect(runAlone(b.exe).result.url).toContain(URL_MARK);
    }, 180_000);

    it("a named file that does not exist at build time is not an error (it may be written at runtime)", () => {
        const app = baseApp(
            `t("gone", () => readFileSync(join(process.cwd(), "tmp/runtime-made.json"), "utf8"));`,
        );
        const b = compile(app.work);
        expect(b.status, String(b.stderr)).toBe(0);
        expect(runAlone(b.exe).result.gone).toBe("ERR ENOENT");
    }, 180_000);

    it("a secret-named file that is merely mentioned is NOT embedded", () => {
        const app = baseApp(
            `t("env", () => readFileSync(join(process.cwd(), ".env.production"), "utf8"));`,
        );
        write(
            join(app.work, ".env.production"),
            `TOKEN=${SECRET_PRIVATE_MARK}\n`,
        );
        const b = compile(app.work);
        expect(b.status, String(b.stderr)).toBe(0);
        expect(readFileSync(b.exe).indexOf(SECRET_PRIVATE_MARK)).toBe(-1);
        expect(runAlone(b.exe).result.env).toBe("ERR ENOENT");
    }, 180_000);
});

describe("self-contained: the post-compile check is wired", () => {
    // A scan of the compile script, not a behavioural test: no real Bun drops a
    // planned file, so the only way to prove the guard is there is to read it.
    const source = readFileSync(COMPILE, "utf8");
    const GUARD =
        /if \(SELF_CONTAINED && DATA_PLAN\.files\.length > 0\) \{\s*(?:\/\/[^\n]*\n\s*)*const dropped = dataPathsMissing\(readFileSync\(OUTFILE\), DATA_PLAN\.files\);\s*if \(dropped\.length > 0\) \{\s*rmSync\(OUTFILE, \{ force: true \}\);\s*console\.error\([^\n]*\);\s*process\.exit\(1\);\s*\}\s*\}/;

    it("every planned data file is verified inside the executable, and the binary is removed otherwise", () => {
        expect(source).toMatch(GUARD);
    });

    it("runs after the build succeeded and before the success log", () => {
        const built = source.indexOf("if (!result.success)");
        const guard = source.search(GUARD);
        const wrote = source.indexOf("] wrote ${OUTFILE}");
        expect(built).toBeGreaterThan(-1);
        expect(guard).toBeGreaterThan(built);
        expect(wrote).toBeGreaterThan(guard);
    });
});
