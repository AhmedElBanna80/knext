/**
 * The vinext x bun compiled executable is proved to carry bytecode by the CLI
 * itself, with the SAME verifiers the compile script and the compiled
 * standalone target use (`bytecode-exec-verify.mjs`) -- independent of whatever
 * the compile script claims, and chosen PER SHAPE:
 *
 *   default / self-contained -> verifyBytecodeExec (one banner-headed entry)
 *   compile.include          -> verifyBytecodeModules (entry + every module)
 *
 * Both directions per shape: a realistic bytecode artifact passes, a plain or
 * under-counted one is rejected with the VERIFIER's reason (not merely
 * "something said bytecode") and the binary is removed.
 */

import { afterAll, describe, expect, it } from "bun:test";
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    rmSync,
    writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildVinextExecutable } from "../cli/vinext-build";

const tempDirs: string[] = [];
afterAll(() => {
    for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
});

function appWithOutput(withIncludes = false): string {
    const cwd = mkdtempSync(join(tmpdir(), "knext-vinext-bc-"));
    tempDirs.push(cwd);
    writeFileSync(
        join(cwd, "package.json"),
        JSON.stringify({ name: "app", type: "module" }),
    );
    mkdirSync(join(cwd, ".output", "server"), { recursive: true });
    writeFileSync(join(cwd, ".output", "server", "index.mjs"), "");
    if (withIncludes) {
        mkdirSync(join(cwd, "lib"), { recursive: true });
        writeFileSync(join(cwd, "lib", "a.js"), "export const a = 1;\n");
        writeFileSync(join(cwd, "lib", "b.js"), "export const b = 2;\n");
    }
    return cwd;
}

function markerOf(argv: readonly string[]): string {
    const i = argv.indexOf("--marker");
    expect(i, "the CLI must hand the compile a marker").toBeGreaterThan(-1);
    return argv[i + 1] as string;
}

const PAD = "\0".repeat(256);
/** One compiled module: pragma, then the banner (source), as Bun lays it out. */
const moduleSrc = (m: string, bytecode: boolean) =>
    `// @bun ${bytecode ? "@bytecode " : ""}@bun-esm\nglobalThis.__knextVinextExecMarker=${JSON.stringify(m)};export{};\n${PAD}`;
/** `n` banner-headed modules, plus the constant-pool copy of the marker. */
const artifact = (m: string, modules: number, bytecode = true) =>
    Buffer.from(
        `ELF…${bytecode ? `pool:${m}…` : ""}${Array.from({ length: modules }, () => moduleSrc(m, bytecode)).join("")}`,
        "latin1",
    );

interface Shape {
    readonly selfContained?: boolean;
    readonly include?: readonly string[];
    /**
     * What the compile script's plan sidecar says (entry + included modules);
     * `null` = the script wrote none. Default: 3, the fixture's include plan.
     */
    readonly plan?: number | null;
    /** Override the marker the sidecar carries (default: the build's own). */
    readonly planMarker?: string;
}
const sidecarOf = (out: string) => `${out}.knext-plan.json`;
let lastCwd = "";
function build(read: (marker: string) => Buffer, shape: Shape = {}) {
    const cwd = appWithOutput(shape.include !== undefined);
    lastCwd = cwd;
    const argvs: string[][] = [];
    writeFileSync(join(cwd, "knext-exec-linux-x64"), "stale binary");
    return buildVinextExecutable({
        cwd,
        bunVersion: "1.4.0",
        skipViteBuild: true,
        include: shape.include,
        selfContained: shape.selfContained,
        run: (argv) => {
            argvs.push([...argv]);
            // The script's plan sidecar (include shape only), beside --outfile.
            const out = argv[argv.indexOf("--outfile") + 1] as string;
            const plan = shape.plan === undefined ? 3 : shape.plan;
            if (shape.include && !shape.selfContained && plan !== null) {
                writeFileSync(
                    sidecarOf(out),
                    JSON.stringify({
                        marker: shape.planMarker ?? markerOf(argv),
                        modules: plan,
                    }),
                );
            }
        },
        readArtifact: () => read(markerOf(argvs[argvs.length - 1] as string[])),
    });
}
const sidecarGone = () =>
    !existsSync(sidecarOf(join(lastCwd, "knext-exec-linux-x64")));
/** Fail closed also means the rejected binary is gone. */
const removed = () => !existsSync(join(lastCwd, "knext-exec-linux-x64"));

const NO_BYTECODE = /compiled WITHOUT --bytecode/;
const MARKER_MISSING = /marker is not in the executable/;

