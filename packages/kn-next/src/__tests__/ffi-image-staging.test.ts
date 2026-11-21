/**
 * In-process Rust (Beta) — the image side of ADR-0069 D14 and the D17
 * zero-diff guarantee.
 *
 *  1. The staged `Dockerfile.standalone` gains exactly two lines, directly after
 *     the `standalone-bun` stage's exec COPY — only when `knext.ffi.json`
 *     exists: `COPY --chown=0:0 --chmod=a-w native /app/.next/standalone/native`
 *     and `RUN chmod go-w` on every directory above the exec (the loader walks
 *     them up to `/` and refuses one that group or other can write; a nested
 *     directory inside a copied tree keeps the build host's mode, which is 0775
 *     under umask 002). Without the file, byte-identical to the template. A
 *     moved or duplicated anchor fails the staging.
 *  2. Nested (monorepo tracing-root) layout: the line is inserted BEFORE
 *     nesting and rewritten by a NEST_RULES entry present only when opted in,
 *     so `native/` lands beside the nested exec; a non-ffi app's nested
 *     Dockerfile is exactly what nesting produced before.
 *  3. The standalone compile (`compileArtifactForDeploy`, turbopack × bun)
 *     writes `native/.integrity.json` over the staged `native/ffi/**` when
 *     opted in, and creates no `native/` at all otherwise.
 *  4. vinext's sharp staging (`stageSharpNative`) leaves `native/ffi/` alone
 *     for an opted-in app — on a first build (no manifest yet) and on a
 *     rebuild (the previous manifest lists `ffi/**`) — and its manifest covers
 *     it. Once the app opts OUT (deletes `knext.ffi.json`), the old
 *     `native/ffi/` is cleared like any other staged entry, so neither the
 *     manifest nor the image (the vinext Dockerfile COPYs `native/` whole)
 *     carries a library nothing calls.
 */

import { afterAll, describe, expect, it, mock } from "bun:test";
import { createHash } from "node:crypto";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    readFileSync,
    realpathSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const roots: string[] = [];
afterAll(() => {
    for (const r of roots) rmSync(r, { recursive: true, force: true });
});

// The real executable build shells out to `bun build --compile`; these tests
// are about what is staged around it, so write a placeholder.
const realExec = { ...(await import("../cli/standalone-exec-build")) };
mock.module("../cli/standalone-exec-build", () => ({
    ...realExec,
    buildStandaloneExecutable: (opts: { cwd: string; arch: string }) => {
        const out = join(opts.cwd, realExec.standaloneExecFileName(opts.arch));
        writeFileSync(out, "binary");
        return out;
    },
}));

const { compileArtifactForDeploy } = await import("../cli/build-artifact");
const {
    FFI_NATIVE_COPY,
    nestStandaloneDockerfile,
    runtimeStandaloneTemplateDir,
    stageStandaloneBuildContext,
    VINEXT_FFI_CLOSE_LINE,
} = await import("../cli/runtime-image");
const { stageSharpNative } = await import("../cli/vinext-build");

function tree(files: Record<string, string>): string {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "knext-ffi-img-")));
    roots.push(base);
    for (const [rel, contents] of Object.entries(files)) {
        const abs = join(base, rel);
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, contents);
    }
    return base;
}

const TEMPLATE_DIR = runtimeStandaloneTemplateDir();
const TEMPLATE = readFileSync(
    join(TEMPLATE_DIR, "Dockerfile.standalone.hbs"),
    "utf8",
);
const ANCHOR =
    "COPY knext-standalone-exec-linux-x64 /app/.next/standalone/knext-standalone-exec";
const TRIPLE = "x86_64-unknown-linux-musl";
const OPT_IN = { "knext.ffi.json": '{ "version": 1 }\n' };
const sha = (b: Uint8Array | string) =>
    createHash("sha256").update(b).digest("hex");

/** Instruction lines of one stage (comments/blanks dropped). */
function stage(dockerfile: string, name: string): string[] {
    const start = dockerfile.search(new RegExp(`^FROM .* AS ${name}$`, "m"));
    expect(start, `no ${name} stage`).toBeGreaterThan(-1);
    const rest = dockerfile.slice(start);
    const next = rest.indexOf("\nFROM ", 1);
    return (next === -1 ? rest : rest.slice(0, next))
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l !== "" && !l.startsWith("#"));
}

