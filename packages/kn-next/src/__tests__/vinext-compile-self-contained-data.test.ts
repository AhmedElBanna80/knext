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
    // Explicit timeout: this removes large compile temp trees, which exceeded
    // bun's 5 s default hook timeout on loaded CI runners with every test green.
}, 60_000);
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
/** A symlink at `path` to `target`, parent created. Takes `path` as a parameter, like `write`. */
function link(target: string, path: string): void {
    mkdirSync(dirname(path), { recursive: true });
    symlinkSync(target, path);
}
/** Make `next` resolvable from the fixture app (a link to the workspace's installed copy). */
function installNext(work: string): void {
    const nextDir = realpathSync(
        resolve(
            import.meta.dir,
            "../../../../apps/file-manager/node_modules/next",
        ),
    );
    mkdirSync(join(work, "node_modules"), { recursive: true });
    symlinkSync(nextDir, join(work, "node_modules/next"));
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

/**
 * Run the compile as `knext build` runs it (`bun run --no-env-file <script> …`, see compileArgv),
 * unless `viaCli: false` runs the script directly, the way a hand-written script might.
 */
function compile(
    work: string,
    extra: string[] = [],
    env: Record<string, string> = {},
    { viaCli = true }: { viaCli?: boolean } = {},
): ReturnType<typeof spawnSync> & { exe: string } {
    const exe = join(work, "knext-2616-exec");
    const r = spawnSync(
        process.execPath,
        [
            ...(viaCli ? ["run", "--no-env-file"] : []),
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
        link(join(app.work, "real/a.json"), join(app.work, "data/link.json"));
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
        const app = baseApp(
            `t("exp", () => readFileSync(join(process.cwd(), "data", "exp" + ".json"), "utf8"));
t("top", () => readFileSync(join(process.cwd(), "data", "top" + ".json"), "utf8"));`,
        );
        write(join(app.work, "data/exp.json"), `{"mark":"${A_MARK}"}\n`);
        write(join(app.work, "data/top.json"), `{"mark":"${B_MARK}"}\n`);
        write(
            join(app.work, "next.config.mjs"),
            'export default async (phase) => ({ outputFileTracingIncludes: { "/": ["./data/top.json"] }, experimental: { outputFileTracingIncludes: { "/": ["./data/exp.json"] } } });\n',
        );
        const b = compile(app.work);
        expect(b.status, String(b.stderr)).toBe(0);
        const r = runAlone(b.exe);
        // the legacy key replaces the top-level one, as Next reads it
        expect(r.result.exp).toContain(A_MARK);
        expect(r.result.top).toBe("ERR ENOENT");
    }, 180_000);

    it("a next.config that might declare includes and cannot be loaded FAILS the build, whatever it does not say", () => {
        const app = baseApp(
            "",
            'import "not-installed-pkg-xyz";\nexport default {};\n',
        );
        const b = compile(app.work);
        expect(b.status).toBe(1);
        expect(String(b.stderr)).toMatch(
            /could not load next\.config\.mjs[\s\S]*not-installed-pkg-xyz/,
        );
    }, 120_000);

    it("a computed require that cannot be loaded FAILS the build", () => {
        const app = baseApp("");
        write(
            join(app.work, "next.config.cjs"),
            "module.exports = require(`./missing-${'inc'}.cjs`);\n",
        );
        const b = compile(app.work);
        expect(b.status).toBe(1);
        expect(String(b.stderr)).toMatch(/could not load next\.config\.cjs/);
    }, 120_000);

    it("outputFileTracingExcludes removes files from the include; an exclude for another route does not apply", () => {
        const PRIV = "KNEXT_DATA_PRIV_EXCLUDED_3a91";
        const app = baseApp(
            `t("kept", () => readFileSync(join(process.cwd(), "data", "a" + ".json"), "utf8"));
t("pub", () => readFileSync(join(process.cwd(), "data", "pub", "c" + ".json"), "utf8"));
t("private", () => readFileSync(join(process.cwd(), "data", "private", "b" + ".json"), "utf8"));`,
            `export default {
  outputFileTracingIncludes: { "/": ["./data/**/*"] },
  outputFileTracingExcludes: { "/": ["./data/private/**"], "/admin/*": ["./data/pub/**"] },
};\n`,
        );
        write(join(app.work, "data/a.json"), `{"mark":"${A_MARK}"}\n`);
        write(join(app.work, "data/pub/c.json"), `{"mark":"${B_MARK}"}\n`);
        write(join(app.work, "data/private/b.json"), `{"mark":"${PRIV}"}\n`);
        installNext(app.work);
        const b = compile(app.work);
        expect(b.status, String(b.stderr)).toBe(0);
        const r = runAlone(b.exe);
        expect(r.result.kept).toContain(A_MARK);
        expect(r.result.pub).toContain(B_MARK);
        expect(r.result.private).toBe("ERR ENOENT");
        expect(readFileSync(b.exe).indexOf(PRIV)).toBe(-1);
        expect(readFileSync(b.exe).indexOf("data/private/b.json")).toBe(-1);
    }, 180_000);

    describe("route keys that a hand-made matcher gets wrong", () => {
        const READ = `t("a", () => readFileSync(join(process.cwd(), "data", "a" + ".json"), "utf8"));
t("p", () => readFileSync(join(process.cwd(), "data", "p" + ".json"), "utf8"));`;
        const setup = (
            includes: string,
            excludes: string,
            withNext: boolean,
        ) => {
            const app = baseApp(
                READ,
                `export default { outputFileTracingIncludes: ${includes}, outputFileTracingExcludes: ${excludes} };\n`,
            );
            write(join(app.work, "data/a.json"), `{"mark":"${A_MARK}"}\n`);
            write(join(app.work, "data/p.json"), `{"mark":"${B_MARK}"}\n`);
            if (withNext) installNext(app.work);
            return app;
        };
        for (const key of [
            "/blog/[slug]",
            "/blog/\\\\[slug\\\\]",
            "/(group)/x",
            "/{api,admin}/*",
        ]) {
            for (const withNext of [false, true]) {
                it(`an include keyed ${key} embeds its files (${withNext ? "next installed" : "no next"})`, () => {
                    const app = setup(
                        `{ ${JSON.stringify(key)}: ["./data/a.json"] }`,
                        "{}",
                        withNext,
                    );
                    const b = compile(app.work);
                    expect(b.status, String(b.stderr)).toBe(0);
                    expect(runAlone(b.exe).result.a).toContain(A_MARK);
                }, 180_000);
            }
        }

        it("`!` negation follows Next: the exclude applies to routes that do not match the rest of the key", () => {
            const app = setup(
                '{ "/": ["./data/**/*"] }',
                '{ "!/admin/*": ["./data/p.json"] }',
                true,
            );
            const b = compile(app.work);
            expect(b.status, String(b.stderr)).toBe(0);
            const r = runAlone(b.exe);
            expect(r.result.a).toContain(A_MARK);
            expect(r.result.p).toBe("ERR ENOENT");
        }, 180_000);

        it("`/api/**` reaches the `/api` route", () => {
            const app = setup(
                '{ "/api": ["./data/**/*"] }',
                '{ "/api/**": ["./data/p.json"] }',
                true,
            );
            const b = compile(app.work);
            expect(b.status, String(b.stderr)).toBe(0);
            expect(runAlone(b.exe).result.p).toBe("ERR ENOENT");
        }, 180_000);

        it("without next, a route-specific exclude key FAILS the build and says how to fix it", () => {
            const app = setup(
                '{ "/": ["./data/**/*"] }',
                '{ "/admin/*": ["./data/p.json"] }',
                false,
            );
            const b = compile(app.work);
            expect(b.status).toBe(1);
            expect(String(b.stderr)).toMatch(
                /outputFileTracingExcludes\['\/admin\/\*'\][\s\S]*[Ii]nstall next/,
            );
        }, 120_000);

        it("without next, an all-routes exclude key still applies", () => {
            const app = setup(
                '{ "/": ["./data/**/*"] }',
                '{ "**": ["./data/p.json"] }',
                false,
            );
            const b = compile(app.work);
            expect(b.status, String(b.stderr)).toBe(0);
            expect(runAlone(b.exe).result.p).toBe("ERR ENOENT");
        }, 180_000);
    });

    it("a config that leaves a timer running does not hold the build up", () => {
        const app = baseApp(
            `t("a", () => readFileSync(join(process.cwd(), "data", "a" + ".json"), "utf8"));`,
            'setInterval(() => {}, 1000);\nexport default { outputFileTracingIncludes: { "/": ["./data/a.json"] } };\n',
        );
        write(join(app.work, "data/a.json"), `{"mark":"${A_MARK}"}\n`);
        const started = Date.now();
        const b = compile(app.work);
        expect(b.status, String(b.stderr)).toBe(0);
        expect(Date.now() - started).toBeLessThan(60_000);
        expect(runAlone(b.exe).result.a).toContain(A_MARK);
    }, 100_000);

    describe("a function where a glob list belongs is an error, not a silent no-include", () => {
        const configs: Record<string, string> = {
            "the map itself":
                "export default { outputFileTracingIncludes: () => ({}) };\n",
            "a route's value":
                'export default { outputFileTracingIncludes: { "/": () => ["./data/a.json"] } };\n',
            "a glob inside the list":
                'export default { outputFileTracingIncludes: { "/": [() => "x"] } };\n',
            "the legacy experimental map":
                "export default { experimental: { outputFileTracingIncludes: () => ({}) } };\n",
            "an exclude":
                'export default { outputFileTracingIncludes: { "/": ["./data/a.json"] }, outputFileTracingExcludes: { "/": () => [] } };\n',
        };
        for (const [name, source] of Object.entries(configs)) {
            it(name, () => {
                const app = baseApp("", source);
                write(join(app.work, "data/a.json"), "{}\n");
                const b = compile(app.work);
                expect(b.status).toBe(1);
                expect(String(b.stderr)).toMatch(
                    /outputFileTracing(Includes|Excludes)[\s\S]*(function|glob)/,
                );
            }, 120_000);
        }
    });

    describe("the config sees the environment `next build` would give it", () => {
        const WRITE_ENV = `import { writeFileSync } from "node:fs";
writeFileSync(process.cwd() + "/seen-env.json", JSON.stringify({
  NODE_ENV: process.env.NODE_ENV ?? null, PICK: process.env.PICK ?? null, BASE: process.env.BASE ?? null,
  DEVONLY: process.env.DEVONLY ?? null, EXPLICIT: process.env.EXPLICIT ?? null, LOCAL: process.env.LOCAL ?? null,
}));
export default { outputFileTracingIncludes: { "/": ["./data/a.json"] } };\n`;
        const setup = (withNext = false) => {
            const app = baseApp("", WRITE_ENV);
            if (withNext) installNext(app.work);
            write(join(app.work, "data/a.json"), "{}\n");
            write(join(app.work, ".env"), "BASE=base\nPICK=base\n");
            write(
                join(app.work, ".env.production"),
                "PICK=prod\nEXPLICIT=prod\n",
            );
            write(
                join(app.work, ".env.development"),
                "PICK=dev\nDEVONLY=dev\n",
            );
            write(join(app.work, ".env.local"), "LOCAL=local\n");
            return app;
        };
        const seen = (work: string) =>
            JSON.parse(readFileSync(join(work, "seen-env.json"), "utf8"));

        it("NODE_ENV unset, compile started in the app root: production files win over the development ones Bun auto-loaded; a shell value wins over every file", () => {
            const app = setup();
            const b = compile(app.work, [], {
                NODE_ENV: "",
                EXPLICIT: "shell",
            });
            expect(b.status, String(b.stderr)).toBe(0);
            expect(seen(app.work)).toEqual({
                NODE_ENV: "production",
                PICK: "prod",
                BASE: "base",
                DEVONLY: null,
                EXPLICIT: "shell",
                LOCAL: "local",
            });
        }, 180_000);

        it("with next installed, the files are loaded by Next's own loader and the result is the same", () => {
            const app = setup(true);
            const b = compile(app.work, [], {
                NODE_ENV: "",
                EXPLICIT: "shell",
            });
            expect(b.status, String(b.stderr)).toBe(0);
            expect(seen(app.work)).toEqual({
                NODE_ENV: "production",
                PICK: "prod",
                BASE: "base",
                DEVONLY: null,
                EXPLICIT: "shell",
                LOCAL: "local",
            });
        }, 180_000);

        it("an explicit NODE_ENV is kept, and the production files still load (as `next build` loads them)", () => {
            const app = setup();
            const b = compile(app.work, [], { NODE_ENV: "development" });
            expect(b.status, String(b.stderr)).toBe(0);
            const env = seen(app.work);
            expect(env.NODE_ENV).toBe("development");
            expect(env.PICK).toBe("prod");
            expect(env.DEVONLY).toBeNull();
        }, 180_000);
    });

    describe("a next.config that declares includes by indirection is still read", () => {
        const READ = `t("a", () => readFileSync(join(process.cwd(), "data", "a" + ".json"), "utf8"));`;
        const INC = '{ outputFileTracingIncludes: { "/": ["./data/a.json"] } }';
        const shapes: Record<
            string,
            { file: string; source: string; extra?: Record<string, string> }
        > = {
            "require of path.join(__dirname, …)": {
                file: "next.config.cjs",
                source: 'const path = require("node:path");\nmodule.exports = require(path.join(__dirname, "inc.cjs"));\n',
                extra: { "inc.cjs": `module.exports = ${INC};\n` },
            },
            "template-literal require": {
                file: "next.config.cjs",
                source: "module.exports = require(`./inc.cjs`);\n",
                extra: { "inc.cjs": `module.exports = ${INC};\n` },
            },
            "computed import()": {
                file: "next.config.mjs",
                source: 'const f = "./inc.mjs";\nexport default (await import(f)).default;\n',
                extra: { "inc.mjs": `export default ${INC};\n` },
            },
            "a key built at run time": {
                file: "next.config.mjs",
                source: 'const k = ["output", "File", "Tracing", "Includes"].join("");\nexport default { [k]: { "/": ["./data/a.json"] } };\n',
            },
            "JSON read through fs": {
                file: "next.config.mjs",
                source: 'import fs from "node:fs";\nexport default JSON.parse(fs.readFileSync(new URL("./inc.json", import.meta.url), "utf8"));\n',
                extra: {
                    "inc.json":
                        '{"outputFileTracingIncludes":{"/":["./data/a.json"]}}',
                },
            },
            "a default export that is a Promise": {
                file: "next.config.mjs",
                source: `export default Promise.resolve(${INC});\n`,
            },
            "an async function": {
                file: "next.config.mjs",
                source: `export default async () => (${INC});\n`,
            },
        };
        for (const [name, shape] of Object.entries(shapes)) {
            it(name, () => {
                const app = baseApp(READ);
                rmSync(join(app.work, "next.config.mjs"), { force: true });
                write(join(app.work, shape.file), shape.source);
                for (const [rel, body] of Object.entries(shape.extra ?? {})) {
                    write(join(app.work, rel), body);
                }
                write(join(app.work, "data/a.json"), `{"mark":"${A_MARK}"}\n`);
                const b = compile(app.work);
                expect(b.status, String(b.stderr)).toBe(0);
                expect(runAlone(b.exe).result.a).toContain(A_MARK);
            }, 180_000);
        }

        it("control: with no config the computed path is not embedded", () => {
            const app = baseApp(READ);
            write(join(app.work, "data/a.json"), `{"mark":"${A_MARK}"}\n`);
            const b = compile(app.work);
            expect(b.status, String(b.stderr)).toBe(0);
            expect(runAlone(b.exe).result.a).toBe("ERR ENOENT");
        }, 120_000);
    });

    it("a next.config that cannot declare includes is not executed a second time", () => {
        const app = baseApp(
            "",
            'import { appendFileSync } from "node:fs";\nappendFileSync(process.cwd() + "/config-ran.log", "ran\\n");\nexport default { reactStrictMode: true };\n',
        );
        const b = compile(app.work);
        expect(b.status, String(b.stderr)).toBe(0);
        expect(existsSync(join(app.work, "config-ran.log"))).toBe(false);
    }, 120_000);

    it("a next.config that declares includes is executed (once) to read them", () => {
        const app = baseApp(
            "",
            'import { appendFileSync } from "node:fs";\nappendFileSync(process.cwd() + "/config-ran.log", "ran\\n");\nexport default { outputFileTracingIncludes: { "/": ["./data/a.json"] } };\n',
        );
        write(join(app.work, "data/a.json"), "{}\n");
        const b = compile(app.work);
        expect(b.status, String(b.stderr)).toBe(0);
        expect(readFileSync(join(app.work, "config-ran.log"), "utf8")).toBe(
            "ran\n",
        );
    }, 120_000);

    describe("a function-form next.config is given the defaults a real load gets", () => {
        const READ = `t("a", () => readFileSync(join(process.cwd(), "data", "a" + ".json"), "utf8"));`;

        it("a plugin-style config that spreads defaultConfig.pageExtensions loads", () => {
            const app = baseApp(READ);
            write(
                join(app.work, "next.config.mjs"),
                `export default (phase, { defaultConfig }) => ({
  pageExtensions: [...defaultConfig.pageExtensions, "mdx"],
  outputFileTracingIncludes: { "/": ["./data/a.json"] },
});\n`,
            );
            write(join(app.work, "data/a.json"), `{"mark":"${A_MARK}"}\n`);
            const b = compile(app.work);
            expect(b.status, String(b.stderr)).toBe(0);
            expect(runAlone(b.exe).result.a).toContain(A_MARK);
        }, 180_000);

        it("without an installed next, a fixed minimal default is used, never a copy from a global cache", () => {
            const app = baseApp(READ);
            write(
                join(app.work, "next.config.mjs"),
                `export default (phase, { defaultConfig }) => {
  // a copy of Next from a global cache would have many experimental defaults
  if (Object.keys(defaultConfig.experimental).length !== 0) throw new Error("not the minimal default");
  return { pageExtensions: [...defaultConfig.pageExtensions, "mdx"], outputFileTracingIncludes: { "/": ["./data/a.json"] } };
};\n`,
            );
            write(join(app.work, "data/a.json"), `{"mark":"${A_MARK}"}\n`);
            const b = compile(app.work);
            expect(b.status, String(b.stderr)).toBe(0);
            expect(runAlone(b.exe).result.a).toContain(A_MARK);
        }, 180_000);

        it("Next's own defaultConfig is used when next resolves from the app", () => {
            const app = baseApp(READ);
            write(
                join(app.work, "node_modules/next/package.json"),
                '{"name":"next","version":"0.0.0"}',
            );
            write(
                join(
                    app.work,
                    "node_modules/next/dist/server/config-shared.js",
                ),
                'exports.defaultConfig = { pageExtensions: ["tsx"], traceMarker: ["./data/a.json"] };\n',
            );
            write(
                join(app.work, "next.config.mjs"),
                'export default (phase, { defaultConfig }) => ({ outputFileTracingIncludes: { "/": defaultConfig.traceMarker } });\n',
            );
            write(join(app.work, "data/a.json"), `{"mark":"${A_MARK}"}\n`);
            const b = compile(app.work);
            expect(b.status, String(b.stderr)).toBe(0);
            expect(runAlone(b.exe).result.a).toContain(A_MARK);
        }, 180_000);
    });

    describe("the config is loaded as `next build` loads it: NODE_ENV=production when unset", () => {
        const READ = `t("a", () => readFileSync(join(process.cwd(), "data", "a" + ".json"), "utf8"));`;
        const CONFIG = `if (process.env.KNEXT_ONLY_IN_ENV_PRODUCTION !== "yes") throw new Error("env missing in " + process.env.NODE_ENV);
export default { outputFileTracingIncludes: { "/": ["./data/a.json"] } };\n`;
        const setup = () => {
            const app = baseApp(READ);
            write(join(app.work, "next.config.mjs"), CONFIG);
            write(
                join(app.work, ".env.production"),
                "KNEXT_ONLY_IN_ENV_PRODUCTION=yes\n",
            );
            write(join(app.work, "data/a.json"), `{"mark":"${A_MARK}"}\n`);
            return app;
        };

        it("NODE_ENV unset: .env.production is in effect", () => {
            const app = setup();
            const b = compile(app.work, [], { NODE_ENV: "" });
            expect(b.status, String(b.stderr)).toBe(0);
            expect(runAlone(b.exe).result.a).toContain(A_MARK);
        }, 180_000);
    });

    describe("a value from the real shell always survives into the config", () => {
        const CONFIG = `import { writeFileSync } from "node:fs";
const keys = ["DATABASE_URL", "FOO", "X", "PICK"];
writeFileSync(process.cwd() + "/seen.json", JSON.stringify(Object.fromEntries(keys.map((k) => [k, process.env[k] ?? null]))));
export default { outputFileTracingIncludes: { "/": ["./data/a.json"] } };\n`;
        const app = (files: Record<string, string>) => {
            const a = baseApp("", CONFIG);
            write(join(a.work, "data/a.json"), "{}\n");
            for (const [name, body] of Object.entries(files)) {
                write(join(a.work, name), body);
            }
            return a;
        };
        const seen = (work: string) =>
            JSON.parse(readFileSync(join(work, "seen.json"), "utf8"));

        it("CI's DATABASE_URL equal to the .env.development entry, NODE_ENV unset", () => {
            const a = app({
                ".env.development": "DATABASE_URL=postgres://ci/db\n",
            });
            const b = compile(a.work, [], {
                NODE_ENV: "",
                DATABASE_URL: "postgres://ci/db",
            });
            expect(b.status, String(b.stderr)).toBe(0);
            expect(seen(a.work).DATABASE_URL).toBe("postgres://ci/db");
            // started as `knext build` starts it, so there is nothing to warn about
            expect(String(b.stderr)).not.toMatch(/--no-env-file/);
        }, 180_000);

        it("NODE_ENV=test with the value also present in .env.local (a file test mode does not read)", () => {
            const a = app({ ".env.local": "X=from-local\n" });
            const b = compile(a.work, [], {
                NODE_ENV: "test",
                X: "from-local",
            });
            expect(b.status, String(b.stderr)).toBe(0);
            expect(seen(a.work).X).toBe("from-local");
        }, 180_000);

        it("a shell FOO equal to the .env entry beats a different .env.production entry", () => {
            const a = app({ ".env": "FOO=b\n", ".env.production": "FOO=c\n" });
            const b = compile(a.work, [], { NODE_ENV: "", FOO: "b" });
            expect(b.status, String(b.stderr)).toBe(0);
            expect(seen(a.work).FOO).toBe("b");
        }, 180_000);

        it("a shell value that a file would have expanded to the same text", () => {
            const a = app({ ".env.development": "FOO=http://$H/dev\n" });
            const b = compile(a.work, [], {
                NODE_ENV: "",
                FOO: "http://host/dev",
                H: "host",
            });
            expect(b.status, String(b.stderr)).toBe(0);
            expect(seen(a.work).FOO).toBe("http://host/dev");
        }, 180_000);

        it("the same four hold with next installed (Next's own env loader)", () => {
            const a = app({
                ".env": "FOO=b\n",
                ".env.production": "FOO=c\nPICK=prod\n",
                ".env.development": "DATABASE_URL=postgres://ci/db\nPICK=dev\n",
            });
            installNext(a.work);
            const b = compile(a.work, [], {
                NODE_ENV: "",
                FOO: "b",
                DATABASE_URL: "postgres://ci/db",
            });
            expect(b.status, String(b.stderr)).toBe(0);
            const s = seen(a.work);
            expect(s.FOO).toBe("b");
            expect(s.DATABASE_URL).toBe("postgres://ci/db");
            expect(s.PICK).toBe("prod");
        }, 180_000);

        it("a compile that was NOT started with --no-env-file passes the environment on unchanged and says so", () => {
            const a = app({
                ".env.development": "PICK=dev\n",
                ".env.production": "PICK=prod\n",
            });
            const b = compile(
                a.work,
                [],
                { NODE_ENV: "", FOO: "shell" },
                { viaCli: false },
            );
            expect(b.status, String(b.stderr)).toBe(0);
            expect(seen(a.work).FOO).toBe("shell");
            expect(String(b.stderr)).toMatch(/not started with --no-env-file/);
        }, 180_000);
    });

    it("an outputFileTracingExcludes entry keyed '*' also removes a file the server code names by literal path", () => {
        const app = baseApp(
            `t("named", () => readFileSync(join(process.cwd(), "data/named.json"), "utf8"));
t("kept", () => readFileSync(join(process.cwd(), "data", "k" + ".json"), "utf8"));`,
            `export default {
  outputFileTracingIncludes: { "/": ["./data/k.json"] },
  outputFileTracingExcludes: { "*": ["./data/named.json"] },
};\n`,
        );
        write(join(app.work, "data/k.json"), `{"mark":"${A_MARK}"}\n`);
        write(join(app.work, "data/named.json"), `{"mark":"${B_MARK}"}\n`);
        const b = compile(app.work);
        expect(b.status, String(b.stderr)).toBe(0);
        const r = runAlone(b.exe);
        expect(r.result.kept).toContain(A_MARK);
        expect(r.result.named).toBe("ERR ENOENT");
        expect(readFileSync(b.exe).indexOf(B_MARK)).toBe(-1);
    }, 180_000);

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