describe("vinext x bun default shape: the CLI verifies the executable", () => {
    it("accepts an executable that carries bytecode", () => {
        expect(() => build((m) => artifact(m, 1))).not.toThrow();
    });

    it("REJECTS an executable compiled without bytecode, and removes it", () => {
        expect(() => build((m) => artifact(m, 1, false))).toThrow(NO_BYTECODE);
        expect(removed()).toBe(true);
    });

    it("REJECTS an executable that lacks the entry marker entirely", () => {
        expect(() => build(() => Buffer.from("ELF no marker here"))).toThrow(
            MARKER_MISSING,
        );
    });

    it("an unreadable artifact fails with the read error, not a bytecode verdict", () => {
        const cwd = appWithOutput();
        expect(() =>
            buildVinextExecutable({
                cwd,
                bunVersion: "1.4.0",
                skipViteBuild: true,
                run: () => {},
                readArtifact: () => {
                    throw new Error("EACCES nope");
                },
            }),
        ).toThrow(/could not be read for the check: EACCES nope/);
    });
});

describe("vinext x bun self-contained shape", () => {
    it("accepts a bytecode artifact", () => {
        expect(() =>
            build((m) => artifact(m, 1), { selfContained: true }),
        ).not.toThrow();
    });

    it("REJECTS one compiled without bytecode", () => {
        expect(() =>
            build((m) => artifact(m, 1, false), { selfContained: true }),
        ).toThrow(NO_BYTECODE);
        expect(removed()).toBe(true);
    });
});

describe("vinext x bun compile.include shape (entry + 2 included modules)", () => {
    const include = ["lib/*.js"];

    it("ACCEPTS a realistic artifact: three banner-headed bytecode modules", () => {
        expect(() => build((m) => artifact(m, 3), { include })).not.toThrow();
    });

    it("REJECTS an artifact where an included module lost its banner/bytecode", () => {
        expect(() => build((m) => artifact(m, 1), { include })).toThrow(
            /heads 1 bytecode module\(s\), expected at least 3/,
        );
        expect(removed()).toBe(true);
    });

    it("REJECTS a 3-module plan whose binary has only 2 banner-headed modules (exact count)", () => {
        expect(() => build((m) => artifact(m, 2), { include })).toThrow(
            /heads 2 bytecode module\(s\), expected at least 3/,
        );
        expect(removed()).toBe(true);
    });

    it("fails closed when the script left no plan sidecar", () => {
        expect(() =>
            build((m) => artifact(m, 3), { include, plan: null }),
        ).toThrow(/plan sidecar .* is missing/);
        expect(removed()).toBe(true);
    });

    it("fails closed when the sidecar's marker is not this build's", () => {
        expect(() =>
            build((m) => artifact(m, 3), {
                include,
                planMarker: "knext-vinext-exec:000000000000000000000000",
            }),
        ).toThrow(/plan sidecar .* marker/);
    });

    it("fails closed on a malformed sidecar count", () => {
        expect(() =>
            build((m) => artifact(m, 3), { include, plan: 0 }),
        ).toThrow(/plan sidecar .* module count/);
    });

    it("deletes the sidecar after verification, pass or fail", () => {
        build((m) => artifact(m, 3), { include });
        expect(sidecarGone()).toBe(true);
        expect(() => build((m) => artifact(m, 2), { include })).toThrow();
        expect(sidecarGone()).toBe(true);
    });

    it("REJECTS an include artifact compiled without bytecode", () => {
        expect(() => build((m) => artifact(m, 3, false), { include })).toThrow(
            NO_BYTECODE,
        );
    });

    it("self-contained wins over include: one banner-headed entry is enough, as in the script", () => {
        expect(() =>
            build((m) => artifact(m, 1), { include, selfContained: true }),
        ).not.toThrow();
    });
});

describe("the CLI and the compile script resolve the SAME output path", () => {
    it("passes an ABSOLUTE --outfile even when process.cwd() is not the app dir", () => {
        const cwd = appWithOutput();
        expect(process.cwd()).not.toBe(cwd);
        const argvs: string[][] = [];
        const ret = buildVinextExecutable({
            cwd,
            bunVersion: "1.4.0",
            skipViteBuild: true,
            run: (argv) => argvs.push([...argv]),
            readArtifact: (p) => {
                // The verifier reads exactly where the script was told to write.
                const out = argvs[0]?.[argvs[0].indexOf("--outfile") + 1];
                expect(p).toBe(out as string);
                return artifact(markerOf(argvs[0] as string[]), 1);
            },
        });
        const out = argvs[0]?.[argvs[0].indexOf("--outfile") + 1] as string;
        expect(out).toBe(join(cwd, "knext-exec-linux-x64"));
        // The returned path stays app-relative, as callers expect.
        expect(ret).toBe("knext-exec-linux-x64");
    });
});