/** Any COPY of a native/ tree, whatever flags it carries (scanned, not enumerated). */
const NATIVE_COPY = /^COPY (?:--\S+ )*\S*native \S/m;

function stageFlat(files: Record<string, string>, templateDir?: string) {
    const app = tree({ "package.json": "{}", ...files });
    const { dockerfile } = stageStandaloneBuildContext({
        cwd: app,
        buildContext: app,
        ...(templateDir ? { templateDir } : {}),
    });
    return readFileSync(dockerfile, "utf8");
}

const WEB_CONFIG = `const path = require("node:path");
module.exports = {
    output: "standalone",
    outputFileTracingRoot: path.join(__dirname, "..", ".."),
    turbopack: { root: path.join(__dirname, "..", "..") },
};
`;

function stageNested(files: Record<string, string>) {
    const root = tree({
        "package.json": "{}",
        "apps/web/package.json": "{}",
        "apps/web/next.config.js": WEB_CONFIG,
        ...files,
    });
    const { dockerfile } = stageStandaloneBuildContext({
        cwd: join(root, "apps", "web"),
        buildContext: root,
    });
    return readFileSync(dockerfile, "utf8");
}

/** A template directory whose Dockerfile is `edit(TEMPLATE)`. */
function templateWith(edit: (t: string) => string): string {
    const dir = tree({});
    for (const f of readdirSync(TEMPLATE_DIR)) {
        writeFileSync(join(dir, f), readFileSync(join(TEMPLATE_DIR, f)));
    }
    writeFileSync(join(dir, "Dockerfile.standalone.hbs"), edit(TEMPLATE));
    return dir;
}

describe("the staged Dockerfile — flat layout", () => {
    it("D17 zero-diff: without knext.ffi.json it is byte-identical to the template", () => {
        expect(stageFlat({})).toBe(TEMPLATE);
    });

    it("opted in: exactly two lines are added, directly after the standalone-bun exec COPY: the native/ COPY and the chmod of every directory above the exec", () => {
        const text = stageFlat(OPT_IN);
        expect(FFI_NATIVE_COPY).toBe(
            "COPY --chown=0:0 --chmod=a-w native /app/.next/standalone/native",
        );
        const ANCESTORS_RUN =
            "RUN chmod go-w /app /app/.next /app/.next/standalone /app/.next/standalone/native";
        const lines = stage(text, "standalone-bun");
        const at = lines.indexOf(ANCHOR);
        expect(at).toBeGreaterThan(-1);
        expect(lines[at + 1]).toBe(FFI_NATIVE_COPY);
        expect(lines[at + 2]).toBe(ANCESTORS_RUN);
        // Nothing else changed: removing the two lines gives the template back.
        const added = text
            .split("\n")
            .filter((l) => !TEMPLATE.split("\n").includes(l));
        expect(added).toEqual([FFI_NATIVE_COPY, ANCESTORS_RUN]);
        expect(text.split("\n").length).toBe(TEMPLATE.split("\n").length + 2);
        // Before the stage's USER line: the chmod runs as root.
        expect(lines.indexOf(ANCESTORS_RUN)).toBeLessThan(
            lines.findIndex((l) => l.startsWith("USER ")),
        );
        // No other stage ships native/.
        for (const s of ["standalone-bun-self-contained", "standalone-node"]) {
            expect(stage(text, s).join("\n")).not.toMatch(NATIVE_COPY);
        }
    });

    it("a missing anchor fails the staging when opted in", () => {
        const dir = templateWith((t) => t.replace(`${ANCHOR}\n`, ""));
        expect(() => stageFlat(OPT_IN, dir)).toThrow(/exactly once/);
        // ...and is irrelevant when not opted in.
        expect(() => stageFlat({}, dir)).not.toThrow();
    });

    it("a duplicated anchor fails the staging when opted in", () => {
        const dir = templateWith((t) =>
            t.replace(ANCHOR, `${ANCHOR}\n${ANCHOR}`),
        );
        expect(() => stageFlat(OPT_IN, dir)).toThrow(/exactly once/);
    });

    it("an anchor moved out of the standalone-bun stage fails the staging", () => {
        const dir = templateWith((t) =>
            t
                .replace(`${ANCHOR}\n`, "")
                .replace(
                    "COPY knext-standalone-exec-linux-x64 /app/knext-standalone-exec",
                    `COPY knext-standalone-exec-linux-x64 /app/knext-standalone-exec\n${ANCHOR}`,
                ),
        );
        expect(() => stageFlat(OPT_IN, dir)).toThrow(/standalone-bun/);
    });
});

describe("the staged Dockerfile — nested (monorepo root) layout", () => {
    it("opted in: the inserted line is rewritten so native/ sits beside the nested exec", () => {
        const text = stageNested({ "apps/web/knext.ffi.json": "{}\n" });
        const lines = stage(text, "standalone-bun");
        const at = lines.indexOf(
            "COPY apps/web/knext-standalone-exec-linux-x64 /app/.next/standalone/apps/web/knext-standalone-exec",
        );
        expect(at).toBeGreaterThan(-1);
        expect(lines[at + 1]).toBe(
            "COPY --chown=0:0 --chmod=a-w apps/web/native /app/.next/standalone/apps/web/native",
        );
        // The directories above the nested exec come out of the copied tree with the build
        // host's mode, so each one is closed, the nested ones included.
        expect(lines[at + 2]).toBe(
            "RUN chmod go-w /app /app/.next /app/.next/standalone /app/.next/standalone/apps /app/.next/standalone/apps/web /app/.next/standalone/apps/web/native",
        );
        expect(text).not.toContain(FFI_NATIVE_COPY);
    });

    it("not opted in: byte-identical to nesting without the ffi rule, and no native line", () => {
        const text = stageNested({});
        expect(text).toBe(
            nestStandaloneDockerfile(TEMPLATE, {
                contextPrefix: "apps/web/",
                coreSrc: "apps/web/node_modules/@getknext/core",
            }),
        );
        expect(text).not.toMatch(NATIVE_COPY);
    });
});

// ---------------------------------------------------------------------------
// The integrity manifest on the standalone compile (turbopack × bun).
// ---------------------------------------------------------------------------

const bunCfg = {
    name: "zone",
    registry: "r",
    build: "turbopack",
    runtime: "bun",
} as never;

function standaloneApp(files: Record<string, string> = {}) {
    return tree({
        "package.json": "{}",
        "next.config.js": 'module.exports = { output: "standalone" };\n',
        ".next/standalone/server.js": "// flat\n",
        ".next/standalone/package.json": "{}",
        ...files,
    });
}

describe("compileArtifactForDeploy — native/.integrity.json over native/ffi", () => {
    it("opted in: lists ffi/<triple>/lib<name>.so and provenance.json with their sha256", () => {
        const lib = "\u007fELF fake library bytes";
        const prov = '{ "target": "x86_64-unknown-linux-musl" }\n';
        const app = standaloneApp({
            ...OPT_IN,
            [`native/ffi/${TRIPLE}/libzone.so`]: lib,
            [`native/ffi/${TRIPLE}/provenance.json`]: prov,
        });
        const result = compileArtifactForDeploy(bunCfg, app);
        expect(result.compiled).toBe(true);
        const manifest = JSON.parse(
            readFileSync(join(app, "native", ".integrity.json"), "utf8"),
        );
        expect(manifest.version).toBe(1);
        expect(manifest.algorithm).toBe("sha256");
        expect(manifest.files).toEqual({
            [`ffi/${TRIPLE}/libzone.so`]: sha(lib),
            [`ffi/${TRIPLE}/provenance.json`]: sha(prov),
        });
    });

    it("opted in with nothing staged for the image arch: refuses rather than ship an image without its library", () => {
        const app = standaloneApp(OPT_IN);
        expect(() => compileArtifactForDeploy(bunCfg, app)).toThrow(
            /native\/ffi\/x86_64-unknown-linux-musl/,
        );
        expect(existsSync(join(app, "native", ".integrity.json"))).toBe(false);
    });

    it("D17 zero-diff: without knext.ffi.json no native/ tree is created", () => {
        const app = standaloneApp();
        compileArtifactForDeploy(bunCfg, app);
        expect(existsSync(join(app, "native"))).toBe(false);
    });

    it("D17 zero-diff: without knext.ffi.json a leftover native/ffi is neither hashed nor shipped", () => {
        // An app that opted out keeps a stale tree on disk; nothing re-hashes
        // it, and the Dockerfile does not COPY it (the condition is the file).
        const app = standaloneApp({
            [`native/ffi/${TRIPLE}/libzone.so`]: "stale",
        });
        compileArtifactForDeploy(bunCfg, app);
        expect(existsSync(join(app, "native", ".integrity.json"))).toBe(false);
        expect(stageFlat({})).not.toMatch(NATIVE_COPY);
    });
});

// ---------------------------------------------------------------------------
// vinext's native/ clean-up keeps its hands off native/ffi/.
// ---------------------------------------------------------------------------

describe("stageSharpNative (vinext × bun) leaves native/ffi/ alone when opted in", () => {
    const LIB = `native/ffi/${TRIPLE}/libzone.so`;

    it("first build: native/ffi/ staged before any manifest exists is kept and hashed", () => {
        const app = tree({ "package.json": "{}", ...OPT_IN, [LIB]: "lib-v1" });
        stageSharpNative(app, { arch: "linux-x64" });
        expect(readFileSync(join(app, LIB), "utf8")).toBe("lib-v1");
        const files = JSON.parse(
            readFileSync(join(app, "native", ".integrity.json"), "utf8"),
        ).files;
        expect(files).toEqual({ [`ffi/${TRIPLE}/libzone.so`]: sha("lib-v1") });
    });

    it("rebuild: the previous manifest lists ffi/**, and the freshly staged library still survives", () => {
        const app = tree({ "package.json": "{}", ...OPT_IN, [LIB]: "lib-v1" });
        stageSharpNative(app, { arch: "linux-x64" });
        // The next build's `knext ffi build` replaces native/ffi/ first.
        writeFileSync(join(app, LIB), "lib-v2");
        stageSharpNative(app, { arch: "linux-x64" });
        expect(readFileSync(join(app, LIB), "utf8")).toBe("lib-v2");
        const files = JSON.parse(
            readFileSync(join(app, "native", ".integrity.json"), "utf8"),
        ).files;
        expect(files[`ffi/${TRIPLE}/libzone.so`]).toBe(sha("lib-v2"));
    });

    it("a hand-written file outside native/ffi/ with no manifest is still refused (unchanged)", () => {
        const app = tree({
            "package.json": "{}",
            ...OPT_IN,
            [LIB]: "lib",
            "native/mine.txt": "do not delete",
        });
        expect(() => stageSharpNative(app, { arch: "linux-x64" })).toThrow(
            /Refusing to stage/,
        );
        expect(readFileSync(join(app, "native", "mine.txt"), "utf8")).toBe(
            "do not delete",
        );
    });
});

describe("stageSharpNative (vinext) clears a stale native/ffi/ once the app opts out", () => {
    const LIB = `native/ffi/${TRIPLE}/libzone.so`;

    it("the vinext image ships native/ whole, so what is on disk is what ships", () => {
        const vinextDockerfile = readFileSync(
            join(dirname(TEMPLATE_DIR), "app", "Dockerfile.hbs"),
            "utf8",
        );
        expect(vinextDockerfile).toMatch(
            /^COPY --chown=0:0 --chmod=a-w native \/app\/native$/m,
        );
    });

    it("opted out after an opted-in build: native/ffi/ is removed and the manifest no longer lists it", () => {
        const app = tree({ "package.json": "{}", ...OPT_IN, [LIB]: "lib-v1" });
        stageSharpNative(app, { arch: "linux-x64" });
        const before = JSON.parse(
            readFileSync(join(app, "native", ".integrity.json"), "utf8"),
        ).files;
        expect(Object.keys(before)).toContain(`ffi/${TRIPLE}/libzone.so`);

        rmSync(join(app, "knext.ffi.json"));
        stageSharpNative(app, { arch: "linux-x64" });

        expect(existsSync(join(app, "native", "ffi"))).toBe(false);
        const after = JSON.parse(
            readFileSync(join(app, "native", ".integrity.json"), "utf8"),
        ).files;
        expect(after).toEqual({});
        expect(readdirSync(join(app, "native"))).toEqual([".integrity.json"]);
    });

    it("opted in: the same rebuild keeps native/ffi/ (the control for the case above)", () => {
        const app = tree({ "package.json": "{}", ...OPT_IN, [LIB]: "lib-v1" });
        stageSharpNative(app, { arch: "linux-x64" });
        stageSharpNative(app, { arch: "linux-x64" });
        expect(readFileSync(join(app, LIB), "utf8")).toBe("lib-v1");
    });

    it("opted out with a native/ffi/ no manifest accounts for: refused, not deleted", () => {
        // Not provably knext's (no ownership record), so the usual refusal.
        const app = tree({ "package.json": "{}", [LIB]: "lib" });
        expect(() => stageSharpNative(app, { arch: "linux-x64" })).toThrow(
            /Refusing to stage/,
        );
        expect(readFileSync(join(app, LIB), "utf8")).toBe("lib");
    });
});

describe("native/ ships root-owned and non-writable, in every image that carries it", () => {
    const LINE = /^COPY (?:--\S+ )*\S*native \S.*$/gm;
    const PERMS =
        /^COPY (?=(?:--\S+ )*--chown=0:0 )(?=(?:--\S+ )*--chmod=a-w )/;
    const vinext = readFileSync(
        join(dirname(TEMPLATE_DIR), "app", "Dockerfile.hbs"),
        "utf8",
    );
    for (const [name, text] of [
        ["the vinext template", () => vinext],
        ["the staged flat standalone-bun Dockerfile", () => stageFlat(OPT_IN)],
        [
            "the staged nested standalone-bun Dockerfile",
            () => stageNested({ "apps/web/knext.ffi.json": "{}\n" }),
        ],
    ] as const) {
        it(`${name}: exactly one native/ COPY, and it carries --chown=0:0 --chmod=a-w`, () => {
            const lines = text().match(LINE) ?? [];
            expect(lines.length).toBe(1);
            for (const l of lines) expect(l).toMatch(PERMS);
        });
    }

    it("only the native/ COPY carries the flags: no other COPY line changed", () => {
        const others = [vinext, stageFlat(OPT_IN)]
            .join("\n")
            .split("\n")
            .filter((l) => l.startsWith("COPY ") && !NATIVE_COPY.test(l));
        expect(others.length).toBeGreaterThan(0);
        for (const l of others) expect(l).not.toContain("--chmod=a-w");
    });
});
// ---------------------------------------------------------------------------
// Every directory above the executable must be root's and closed to group and
// other: the loader walks them up to / and refuses the first that is not
// (ADR-0069 Amendment 1), because a user who can write one can rename the tree
// out of it. So the IMAGE has to leave them that way, on any build host.
// ---------------------------------------------------------------------------

describe("every directory above the executable in the image is root-owned and closed to group and other, whatever mode the build host's files have", () => {
    interface Dir {
        uid: number;
        mode: number;
    }

    /**
     * What BuildKit leaves, as measured on docker 29 with a context made under umask 002 (0775
     * directories): WORKDIR and the parents a COPY creates are 0755 and root's; the destination
     * directory of a directory COPY is 0755 and root's, whatever the source's mode; a directory
     * INSIDE the copied tree keeps the source's mode; nothing is anyone's but root's without a
     * --chown. Only chmod and chown are understood in a RUN: a chmod it does not know fails the
     * model rather than being skipped. With `destFromHost`, a COPY's destination directory takes
     * the build host's mode too: not what BuildKit does today, and not something it promises, so
     * the chmod must not depend on it.
     */
    function evaluate(
        instructions: string[],
        hostMode: number,
        destFromHost = false,
    ): (path: string) => Dir | undefined {
        const explicit = new Map<string, Dir>();
        const trees: string[] = [];
        const inTree = (p: string) =>
            trees.some((t) => p !== t && p.startsWith(`${t}/`));
        const ensure = (dir: string) => {
            for (let d = dir; d !== "/"; d = dirname(d)) {
                if (!explicit.has(d) && !inTree(d)) {
                    explicit.set(d, { uid: 0, mode: 0o755 });
                }
            }
        };
        const modeOf = (p: string): Dir | undefined =>
            explicit.get(p) ??
            (inTree(p) ? { uid: 0, mode: hostMode } : undefined);
        const joined: string[] = [];
        for (const l of instructions) {
            const last = joined.length - 1;
            if (last >= 0 && joined[last]?.endsWith("\\")) {
                joined[last] = `${joined[last]?.slice(0, -1)} ${l}`;
            } else joined.push(l);
        }
        for (const line of joined) {
            const [word, ...rest] = line.split(/\s+/);
            if (word === "WORKDIR") ensure(rest[0] as string);
            if (word === "COPY") {
                const args = rest.filter((a) => !a.startsWith("--"));
                const dst = args[args.length - 1] as string;
                if (!dst.startsWith("/")) continue;
                ensure(dirname(dst));
                // A destination that already exists keeps what it has.
                if (!explicit.has(dst) && !inTree(dst)) {
                    explicit.set(dst, {
                        uid: 0,
                        mode: destFromHost ? hostMode : 0o755,
                    });
                }
                trees.push(dst);
            }
            if (word === "RUN") {
                for (const cmd of line.slice(4).split("&&")) {
                    const [tool, ...args] = cmd.trim().split(/\s+/);
                    if (tool === "chmod") {
                        const [spec, ...paths] = args as string[];
                        for (const p of paths) {
                            const cur = modeOf(p) ?? { uid: 0, mode: 0o755 };
                            const mode =
                                spec === "go-w"
                                    ? cur.mode & ~0o022
                                    : /^[0-7]{3,4}$/.test(spec as string)
                                      ? Number.parseInt(spec as string, 8)
                                      : Number.NaN;
                            if (Number.isNaN(mode)) {
                                throw new Error(
                                    `the model does not know chmod ${spec}`,
                                );
                            }
                            explicit.set(p, { ...cur, mode });
                        }
                    } else if (tool === "chown") {
                        const [owner, ...paths] = args as string[];
                        for (const p of paths) {
                            const cur = modeOf(p) ?? { uid: 0, mode: 0o755 };
                            explicit.set(p, {
                                ...cur,
                                uid: Number.parseInt(
                                    (owner as string).split(":")[0] as string,
                                    10,
                                ),
                            });
                        }
                    }
                }
            }
        }
        return modeOf;
    }

    /** Every directory from `execDir` up to (not including) / that is not root's, or that group or other can write. */
    function violations(
        instructions: string[],
        execDir: string,
        hostMode: number,
        opts: { destFromHost?: boolean; also?: string[] } = {},
    ): string[] {
        const modeOf = evaluate(instructions, hostMode, opts.destFromHost);
        const bad: string[] = [];
        for (const d of [...(opts.also ?? []), ...ancestors(execDir)]) {
            const dir = modeOf(d);
            if (dir === undefined) bad.push(`${d}: not made by the Dockerfile`);
            else if (dir.uid !== 0) bad.push(`${d}: owned by uid ${dir.uid}`);
            else if ((dir.mode & 0o022) !== 0) {
                bad.push(`${d}: mode ${dir.mode.toString(8)}`);
            }
        }
        return bad;
    }

    /** `dir` and every directory above it, up to (not including) /. */
    const ancestors = (dir: string) => {
        const out: string[] = [];
        for (let d = dir; d !== "/"; d = dirname(d)) out.push(d);
        return out;
    };

    /** The directory the native/ COPY lands in (the loader looks for native/ beside the exec). */
    const nativeDir = (instructions: string[]) => {
        const line = instructions.find((l) => NATIVE_COPY.test(l)) as string;
        return dirname(line.trim().split(/\s+/).pop() as string);
    };

    const flat = () => stage(stageFlat(OPT_IN), "standalone-bun");
    const nested = () =>
        stage(
            stageNested({ "apps/web/knext.ffi.json": "{}\n" }),
            "standalone-bun",
        );
    const HOSTS = [0o775, 0o777];

    for (const host of HOSTS) {
        it(`flat standalone-bun, build host directories 0${host.toString(8)}: /app, /app/.next and the exec's directory are root's and closed`, () => {
            const lines = flat();
            expect(nativeDir(lines)).toBe("/app/.next/standalone");
            expect(violations(lines, nativeDir(lines), host)).toEqual([]);
        });

        it(`nested standalone-bun, build host directories 0${host.toString(8)}: the tracing-root prefix directories the copy brings are closed too`, () => {
            const lines = nested();
            expect(nativeDir(lines)).toBe("/app/.next/standalone/apps/web");
            expect(violations(lines, nativeDir(lines), host)).toEqual([]);
        });
    }

    it("the model sees the gap the chmod closes: without it a nested prefix directory comes out group-writable under umask 002", () => {
        const without = nested().filter((l) => !l.startsWith("RUN chmod go-w"));
        expect(violations(without, nativeDir(without), 0o775)).toEqual([
            "/app/.next/standalone/apps/web: mode 775",
            "/app/.next/standalone/apps: mode 775",
        ]);
        // The flat layout never had the gap: the copy's destination is 0755 (measured).
        const flatWithout = flat().filter(
            (l) => !l.startsWith("RUN chmod go-w"),
        );
        expect(violations(flatWithout, nativeDir(flatWithout), 0o777)).toEqual(
            [],
        );
    });

    it("native/ itself and every directory above it are closed even on a builder that gives a COPY's destination the build host's mode: the chmod names each of them", () => {
        for (const host of HOSTS) {
            for (const lines of [flat(), nested()]) {
                const exec = nativeDir(lines);
                const opts = {
                    destFromHost: true,
                    also: [`${exec}/native`],
                };
                expect(violations(lines, exec, host, opts)).toEqual([]);
                // The control: without the chmod, that builder leaves the same directories open.
                const without = lines.filter(
                    (l) => !l.startsWith("RUN chmod go-w"),
                );
                expect(violations(without, exec, host, opts)).toContain(
                    `${exec}/native: mode ${host.toString(8)}`,
                );
            }
        }
    });

    it("the model sees an ancestor chowned to the app user", () => {
        const lines = [...flat(), "RUN chown 65532:65532 /app/.next"];
        expect(violations(lines, nativeDir(lines), 0o775)).toEqual([
            "/app/.next: owned by uid 65532",
        ]);
    });

    it("the vinext x bun Dockerfile: the executable's directory is /app, made by WORKDIR, whatever the host", () => {
        const vinextText = readFileSync(
            join(dirname(TEMPLATE_DIR), "app", "Dockerfile.hbs"),
            "utf8",
        );
        const lines = vinextText
            .split("\n")
            .map((l) => l.trim())
            .filter((l) => l !== "" && !l.startsWith("#"));
        expect(nativeDir(lines)).toBe("/app");
        for (const host of HOSTS) {
            expect(violations(lines, "/app", host)).toEqual([]);
        }
    });

    it("the vinext x bun Dockerfile plus the one line knext ffi init adds closes /app and /app/native even on a builder that gives a COPY's destination the build host's mode; without the line /app/native is left open", () => {
        const vinextText = readFileSync(
            join(dirname(TEMPLATE_DIR), "app", "Dockerfile.hbs"),
            "utf8",
        );
        const lines = vinextText
            .split("\n")
            .map((l) => l.trim())
            .filter((l) => l !== "" && !l.startsWith("#"));
        const at = lines.findIndex((l) => NATIVE_COPY.test(l));
        expect(at).toBeGreaterThan(-1);
        const withLine = [
            ...lines.slice(0, at + 1),
            VINEXT_FFI_CLOSE_LINE,
            ...lines.slice(at + 1),
        ];
        for (const host of HOSTS) {
            const opts = { destFromHost: true, also: ["/app/native"] };
            expect(violations(withLine, "/app", host, opts)).toEqual([]);
            // The control: the template alone leaves /app/native as the builder made it.
            expect(violations(lines, "/app", host, opts)).toEqual([
                `/app/native: mode ${host.toString(8)}`,
            ]);
        }
    });
});
